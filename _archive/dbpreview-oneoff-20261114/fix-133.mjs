// 重写 #133：上轮写它时正文含收尾符字面量，被正则当成结束符，条目被截断成 58 字节。
// 这次正文里一律不出现那个符号，改用文字描述。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:11616'
const j = async (p) => (await fetch(BASE + p)).json()
const post = async (p, body) =>
  (await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })).json()

const list = await j('/api/dsh-memory/entries?table=rules&scope=dsh-fatfishdream-memory&limit=100')
const e = (list.entries || []).find((x) => x.id === 133)
if (!e) { console.log('找不到 #133'); process.exit(1) }

console.log('改前 len=' + String(e.text).length)
console.log('改前全文: ' + JSON.stringify(e.text))

// 描述式写法：全程不写那两个横线加尖括号的组合
const next =
  '**写 mem 标记不要加闭合标签**：插件只认「开标签 / 换行 / 正文 / 换行 / 收尾符」这一种形状，' +
  '没有开闭配对。收尾符就是 HTML 注释的结束符（箭头减号加两个横线），一条只写一次，且必须单独起一行。' +
  '多写一个 XML 风格的闭合标签，它不会被剥离，前半截会变成正文永久写进库并每轮注入（2026-11-13 踩过两次）。' +
  '另注意：整条压成一行也会匹配不上、静默丢失。完整语法见 AGENTS.md 硬约束 6.1，' +
  '实证脚本 `_dbpreview/test-marker-forms.mjs`。'

// 自检：不能含尖括号开头的 mem 标记字面量
if (/<!--\s*\/?\s*mem-/.test(next)) {
  console.log('❌ 新正文仍含标记字面量，中止')
  process.exit(1)
}

const r = await post('/api/dsh-memory/entry/update', { id: 133, table: 'rules', text: next })
console.log('\n写入 ok=' + r.ok)
if (r.entry) {
  console.log('改后 len=' + String(r.entry.text).length)
  console.log('改后全文: ' + JSON.stringify(r.entry.text))
}
