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
const hasLimitConst = INDEX_SRC.includes('WRITE_FAIL_STREAK_LIMIT = 4')

// ② 写入结果必须更新计数（成功清零 / 有标记但失败 +1）
const streakSuccessReset = /if \(markerWritten > 0\) \{[\s\S]*?writeFailStreak\.set\(sKey, 0\)/.test(INDEX_SRC)
const streakFailIncrement = /writeFailStreak\.set\(sKey, prev \+ 1\)/.test(INDEX_SRC)

// ③ 提醒必须走 safePushMessage + 有阈值判断 + 成功后清零
const reminderUsesSafePush = /safePushMessage\(\s*agent,\s*`\[dsh-memory\] 连续/.test(INDEX_SRC)
const reminderChecksLimit = /failStreak >= WRITE_FAIL_STREAK_LIMIT/.test(INDEX_SRC)
const reminderResetsOnDelivered = /if \(delivered\) \{[\s\S]*?writeFailStreak\.set\(sessionKey, 0\)/.test(INDEX_SRC)

for (const [label, ok, detail] of [
  ['有 writeFailStreak 计数器', hasStreakMap, '缺它 → 无法跨轮累计失败'],
  ['阈值常量 = 4', hasLimitConst, '改阈值必须显式，不能埋魔法数字'],
  ['成功写入清零计数', streakSuccessReset, '成功不清零 → 提醒一次后永远卡在阈值'],
  ['失败轮次 +1', streakFailIncrement, '缺它 → 计数永不增长，提醒永不触发'],
  ['提醒走 safePushMessage', reminderUsesSafePush, '不走它 → turn-stopping 异常会中断会话'],
  ['提醒有阈值判断', reminderChecksLimit, '缺它 → 退回每轮提醒（217 次太吵）'],
  ['投递成功后清零', reminderResetsOnDelivered, '不清零 → 下轮仍触发，重复提醒'],
]) {
  if (ok) { pass++; console.log(`  OK   ${label}`) }
  else { fail++; console.log(`  FAIL ${label} — ${detail}`) }
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
