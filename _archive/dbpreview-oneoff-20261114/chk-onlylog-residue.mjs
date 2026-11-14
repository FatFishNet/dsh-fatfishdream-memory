/**
 * 一次性核对：源码与文档里是否还有「已移除的标记」的说法。
 *
 * 2026-11-13：mem-fact / mem-note / mem-fix 全部移除，只剩 mem-log。
 * 代码里还有残留会通过两种方式影响现实：
 *   1. POLICY_TEMPLATE 是新用户的开箱默认值（硬约束 13）
 *   2. 运行时 safePushMessage 的文案会直接注入会话
 * 所以查完代码还要查文档，文档错了下一个人会照错的结构动手。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IDX = fs.readFileSync(path.join(REPO, 'dsh-memory/index.js'), 'utf8').split('\n')

/** 允许出现旧标记名的地方：说明「已移除」的注释、迁移历史。
 *  ⚠️ 判定要看**上下文窗口**，不能只看本行 —— 实际写法多是
 *  「`mem-note`（项目规则）/ `mem-fact`（用户画像）」换行后才接「已于…移除」。
 *  只判单行会把这些合法说明误报成残留，检查一旦误报就没人信了。 */
const ALLOW = /移除|已删|不再|removed|历史/
const allowAt = (lines, i) =>
  ALLOW.test(lines.slice(Math.max(0, i - 1), i + 3).join(' ')) || lines[i].trim().startsWith('//')

let hit = 0
console.log('=== 1. index.js 里旧标记名的每一处 ===\n')
IDX.forEach((line, i) => {
  if (!/mem-note|mem-fact|mem-fix/.test(line)) return
  const n = i + 1
  const ok = allowAt(IDX, i)
  if (!ok) hit++
  console.log(`${ok ? '  ' : '❌'} L${n}  ${line.trim().slice(0, 96)}`)
})

console.log('\n=== 2. POLICY_TEMPLATE 不得教模型写规则/画像 ===\n')
const src = IDX.join('\n')
const tplStart = src.indexOf('const POLICY_TEMPLATE = `')
const tplEnd = src.indexOf('`\n', tplStart)
const TMPL = src.slice(tplStart, tplEnd)
console.log(`模板字节 ${Buffer.byteLength(TMPL)}`)
for (const w of ['mem-note', 'mem-fact', 'mem-fix', '/memory` 命令']) {
  const bad = TMPL.includes(w)
  if (bad) hit++
  console.log(`${bad ? '❌' : '✅'} 模板不含 ${w}`)
}

console.log('\n=== 3. 运行时推送文案不得让模型写规则 ===\n')
// 整理提醒与弱信号提示都是 safePushMessage 推给模型的原话
const PUSH_RE = /safePushMessage\([\s\S]{0,600}?\)\n/g
const pushes = src.match(PUSH_RE) ?? []
let pushBad = 0
for (const p of pushes) {
  if (/mem-note|mem-fact/.test(p)) {
    pushBad++
    console.log('❌ ' + p.split('\n').find((l) => /mem-note|mem-fact/.test(l))?.trim().slice(0, 96))
  }
}
if (pushBad === 0) console.log(`✅ ${pushes.length} 处 safePushMessage 文案全部只提 mem-log`)
hit += pushBad

console.log('\n=== 4. 文档残留 ===\n')
const DOCS = [
  'AGENTS.md',
  'README.md',
  'dsh-memory/README.md',
  'dsh-memory/STORAGE.md',
  'dsh-memory/NOTICE',
  'docs/项目地图.md',
  'docs/TESTING.md',
  'docs/DECISIONS.md',
]
let docHit = 0
for (const d of DOCS) {
  const p = path.join(REPO, d)
  if (!fs.existsSync(p)) continue
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  lines.forEach((line, i) => {
    if (!/mem-note|mem-fact|mem-fix/.test(line)) return
    if (allowAt(lines, i)) return
    docHit++
    console.log(`❌ ${d}:${i + 1}  ${line.trim().slice(0, 90)}`)
  })
}
if (docHit === 0) console.log('✅ 文档全部已同步')

console.log(`\n────────────────\n代码 ${hit} 处 / 文档 ${docHit} 处`)
process.exit(hit + docHit === 0 ? 0 : 1)
