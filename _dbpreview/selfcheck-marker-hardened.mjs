/**
 * 验证加固后的标记正则。
 *
 * 核心场景：正文里出现「完整标记示例」时不应被当成真标记。
 * 同时必须保证所有正常写法仍然命中（否则记忆就收不到了）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OLD = /<!--mem-(log|fact|note|fix)(?:[ \t]+topic=([^\n]+))?\n([\s\S]*?)-->/g
const NEW = /^<!--mem-(log|fact|note|fix)(?:[ \t]+topic=([^\n]+))?\n([\s\S]*?)-->/gm

function parse(re, text) {
  return [...text.matchAll(re)].map((m) => ({
    kind: m[1],
    topic: typeof m[2] === 'string' && m[2].trim() !== '' ? m[2].trim() : null,
    body: String(m[3] ?? '').trim(),
  }))
}

const cases = [
  {
    name: '正常：行首标记带 topic',
    text: '<!--mem-log topic=开发日志\n- 做完了\n-->',
    shouldMatch: true,
  },
  {
    name: '正常：行首标记无 topic',
    text: '<!--mem-log\n- 做完了\n-->',
    shouldMatch: true,
  },
  {
    name: '正常：前面有正文，标记在其后单独起行',
    text: '一些说明。\n\n<!--mem-note topic=技术讨论\n- 结论\n-->',
    shouldMatch: true,
  },
  {
    name: '事故复现：正文里的示例（前面有反引号）',
    text: '用法是 `<!--mem-log topic=xxx` 这样，后面还有很多说明。',
    shouldMatch: false,
  },
  {
    name: '事故复现：示例在句子中间',
    text: '要标注就用 <!--mem-log topic=开发日志 开头，然后写正文。',
    shouldMatch: false,
  },
  {
    name: '边界：标记前有缩进（不该命中）',
    text: '   <!--mem-log\n- 缩进的\n-->',
    shouldMatch: false,
  },
]

let pass = 0
let fail = 0

for (const c of cases) {
  const oldHits = parse(OLD, c.text).length
  const newHits = parse(NEW, c.text).length
  const ok = c.shouldMatch ? newHits === 1 : newHits === 0

  if (ok) {
    pass++
    console.log(`  OK   ${c.name}`)
    if (!c.shouldMatch && oldHits > 0) {
      console.log(`       （旧正则命中 ${oldHits} 次 → 正是事故原因，新正则已挡住）`)
    }
  } else {
    fail++
    console.log(`  FAIL ${c.name}`)
    console.log(`       期望 ${c.shouldMatch ? '命中 1 次' : '命中 0 次'}，旧=${oldHits} 新=${newHits}`)
  }
}

// 多标记场景
const multi = `<!--mem-log topic=技术讨论
- A
-->

正文说明

<!--mem-note topic=开发日志
- B
-->`
const multiHits = parse(NEW, multi)
const multiOk = multiHits.length === 2 && multiHits[0].kind === 'log' && multiHits[1].kind === 'note'
if (multiOk) {
  pass++
  console.log('  OK   多标记混排仍正确解析 2 条')
} else {
  fail++
  console.log('  FAIL 多标记混排:', JSON.stringify(multiHits))
}

// ---------------------------------------------------------------- D. 解析层记账（源码级）
//
// 2026-11-14 实测：一天 108 次 mem-写流水、0 次写入失败，却有 5 轮
// （4.6%）「正文里有标记、一条都没落库」——其中两轮连日志都没有。
// 原因是解析层静默 continue（空正文 / 正则零匹配）。
//
// 这里做**源码级**断言：那几条记账代码必须还在。真正的行为验证要发一轮
// 带畸形标记的消息再看日志，脚本里做不到 —— 所以这层只守「别被人删掉」。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory/index.js'), 'utf8')
console.log('\n=== D. 解析失败必须有诊断（源码级）===\n')
for (const needle of [
  ['匹配计数 markerMatched', 'markerMatched += 1'],
  ['落库计数 markerWritten', 'markerWritten += 1'],
  ['有标记但零匹配要报', "diag('marker-unmatched'"],
  ['有匹配但零落库要报', "diag('marker-dropped'"],
  ['空正文不再静默 continue', "reason: 'empty-body'"],
]) {
  const [label, text] = needle
  const ok = INDEX_SRC.includes(text)
  if (ok) { pass++; console.log(`  OK   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} — 源码里找不到 ${text}`) }
}

// ---------------------------------------------------------------------------
// E. 「只是提到标记」不能刷 marker-unmatched（2026-11-16）
//
// 实测经过：模型在回复里**引用正则与示例**排查擦除器，
// 正文因此含 `<!--mem-(?:log|fact|note|fix)` 这种**示例字样**（不在行首）。
// hasMarker 见字就为真，而真标记一个没写 → 连续三轮刷 marker-unmatched，
// 掩盖了真问题（那三轮是真的忘了写流水）。
//
// 现在的判据：`^[ \t]*<!--mem-` 在行首 → 才算「试图写标记」。
// ---------------------------------------------------------------------------
console.log('\n=== E. 区分「提到标记」与「写错标记」（2026-11-16）===\n')

// ① 行为级：把判据单独跑一遍真实文本，确认分类正确
const lineStartRe = /^[ \t]*<!--mem-/m
const CASES = [
  // [说明, 文本, 期望 atLineStart]
  ['引用正则片段（真实失败案例）',
    '对应到 `MEM_STRIP_RE`：\n\n```js\n/^[ \\t]*<!--mem-(?:log|fact|note|fix)\\b[^`]*?-->[ \\t]*$/gm\n```', false],
  ['引用示例标记（行中间）',
    "  head: \"<!--mem-log ...-->'\\n4: tag: CODE", false],
  ['真写了但缺收尾符（行首）',
    '正文\n\n<!--mem-log topic=开发日志 summary=测试\n没有收尾符', true],
  ['正常完整标记（行首）', '正文\n\n<!--mem-log topic=开发日志 summary=x\n正文\n-->', true],
  ['行首带缩进的真标记', '正文\n\n   <!--mem-log topic=开发日志 summary=x\n正文\n-->', true],
]
for (const [label, text, want] of CASES) {
  const got = lineStartRe.test(text)
  const ok = got === want
  if (ok) { pass++; console.log(`  OK   ${label} → atLineStart=${got}`) }
  else { fail++; console.log(`  FAIL ${label} — 期望 ${want}，实际 ${got}`) }
}

// ② 源码级：分支必须真的存在，且两个 diag 互斥（不能都写）
const hasMentionDiag = INDEX_SRC.includes("diag('marker-mention-only'")
const hasAtLineStartCheck = INDEX_SRC.includes('/^[ \\t]*<!--mem-/m.test(text)')
const unmatchedInsideIf = /if \(atLineStart\) \{\s*diag\('marker-unmatched'/.test(INDEX_SRC)
for (const [label, ok, detail] of [
  ['有 marker-mention-only 分支', hasMentionDiag, '删掉它 → 「提到标记」又会刷 unmatched'],
  ['有行首判据', hasAtLineStartCheck, '缺判据 → 无法区分两类'],
  ['unmatched 只在行首成立时上报', unmatchedInsideIf, '若挪到 if 外 → 两类都会报错'],
]) {
  if (ok) { pass++; console.log(`  OK   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} — ${detail}`) }
}

// ---------------------------------------------------------------------------
// F. 连续写入失败提醒（2026-11-16，用户要求「连续 4 轮失败提醒」）
//
// 兜的是「模型写了标记却 0 条落库」的连续失败，不是「忘写」（那靠注入规则）。
// 历史教训：每轮提醒两天触发 217 次，所以必须有阈值 + safePushMessage。
// 这里做**源码级断言**（事件流无法在脚本里单测），守住四个关键锚点。
// ---------------------------------------------------------------------------
console.log('\n=== F. 连续写入失败提醒（2026-11-16）===\n')

// ① 计数器声明 + 阈值常量
const hasStreakMap = INDEX_SRC.includes('const writeFailStreak = new Map()')
// ⚠️ 2026-11-17 16:26：阈值从 2 改为 **1**（用户定）。
//   演进：4 → 2 → 1。理由见 index.js 里 `writeFailStreak` 的注释：
//   2 的话「第 1 轮必然漏」，而漏记率约 50%，等于每两轮就有一条永远没人补。
//   1 是本轮没写就提醒 —— 唯一不依赖「后续轮次会来」的形态。
//
//   这里是**故意写死具体数值**的 —— 改阈值必须显式改这一行，
//   否则「某天有人把 1 改回 100」，这道防线会在无人察觉时失效。
//   不要改成「只要常量存在就算过」那种宽松判据。
const hasLimitConst = INDEX_SRC.includes('WRITE_FAIL_STREAK_LIMIT = 1')

// ② 写入结果必须更新计数 —— v2 改成「按轮结算」，判据移到 G 段断言。
//    （v1 的 streakSuccessReset / streakFailIncrement 两条已随逻辑改写删除，
//      留着会去匹配已经不存在的老正则，变成永远 FAIL 的噪声。）

// ③ 提醒必须走 safePushMessage + 有阈值判断 + 成功后清零
// ⚠️ 2026-11-17 16:26：文案从「已连续 N 轮」改成「这一轮」，因为阈值已是 1，
//    「连续」这个词没有意义了。锚点同步改。
// ⚠️ 2026-11-18 换锚点：v1 的 `[dsh-memory] 这一轮还没把记忆写进流水` 四行已删
//（同一条提醒里它和 v3「静默补记」互相矛盾，见 verify-injection-consistency 反向断言）。
//
// ⚠️ 这里**不能**用 `safePushMessage(\s*agent,\s*<文案>` 这种跨参正则：
//    那条提醒里 `agent,` 与文案之间夹着 80 行注释（补记三版迭代的留档），
//    `\s*` 过不去 → 正则恒不匹配 → 断言永远红。
//    正确做法是**分段判断**：从文案往前找最近的 `safePushMessage(`，
//    再从文案往后找 `'steer',`，两头都在同一次调用里才算「走了 safePushMessage」。
//
// ⚠️ 这段依赖下面的 `remindIdx`，所以实际计算挪到了它定义之后（见 G 段）。
//    2026-11-18 第一次改时放错位置，`node --check` 通过但运行时报
//    `Cannot access 'remindIdx' before initialization` ——
//    check 查不出 TDZ，只能跑一遍才发现。
const reminderChecksLimit = /failStreak >= WRITE_FAIL_STREAK_LIMIT/.test(INDEX_SRC)
const reminderResetsOnDelivered = /if \(delivered\) \{[\s\S]*?writeFailStreak\.set\(sessionKey, 0\)/.test(INDEX_SRC)

// ④b 总开关（2026-11-18 新增）：兜底通道可以被临时关掉，但必须显式记录。
//
// ## 为什么加这条
//
// 2026-11-18 用户决定先关掉兜底试用（改成短命令脚本 + 人工看流水）。
// 关法是一个常量 `WRITE_FAIL_NUDGE_ENABLED = false`，不是删代码。
//
// 断言它「存在」而不是断言它「为 false」：这个值本来就是会变的开关，
// 断言成固定值等于把「用户此刻的选择」钉进测试 —— 下次改回 true 就要改测试，
// 而改测试的门槛一低，就会有人顺手把断言删掉。
// 真正要守的是「开关还在、且是常量而不是埋进表达式」。
const hasNudgeFlag = /const WRITE_FAIL_NUDGE_ENABLED = (true|false)\b/.test(INDEX_SRC)

// ④ 防无限循环闸门（2026-11-17 16:26 新增，随阈值改 1 一起加）
//
// ## 为什么这条断言必须存在
//
// DSH 契约（agent/turn-stopping）：「a listener that objects steers
// (agent.steer(...)) and the machine re-reads its inbox: fresh steering
// runs another step, none closes the turn.」
//
// 也就是说 steer 会让本轮不关闭、多跑一步。阈值改成 1 后，若没有闸门就是
//     没写 → steer → 多跑一步 → 还是没写 → 再 steer → 无限循环
// 会烧光 token、拖死客户端。
//
// 守两件事：①闸门键存在且带包名前缀 ②判断它时用的是「本轮已提醒过」
const hasSteerGuard = INDEX_SRC.includes('const fatfishSteerGuard = new Map()')
const guardKeyNamespaced = /FATFISH_STEER_GUARD_KEY = `\$\{PLUGIN_SOURCE_KIND\}:steer`/.test(INDEX_SRC)
// 判重逻辑两段都要：
//   ① `alreadyNudgedThisTurn` 的定义比的是「本轮 turn 号」
//   ② steer 的 if 条件里带了 `!alreadyNudgedThisTurn`
// 只查一半是不够的 —— 定义在但条件没用它，等于没闸门。
const guardDefinedByTurn = /const alreadyNudgedThisTurn =[\s\S]{0,160}=== bpTurn/.test(INDEX_SRC)
const guardUsedInCondition = /if \(WRITE_FAIL_NUDGE_ENABLED && failStreak >= WRITE_FAIL_STREAK_LIMIT && !alreadyNudgedThisTurn\)/.test(INDEX_SRC)
const guardBlocksRepeat = guardDefinedByTurn && guardUsedInCondition

// ⚠️ `reminderUsesSafePush` 在下面 G 段才定义（它依赖 remindIdx），
//    这里**不能**引用它 —— 连 `typeof x` 都会因 TDZ 抛
//    `Cannot access 'x' before initialization`（2026-11-18 实际踩到，
//    `node --check` 查不出）。这条断言挪到 G 段末尾统一跑。
const DEFERRED = Symbol('deferred')
for (const [label, ok, detail] of [
  ['有 writeFailStreak 计数器', hasStreakMap, '缺它 → 无法跨轮累计'],
  ['阈值常量 = 1（2026-11-17 由 2 改）', hasLimitConst, '改阈值必须显式，不能埋魔法数字'],
  ['提醒走 safePushMessage', DEFERRED, '不走它 → turn-stopping 异常会中断会话'],
  ['提醒有阈值判断', reminderChecksLimit, '缺它 → 退回每轮提醒（217 次太吵）'],
  ['投递成功后清零', reminderResetsOnDelivered, '不清零 → 下轮仍触发，重复提醒'],
  ['有防无限循环闸门', hasSteerGuard, '缺它 → steer 会让本轮永不关闭'],
  ['闸门键带包名前缀', guardKeyNamespaced, '用大众名字会和别的插件撞（用户 2026-11-17 提醒）'],
  ['闸门按 turn 判重', guardBlocksRepeat, '缺它 → 同一轮反复 steer，就是那个无限循环'],
  ['兜底总开关是显式常量', hasNudgeFlag, '缺它 → 临时关掉兜底这件事没有任何可核对痕迹'],
]) {
  // DEFERRED 占位不在这里判定，见 G 段末尾
  if (ok === DEFERRED) continue
  if (ok) { pass++; console.log(`  OK   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} — ${detail}`) }
}

// ---------------------------------------------------------------------------
// G. 连续未写流水的「按轮」判据（2026-11-16 v2）
//
// ## 为什么改
//
// v1 只在「有标记但 0 落库」时计数，对 `hasMarker === false` 显式不计数。
// 用户 2026-11-16 实报「闲聊为什么没进流水」—— 查出来是模型**连续 10 轮
// 压根没写标记**，而 v1 对这种恰好零检测。
//
// ## 为什么必须按轮、不能按条
//
// 一次回复会触发多条 assistant/message（每个工具调用步一条，实测 4~5 条）。
// 若按条计数，阈值 4 会在一轮内被顶穿 —— 等于退回「每轮提醒」的老路
// （DECISIONS 记着：两天 217 次，用户反馈太吵）。
//
// ## 这组断言的边界（重要）
//
// **测不了真实行为**：脚本无法伪造 assistant/message 事件
// （见 selfcheck-e2e-memory.mjs 顶部注释）。所以这里只做源码级断言，
// 守住「结构没被改坏」，不宣称「行为已验证」。
// ---------------------------------------------------------------------------
console.log('\n=== G. 未写流水按轮计数（2026-11-16 v2）===\n')

// ① turnActivity 记录必须带 wroteLog 字段
const hasWroteLogField = /\{ writes: 0, wroteMemory: false, wroteLog: false \}/.test(INDEX_SRC)
// ② assistant/message 里只在成功时置位（不能在那里 +1 计数）
const setsWroteLog = /rec\.wroteLog = true/.test(INDEX_SRC)
const noCountInAssistantMsg = {
  ok: !/writeFailStreak\.set\(sKey, prev \+ 1\)/.test(INDEX_SRC),
  detail: 'assistant/message 里不该直接改 streak —— 粒度是「条」，会一轮顶穿阈值',
}
// ③ turn-stopping 里按「轮」结算
const settlesPerTurn = /const wroteThisTurn = record !== undefined && record\.wroteLog === true/.test(INDEX_SRC)
// ④ 没写过也要 +1（这是 v2 的核心：v1 恰恰漏了这一半）
const incrementsWhenNotWritten = /const wroteThisTurn[\s\S]{0,400}?writeFailStreak\.set\(sessionKey, prev \+ 1\)/.test(INDEX_SRC)
// ⑤ 提醒文案必须能指导行动（不能只说「没写」）
//
// ⚠️ 2026-11-16 改：写入通道从「正文标记」改成「HTTP 接口」，
// 所以「怎么补」的答案也变了。断言守的是**可执行性**（给了具体动作），
// 不是守某一句具体文案 —— 所以这里认两种形态都算数：
//   走 HTTP：文案里出现 /api/dsh-memory/log
//   退化标记：文案里出现 mem-log 标记的写法
//
// ⚠️⚠️ 2026-11-17 修（审计代理 P0 #3，很关键）：
//
//   旧写法在**整个 index.js** 上测 `/\/api\/dsh-memory\/log/` —— 而 index.js
//   里那个 HTTP 路由 `path: '/api/dsh-memory/log',` 本身就包含该字符串！
//   于是这条断言**永远为真**：提醒文案哪怕退化成「你忘了写」，照样绿。
//
//   这与文件 L247 记的教训是同一个病（「只查有没有、不查在哪用」），
//   只是这次连文件都没限定。修法：**只在提醒文案那一段里找**。
//
//   怎么定位那一段：`safePushMessage(` 调用里那句以「[dsh-memory] 这一轮还没把记忆写进流水」
//   开头的模板串。
//
// ⚠️ 2026-11-17 16:26：锚点从「已连续」改成「这一轮还没把记忆写进流水」。
//   阈值从 2 降到 1 后，「连续 N 轮」这个概念不再成立，文案已同步改写。
//   改锚点时**必须同步改 index.js 里的文案**，否则这条会变成「永远定位不到」的假红。
//
// ⚠️ 2026-11-18：v1 那四行（含「这一轮还没把记忆写进流水」）已整体删除。
//   原因：它和同一处 v3 的「静默补记 / 不要输出任何文字」互相矛盾，
//   模型只能折中成「补完再说一句确认」，每轮多一条废话。
//   锚点随之换成 v3 首句。**历史没有被抹掉** —— 见 verify-injection-consistency
//   里那三条反向断言：v1 的三种特征一旦回潮，那边立刻红。
const REMIND_ANCHOR = '本轮流水还没写。现在**静默补记**'
const remindIdx = INDEX_SRC.indexOf(REMIND_ANCHOR)
const remindSeg =
  remindIdx < 0 ? '' : INDEX_SRC.slice(remindIdx, remindIdx + 900)

// ③ 判断「提醒走的是 safePushMessage 且以 steer 收尾」（2026-11-18 分段判定）
//
// 不用跨参正则的原因见上面 ③ 的注释：`agent,` 与文案之间夹着 80 行注释。
// 这里从文案往前找**最近的** `safePushMessage(`，剥掉注释后要求它紧接 `agent,`；
// 再往文案之后找 `'steer',`，两者都成立才算「走了 safePushMessage」。
const remindBack = remindIdx < 0 ? '' : INDEX_SRC.slice(Math.max(0, remindIdx - 8000), remindIdx)
const remindCallStart = remindBack.lastIndexOf('safePushMessage(')
const remindForward = remindIdx < 0 ? '' : INDEX_SRC.slice(remindIdx, remindIdx + 1200)
const remindCallSeg = remindCallStart < 0 ? '' : remindBack.slice(remindCallStart)
const remindCallCode = remindCallSeg
  .replace(/\/\/[^\n]*/g, '') // 去行注释
  .replace(/\/\*[\s\S]*?\*\//g, '') // 去块注释
const reminderUsesSafePush = () =>
  remindIdx >= 0 &&
  remindCallStart >= 0 &&
  // 剥掉注释后，调用应是 `safePushMessage(\n  agent,` 形态。
  // 不能写成「8000 字符里出现过 agent,」—— 那样别的调用也能让它成立，断言退化成恒真。
  /^safePushMessage\(\s*agent\s*,/.test(remindCallCode) &&
  remindForward.includes("'steer',")
// 自检：定位不到时判红而不是判绿 —— 否则「找不到文案」会被当成「文案没问题」。
const remindLocated = remindIdx >= 0
const reminderActionable =
  remindLocated &&
  (/\/api\/dsh-memory\/log/.test(remindSeg) || /mem-log/.test(remindSeg))
// ⑥ 清零必须在 wroteThisTurn 为真时执行 ——
//    ⚠️ 这条是变异测试抓出来的漏：`write-fail-reset-removed` 把
//    `if (wroteThisTurn)` 改成 `if (false)`，而上面 ⑤ 条只断言
//    「wroteThisTurn 的定义还在」，定义没动，于是照样绿。
//    教训：**只查有没有、不查在哪用**，和我 2026-11-15 踩的是同一个坑。
const resetsWhenWrote = /if \(wroteThisTurn\) \{\s*if \(\(writeFailStreak\.get\(sessionKey\) \?\? 0\) !== 0\) \{\s*writeFailStreak\.set\(sessionKey, 0\)/.test(
  INDEX_SRC,
)

for (const [label, ok, detail] of [
  ['turnActivity 带 wroteLog 字段', hasWroteLogField, '缺字段 → 无法记录「本轮写过」'],
  ['成功时置位 wroteLog', setsWroteLog, '缺它 → 永远算「没写过」'],
  ['assistant/message 不直接改 streak', noCountInAssistantMsg.ok, noCountInAssistantMsg.detail],
  ['turn-stopping 按轮结算', settlesPerTurn, '缺它 → 粒度错了'],
  ['没写过也 +1（v2 核心）', incrementsWhenNotWritten, '缺它 → 回到 v1，忘写仍然零检测'],
  // ⚠️ 这一条必须排在「提醒文案可执行」前面：定位不到文案时，
  //    「可执行」若仍判真就是假的（找不到 ⇒ 什么都测不到）。
  //    ⚠️ 注意 detail 里的锚点说明也要跟着换 —— 否则报错时会指向一个已删的句子，
  //       下一个人按那句去 grep 会找不到。
  ['能定位到提醒文案（否则下一条无意义）', remindLocated, 'index.js 里找不到「本轮流水还没写。现在**静默补记**」锚点，文案可能被改写'],
  ['提醒文案可执行', reminderActionable, '只说「没写」不够，要告诉怎么补'],
  ['写过时真的会清零（不是 if(false)）', resetsWhenWrote, '清零被跳过 → 提醒一次后永远卡在阈值'],
  // ---- 这里才是 F 段那条「提醒走 safePushMessage」的真正判定（2026-11-18 延后）----
  // 它依赖 remindIdx / remindCallSeg，F 段执行时那些还没定义（TDZ）。
  // 放在最后判定，且**保持原 label 原文**，便于和 F 段列表对照。
  ['提醒走 safePushMessage', reminderUsesSafePush(), '不走它 → turn-stopping 异常会中断会话'],
]) {
  if (ok) { pass++; console.log(`  OK   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} — ${detail}`) }
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
