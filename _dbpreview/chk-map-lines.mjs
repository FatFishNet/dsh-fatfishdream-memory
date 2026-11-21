// 核对：地图里每条 L#### 引用，实际那一行是什么。
// verify-map.mjs 只判「非空行」，所以内容漂了它也不报 —— 这个脚本把真实内容打出来人工看。
import fs from 'node:fs'

const SRC = {
  index: 'dsh-fatfishdream-memory/index.js',
  client: 'dsh-fatfishdream-memory/client.js',
  store: 'dsh-fatfishdream-memory/db-store.mjs',
  schema: 'dsh-fatfishdream-memory/db-schema.mjs',
}
const files = {}
for (const [k, p] of Object.entries(SRC)) files[k] = fs.readFileSync(p, 'utf8').split('\n')

const mapLines = fs.readFileSync('docs/项目地图.md', 'utf8').split('\n')

function ownerOf(lineNo) {
  let heading = ''
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = mapLines[i].match(/^##\s+(\S+.*)$/)
    if (m) { heading = m[1]; break }
  }
  const h = heading.trim()
  if (h.startsWith('3.')) return 'index'
  if (h.startsWith('4.')) return 'schema'
  if (h.startsWith('5.')) return 'store'
  if (h.startsWith('6.')) return 'client'
  if (/^(7|8|9|10|11|12|13)\b/.test(h)) return 'index'
  return null
}

let n = 0
mapLines.forEach((line, i) => {
  const owner = ownerOf(i + 1)
  for (const m of line.matchAll(/\bL(\d{3,4})\b/g)) {
    const num = +m[1]
    const src = owner ? files[owner] : null
    const actual = src ? (src[num - 1] || '越界').trim().slice(0, 70) : '?'
    n++
    console.log(`${String(n).padStart(3)} map#${String(i + 1).padStart(3)} [${owner || 'mixed'}] L${num}  →  ${actual}`)
  }
})
console.log(`\n共 ${n} 处`)
