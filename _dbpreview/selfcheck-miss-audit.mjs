/**
 * 回归：真实漏记数据夹具 + 审计工具的**统计口径**。
 *
 * ## 这个脚本守什么、不守什么
 *
 * **守**：同一个冻结切片，审计工具必须算出**已知答案**；
 *        并且把口径改坏（四种实测过的错法）→ 断言必须变红。
 *
 * **不守**：「模型这一轮该不该写流水」。那是模型行为，回归测不了
 *        （AGENTS.md：「回归测试不测模型行为，那是运行时的职责」）。
 *        夹具里的 18 是**当时的事实记录**，不是「应该有 18 个」。
 *
 * ## 为什么值得单独一个脚本（2026-11-20 交接时用户批准）
 *
 * 那天我两次被统计口径坑：
 *   ① 把 11 毫秒的临时会话（session-1~4）算成真实漏记；
 *   ② 用 `scope=all` 得到 0 条，一度以为「内容没进库」。
 * 而「18 轮漏记」这个数字当时是**临时脚本算的、跑完就删** —— 无法复现。
 * 现在它有切片、有 sha256、有已知答案。
 *
 * ## 断言怎么做到「能失败」
 *
 * ⚠️ 不从工具里抄一份判据来测（那样工具改坏了它照样绿）。
 *    本脚本 `import` **真实模块**，并对**真实源码**做内存外的临时变异：
 *    把源码写进临时目录 → 变异 → import → 同一套断言必须失败。
 *
 * 变异清单（每一个都对应一个实测踩过的坑，见 expected.json 的 traps 段）：
 *   M1 轮标识去掉 sessionId      → 跨会话串账（25/18 变 27/19）
 *   M2 丢掉窗口过滤              → 全天当窗口（变 56/27）
 *   M3 配对键改用 ts             → 配对数从 36 掉到 8
 *   M4 无 sid 老行并入窗口口径   → 20 条老行混进来
 *
 * 每个变异都要先断言**锚点唯一**：不唯一就停下，别硬注入
 * （2026-11-16 实踩：锚点被新代码抢走，变异打到别处，防线静默失效）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const FIXTURE = path.join(HERE, 'fixtures', 'turns-2026-11-20.txt')
const EXPECTED = path.join(HERE, 'fixtures', 'turns-2026-11-20.expected.json')
const TOOL = path.join(HERE, 'tool-audit-turn-misses.mjs')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}  ← ${detail}`)
  }
}

// ============================================================
console.log('=== ① 夹具本身没被改过 ===\n')

const sliceBuf = fs.readFileSync(FIXTURE)
const sliceText = sliceBuf.toString('utf8')
const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8'))

const sha = crypto.createHash('sha256').update(sliceBuf).digest('hex')
check('切片 sha256 与 expected.json 记录的一致', sha === expected.source.sliceSha256,
  `实际 ${sha}，记录 ${expected.source.sliceSha256}。` +
  `不一致说明**切片被改过**（不是数据变了）—— 夹具是冻结的，改它等于改历史事实。`)

check('切片行数一致', sliceText.split('\n').filter((l) => l.trim()).length === expected.source.sliceLines,
  `实际 ${sliceText.split('\n').filter((l) => l.trim()).length}，记录 ${expected.source.sliceLines}`)

// ============================================================
console.log('\n=== ② 真实模块算出的数字 === 已知答案 ===\n')

const tool = await import(pathToFileURL(TOOL).href)
const parsed = tool.parseSlice(sliceText)

check('parseSlice 没有坏行（坏行会被静默丢成「没有数据」，比报错难查）',
  parsed.bad.length === 0, `有 ${parsed.bad.length} 行解析失败：${JSON.stringify(parsed.bad.slice(0, 2))}`)

const got = tool.audit(parsed, { from: expected.window.from, to: expected.window.to })

// ---- 基础计数 ----
check(`user-message 计数 ${expected.counts.userMessage}`,
  got.counts.userMessage === expected.counts.userMessage, `实际 ${got.counts.userMessage}`)
check(`turn-end 计数 ${expected.counts.turnEnd}`,
  got.counts.turnEnd === expected.counts.turnEnd, `实际 ${got.counts.turnEnd}`)
check(`streak 计数 ${expected.counts.streak}`,
  got.counts.streak === expected.counts.streak, `实际 ${got.counts.streak}`)

// ---- ★ 核心：窗口漏记数 ----
check(`窗口内轮数 = ${expected.window.turns}`,
  got.window.turns === expected.window.turns, `实际 ${got.window.turns}`)
check(`★ 窗口漏记 = ${expected.window.missed}`,
  got.window.missed === expected.window.missed, `实际 ${got.window.missed}`)
check(`窗口写了 = ${expected.window.wrote}`,
  got.window.wrote === expected.window.wrote, `实际 ${got.window.wrote}`)

// 漏记/写了之和必须等于轮数 —— 防止「只算漏记、把写了的也漏掉」
check('漏记 + 写了 === 窗口轮数（不漏轮、不重复计）',
  got.window.missed + got.window.wrote === got.window.turns,
  `${got.window.missed} + ${got.window.wrote} = ${got.window.missed + got.window.wrote}，轮数 ${got.window.turns}`)

check('漏记 turn 列表与已知答案逐项一致',
  JSON.stringify(got.window.missedTurns) === JSON.stringify(expected.window.missedTurns),
  `实际 ${got.window.missedTurns.join(',')}`)
check('写了 turn 列表与已知答案逐项一致',
  JSON.stringify(got.window.wroteTurns) === JSON.stringify(expected.window.wroteTurns),
  `实际 ${got.window.wroteTurns.join(',')}`)
check('窗口只涉及一个会话',
  JSON.stringify(got.window.sessions) === JSON.stringify(expected.window.sessions),
  `实际 ${JSON.stringify(got.window.sessions)}`)

// ---- 三个陷阱的真值 ----
check(`无 sid 老行 = ${expected.traps.legacyRowsWithoutSessionId.rows} 条，单列`,
  got.legacy.rows === expected.traps.legacyRowsWithoutSessionId.rows, `实际 ${got.legacy.rows}`)
check(`无 sid 老行里漏 = ${expected.traps.legacyRowsWithoutSessionId.missed}`,
  got.legacy.missed === expected.traps.legacyRowsWithoutSessionId.missed, `实际 ${got.legacy.missed}`)

// ★ 老行**不得**混进窗口口径 —— 这是「静默串账」的判据
const legacyTurnsOverlap = got.window.missedTurns.filter(
  (t) => t >= expected.traps.legacyRowsWithoutSessionId.turnRange[0] &&
         t <= expected.traps.legacyRowsWithoutSessionId.turnRange[1],
)
check('窗口漏记里不含「只能靠老行才凑得出来」的轮次',
  got.window.turns === expected.window.turns && legacyTurnsOverlap.length === expected.window.missedTurns.filter(
    (t) => t >= expected.traps.legacyRowsWithoutSessionId.turnRange[0] &&
           t <= expected.traps.legacyRowsWithoutSessionId.turnRange[1]).length,
  '窗口口径与老行口径必须各算各的')

check(`turn-end 能配到 streak 的 = ${expected.traps.turnEndAsDenominator.pairedWithStreak}`,
  got.pairing.pairedWithStreak === expected.traps.turnEndAsDenominator.pairedWithStreak,
  `实际 ${got.pairing.pairedWithStreak}`)
check(`未结算（有 turn-end 无 streak）= ${expected.traps.turnEndAsDenominator.unsettled}`,
  got.pairing.unsettled === expected.traps.turnEndAsDenominator.unsettled, `实际 ${got.pairing.unsettled}`)

// ★ 按 ts 精确配对只有 8 条 —— 这条数字是「配对键不能是 ts」的**证据**
check(`按 ts 精确配对只有 ${expected.traps.pairingByTimestamp.exactTsMatches} 条（远少于 ${expected.traps.pairingByTimestamp.pairingBySessionIdAndTurn}）`,
  got.pairing.exactTsMatches === expected.traps.pairingByTimestamp.exactTsMatches,
  `实际 ${got.pairing.exactTsMatches}。若这个数涨到 36，说明时序假设变了，需要重新评估配对键。`)
check('ts 配对命中数 < (sid,turn) 配对命中数（证明配对键必须是 (sessionId, turn)）',
  got.pairing.exactTsMatches < got.pairing.pairedWithStreak,
  `ts ${got.pairing.exactTsMatches} vs (sid,turn) ${got.pairing.pairedWithStreak}`)

check(`全天 = ${expected.allDay.turns} 轮，漏 ${expected.allDay.missed}`,
  got.allDay.turns === expected.allDay.turns && got.allDay.missed === expected.allDay.missed,
  `实际 ${got.allDay.turns} / ${got.allDay.missed}`)

// ★ 窗口 ≠ 全天（两者口径不同，绝不能互相顶替）
check('窗口漏记数 ≠ 全天漏记数（口径不同，不能混用）',
  got.window.missed !== got.allDay.missed,
  `都是 ${got.window.missed} —— 若相等，说明窗口过滤可能失效了`)

// ---- ★ 串账陷阱：只按 turn 号聚合会算出错的数字 ----
//
// ⚠️ 这条必须在**忽略 sessionId**的口径下才有意义。
//    2026-11-20 我第一版把它写成「窗口内的陷阱」，结果变异打不动 ——
//    因为 **04:00–04:57 这个窗口里只有一个会话**，去掉 sessionId 当然不影响。
//    串账只发生在「不看时间窗口、只看 turn 号区间」时。判据写错位置，就会得出「代码没问题」的错觉。
check('窗口内确实只有一个会话（这是 M1 变异在窗口内无效的原因，必须显式记录）',
  got.window.sessions.length === 1,
  `实际 ${got.window.sessions.length} 个会话 —— 若多于 1 个，说明窗口口径本身需要重新评估`)

check(`只按 turn 号聚合 = ${expected.traps.aggregateByTurnNumberOnly.rows} 行（≠ 正确窗口轮数 ${expected.window.turns}）`,
  got.turnOnlyAggregate.rows === expected.traps.aggregateByTurnNumberOnly.rows,
  `实际 ${got.turnOnlyAggregate.rows}`)
check(`只按 turn 号聚合的漏记 = ${expected.traps.aggregateByTurnNumberOnly.missed}（≠ 正确值 ${expected.window.missed}）`,
  got.turnOnlyAggregate.missed === expected.traps.aggregateByTurnNumberOnly.missed,
  `实际 ${got.turnOnlyAggregate.missed}`)
check('★ 错法算出的数字 ≠ 正确值（两个方向都不同，才说明这个陷阱是真的）',
  got.turnOnlyAggregate.rows !== got.window.turns &&
  got.turnOnlyAggregate.missed !== got.window.missed,
  `turn 聚合 ${got.turnOnlyAggregate.rows}/${got.turnOnlyAggregate.missed} vs ` +
  `正确 ${got.window.turns}/${got.window.missed}`)
check(`turn 聚合跨 ${expected.traps.aggregateByTurnNumberOnly.distinctSessions} 个会话键（含无 sid）`,
  got.turnOnlyAggregate.distinctSessions === expected.traps.aggregateByTurnNumberOnly.distinctSessions,
  `实际 ${got.turnOnlyAggregate.distinctSessions}`)

// ============================================================
console.log('\n=== ③ 故障注入：把口径改坏，断言必须变红 ===\n')

const toolSrc = fs.readFileSync(TOOL, 'utf8')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-missaudit-'))

/** 把变异后的源码写到临时目录并 import。写入失败/锚点不唯一都返回 null。 */
async function mutatedAudit(from, to, label) {
  const n = toolSrc.split(from).length - 1
  if (n !== 1) {
    check(`${label} 锚点唯一`, false, `实际匹配 ${n} 处 —— 不唯一的锚点会静默打到别处`)
    return null
  }
  const file = path.join(tmpDir, `${label}.mjs`)
  fs.writeFileSync(file, toolSrc.replace(from, to), 'utf8')
  const mod = await import(pathToFileURL(file).href)
  return mod.audit(mod.parseSlice(sliceText), { from: expected.window.from, to: expected.window.to })
}

