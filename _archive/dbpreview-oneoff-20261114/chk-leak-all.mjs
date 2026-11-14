// 全表扫描：找出所有正文里残留 mem 标记字面量的条目（含已 soft-deleted 的）。
// 只读，走插件 API。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:11616'
const j = async (p) => (await fetch(BASE + p)).json()

const LEAK = /<!--\/?mem-/i
let found = 0

for (const table of ['profile', 'rules']) {
  for (const status of ['active', 'stale', 'deleted']) {
    const r = await j(`/api/dsh-memory/entries?table=${table}&status=${status}&limit=300`)
    for (const e of r.entries || []) {
      const t = String(e.text || '')
      if (LEAK.test(t)) {
        found++
        console.log(`${table} #${e.id} status=${e.status} kind=${e.kind} len=${t.length}`)
        console.log('   全文: ' + JSON.stringify(t.slice(0, 120)))
        console.log('   尾部: ' + JSON.stringify(t.slice(-70)))
        console.log('')
      }
    }
  }
}
console.log(found === 0 ? '✅ 无残留' : `发现 ${found} 条残留`)
