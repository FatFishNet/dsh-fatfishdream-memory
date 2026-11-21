/**
 * 回归测试：**补记写入不许污染主会话的轮次记账**（2026-11-20）。
 *
 * ## 它守的缺陷（当前无任何其他脚本覆盖）
 *
 * 补记从「子代理」重写成「`prepareCall` 直连」之后，POST 到 `/log` 的
 * `sessionId` 变成了**主会话的 sid**。若照常记账，会串两处：
 *
 *   ① `turnActivity[sid].wroteLog = true`
 *      → 下一轮 `turn-stopping` 读到 `wroteThisTurn === true`
 *      → `writeFailStreak` 被清零，**真实漏记被静默抹掉**；
 *   ② `turnLogWrites[sid]` 在补记落库那一刻 +1
 *      → 若这发生在**下一轮进行中**（补记本身要 2~30 秒），
 *        下一轮 `turn/end` 的 `backfill-check` 读到 `wroteCount = 1`
 *      → 判成「这轮写了」→ **真实漏记不再入队**。
 *
 * 合起来就是：**补记越成功，越会把下一轮的漏记判据毒掉**。
 * 而这一切没有任何症状 —— 日志干净、界面正常、health 全绿，
 * 只是那段记忆**不存在**。硬约束 15 把它归为**数据丢失**。
 *
 * 旧方案（子代理）没有这个问题：子代理自己跑 `log.ps1`，sid 是子会话的，
 * 天然落在另一个键上。**这个坑是重构引入的**，迁移时没跟过来。
 *
 * ## 为什么两个方向都必须测
 *
 * 只测「补记不记账」会漏掉**反向错误**：如果拦截条件写成了恒真
 * （比如 `body.backfill !== undefined` 而不是 `=== true`，或者干脆漏了 `!`），
 * 那么**所有**正常写入都不再记账 → 每一轮都被判成「没写」→
 * 补记会对**每一轮**都触发，既烧模型配额又把计数彻底废掉。
 *
 * 所以第 ② 段专门守「正常写入必须照常记账」。
 *
 * ## 断言怎么做到「能失败」
 *
 * 从源码抽出 `/log` 路由里那两段真实记账代码，喂假 Map / 假 body 执行，
 * 不抄一份逻辑进测试。自带第 ④ 段自证：把 `!fromBackfill` 的 `!` 去掉，
 * 第 ① 段必须变红。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const INDEX = path.join(ROOT, 'dsh-fatfishdream-memory', 'index.js')

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

const SRC = fs.readFileSync(INDEX, 'utf8')

/** 剥掉注释，只留代码（判据要求：断言「某段代码不在了」时必须先剥注释）。 */
function stripComments(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//')
      return i >= 0 ? l.slice(0, i) : l
    })
    .join('\n')
}

const CODE = stripComments(SRC)

/**
 * 抽出 `/log` 路由 handler 里「按会话记账」那两段，拼成一个可执行函数。
 *
 * 锚点说明（改源码时要一起改这里，否则第 ⑤ 段会明确报「锚点失配」）：
 *   · 第一段：`const fromBackfill = …` 到第二段结束
 *   · 两段之间夹着大段注释与 `turnOfLog` 声明，原样带上也没关系 ——
 *     它们只用 `sid` / `turnActivity` / `logRouteHits` / `turnLogWrites` /
 *     `currentTurn` / `diag` 这些**会被我们注入**的符号。
 */
function extractAccounting() {
  const startAnchor = "const fromBackfill = body.backfill === true"
  const endAnchor = "diag('log-same-turn-multi'"
  const a = SRC.indexOf(startAnchor)
  if (a < 0) return null
  const b = SRC.indexOf(endAnchor, a)
  if (b < 0) return null
  // endAnchor 之后还有 `… )` 与三层闭合大括号，多取 200 字符足够覆盖
  return SRC.slice(a, b + 200)
}

/**
 * 把抽出的源码套进一个函数里执行。
 *
 * 注入的符号：
 *   · `body`          —— 请求体（决定 fromBackfill）
 *   · `sid`           —— 会话键
 *   · `turnActivity`  —— Map<string, {writes,wroteMemory,wroteLog}>
 *   · `logRouteHits`  —— Map<string, number>
 *   · `turnLogWrites` —— Map<string, {turn, writes}>
 *   · `currentTurn`   —— Map<string, number>
 *   · `r`             —— appendLog 的结果（需要 `.id`）
 *   · `diag`          —— 诊断收集器
 *
 * 源码里 `const fromBackfill = …` 与 `let turnOfLog = …` 会各自声明，
 * 所以只把**执行前**需要的变量做成参数。
 */
