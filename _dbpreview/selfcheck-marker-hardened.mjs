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

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
