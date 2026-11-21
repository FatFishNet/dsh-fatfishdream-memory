import { readFileSync } from 'node:fs'
const POLICY = 'D:/dsh-fatfishdream-memory/policy.md'
const raw = readFileSync(POLICY, 'utf8')

// 复刻 index.js 的 policyTextSync + activeLines（只读）
const lines = raw.split('\n')
let start = -1
for (let i = 0; i < lines.length; i++) {
  if (/^#{1,2}\s*.*给模型的规则/.test(lines[i])) { start = i + 1; break }
}
if (start === -1) { console.log('❌ 找不到「给模型的规则」标题'); process.exit(1) }
const collected = []
for (let i = start; i < lines.length; i++) {
  if (/^#{1,2}\s/.test(lines[i])) break
  collected.push(lines[i])
}
console.log(`段范围: L${start + 1} ~ L${start + collected.length}`)
console.log('原始段行数:', collected.length)
console.log('')
console.log('--- 原始段内容 ---')
collected.forEach((l, i) => console.log(`  L${start + 1 + i}: ${JSON.stringify(l)}`))

// activeLines
const items = []
let current = null
for (const rawLine of collected.join('\n').split('\n')) {
  const line = rawLine.trimEnd()
  if (line.trim() === '') { if (current !== null) { items.push(current); current = null } continue }
  if (line.startsWith('- ')) { if (current !== null) items.push(current); current = line; continue }
  if (/^#{1,6}\s/.test(line)) { if (current !== null) { items.push(current); current = null } continue }
  if (current !== null) current = `${current} ${line.trim()}`
}
if (current !== null) items.push(current)
const out = []
for (const item of items) {
  const line = item.trimEnd()
  if (/^- \[superseded\b/i.test(line)) continue
  if (/^- \[stale\b/i.test(line)) continue
  if (/^-\s*[（(].*[）)]\s*$/u.test(line)) continue
  if (line.startsWith('- [active]')) out.push(`- ${line.slice('- [active]'.length).trim()}`)
  else if (line.startsWith('- ')) out.push(line)
}
console.log('')
console.log('--- 实际注入的条目 ---')
out.forEach((l, i) => {
  console.log(`  [${i + 1}] ${l}`)
  console.log('      长度:', l.length, '字符')
})
console.log('')
console.log('注入总字节:', Buffer.byteLength(out.join('\n'), 'utf8'))
