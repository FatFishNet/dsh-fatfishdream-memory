// 第 1 步：截掉 #128 尾部泄漏的 `<!--/mem-note` 残片。
// 走插件自己的 entry/update 路由（与 GUI 同一条路径），不碰 memory.db 文件。
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:11616'

const j = async (p) => (await fetch(BASE + p)).json()
const post = async (p, body) =>
  (
    await fetch(BASE + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  ).json()

// 取当前值
const list = await j('/api/dsh-memory/entries?table=rules&scope=dsh-fatfishdream-memory&limit=200')
const target = (list.entries || []).find((e) => e.id === 128)
if (!target) {
  console.log('❌ 找不到 #128')
  process.exit(1)
}

console.log('=== 改前 ===')
console.log('长度:', target.text.length)
console.log('尾部:', JSON.stringify(target.text.slice(-50)))

// 剥掉结尾的残留闭合标签（可能带换行/空白）
const cleaned = target.text.replace(/\s*<!--\/?mem-[a-z]*\s*$/i, '').trim()

console.log('\n=== 改后（本地计算）===')
console.log('长度:', cleaned.length)
console.log('尾部:', JSON.stringify(cleaned.slice(-50)))
console.log('还含字面量 <!--mem- ?', /<!--\/?mem-/.test(cleaned))

if (/<!--\/?mem-/.test(cleaned)) {
  console.log('❌ 清理后仍残留标记，中止')
  process.exit(1)
}

const r = await post('/api/dsh-memory/entry/update', { id: 128, table: 'rules', text: cleaned })
console.log('\n=== 写入结果 ===')
console.log('ok =', r.ok, r.error || '')
if (r.entry) {
  console.log('回读长度:', r.entry.text.length)
  console.log('回读尾部:', JSON.stringify(r.entry.text.slice(-50)))
  console.log('回读仍含标记 ?', /<!--\/?mem-/.test(r.entry.text))
}