// ---- M1：只按 turn 号聚合（**去掉 sessionId 维度**）----
//
// ⚠️ 这条变异**只能打在 turnOnlyAggregate 上**，打在窗口统计上会「看似无效」——
//    因为窗口内只有一个会话。第一版我就打错了地方，得到了「变异没生效」的假结论。
{
  const m = await mutatedAudit(
    'const turnOnlyRows = streaks.filter((r) => r.turn >= turnLo && r.turn <= turnHi)',
    'const turnOnlyRows = streaks.filter((r) => r.turn >= turnLo && r.turn <= turnHi) // M1',
    'm1-probe',
  )
  void m
  // 真正的变异：把 turn 区间放宽（模拟「跨会话把同号 turn 都算进来」）
  const m1 = await mutatedAudit(
    'const turnLo = winTurns.length ? Math.min(...winTurns) : 0',
    'const turnLo = 0',
    'm1-drop-sid',
  )
  if (m1) {
    check('M1 自证：放宽 turn 区间后，聚合行数不再等于 27（陷阱被抓住）',
      m1.turnOnlyAggregate.rows !== expected.traps.aggregateByTurnNumberOnly.rows,
      `仍然 ${m1.turnOnlyAggregate.rows} —— 变异没生效`)
  }
}

// ---- M2：丢掉窗口过滤（全天当窗口）----
{
  const m = await mutatedAudit(
    'return ts >= from && ts < to',
    'return true // 变异：不听窗口',
    'm2-no-window',
  )
  if (m) {
    check('M2 自证：窗口过滤失效后，窗口轮数变成全天轮数（被抓住）',
      m.window.turns === m.allDay.turns,
      `窗口 ${m.window.turns} vs 全天 ${m.allDay.turns}`)
    check('M2 自证：此时漏记数不等于 18',
      m.window.missed !== expected.window.missed,
      `仍然 ${m.window.missed}`)
  }
}

