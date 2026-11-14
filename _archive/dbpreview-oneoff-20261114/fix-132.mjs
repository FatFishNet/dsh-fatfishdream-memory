// 改写 #132：它正文里提到了 /memory search（用户侧命令），不该出现在注入里。
// 走插件 entry/update 路由。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:11616'
const j = async (p) => (await fetch(BASE + p)).json()
const post = async (p, body) =>
  (await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json()

const list = await j('/api/dsh-memory/entries?table=rules&scope=dsh-fatfishdream-memory&limit=100')
const e = (list.entries || []).find((x) => x.id === 132)
if (!e) { console.log('❌ 找不到 #132'); process.exit(1) }

console.log('改前:', JSON.stringify(e.text))

const next =
  '**插件诊断日志（`logs/*.log`）不是记忆。** 它只有 `apply-start`/`entry-deleted`/`textLength` 这类技术事件，' +
  '没有对话内容，也分不清某条 `entry-updated` 是用户还是模型做的。回答「我们之前做过什么」只能靠每轮注入；' +
  '翻 `logs/*.log` 拼时间线是拿监控录像冒充回忆，还会把推测当成事实。查不到就说「没记住」，不要用日志编答案。'

const r = await post('/api/dsh-memory/entry/update', { id: 132, table: 'rules', text: next })
console.log('\n写入:', r.ok)
if (r.entry) console.log('改后:', JSON.stringify(r.entry.text))
