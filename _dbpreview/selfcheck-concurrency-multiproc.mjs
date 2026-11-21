/**
 * 真·多进程并发写测试（2026-11-17）。
 *
 * ## 为什么需要它（上面那个 selfcheck-concurrency.mjs 不够）
 *
 * 那个脚本用的是 `DatabaseSync`（同步 API）+ Node 单线程，
 * 所谓「并发」实际是**同步串行** —— 每个 appendLog 执行完才下一个。
 * 它证明的是「事务状态不会搞混」，**证明不了「两条连接同时写会不会丢」**。
 *
 * 真正的并发必须**多个 OS 进程**同时往同一个库写。
 * 这才能替代「两个真实会话同时说话」这个无法构造的场景。
 *
 * ## 做法
 *
 * fork 出 N 个 worker 进程，各自独立 open 数据库，
 * 同时（用统一的起始时间戳对齐）往同一个临时库写 M 条，
 * 然后父进程统计：**成功写入数 == 库里实际条数**。
 *
 * ## 判据
 *
 * - 每个 worker 报告自己成功写了几条
 * - 父进程查库里总条数
 * - 两者必须相等 → 没有「返回成功却没落库」
 * - 允许 worker 报 `SQLITE_BUSY`（锁竞争是合法的），但**那些必须计入失败而不是静默丢弃**
 *
 * ⚠️ 用临时库，绝不碰真实库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---- worker 模式：被 fork 时走这条分支 ----
if (process.env.DSH_CONCURRENCY_WORKER === '1') {
  const { createDbStore } = await import('../dsh-fatfishdream-memory/db-store.mjs')
  const dbPath = process.env.DSH_CONCURRENCY_DB
  const tag = process.env.DSH_CONCURRENCY_TAG
  const count = Number(process.env.DSH_CONCURRENCY_COUNT)
  const startAt = Number(process.env.DSH_CONCURRENCY_START)
  const store = createDbStore(dbPath, {}, () => {})
  store.open()

  const ok = []
  const errs = []

  // 等到统一起始时刻再动手，让各进程尽量真的同时写
  while (Date.now() < startAt) { /* busy wait，几十毫秒 */ }

  for (let i = 0; i < count; i++) {
    try {
      const r = store.appendLog('race', `worker${tag} #${i}`, {
        topic: '开发日志',
        summary: `w${tag}-${i}`,
        keywords: `race${tag}`,
      })
      ok.push(r.id)
    } catch (e) {
      errs.push(String(e?.message ?? e))
    }
  }
  store.close()
  // ⚠️ 2026-11-17 改：结果写**文件**，不再走 stdout。
  //
  // 为什么改：受限沙箱（workspace-write）下程序不能开命名管道，
  // `spawn` 用 `stdio: 'pipe'` 会直接 EPERM 抛错 —— 整个脚本还没测任何东西就崩了。
  // 而本机默认就是受限沙箱（只有显式 danger-full-access 才放开）。
  //
  // 改成写文件后，父进程可以用 `stdio: 'ignore'`（沙箱允许），
  // 完全绕开管道。这与 `lib-spawn-capture.mjs` 的退路是同一个思路。
  const outFile = process.env.DSH_CONCURRENCY_OUT
  if (outFile) {
    try {
      fs.writeFileSync(outFile, JSON.stringify({ tag, ok: ok.length, errs: errs.length, sample: errs[0] ?? null }), 'utf8')
    } catch (e) {
      // 写不出来就让父进程从「文件缺失」推断 worker 失败了 —— 不静默
      process.exit(2)
    }
  }
  process.exit(0)
}

