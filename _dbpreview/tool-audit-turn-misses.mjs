/**
 * 审计工具：从**冻结的日志切片**统计「某段时间里哪些轮次没写流水」。
 *
 * ## 为什么要有这个文件（2026-11-20）
 *
 * 交接单里那句「18 轮漏记」是我**用临时脚本算的，跑完就删了**。
 * 于是那个数字**无法复现** —— 下次谁觉得可疑，都得重新手写一遍统计，
 * 而重写出来的数字一旦不同，谁也说不清是「数据变了」还是「口径变了」。
 *
 * 当天我被统计口径坑过两次：
 *   ① 把 11 毫秒的临时会话（session-1~4）算成真实漏记；
 *   ② 用 `scope=all` 查跨项目得到 0 条，一度以为「内容没进库」（正确写法是 `all=1`）。
 *
 * ## 四条硬规则（每一条都对应一个实测过的坑）
 *
 * 1. **轮的标识是 `(sessionId, turn)`，不是 `turn`，也不是 `ts`。**
 *    `turn` 每个会话各自从 1 数起 → 跨会话按 turn 聚合必然串账。
 *    实测：按 turn 号聚合 31..55 得 27 行 / 漏 19，而正确值是 25 / 18。
 *    按 ts 配对同样不行：62 条 turn-end 里只有 8 条与 streak 同 ts，最大偏差 59ms。
 *
 * 2. **无 `sessionId` 的老行单列，不并进任何会话口径。**
 *    该字段 2026-11-20 03:35 才加上，之前 20 行没有。它们无法归属 → 只能报出来。
 *
 * 3. **分母只能来自 streak 行本身，不能拿 turn-end 减。**
 *    62 − 36 = 26 轮是真的**没有结算记录**，不是「漏记」。把两者混起来会说谎。
 *
 * 4. **窗口按 streak 行的 ts 过滤。**
 *    按 turn 号过滤窗口等于假设 turn 号与时间同序 —— 多会话并发时不成立。
 *
 * ## 用法
 *
 *     node _dbpreview/tool-audit-turn-misses.mjs \
 *       --slice _dbpreview/fixtures/turns-2026-11-20.txt \
 *       --from 2026-11-20T04:00:00 --to 2026-11-20T04:57:00 [--json]
 *
 * 不带参数时默认就是上面那套夹具 + 窗口。
 *
 * ⚠️ 本工具**不碰 memory.db**、不联网、只读切片文件。
 * ⚠️ 它**不进 run-all**（工具不是回归）。守它的是 `selfcheck-miss-audit.mjs`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

/** 日志行：`<ts> [<tag>] <json>`。其余行一律忽略（切片里本来就只有三种标签）。 */
export const LOG_LINE_RE = /^(\S+) \[([a-z0-9-]+)\] +(\{.*\})$/

/**
 * 解析切片文本 → { users, turnEnds, streaks }。
 *
 * 坏行**不静默跳过**：记进 `bad` 并让调用方看得见。
 * （本项目的老毛病：解析失败静默当「没有数据」，比报错难查十倍。）
 */