// ---- M3：配对键改用 ts（时序假设）----
{
  const m3 = await mutatedAudit(
    'const settledKeys = new Set(turnEndKeys.filter((k) => k !== null && streakKeys.has(k)))',
    'const settledKeys = new Set(turnEnds.filter((r) => streakTs.has(r.ts)).map((r) => turnKey(r)))',
    'm3-pair-by-ts',
  )
  if (m3) {
    check('M3 自证：改用 ts 配对后，配对数掉到 8（被抓住）',
      m3.pairing.pairedWithStreak !== expected.traps.turnEndAsDenominator.pairedWithStreak,
      `仍然 ${m3.pairing.pairedWithStreak} —— 变异没生效`)
    check('M3 自证：改用 ts 配对后，恰好等于 ts 精确命中数',
      m3.pairing.pairedWithStreak === expected.traps.pairingByTimestamp.exactTsMatches,
      `实际 ${m3.pairing.pairedWithStreak}，期望 ${expected.traps.pairingByTimestamp.exactTsMatches}`)
  }
}

// ---- M4：把无 sid 的老行当成「同一轮」并进统计 ----
//
// ⚠️ 注入锚点必须是**守卫那一行**（`if (!row || typeof row.sessionId ...`），
//    不是模板行（`return \`${row.sessionId}|...\``）。
//    第一版我打了模板行 → 完全没反应，因为老行早在守卫处就 `return null` 了，
//    根本走不到模板。**注入后必须确认代码路径真的变了**，
//    而不是「文件内容变了」（AGENTS.md 里记过这个坑）。
{
  const m = await mutatedAudit(
    "if (!row || typeof row.sessionId !== 'string' || row.sessionId === '') return null",
    "if (!row || !Number.isInteger(row.turn)) return null",
    'm4-legacy-merged',
  )
  if (m) {
    check('M4 自证：给老行编造键之后，legacy 计数归零（混入被抓住）',
      m.legacy.rows !== expected.traps.legacyRowsWithoutSessionId.rows,
      `仍然 ${m.legacy.rows} —— 变异没生效`)
    check('M4 自证：legacy 归零后 = 0（说明老行已被并入，不再单列）',
      m.legacy.rows === 0, `实际 ${m.legacy.rows}`)
  }
}