function buildRunner(code) {
  // 源码里已声明的东西不能再当参数（重复声明会 SyntaxError）
  const params = ['body', 'sid', 'turnActivity', 'logRouteHits', 'turnLogWrites', 'currentTurn', 'r', 'diag']
  return new Function(...params, `
    ${code}
    return {
      fromBackfill,
      routeHits: logRouteHits.get(sid) ?? 0,
      activity: turnActivity.get(sid) ?? null,
      turnWrites: turnLogWrites.get(sid) ?? null,
      turnOfLog,
      turnWritesOut: turnWrites,
    }
  `)
}

const CODE_SEG = extractAccounting()

// ============================================================
console.log('=== ⓪ 锚点核对：抽不出源码块就必须立刻失败 ===\n')

check('能从源码抽出 /log 的记账块', typeof CODE_SEG === 'string' && CODE_SEG.length > 300,
  CODE_SEG === null ? '锚点失配 —— 源码结构变了，本脚本已失效' : `长度 ${CODE_SEG?.length}`)

// 抽支点先自证：块里必须真的包含我们要测的那两处判断
if (typeof CODE_SEG === 'string') {
  check('抽出的块含 fromBackfill 判定', CODE_SEG.includes('const fromBackfill = body.backfill === true'), '')
  check('抽出的块含 !fromBackfill 守卫（记账段）',
    /if \(sid !== '' && !fromBackfill\)/.test(CODE_SEG), '')
  check('抽出的块含 turnLogWrites 推进', CODE_SEG.includes('turnLogWrites.set'), '')
}

if (typeof CODE_SEG !== 'string') {
  // 抽不到就别往下跑，直接以失败收场，避免「0 条断言 = 0 失败」的假绿
  console.log('\n' + '─'.repeat(70))
  console.log('❌ 抽取失败，后续断言无法建立 —— 本脚本视为失败')
  process.exit(1)
}

const run = buildRunner(CODE_SEG)

/** 造一套干净的记账状态。 */
function freshState(prevStreakTurn = 5) {
  return {
    turnActivity: new Map(),
    logRouteHits: new Map(),
    turnLogWrites: new Map([['s1', { turn: prevStreakTurn, writes: 0 }]]),
    currentTurn: new Map([['s1', prevStreakTurn]]),
  }
}

/** 跑一次，返回记账结果。 */
function runOnce({ backfill, sid = 's1', turn = 5 }) {
  const st = freshState(turn)
  const diags = []
  const out = run(
    backfill === undefined ? {} : { backfill },
    sid,
    st.turnActivity,
    st.logRouteHits,
    st.turnLogWrites,
    st.currentTurn,
    { id: 999 },
    (name, payload) => diags.push([name, payload]),
  )
  return { out, diags }
}

// ============================================================
console.log('\n=== ① 补记写入：三处记账一个都不许动 ===\n')

{
  const { out, diags } = runOnce({ backfill: true })

  check('fromBackfill 被正确识别为 true', out.fromBackfill === true, String(out.fromBackfill))

  // ★ 核心断言 ①：logRouteHits 不许涨
  check('补记写入 → logRouteHits 不涨（保持 0）',
    out.routeHits === 0, `实际 ${out.routeHits}`)

  // ★ 核心断言 ②：turnActivity 不许被创建/置位
  check('补记写入 → turnActivity 保持为 null（没被创建）',
    out.activity === null, JSON.stringify(out.activity))

  // ★ 核心断言 ③：turnLogWrites 不许 +1
  check('补记写入 → turnLogWrites.writes 保持 0',
    out.turnWrites !== null && out.turnWrites.writes === 0,
    JSON.stringify(out.turnWrites))

  // ★ 核心断言 ④：响应里的 turn / turnWrites 必须是 null
  //   （实测 12:56:41 那条 log-written 的 turn 和 turnWrites 都是 null，就是这个形态）
  check('补记写入 → turnOfLog 为 null', out.turnOfLog === null, String(out.turnOfLog))
  check('补记写入 → 响应的 turnWrites 为 null', out.turnWritesOut === null, String(out.turnWritesOut))

  // 但必须留一条可审计的诊断（拦的是计数，不是留痕）
  check('补记写入 → 输出 log-from-backfill 诊断（可审计）',
    diags.some(([n]) => n === 'log-from-backfill'), JSON.stringify(diags.map((d) => d[0])))
}

