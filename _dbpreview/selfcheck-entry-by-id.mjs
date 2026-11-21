/**
 * 回归：按 id 取单条全文的接口（2026-11-14 新增）。
 *
 * 背景：注入长期教模型「先 summary=1 看摘要，确认相关再按 id 取全文」，
 * 但此前根本没有这个入口 —— 未注册路径一律 401（DSH 默认），模型只能
 * 退回重查整页全文。本脚本锁定路由契约：
 *   - id + table 都必填（四张表 id 各自编号，只给 id 会取错表）
 *   - 正常返回 entry.text 与列表接口一致
 *   - 缺参数 400 / 未知表 400 / 非数字 id 400 / 不存在 404
 *
 * 需要 DSH 在跑（HTTP）；数据用真实库里的 rules / profile，不写库。
 */
const BASE = process.env.DSH_WEB_URL || process.env.DSH_BASE
if (!BASE) { console.log('❌ 需要 DSH_WEB_URL'); process.exit(1) }

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? '  ← ' + detail : ''}`)
}

async function get(path) {
  const res = await fetch(BASE + path)
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

console.log('=== 1. 从列表拿一条真实条目 ===\n')
const list = await get('/api/dsh-memory/entries?table=rules&status=active&limit=1')
check('entries 接口可用', list.status === 200 && list.json?.ok === true, `status=${list.status}`)
const row = list.json?.entries?.[0]
check('rules 里至少有一条 active（否则无法验证）', row !== undefined)
if (!row) {
  console.log('\n无法继续，退出（不是接口失败）')
  process.exit(fail === 0 ? 0 : 1)
}
console.log(`  选中 rules #${row.id}，正文 ${String(row.text).length} 字`)

console.log('\n=== 2. 按 id 取全文 ===\n')
const got = await get(`/api/dsh-memory/entry?id=${row.id}&table=rules`)
check('GET /entry 返回 200 且 ok', got.status === 200 && got.json?.ok === true, `status=${got.status}`)
check('返回的 table 正确', got.json?.table === 'rules', String(got.json?.table))
check('返回的 id 正确', got.json?.entry?.id === row.id, String(got.json?.entry?.id))
check('正文与列表接口完全一致', got.json?.entry?.text === row.text,
  `列表 ${String(row.text).length} 字 / 接口 ${String(got.json?.entry?.text).length} 字`)

console.log('\n=== 3. profile 表也能按 id 取 ===\n')
const plist = await get('/api/dsh-memory/entries?table=profile&status=active&limit=1')
const prow = plist.json?.entries?.[0]
if (prow) {
  const pget = await get(`/api/dsh-memory/entry?id=${prow.id}&table=profile`)
  check('profile 按 id 可取', pget.json?.ok === true && pget.json?.entry?.text === prow.text)
} else {
  console.log('  （跳过：profile 为空）')
}

console.log('\n=== 4. 错误处理 ===\n')
const noTable = await get(`/api/dsh-memory/entry?id=${row.id}`)
check('缺 table → 400', noTable.status === 400 && /table/.test(String(noTable.json?.error)), `status=${noTable.status}`)

const noId = await get('/api/dsh-memory/entry?table=rules')
check('缺 id → 400', noId.status === 400, `status=${noId.status}`)

const badId = await get('/api/dsh-memory/entry?id=abc&table=rules')
check('非数字 id → 400', badId.status === 400, `status=${badId.status}`)

const badTable = await get(`/api/dsh-memory/entry?id=${row.id}&table=nope`)
check('未知 table → 400', badTable.status === 400, `status=${badTable.status}`)

const missing = await get('/api/dsh-memory/entry?id=999999&table=rules')
check('不存在的 id → 404', missing.status === 404, `status=${missing.status}`)

console.log('\n=== 5. 不再存在于「未注册路径」的 401 黑洞里 ===\n')
const oldShape = await get(`/api/dsh-memory/entry/${row.id}`)
check('旧写法 /entry/<id> 仍是 401（未注册路径的默认行为，不用它）',
  oldShape.status === 401, `status=${oldShape.status}`)

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