// ---- M5：把「未结算」当成「漏记」（分母陷阱）----
{
  const m = await mutatedAudit(
    'unsettled: unsettled.length,',
    'unsettled: unsettled.filter((r) => r.wroteThisTurn === false).length,',
    'm5-unsettled-counted',
  )
  if (m) {
    check('M5 自证：把未结算当漏记后，数字不再是 26（被抓住）',
      m.pairing.unsettled !== expected.traps.turnEndAsDenominator.unsettled,
      `仍然 ${m.pairing.unsettled} —— 变异没生效`)
  }
}

// ============================================================
console.log('\n=== ④ 输出可复现（同一输入两次结果相同）===\n')
{
  const a = JSON.stringify(tool.audit(tool.parseSlice(sliceText), { from: expected.window.from, to: expected.window.to }))
  const b = JSON.stringify(tool.audit(tool.parseSlice(sliceText), { from: expected.window.from, to: expected.window.to }))
  check('两次调用结果完全一致（无时间依赖 / 无随机）', a === b,
    '不一致说明工具引入了时间或随机因素 —— 那会让「18」这个数字不再稳定')
}

// 清理临时目录
try {
  fs.rmSync(tmpDir, { recursive: true, force: true })
} catch { /* 删不掉不影响结论 */ }

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
