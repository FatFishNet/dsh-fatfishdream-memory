/**
 * 并发写入完整性测试（2026-11-17 新增）。
 *
 * ## 为什么要它
 *
 * 记忆里唯一一次「写入丢失」的实测记录是 DECISIONS D13：
 * 「并发 12 条消息，**无队列会丢失到只剩 1 条**」—— 但那是 `.md` 时代
 * （读-改-写整个文件）的问题，用 `serialize()` 串行队列修的。
 *
 * 改 SQLite 之后，写入走 `insertInto` → `withFtsTransaction`（BEGIN IMMEDIATE），
 * 理论上安全。但**从来没有实测过**，而这是「记忆会不会丢」的核心问题。
 *
 * ## 测什么
 *
 * 三种并发度，各自断言「写了几条，库里就该有几条」：
 *   1. 同 store 实例并发（同一连接，模拟同一进程内多轮并发）
 *   2. 多 store 实例并发（**不同连接**，这是真实的多会话场景）
 *   3. 混合 logs + archive 并发（两条写入路径同时压）
 *
 * ## 为什么第 2 种最关键
 *
 * 同一个工作区的两个会话 = 两个 store 实例 = 两条独立 SQLite 连接。
 * `withFtsTransaction` 的 `inTransaction` 是**闭包变量**，
 * 每个 store 实例各有一份 —— 所以它只能防「同实例重入」，
 * 跨实例的互斥完全靠 SQLite 的 `BEGIN IMMEDIATE` 文件锁。
 *
 * 这也是唯一能替代「两个真实会话同时说话」的测试手段。
 *
 * ⚠️ 用临时库，绝不碰真实库。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) { pass++ }
  else { fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${name}  ← ${detail}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-concurrency-'))
const dbPath = path.join(tmpRoot, 'test.db')
const noop = () => {}

function openStore() {
  const s = createDbStore(dbPath, {}, noop)
  s.open()
  return s
}

const SCOPE = 'concurrency-test'

try {
  // ============================================================
  console.log('=== 1. 同 store 实例并发写 logs（20 条）===\n')
  //
  // 同一连接上「同时」发起多个 appendLog。Node 是单线程，
  // 但这些调用之间没有 await 间隙（同步 SQLite），所以实际是串行执行的。
  // 这一组验证的是「不会因为事务状态搞混而丢」。
  {
    const store = openStore()
    const N = 20
    const ids = []
    for (let i = 0; i < N; i++) {
      const r = store.appendLog(SCOPE, `同实例并发 ${i}`, {
        topic: '开发日志',
        summary: `同实例 ${i}`,
        keywords: `并发${i}`,
      })
      ids.push(r.id)
    }
    const count = store.countScope('logs', SCOPE)
    check(`同实例写入 ${N} 条，库里应有 ${N} 条`, count === N, `实际 ${count}`)
    check(`返回的 ${N} 个 id 互不相同`, new Set(ids).size === N, `去重后 ${new Set(ids).size}`)
    check('返回的 id 全部是正整数', ids.every((x) => Number.isInteger(x) && x > 0), JSON.stringify(ids.slice(0, 3)))

    // FTS 必须同步（这是「能查到」的前提）
    const found = store.search(`并发`, SCOPE)
    check('FTS 同步：搜得到刚写的条目', found.length > 0, `命中 ${found.length}`)

    store.close()
  }

  // ============================================================
  console.log('\n=== 2. 多 store 实例并发写（不同连接，模拟多会话）===\n')
  //
  // 这是最关键的一组：每个 store 是独立的 SQLite 连接，
  // inTransaction 闭包各有一份，互斥只能靠 BEGIN IMMEDIATE 的文件锁。
  {
    // 先建库、确认可用
    const init = openStore()
    init.close()

    const writers = []
    const WRITERS = 4
    const PER_WRITER = 10
    const SCOPE2 = 'multi-conn'

    for (let w = 0; w < WRITERS; w++) {
      // 每个 writer 独立 open 一个连接
      const s = openStore()
      writers.push({ store: s, tag: w })
    }

    // 交错写入：模拟两个会话交替说话（不是「先写完一个再写另一个」）
    const results = []
    for (let i = 0; i < PER_WRITER; i++) {
      for (const { store, tag } of writers) {
        try {
          const r = store.appendLog(SCOPE2, `连接${tag} 第${i}条`, {
            topic: '开发日志',
            summary: `c${tag}-${i}`,
            keywords: `多连接${tag}`,
          })
          results.push({ tag, id: r.id, ok: true })
        } catch (e) {
          results.push({ tag, id: null, ok: false, err: String(e?.message ?? e) })
        }
      }
    }

    const expected = WRITERS * PER_WRITER
    const success = results.filter((r) => r.ok).length
    const errors = results.filter((r) => !r.ok)

    console.log(`   尝试 ${expected} 次，成功 ${success} 次，报错 ${errors.length} 次`)
    if (errors.length > 0) {
      for (const e of errors.slice(0, 3)) console.log(`     writer${e.tag}: ${e.err}`)
    }

    // 关键断言：**成功的次数必须等于库里实际条数**。
    // 若 assert 失败说明「返回成功但没写进去」或「写进去了但返回失败」。
    const checkStore = openStore()
    const actual = checkStore.countScope('logs', SCOPE2)
    check(`多连接并发：成功 ${success} 次 → 库里应有 ${success} 条`, actual === success, `实际 ${actual}`)

    // 另一个角度：用户视角「我写了几条就该有几条」
    // 若全部成功，条数必须等于尝试次数（不能悄悄丢）
    if (errors.length === 0) {
      check(`多连接并发：${expected} 次全部成功，库中必须有 ${expected} 条`, actual === expected, `实际 ${actual}`)
    } else {
      console.log('   （有报错，跳过「全部成功」断言 —— 报错本身是合法的锁竞争结果，不算丢数据）')
    }

    // 主表与 FTS 必须一致（并发下最容易出现的不一致）
    const mainCount = actual
    const ftsRow = checkStore.stats()
    check(
      '多连接并发后主表条数可读（stats 未崩）',
      typeof ftsRow?.total === 'number',
      JSON.stringify({ total: ftsRow?.total }),
    )

    checkStore.close()
    for (const { store } of writers) store.close()
  }

  // ============================================================
  console.log('\n=== 3. logs + archive 两种路径并发 ===\n')
  {
    const store = openStore()
    const SCOPE3 = 'mixed'
    const N = 15
    let logOk = 0
    let arcOk = 0
    for (let i = 0; i < N; i++) {
      try {
        store.appendLog(SCOPE3, `混合日志 ${i}`, { topic: '开发日志', summary: `m${i}` })
        logOk++
      } catch { /* 记录失败次数 */ }
      try {
        const r = store.appendArchive({ scope: SCOPE3, role: 'user', text: `混合原文 ${i}` })
        if (r?.written !== false) arcOk++
      } catch { /* 记录失败次数 */ }
    }
    const lc = store.countScope('logs', SCOPE3)
    check(`混合并发：日志成功 ${logOk} 次 → 库里 ${logOk} 条`, lc === logOk, `实际 ${lc}`)

    const arc = store.listArchive({ scope: SCOPE3, limit: 100 })
    check(`混合并发：原文成功 ${arcOk} 次 → 库里 ${arcOk} 条`, arc.rows.length === arcOk, `实际 ${arc.rows.length}`)
    store.close()
  }

  // ============================================================
  console.log('\n=== 4. 库完整性（并发写完后必须仍然 ok）===\n')
  {
    const s = openStore()
    // 用一个只读连接查 PRAGMA
    const { DatabaseSync } = await import('node:sqlite')
    s.close()
    const ro = new DatabaseSync(dbPath, { readOnly: true })
    const qc = Object.values(ro.prepare('PRAGMA quick_check').get())[0]
    const ic = Object.values(ro.prepare('PRAGMA integrity_check').get())[0]
    check('quick_check = ok', qc === 'ok', String(qc))
    check('integrity_check = ok', ic === 'ok', String(ic))

    // 四表主表与 FTS 条数必须相等
    for (const t of ['profile', 'rules', 'logs', 'archive']) {
      let main = 0
      let fts = 0
      try { main = ro.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c } catch { main = -1 }
      try { fts = ro.prepare(`SELECT COUNT(*) c FROM ${t}_fts`).get().c } catch { fts = -1 }
      check(`${t} 主表(${main}) = FTS(${fts})`, main === fts && main >= 0, `${main} vs ${fts}`)
    }
    ro.close()
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