export function parseSlice(text) {
  const users = []
  const turnEnds = []
  const streaks = []
  const bad = []
  for (const [i, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue
    const m = LOG_LINE_RE.exec(line)
    if (!m) {
      bad.push({ line: i + 1, reason: '不符合 <ts> [<tag>] <json> 形状', text: line.slice(0, 80) })
      continue
    }
    const [, ts, tag, body] = m
    let data = null
    try {
      data = JSON.parse(body)
    } catch (e) {
      bad.push({ line: i + 1, reason: `JSON 解析失败：${e.message}`, text: line.slice(0, 80) })
      continue
    }
    if (tag === 'user-message') users.push({ ts, ...data })
    else if (tag === 'turn-end-hit') turnEnds.push({ ts, ...data })
    else if (tag === 'write-streak-check') streaks.push({ ts, ...data })
  }
  return { users, turnEnds, streaks, bad }
}

/**
 * 轮的稳定标识。
 *
 * ⚠️ 没有 sessionId 时**返回 null**，而不是退回 `|${turn}` ——
 * 那会把 20 条老行悄悄并成「同一轮」，正是规则 2 要防的事。
 */
export function turnKey(row) {
  if (!row || typeof row.sessionId !== 'string' || row.sessionId === '') return null
  if (!Number.isInteger(row.turn)) return null
  return `${row.sessionId}|${row.turn}`
}

/** 窗口过滤：**只看 streak 行自己的 ts**（规则 4）。半开区间 [from, to)。 */
export function inWindow(ts, from, to) {
  return ts >= from && ts < to
}

/**
 * 主统计。
 *
 * @returns {{
 *   counts: object, window: object, legacy: object,
 *   pairing: object, allDay: object, bad: Array
 * }}
 */
export function audit(parsed, { from, to }) {
  const { users, turnEnds, streaks } = parsed

  // --- 全天 ---
  const allDayMissed = streaks.filter((r) => r.wroteThisTurn === false)

  // --- 陷阱统计：**忽略 sessionId**，按 turn 号范围跨会话聚合 ---
  //
  // 2026-11-20 实测的错法：只按 turn 号筛（31..55），不管它属于哪个会话。
  // 结果 27 行 / 漏 19，而正确值是 25 / 18 —— 多出来的正是「别的会话也用同一个 turn 号」。
  //
  // ⚠️ 这个统计**故意保留**，因为它是「为什么不能用 turn 号聚合」的**证据**，
  //    而不是一个可用结果。窗口统计绝不使用它。
  //
  // ⚠️ 但要记准：**在 04:00–04:57 这个窗口里只有一个会话**，
  //    所以窗口统计本身并不受 sessionId 影响 —— 串账只发生在「不看窗口、只看 turn 号」时。
  //    （我第一版把这条写成了窗口内的陷阱，实测发现变异打不动，是判据写错了。）
  const winTurns = streaks.filter((r) => inWindow(r.ts, from, to)).map((r) => r.turn)
  const turnLo = winTurns.length ? Math.min(...winTurns) : 0
  const turnHi = winTurns.length ? Math.max(...winTurns) : 0
  const turnOnlyRows = streaks.filter((r) => r.turn >= turnLo && r.turn <= turnHi)

  // --- 窗口：按 streak 自己的 ts 过滤 ---
  const win = streaks.filter((r) => inWindow(r.ts, from, to))
  const winWrote = win.filter((r) => r.wroteThisTurn !== false)
  const winMissed = win.filter((r) => r.wroteThisTurn === false)

  // --- 老行（无 sessionId）：单列，绝不并进窗口 ---
  const legacy = streaks.filter((r) => turnKey(r) === null)

  // --- 配对：键是 (sessionId, turn)，不是 ts ---
  //
  // ⚠️ `streakTs` 必须定义在 `settledKeys` **之前**：
  //    自证的 M3 变异会把 settledKeys 改成「按 ts 配对」，
  //    若 streakTs 定义在后面就会抛 TDZ：
  //    `ReferenceError: Cannot access 'streakTs' before initialization`。
  //    **`node --check` 查不出 TDZ**（2026-11-18 实踩过同款，只在运行时炸），
  //    而它的表现是「自证段崩了」，很容易被误读成「测试脚本自己坏了」。
  const streakTs = new Set(streaks.map((r) => r.ts))
  const exactTsMatches = turnEnds.filter((r) => streakTs.has(r.ts)).length

  const streakKeys = new Set(streaks.map(turnKey).filter((k) => k !== null))
  const turnEndKeys = turnEnds.map(turnKey)
  const settledKeys = new Set(turnEndKeys.filter((k) => k !== null && streakKeys.has(k)))
  const unsettled = turnEnds.filter((r) => {
    const k = turnKey(r)
    return k !== null && !streakKeys.has(k)
  })

  return {
    counts: {
      userMessage: users.length,
      turnEnd: turnEnds.length,
      streak: streaks.length,
    },
    window: {
      from,
      to,
      sessions: [...new Set(win.map((r) => r.sessionId).filter(Boolean))],
      turns: win.length,
      wrote: winWrote.length,
      missed: winMissed.length,
      wroteTurns: winWrote.map((r) => r.turn).sort((a, b) => a - b),
      missedTurns: winMissed.map((r) => r.turn).sort((a, b) => a - b),
    },
    turnOnlyAggregate: {
      turnRange: [turnLo, turnHi],
      rows: turnOnlyRows.length,
      missed: turnOnlyRows.filter((r) => r.wroteThisTurn === false).length,
      distinctSessions: new Set(
        turnOnlyRows.map((r) => (r.sessionId === undefined ? '(nosid)' : r.sessionId)),
      ).size,
    },
    legacy: {
      rows: legacy.length,
      missed: legacy.filter((r) => r.wroteThisTurn === false).length,
      turnRange: legacy.length
        ? [Math.min(...legacy.map((r) => r.turn)), Math.max(...legacy.map((r) => r.turn))]
        : null,
    },
    pairing: {
      turnEndRows: turnEnds.length,
      pairedWithStreak: settledKeys.size,
      unsettled: unsettled.length,
      exactTsMatches,
    },
    allDay: {
      turns: streaks.length,
      missed: allDayMissed.length,
    },
    bad: parsed.bad,
  }
}

// ---------------------------------------------------------------- CLI
function argOf(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const slicePath = argOf('--slice', path.join(HERE, 'fixtures', 'turns-2026-11-20.txt'))
  const from = argOf('--from', '2026-11-20T04:00:00')
  const to = argOf('--to', '2026-11-20T04:57:00')
  const wantJson = process.argv.includes('--json')

  let text
  try {
    text = fs.readFileSync(path.resolve(REPO, slicePath), 'utf8')
  } catch (e) {
    console.error(`❌ 读不到切片：${slicePath}\n   ${e.message}`)
    process.exit(1)
  }

  const result = audit(parseSlice(text), { from, to })
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`切片：${path.relative(REPO, path.resolve(REPO, slicePath))}`)
    console.log(`窗口：${from} → ${to}（半开区间）\n`)
    console.log(`日志行：user-message ${result.counts.userMessage} / turn-end ${result.counts.turnEnd} / streak ${result.counts.streak}`)
    console.log(`窗口内：${result.window.turns} 轮，写了 ${result.window.wrote}，**漏 ${result.window.missed}**`)
    console.log(`  漏记 turn：${result.window.missedTurns.join(',')}`)
    console.log(`  写了 turn：${result.window.wroteTurns.join(',')}`)
    console.log(`  会话：${result.window.sessions.join(',') || '(无)'}`)
    console.log(`\n无 sessionId 的老行：${result.legacy.rows} 行，其中漏 ${result.legacy.missed}` +
      `（turn ${result.legacy.turnRange?.join('..') ?? '-'}）—— 单列，不入窗口`)
    console.log(`\n❌ 错法（仅留作证据，不要用）：只按 turn 号 ${result.turnOnlyAggregate.turnRange.join('..')} 聚合 → ` +
      `${result.turnOnlyAggregate.rows} 行 / 漏 ${result.turnOnlyAggregate.missed}，` +
      `跨 ${result.turnOnlyAggregate.distinctSessions} 个会话` +
      `（正确值 ${result.window.turns} / ${result.window.missed}）`)
    console.log(`配对：turn-end ${result.pairing.turnEndRows} 行，能配到 streak 的 ${result.pairing.pairedWithStreak}` +
      `，未结算 ${result.pairing.unsettled}`)
    console.log(`  （按 ts 精确配对只有 ${result.pairing.exactTsMatches} 条 → 配对键必须是 (sessionId, turn)）`)
    console.log(`\n全天：${result.allDay.turns} 轮，漏 ${result.allDay.missed}`)
    if (result.bad.length) {
      console.log(`\n⚠️ 有 ${result.bad.length} 行解析失败：`)
      for (const b of result.bad.slice(0, 5)) console.log(`   第 ${b.line} 行：${b.reason}`)
    }
  }
}
