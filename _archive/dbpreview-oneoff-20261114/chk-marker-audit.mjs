// 只读诊断：查我这两轮写入的标记实际落成了什么。
// 走插件自己的 HTTP API（GUI 与 /memory status 用的是同一套），不碰 memory.db 文件。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:7952'

const get = async (p) => (await fetch(BASE + p)).json()

const state = await get('/api/dsh-memory/state')
console.log('=== state ===')
console.log('root     ', state.root)
console.log('health   ', state.health?.ok, 'failed=', JSON.stringify(state.health?.failed))
console.log('byTable  ', JSON.stringify(state.db?.byTable))

console.log('\n=== rules 表里 scope=本项目 的条目 ===')
const rules = await get(
  '/api/dsh-memory/entries?table=rules&scope=dsh-fatfishdream-memory&status=active&limit=50',
)
for (const e of rules.entries || []) {
  const text = String(e.text || '')
  console.log(`#${e.id} kind=${e.kind} len=${text.length}`)
  console.log('   ' + text.replace(/\n/g, ' ⏎ ').slice(0, 200))
}

console.log('\n=== 全局 rules 里含 FatFishDream-memory 的（mem-fix 该清掉的）===')
const g = await get('/api/dsh-memory/entries?table=rules&scope=__global__&status=active&limit=100')
const hit = (g.entries || []).filter((e) => /FatFishDream-memory/.test(e.text || ''))
console.log(`全局 active 共 ${(g.entries || []).length} 条，命中 ${hit.length} 条`)
for (const e of hit) console.log(`#${e.id} status=${e.status}  ${String(e.text).slice(0, 120)}`)