// ============================================================
console.log('\n=== ② 正常写入：三处记账必须照常生效（反向守卫）===\n')

{
  // ★ 不带 backfill 字段 —— 这是模型正常 POST 的形态
  const { out, diags } = runOnce({ backfill: undefined })

  check('正常写入 → fromBackfill 为 false', out.fromBackfill === false, String(out.fromBackfill))

  // ★ 核心断言：logRouteHits 必须 +1
  //
  // 为什么这条和 ① 同等重要：如果拦截条件写成恒真
  // （`body.backfill !== undefined` / 漏了 `!` / 干脆把整段包进 `if (false)`），
  // 那么**所有**写入都不再记账 → 每轮都被判成「没写」→
  // 补记对每一轮都触发，既烧配额又把计数彻底废掉。
  // 没有这条，① 全绿而系统已经废了。
  check('正常写入 → logRouteHits +1（从 0 变 1）',
    out.routeHits === 1, `实际 ${out.routeHits}`)

  // ★ 核心断言：turnActivity.wroteLog 必须置 true
  check('正常写入 → turnActivity.wroteLog = true',
    out.activity !== null && out.activity.wroteLog === true,
    JSON.stringify(out.activity))

  // ★ 核心断言：turnLogWrites 必须 +1
  check('正常写入 → turnLogWrites.writes 从 0 变 1',
    out.turnWrites !== null && out.turnWrites.writes === 1,
    JSON.stringify(out.turnWrites))

  // 响应里必须带上轮次信息（调用方靠它自查「本轮第几条」）
  check('正常写入 → turnOfLog 不为 null', out.turnOfLog !== null, String(out.turnOfLog))
  check('正常写入 → 响应的 turnWrites = 1', out.turnWritesOut === 1, String(out.turnWritesOut))

  // 正常写入**不该**留 backfill 诊断（否则日志里分不清是谁写的）
  check('正常写入 → 不输出 log-from-backfill 诊断',
    diags.some(([n]) => n === 'log-from-backfill') === false,
    JSON.stringify(diags.map((d) => d[0])))
}

// ============================================================
console.log('\n=== ③ 边界：backfill 只认严格的 true ===\n')

{
  // 为什么必须严格 `=== true`：JSON 里 `"backfill": "true"`（字符串）
  // 或 `"backfill": 1` 这类形态若被当作真值，会出现「谁都能宣布自己是补记」，
  // 于是任何调用方都能绕过记账 —— 那等于这道闸门不存在。
  for (const [label, val] of [
    ['字符串 "true"', 'true'],
    ['数字 1', 1],
    ['字符串 "1"', '1'],
  ]) {
    const { out } = runOnce({ backfill: val })
    check(`backfill=${label} 不算补记（fromBackfill=false）`,
      out.fromBackfill === false, String(out.fromBackfill))
    check(`backfill=${label} → 仍然正常记账（routeHits=1）`,
      out.routeHits === 1, `实际 ${out.routeHits}`)
  }

  // 反过来：严格的布尔 true 才算
  const { out } = runOnce({ backfill: true })
  check('backfill=true（布尔）才算补记', out.fromBackfill === true, String(out.fromBackfill))
}

// ============================================================
console.log('\n=== ④ 自证：把守卫改坏，① 或 ② 必须变红 ===\n')

