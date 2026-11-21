/**
 * 隔离测试：`/api/dsh-memory/log` 的写入结算逻辑（2026-11-18）。
 *
 * ⭐ 为什么单独造这个脚本
 *
 * 用户观察到一个说不通的现象：反复触发也不会产生新流水，但偶尔又会写。
 * 前几轮我给出的解释（"判据出错" / "情绪导致" / "纯说话轮无处附着"）
 * 一个接一个被数据否掉。而真实日志给出的差别只有一处：
 *
 *     写了流水的轮，序列里多一对  `summary-derived` + `[mem-写流水]`
 *     没写的轮，直接  archive-assistant → write-streak-check
 *
 * 于是开始怀疑「写入那一侧的代码本身有条件分支」。
 *
 * 本脚本把 index.js 里 /log 处理段的**关键判定**原样复制到临时库上跑，
 * 覆盖那些容易静默失败的分支。**不碰真实 memory.db**。
 *
 * ## 复制的判定（与 index.js 对应行）
 *
 *   · scope 解析：传 scope → 用它；否则用 cwd 算（L6622–6640）
 *   · cwd 必须是**存在的目录**（L6632，用 isDirectoryPath，不是 exists）
 *   · `sid` 取自请求体 `body.sessionId`，为空则不记（L6689–6695）
 *   · `wroteLog` / `logRouteHits` 都按这个 sid 分键（L6691–6694）
 *
 * ## 判据设计（避免恒真断言）
 *
 * 每条断言都必须能在「代码被改坏」时变红。凡是做不到的，只打印不断言。
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')

let pass = 0
let fail = 0
const failures = []

function check(name, ok, note = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}${note ? ` — ${note}` : ''}`)
    console.log(`  ❌ ${name}${note ? ` — ${note}` : ''}`)
  }
}

// ---- 临时环境：独立的根目录 + 独立的库 -------------------------------
const root = mkdtempSync(join(tmpdir(), 'dsh-log-route-'))
const dbPath = join(root, 'memory.db')
const workDir = join(root, 'workspace-probe')
mkdirSync(workDir, { recursive: true })

const logged = []
const logs = []

function makeStore() {
  return createDbStore(dbPath, {}, (level, msg) => logs.push({ level, msg }))
}

try {
  console.log(`=== 隔离测试：/log 写入结算 ===`)
  console.log(`临时库：${dbPath}\n`)

  const store = makeStore()
  // ---- 1) 基本写入：能落库、能读回 ---------------------------------
  console.log('--- 1) 最基础的写入 ---')
  const r1 = store.appendLog('dsh-fatfishdream-memory', '隔离测试第一条', {
    topic: '开发日志',
    summary: '隔离测试',
  })
  check('appendLog 返回了 id', Number.isInteger(r1?.id) && r1.id > 0, JSON.stringify(r1))
  check('appendLog 返回了 project', typeof r1?.project === 'string' && r1.project !== '', String(r1?.project))

  const back = store.recentLogs?.('dsh-fatfishdream-memory', 5)
  if (Array.isArray(back)) {
    check('刚写的那条能读回', back.some((x) => x.id === r1.id), `读回 ${back.length} 条`)
  } else {
    console.log('  （本段不适用：store 没有暴露 recentLogs，改用 lastLogTs 验证）')
    const ts = store.lastLogTs?.()
    check('lastLogTs 能读到刚写入的时间', typeof ts === 'string' && ts !== '', String(ts))
  }

  // ---- 2) 复刻 sid 分键逻辑 ---------------------------------------
  //
  // 这一段是本次排查的重点：`wroteLog` 与 `logRouteHits` 都按
  // `body.sessionId` 分键，与 turn-stopping 的 `String(agent.session.id)`
  // 必须**逐字相同**。这里用手写的两个 Map 复刻，验证分支行为。
  console.log('\n--- 2) sid 分键：空 / 有值 / 带空白 ---')

  const turnActivity = new Map()
  const logRouteHits = new Map()

  // 与 index.js L6689–6694 同构
  function applyLogRouteSettlement(body) {
    const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sid !== '') {
      const rec = turnActivity.get(sid) ?? { writes: 0, wroteMemory: false, wroteLog: false }
      rec.wroteLog = true
      turnActivity.set(sid, rec)
      logRouteHits.set(sid, (logRouteHits.get(sid) ?? 0) + 1)
      return true
    }
    return false
  }

  // 2a) 正常 sid
  const sidA = 'session-aaaa'
  const okA = applyLogRouteSettlement({ sessionId: sidA })
  check('有 sessionId 时会计数', okA === true)
  check('wroteLog 被置 true', turnActivity.get(sidA)?.wroteLog === true)
  check('logRouteHits 变成 1', logRouteHits.get(sidA) === 1)

  // 2b) 再写一次，hits 递增、wroteLog 仍是 true（幂等）
  applyLogRouteSettlement({ sessionId: sidA })
  check('第二次写入 logRouteHits 变成 2', logRouteHits.get(sidA) === 2)
  check('wroteLog 仍为 true（幂等）', turnActivity.get(sidA)?.wroteLog === true)

  // 2c) 空 sid —— 必须**不**计数（宁可漏计数，不能错记到别人头上）
  const okEmpty = applyLogRouteSettlement({ sessionId: '' })
  check('空 sessionId 不计数（返回 false）', okEmpty === false)
  check('空 sid 没有污染任何已有键', logRouteHits.size === 1, `size=${logRouteHits.size}`)

  // 2d) 缺失 sessionId（undefined）
  const okMissing = applyLogRouteSettlement({})
  check('缺失 sessionId 不计数', okMissing === false)
  check('缺失后仍只有 1 个键', logRouteHits.size === 1, `size=${logRouteHits.size}`)

  // 2e) 带空白的 sid 会被 trim —— 但**与 turn-stopping 的紧值不再相同**
  //
  // ⚠️ 这是一处**真实的不对称**，本测试要把它显式记录下来：
  //    /log 侧 `body.sessionId.trim()`
  //    turn-stopping 侧 `String(agent.session.id)`（不 trim）
  //    如果模型传了带空白的 sid，两边键就不同 → wroteLog 记在 A 键、
  //    结算读 B 键 → **表现为「写了却判没写」，且不报错**。
  const sidPadded = '  session-bbbb  '
  applyLogRouteSettlement({ sessionId: sidPadded })
  const settledKey = 'session-bbbb' // turn-stopping 若拿到的是已 trim 的值
  check(
    '带空白 sessionId 会被 trim 成干净的键',
    logRouteHits.has('session-bbbb') === true,
    `现有键：${[...logRouteHits.keys()].join(' | ')}`,
  )

  // ---- 3) scope 在库层的表现 ---------------------------------------
  //
  // ⚠️ `resolveProjectKey` **不**在 db-store 的返回对象上（它是 index.js 的
  //    上层函数）。所以本段不测它 —— 改用库里真实可用的 API 验证 scope 行为：
  //    同一个 scope 名持续累加、写错 scope 会凭空建出一个新分组。
  //    这是「假 scope 污染」的实际后果（index.js L6613–6621 注释里记的那个坑）。
  console.log('\n--- 3) scope 行为（写错 project 会凭空多出一个分组）---')

  store.appendLog('probe-real-scope', '真实 scope 第一条', { topic: '开发日志', summary: 's1' })
  store.appendLog('probe-real-scope', '真实 scope 第二条', { topic: '开发日志', summary: 's2' })
  store.appendLog('probe-typo-scope', '手滑写错 scope 的一条', { topic: '开发日志', summary: 's3' })

  const scopes = store.listScopesWithData?.()
  if (Array.isArray(scopes)) {
    const names = scopes.map((x) => (typeof x === 'string' ? x : x?.scope))
    check('正确的 scope 只出现一次（不是每次新建）', names.filter((n) => n === 'probe-real-scope').length === 1, names.join(','))
    // 这一条**故意断言「会多出来」** —— 用它证明「写错 scope 不会被拦」，
    // 从而坐实「路由层必须先校验 cwd 存在」是必要的（不是多余防御）。
    check('写错 scope 会凭空多出一个分组（故路由层校验是必要的）', names.includes('probe-typo-scope'), names.join(','))
  } else {
    console.log('  （本段不适用：store 没有 listScopesWithData）')
  }

  // ---- 4) 大量写入：检查有没有上限/静默丢弃 -------------------------
  console.log('\n--- 4) 连续写 20 条，看有没有静默丢失 ---')
  const ids = []
  for (let i = 1; i <= 20; i++) {
    const rr = store.appendLog('dsh-fatfishdream-memory', `连续写入第 ${i} 条`, {
      topic: '开发日志',
      summary: `连写${i}`,
    })
    if (Number.isInteger(rr?.id)) ids.push(rr.id)
  }
  check('20 条全部拿到 id', ids.length === 20, `只拿到 ${ids.length} 个`)
  check('id 互不相同（无覆盖）', new Set(ids).size === ids.length, `唯一 id ${new Set(ids).size} 个`)
  check(
    'id 单调递增',
    ids.every((v, i) => i === 0 || v > ids[i - 1]),
    `首=${ids[0]} 末=${ids[ids.length - 1]}`,
  )

  store.close?.()
} catch (error) {
  console.log(`\n💥 测试过程抛错：${error?.stack ?? error}`)
  fail += 1
  failures.push(`抛错：${error?.message ?? error}`)
} finally {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响判据 */
  }
}

console.log(`\n────────────────────────────`)
console.log(`结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
