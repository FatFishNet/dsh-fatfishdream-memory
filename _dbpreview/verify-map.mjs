/**
 * 地图行号核对（改进判据版）
 *
 * 上一版把「落在注释/空行/let 声明」一律标为可疑，误报太多。
 * 现在改为：只要该行**不是空行**就算通过；
 * 真正的判断交给 verify-functions.mjs（它按名字断言）。
 */
import fs from 'node:fs'

const map = fs.readFileSync('docs/项目地图.md', 'utf8')
const mapLines = map.split('\n')

const SRC = {
  index: 'dsh-fatfishdream-memory/index.js',
  client: 'dsh-fatfishdream-memory/client.js',
  store: 'dsh-fatfishdream-memory/db-store.mjs',
  schema: 'dsh-fatfishdream-memory/db-schema.mjs',
}
const files = {}
for (const [k, p] of Object.entries(SRC)) files[k] = fs.readFileSync(p, 'utf8').split('\n')

function ownerOf(lineNo) {
  let heading = ''
  for (let i = lineNo - 1; i >= 0; i--) {
    const m = mapLines[i].match(/^##\s+(\S+.*)$/)
    if (m) {
      heading = m[1]
      break
    }
  }
  const h = heading.trim()
  if (h.startsWith('3.')) return 'index'
  if (h.startsWith('4.')) return 'schema'
  if (h.startsWith('5.')) return 'store'
  if (h.startsWith('6.')) return 'client'
  if (/^(7|8|9|10|11|12|13)\b/.test(h)) return 'index'
  return 'mixed'
}

const rows = []
mapLines.forEach((line, i) => {
  for (const m of line.matchAll(/\bL(\d{3,4})\b/g)) {
    rows.push({ n: +m[1], mapLine: i + 1, owner: ownerOf(i + 1) })
  }
})

let blank = 0
let outlier = 0
for (const r of rows) {
  const owners = r.owner === 'mixed' ? Object.keys(SRC) : [r.owner]
  let found = false
  let content = ''
  for (const o of owners) {
    const src = files[o]
    if (r.n <= src.length) {
      content = (src[r.n - 1] || '').trim()
      if (content !== '') found = true
    }
  }
  if (!found) {
    blank++
    console.log(`  ⚠️ L${r.n}（地图行 ${r.mapLine}）落空/越界`)
  }
}

console.log(`\n共 ${rows.length} 处引用，${blank} 处落空`)

// 附带：源码规模
const sizes = Object.entries(SRC).map(([k, p]) => {
  const a = files[k]
  return `${k}=${a[a.length - 1] === '' ? a.length - 1 : a.length}`
})
console.log('源码规模:', sizes.join('  '))
process.exit(blank === 0 ? 0 : 1)