{
  // 自证 1：去掉 `!fromBackfill` 的 `!`（补记也会记账）
  const noBang = CODE_SEG.replace(
    "if (sid !== '' && !fromBackfill) {\n              const rec = turnActivity.get(sid)",
    "if (sid !== '' && fromBackfill) {\n              const rec = turnActivity.get(sid)",
  )
  check('自证：!fromBackfill 的注入锚点唯一（改得到）',
    noBang !== CODE_SEG, '锚点没匹配上 → 下面的自证无效')
  if (noBang !== CODE_SEG) {
    const brokenRun = buildRunner(noBang)
    const st = freshState(5)
    const broken = brokenRun(
      { backfill: true }, 's1', st.turnActivity, st.logRouteHits, st.turnLogWrites, st.currentTurn,
      { id: 999 }, () => {},
    )
    check('自证：把 `!` 去掉后，① 的「logRouteHits 不涨」断言会红',
      broken.routeHits !== 0, `错误实现返回 ${broken.routeHits}`)
    check('自证：把 `!` 去掉后，① 的「turnActivity 保持 null」断言会红',
      broken.activity !== null, JSON.stringify(broken.activity))
  }

  // 自证 2：把判定放宽成 `body.backfill !== undefined`（谁都能宣布自己是补记）
  const loose = CODE_SEG.replace(
    'const fromBackfill = body.backfill === true',
    'const fromBackfill = body.backfill !== undefined',
  )
  check('自证：=== true 的注入锚点唯一', loose !== CODE_SEG, '锚点没匹配上')
  if (loose !== CODE_SEG) {
    const brokenRun2 = buildRunner(loose)
    const st = freshState(5)
    const broken2 = brokenRun2(
      { backfill: 'true' }, 's1', st.turnActivity, st.logRouteHits, st.turnLogWrites, st.currentTurn,
      { id: 999 }, () => {},
    )
    check('自证：放宽成 !== undefined 后，③ 的「字符串不算补记」断言会红',
      broken2.fromBackfill === true, `错误实现返回 ${broken2.fromBackfill}`)
  }

  // 自证 3：把整段记账包进 `if (false)`（等于彻底不记账）
  const disabled = CODE_SEG.replace(
    "if (sid !== '' && !fromBackfill) {\n              const rec = turnActivity.get(sid)",
    "if (false) {\n              const rec = turnActivity.get(sid)",
  )
  check('自证：整体失能的注入锚点唯一', disabled !== CODE_SEG, '锚点没匹配上')
  if (disabled !== CODE_SEG) {
    const brokenRun3 = buildRunner(disabled)
    const st = freshState(5)
    const broken3 = brokenRun3(
      {}, 's1', st.turnActivity, st.logRouteHits, st.turnLogWrites, st.currentTurn,
      { id: 999 }, () => {},
    )
    check('自证：记账整体失能后，② 的「正常写入 routeHits=1」断言会红',
      broken3.routeHits === 0, `错误实现返回 ${broken3.routeHits}`)
  }
}

// ============================================================
// ⑤ 接线：补记那侧必须真的传 backfill:true
// ============================================================
console.log('\n=== ⑤ 接线：runBackfillTask 必须真的传 backfill:true ===\n')

{
  check('源码（非注释）里有 backfill: true', CODE.includes('backfill: true'),
    '没传 → /log 不知道这是补记，记账照旧污染')

  // 位置核对：必须出现在 POST 的 body 里，而不是别的地方
  const rbt = SRC.indexOf('const runBackfillTask = ')
  check('能找到 runBackfillTask', rbt > 0)
  if (rbt > 0) {
    // ⚠️ 窗口不能用固定的 3000。2026-11-20 加了一堆注释后，
    //    `backfill: true` 距函数头已有 **1780 字符**（剥注释后），
    //    而下一轮改动只会更长 —— 固定窗口会让这条断言**假红**（实测已发生）。
    //    改用「到下一个顶层函数为止」，与函数边界同生共死。
    const nextTop = (() => {
      const candidates = [
        SRC.indexOf('\n  const pumpBackfill = ', rbt),
        SRC.indexOf('\n  const enqueueBackfill = ', rbt),
        SRC.indexOf('\n  safeOn(', rbt),
      ].filter((n) => n > rbt)
      return candidates.length > 0 ? Math.min(...candidates) : rbt + 12000
    })()
    const tail = SRC.slice(rbt, nextTop)
    check('backfill:true 出现在 runBackfillTask 的 POST body 里',
      tail.includes('backfill: true') && tail.includes('/api/dsh-memory/log'),
      `窗口 ${tail.length} 字符，位置不对 → 这条标记可能没生效`)
  }

  // 反向：不许别的地方也传 backfill:true（否则任何调用方都能绕过记账）
  const occurrences = CODE.split('backfill: true').length - 1
  check('backfill:true 在代码里只出现 1 次（唯一调用点）',
    occurrences === 1, `实际 ${occurrences} 次`)
}

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
