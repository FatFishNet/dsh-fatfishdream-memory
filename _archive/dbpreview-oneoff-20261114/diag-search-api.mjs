/** 核实 HTTP 检索接口：模型能不能用它代替 grep */
const BASE = 'http://127.0.0.1:6242'

async function probe(path) {
  try {
    const r = await fetch(BASE + path)
    const text = await r.text()
    let j
    try { j = JSON.parse(text) } catch { return { status: r.status, raw: text.slice(0, 120) } }
    return { status: r.status, json: j }
  } catch (e) {
    return { error: e.message }
  }
}

const queries = [
  ['沙箱', '/api/dsh-memory/search?q=' + encodeURIComponent('沙箱')],
  ['迁移', '/api/dsh-memory/search?q=' + encodeURIComponent('迁移')],
  ['memory', '/api/dsh-memory/search?q=memory'],
  ['带项目参数', '/api/dsh-memory/search?q=' + encodeURIComponent('沙箱') + '&project=' + encodeURIComponent('dsh-fatfishdream-memory')],
]

for (const [label, p] of queries) {
  const r = await probe(p)
  console.log(`\n=== ${label} ===`)
  if (r.error) { console.log('  请求失败:', r.error); continue }
  console.log('  status:', r.status)
  if (r.raw !== undefined) { console.log('  非 JSON:', r.raw); continue }
  const j = r.json
  console.log('  顶层键:', Object.keys(j).join(', '))
  if (j.ok === false) { console.log('  ok=false:', j.error); continue }
  const rows = j.rows ?? j.entries ?? j.hits ?? []
  console.log('  命中条数:', rows.length)
  if (rows[0]) {
    console.log('  首条字段:', Object.keys(rows[0]).join(', '))
    console.log('  首条内容:', String(rows[0].text ?? '').slice(0, 60).replace(/\n/g, ' '))
  }
}

console.log('\n=== 结论 ===')
console.log('如果命中 0 条，说明该接口的检索参数/分词与预期不符，')
console.log('那么「改用 HTTP 接口」这条建议本身也不成立 —— 需要先修接口。')