// ---- 父进程模式 ----
let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) { pass++ }
  else { fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${name}  ← ${detail}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-race-'))
const dbPath = path.join(tmpRoot, 'race.db')

try {
  // 先建库（schema 就位）
  const { createDbStore } = await import('../dsh-fatfishdream-memory/db-store.mjs')
  {
    const s = createDbStore(dbPath, {}, () => {})
    s.open()
    s.close()
  }

  const WORKERS = 4
  const PER = 25
  const startAt = Date.now() + 600 // 给所有进程 600ms 准备时间

  console.log(`=== ${WORKERS} 个进程 × 各 ${PER} 条，同时开写 ===\n`)

  const children = []
  for (let w = 0; w < WORKERS; w++) {
    // ⚠️ 2026-11-17：结果走**临时文件**，不走 stdout 管道。
    //
    // 原实现用 `stdio: ['ignore', 'pipe', 'pipe']` 读子进程输出，
    // 在 workspace-write 沙箱下直接 `spawn EPERM` —— 脚本什么都没测就崩了。
    // 本机默认权限就是 workspace-write，所以这条必须按沙箱可用的方式写。
    //
    // `stdio: 'ignore'` 在沙箱下是允许的（exit code 依然准确），
    // worker 把 JSON 写进 outFile，父进程读完即删。
    const outFile = path.join(tmpRoot, `worker-${w}.json`)
    const child = spawn(process.execPath, [HERE + '/selfcheck-concurrency-multiproc.mjs'], {
      env: {
        ...process.env,
        DSH_CONCURRENCY_WORKER: '1',
        DSH_CONCURRENCY_DB: dbPath,
        DSH_CONCURRENCY_TAG: String(w),
        DSH_CONCURRENCY_COUNT: String(PER),
        DSH_CONCURRENCY_START: String(startAt),
        DSH_CONCURRENCY_OUT: outFile,
      },
      stdio: 'ignore',
    })
    children.push(
      new Promise((resolve) => {
        child.on('exit', (code) => {
          let parsed = null
          let err = ''
          try {
            parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'))
          } catch (e) {
            // 文件没有/读不动 = worker 没跑到写文件那步（崩了或被杀）
            err = String(e?.message ?? e)
          }
          resolve({ tag: w, code, parsed, err: err.slice(0, 300) })
        })
        child.on('error', (e) => {
          resolve({ tag: w, code: null, parsed: null, err: `spawn 失败：${e?.message ?? e}` })
        })
      }),
    )
  }

  const results = await Promise.all(children)
  let totalOk = 0
  let totalErr = 0
  for (const r of results) {
    if (!r.parsed) {
      console.log(`   worker${r.tag}: ❌ 没拿到结果（exit=${r.code}）${r.err ? ' — ' + r.err : ''}`)
      continue
    }
    totalOk += r.parsed.ok
    totalErr += r.parsed.errs
    console.log(
      `   worker${r.tag}: 成功 ${r.parsed.ok} / 失败 ${r.parsed.errs}` +
        (r.parsed.sample ? `  （首条错误：${r.parsed.sample.slice(0, 60)}）` : ''),
    )
  }

  console.log(`\n   合计：成功 ${totalOk} 次，报错 ${totalErr} 次（共尝试 ${WORKERS * PER}）`)

  // ---- 核心断言 ----
  const s = createDbStore(dbPath, {}, () => {})
  s.open()
  const actual = s.countScope('logs', 'race')

  check('所有 worker 都跑完了（没有崩）', results.every((r) => r.parsed !== null), `${results.filter((r) => !r.parsed).length} 个没结果`)
  check(
    `成功写入 ${totalOk} 次 → 库里必须有 ${totalOk} 条（不能多也不能少）`,
    actual === totalOk,
    `实际 ${actual}，差 ${actual - totalOk}`,
  )

  // 若全部成功（没有锁竞争失败），条数必须等于尝试总数
  if (totalErr === 0) {
    check(`无锁竞争失败，库中应为全部 ${WORKERS * PER} 条`, actual === WORKERS * PER, `实际 ${actual}`)
  } else {
    console.log('   （有锁竞争报错 —— 合法，只要「报错的不算成功」即可）')
  }

  // FTS 一致性
  const st = s.stats()
  check('多进程并发后 stats 可读', typeof st?.total === 'number', JSON.stringify({ total: st?.total }))
  s.close()

  // 库完整性
  const { DatabaseSync } = await import('node:sqlite')
  const ro = new DatabaseSync(dbPath, { readOnly: true })
  const qc = Object.values(ro.prepare('PRAGMA quick_check').get())[0]
  check('多进程并发后 quick_check = ok', qc === 'ok', String(qc))
  for (const t of ['profile', 'rules', 'logs', 'archive']) {
    let main = 0
    let fts = 0
    try { main = ro.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c } catch { main = -1 }
    try { fts = ro.prepare(`SELECT COUNT(*) c FROM ${t}_fts`).get().c } catch { fts = -1 }
    check(`多进程并发后 ${t} 主表(${main}) = FTS(${fts})`, main === fts && main >= 0, `${main} vs ${fts}`)
  }
  ro.close()
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
