// 只读核对：我自己写的两条 note 到底成了什么样，以及注入预算的实时值。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:7952'
const get = async (p) => (await fetch(BASE + p)).json()

console.log('=== 本轮之前的 #128（我 turn1 写的 mem-note）===')
const r = await get('/api/dsh-memory/entries?table=rules&scope=dsh-fatfishdream-memory&limit=100')
const byId = new Map((r.entries || []).map((e) => [e.id, e]))
for (const id of [128, 129, 33]) {
  const e = byId.get(id)
  if (!e) { console.log(`#${id} 不在 active 列表里（可能已 stale/deleted）`); continue }
  console.log(`\n#${id} status=${e.status} kind=${e.kind} len=${String(e.text).length}`)
  console.log('  尾部 60 字符: ' + JSON.stringify(String(e.text).slice(-60)))
  console.log('  含字面量 <!--/mem- ? ', /<!--\/mem-/.test(e.text))
}

console.log('\n=== 注入预算实时值 ===')
const st = await get('/api/dsh-memory/state')
console.log(JSON.stringify(st.injection || st.usage || st.budget || {}, null, 2).slice(0, 800))

console.log('\n=== 谁把 <!--/mem- 泄漏进了正文（全表扫）===')
for (const table of ['profile', 'rules']) {
  const all = await get(`/api/dsh-memory/entries?table=${table}&limit=200`)
  for (const e of all.entries || []) {
    if (/<!--\/mem-|<!--mem-/.test(String(e.text))) {
      console.log(`${table} #${e.id} status=${e.status} 泄漏片段: ${JSON.stringify(String(e.text).slice(-40))}`)
    }
  }
}
