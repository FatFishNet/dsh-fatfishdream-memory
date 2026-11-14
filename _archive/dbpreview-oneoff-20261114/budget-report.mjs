// 列出本项目 rules 里所有 active 条目的字节账，定位该精简哪几条。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:11616'
const j = async (p) => (await fetch(BASE + p)).json()

const list = await j('/api/dsh-memory/entries?table=rules&scope=dsh-fatfishdream-memory&limit=200')
const rows = (list.entries || []).filter((e) => e.status === 'active')

const B = (s) => Buffer.byteLength(s, 'utf8')
let sum = 0
console.log('序号  行字节  id   kind     开头')
console.log('-'.repeat(78))
const sorted = [...rows].sort((a, b) => {
  const rank = { redline: 0, pref: 1, state: 2 }
  const d = (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3)
  return d !== 0 ? d : a.id - b.id
})
sorted.forEach((e, i) => {
  const line = '- ' + e.text
  const b = B(line) + 1 // join 用的 \n
  sum += b
  console.log(
    String(i + 1).padStart(3) + '  ' +
    String(b).padStart(6) + '  ' +
    String(e.id).padStart(3) + '  ' +
    String(e.kind).padEnd(8) + '  ' +
    String(e.text).slice(0, 40).replace(/\n/g, ' '),
  )
})
console.log('-'.repeat(78))
console.log(`合计 ${sum} 字节 / 预算 4096，超出 ${Math.max(0, sum - 4096)} 字节`)
console.log(`条目数 ${rows.length}`)
