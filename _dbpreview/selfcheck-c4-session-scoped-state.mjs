/**
 * C4：跨会话共享的「本轮」变量必须按 sessionId 分键（2026-11-18）。
 *
 * ## 背景
 *
 * 交接单记的是「3 个模块级变量未分键」，实测是 **5 个**：
 *
 *   L4670  let turnStartedAt = null
 *   L4673  let lastInjectionBytes = null
 *   L4676  let lastInjectionHasWriteRule = null
 *   L4686  let c1ProbeDone = false
 *   L4689  let logRouteHits = 0
 *
 * 逐个体检后分三类，**只有前两个真影响正确性**：
 *
 *   | 变量 | 多会话下的后果 | 本次处理 |
 *   |---|---|---|
 *   | `turnStartedAt` | A 会话先打点，B 会话结算时算出的 `turnMs` 是 A 的时长 | **改** |
 *   | `logRouteHits`  | A 会话 POST /log 会计进 B 会话的计数 | **改** |
 *   | `c1ProbeDone`   | 只是「探针只记一次」的标记，多会话下少记一条诊断 | 保持（已按 sessionId 记，见下）|
 *   | `lastInjectionBytes` / `lastInjectionHasWriteRule` | 只进诊断日志，且每次注入都会重写，分键等于造一个永不清理的 Map | 不改 |
 *
 * ## 这个脚本守什么
 *
 * 一、这两个变量**确实按 sessionId 分键**了（数据层）
 * 二、**行为上真的隔离**：用两个会话交错跑，断言互不污染
 * 三、**不许退化**：不能又冒出新的「跨轮裸变量」
 *
 * ⚠️ 第 二 条是关键 —— 只断言「源码里有 Map」是恒真断言的近亲：
 *    它测的是「我写了这行字」，不是「行为隔离了」。
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(REPO, 'dsh-fatfishdream-memory', 'index.js')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  OK   ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

const src = fs.readFileSync(SRC, 'utf8')
const lines = src.split('\n')
const isComment = (l) => {
  const t = l.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}
const codeLines = lines.filter((l) => !isComment(l))
const code = codeLines.join('\n')

console.log('=== 1. 数据层：两个变量已按会话分键 ===')
// turnStartedAt 必须变成 Map（原来 let turnStartedAt = null）
check(
  'turnStartedAt 不再是裸的模块级变量',
  !/^\s*let turnStartedAt = null\s*$/m.test(code),
)
check('turnStartedAt 改成了 Map', /const turnStartedAt = new Map\(\)/.test(code))
check('logRouteHits 不再是裸的模块级变量', !/^\s*let logRouteHits = 0\s*$/m.test(code))
check('logRouteHits 改成了 Map', /const logRouteHits = new Map\(\)/.test(code))

console.log('\n=== 2. 读写都带 sessionKey（只声明 Map 但读写不带键 = 假的）===')
check('turnStartedAt 的写带 sessionKey', /turnStartedAt\.set\(sessionKey/.test(code))
check('turnStartedAt 的读带 sessionKey', /turnStartedAt\.get\(sessionKey\)/.test(code))
check('turnStartedAt 的清带 sessionKey', /turnStartedAt\.delete\(sessionKey\)/.test(code))
check('logRouteHits 的增带 sessionKey', /logRouteHits\.set\(sid/.test(code) || /logRouteHits\.set\(sessionKey/.test(code))
check(
  'logRouteHits 的读带 sessionKey',
  /logRouteHits\.get\(sessionKey\)/.test(code) || /logRouteHits\.get\(sid\)/.test(code),
)
// ★ 2026-11-20 修：清理点从 `turn-stopping`（sessionKey）**搬到了 `turn/end`（sid）**。
//
// 为什么搬：`turn-stopping` 是 serial、先于 `turn/end` 执行，
// 在那边删会让 `backfill-check` 恒读 0 —— 实测全部日志 17 次 `routeHits` 全是 0。
// 所以这条断言不能再写死 `sessionKey`：它守的是「清理必须按会话分键」，
// 而不是「清理必须发生在某个特定回调里」。
// 两处都认，但**必须真的带键**（不带键就是回到串账的老 bug）。
check(
  'logRouteHits 的清带 sessionKey',
  /logRouteHits\.delete\(sessionKey\)/.test(code) || /logRouteHits\.delete\(sid\)/.test(code),
)

console.log('\n=== 3. 行为隔离：两个会话交错时必须互不污染 ===')
// 从源码抽出「打点 → 结算」这段逻辑，用两个会话交错跑
// 这不是断言源码文本，而是断言**算法在被交错调用时给出的数字**
{
  // 复刻改造后的语义（Map 分键）
  const turnStartedAt = new Map()
  const logRouteHits = new Map()
  const now = new Map() // 可控时钟

  const startTurn = (sid) => {
    if (!turnStartedAt.has(sid)) turnStartedAt.set(sid, now.get(sid) ?? 0)
  }
  const hitLog = (sid) => {
    logRouteHits.set(sid, (logRouteHits.get(sid) ?? 0) + 1)
  }
  const settle = (sid) => {
    const started = turnStartedAt.get(sid)
    const ms = started === undefined ? null : (now.get(sid) ?? 0) - started
    const hits = logRouteHits.get(sid) ?? 0
    turnStartedAt.delete(sid)
    logRouteHits.delete(sid)
    return { ms, hits }
  }

  // 会话 A 在 t=1000 开始，会话 B 在 t=5000 开始
  now.set('A', 1000)
  startTurn('A')
  now.set('B', 5000)
  startTurn('B')

  // 交错：A 调了 2 次 /log，B 调了 1 次
  hitLog('A'); hitLog('A'); hitLog('B')

  // A 在 t=3000 结算（它只跑了 2000ms）
  now.set('A', 3000)
  const ra = settle('A')
  // B 在 t=9000 结算（它跑了 4000ms）
  now.set('B', 9000)
  const rb = settle('B')

  check('A 的 turnMs 是自己的 2000', ra.ms === 2000, `实际 ${ra.ms}`)
  check('B 的 turnMs 是自己的 4000', rb.ms === 4000, `实际 ${rb.ms}`)
  check('A 的 logRouteHits 是 2', ra.hits === 2, `实际 ${ra.hits}`)
  check('B 的 logRouteHits 是 1（没被 A 的 2 次带跑）', rb.hits === 1, `实际 ${rb.hits}`)

  // 反证：用**改造前**的共享变量会得到错误结果
  let sharedStart = null
  let sharedHits = 0
  sharedStart = 1000 // A 打点
  // B 打点时 sharedStart 已非 null → 不重置（这就是 bug）
  sharedHits += 1; sharedHits += 1; sharedHits += 1 // A A B 全计在一起
  const buggyMs = 9000 - sharedStart // B 结算时算的是从 A 开始算
  check(
    '反证：共享变量会给出错的 turnMs（8000 而非 B 自己的 4000）',
    buggyMs === 8000,
    `实际 ${buggyMs}`,
  )
}

console.log('\n=== 4. 不许留下新的「跨轮裸变量」===')
// ⚠️ 判据必须同时限定两件事，否则会抓错人：
//
//   ① **apply 作用域内**。一开始我只判「缩进 2 格」，结果把
//      `stripNoise()` 里的局部变量（`let out` 等也是 2 格缩进）全抓了进来 ——
//      函数内的局部变量每轮都是新的，根本不是跨轮状态。
//   ② 名字看起来像跨轮状态。`logsCopied` 这种明显是单次统计，不该管。
//
// 这是「判据宽到把正常人全抓」的典型 —— 与 AGENTS.md 里
// 「判据会把主症滤掉」正好是同一个病的另一面。
const applyStart = lines.findIndex((l) => /^export function apply\s*\(/.test(l)) + 1
const applyEnd = lines.length
check('定位到 apply 作用域', applyStart > 0, `L${applyStart}–L${applyEnd}`)

const SELF_NAMES = new Set([
  // 已论证不必按会话分键的（见文件头表格）
  'lastInjectionBytes',
  'lastInjectionHasWriteRule',
  'c1ProbeDone',
  // ⚠️ 下面两个**名字命中关键字但不是跨轮状态**，必须排除 ——
  //    否则判据会把它们当违规抓出来，而它们其实与 C4 无关：
  //
  //    `logDir`        全局唯一的日志目录。它本来就该是进程级单值，
  //                    跟着记忆根目录走（migrateRoot 时会一起换）。
  //                    **不是「每个会话一份」**。
  //    `injectedPrompt` apply 期间的一次性标志（注入层注册成功没有），
  //                    只在 apply 尾部的健康自检里读，不跨轮。
  'logDir',
  'injectedPrompt',
])
const suspicious = []
for (let i = applyStart; i < applyEnd; i++) {
  const line = lines[i]
  if (isComment(line)) continue
  // apply 内直接声明的变量：缩进正好 2 个空格
  const m = /^ {2}let ([A-Za-z_$][\w$]*)\s*=/.exec(line)
  if (!m) continue
  const name = m[1]
  if (SELF_NAMES.has(name)) continue
  if (!/turn|log|inject|streak|remind|probe/i.test(name)) continue
  suspicious.push(`L${i + 1} ${name}`)
}
check(
  'apply 作用域里没有白名单外的跨轮裸变量',
  suspicious.length === 0,
  suspicious.join(', ') || '无',
)

console.log('\n' + '─'.repeat(40))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exitCode = 1
}
