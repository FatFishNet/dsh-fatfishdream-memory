// 通用批量提交器：读 batchN.json 提交
import fs from 'node:fs'

const file = process.argv[2]
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:5502'

const items = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log(`提交 ${file}：${items.length} 条`)

const r = await fetch(`${BASE}/api/dsh-memory/entry/topic`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ items }),
})
const out = await r.json()

if (!out.ok) {
  console.log('失败:', JSON.stringify(out))
  process.exit(1)
}

console.log(`总 ${out.total}，成功 ${out.changed}`)
const failed = (out.results || []).filter((x) => !x.ok)
if (failed.length) {
  console.log('失败项:')
  for (const f of failed) console.log(`  #${f.id}: ${f.error}`)
  process.exit(1)
}
console.log('全部成功')
