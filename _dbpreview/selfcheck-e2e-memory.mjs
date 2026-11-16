/**
 * 端到端：验证「标记写入 → 落库 → 检索 → 条件查询」整条链路。
 *
 * ⚠️ 写入那一步**必须由模型在回复正文里写 mem-log 标记**（脚本无法伪造
 * assistant/message 事件）。所以用法是：
 *   1) 模型回复里写一条带唯一关键词的流水（例如 E2E5A1）
 *   2) 跑本脚本核对读取与各种条件组合：
 *        node _dbpreview/selfcheck-e2e-memory.mjs <canary> <bodyToken>
 *
 * 默认 scope 取 dsh-fatfishdream-memory；可用环境变量 E2E_SCOPE 覆盖。
 * 只读，不写库。
 */
const BASE = process.env.DSH_WEB_URL || process.env.DSH_BASE
const CANARY = process.argv[2]
const BODY = process.argv[3] || CANARY
const SCOPE = process.env.E2E_SCOPE || 'dsh-fatfishdream-memory'
const OTHER_SCOPE = '__e2e_other_project__'

if (!BASE) { console.log('❌ 需要 DSH_WEB_URL'); process.exit(1) }
if (!CANARY) { console.log('❌ 需要 canary 参数'); process.exit(1) }

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? '  ← ' + detail : ''}`)
}

async function get(path) {
  const res = await fetch(BASE + path)
  let json
  try { json = await res.json() } catch { json = null }
  return { status: res.status, json }
}

const q = encodeURIComponent(CANARY)

console.log(`=== 端到端：canary=${CANARY} scope=${SCOPE} ===\n`)

// 1) 落库
const entries = await get(`/api/dsh-memory/entries?table=logs&scope=${encodeURIComponent(SCOPE)}&limit=30`)
check('entries 接口可用', entries.status === 200 && entries.json?.ok === true, `status=${entries.status}`)
const row = entries.json?.entries?.find(
  (e) => String(e.summary ?? '').includes(CANARY) || String(e.text ?? '').includes(CANARY)
  || String(e.keywords ?? '').includes(CANARY),
)
check('刚写的流水出现在 logs 列表', row !== undefined)
let rowId = row?.id
check('条目带 topic', typeof row?.topic === 'string' && row.topic !== '', String(row?.topic))
check('条目带 summary（非空）', typeof row?.summary === 'string' && row.summary.trim() !== '', String(row?.summary))
check('条目带 keywords', typeof row?.keywords === 'string' && row.keywords.includes(CANARY), String(row?.keywords))
check('summary 不含正文换行（单行）', !String(row?.summary ?? '').includes('\n'), JSON.stringify(row?.summary))

// 2) 摘要检索
const s1 = await get(`/api/dsh-memory/search?q=${q}&scope=${encodeURIComponent(SCOPE)}&summary=1&limit=5`)
check('摘要检索命中', s1.json?.ok && s1.json.hits?.some((h) => h.id === rowId),
  `hits=${JSON.stringify((s1.json?.hits ?? []).map((h) => h.id))}`)
const hit1 = s1.json?.hits?.find((h) => h.id === rowId)
check('摘要检索返回 keywords 数组', Array.isArray(hit1?.keywords) && hit1.keywords.includes(CANARY),
  JSON.stringify(hit1?.keywords))
check('摘要检索不返回正文（excerpt 短）',
  typeof hit1?.excerpt === 'string' && hit1.excerpt.length <= 80, `${hit1?.excerpt?.length}`)

// 3) 两段式第二步：按 id 取全文（2026-11-14 新增入口）
const e1 = await get(`/api/dsh-memory/entry?id=${rowId}&table=logs`)
check('按 id 取全文可用', e1.status === 200 && e1.json?.ok === true, `status=${e1.status}`)
check('取回的是同一条（id/table 对得上）',
  e1.json?.entry?.id === rowId && e1.json?.table === 'logs',
  `id=${e1.json?.entry?.id} table=${e1.json?.table}`)
check('取回的正文含唯一标记（摘要→全文闭环）',
  String(e1.json?.entry?.text ?? '').includes(BODY))

// 4) 全文检索（不用 id 的另一条路，保留对照）
const s2 = await get(`/api/dsh-memory/search?q=${q}&scope=${encodeURIComponent(SCOPE)}&limit=5`)
const hit2 = s2.json?.hits?.find((h) => h.id === rowId)
check('全文检索命中', hit2 !== undefined)
check('全文里能读到正文唯一标记', String(hit2?.text ?? '').includes(BODY), String(hit2?.text ?? '').slice(0, 40))

// 4) 变量条件：scope 隔离 / 跨项目 / 缺省 / 时间范围 / 分页 / 状态
const s3 = await get(`/api/dsh-memory/search?q=${q}&scope=${encodeURIComponent(OTHER_SCOPE)}`)
check('scope 隔离：别的项目查不到', s3.json?.ok && s3.json.hits?.length === 0,
  `hits=${s3.json?.hits?.length}`)

const s4 = await get(`/api/dsh-memory/search?q=${q}&all=1`)
check('all=1 能跨项目查到', s4.json?.ok && s4.json.hits?.some((h) => h.id === rowId))

const s5 = await get(`/api/dsh-memory/search?q=${q}`)
check('缺 scope 返回 400', s5.status === 400 && s5.json?.ok === false, `status=${s5.status}`)

// ⚠️ 必须用**本地日期**：库里 ts 是本地时间（无 Z），
//    而 toISOString() 给的是 UTC 日期 —— 东八区凌晨会差一天（实踩）。
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const e2 = await get(`/api/dsh-memory/entries?table=logs&scope=${encodeURIComponent(SCOPE)}&from=${today}&to=${today}&limit=30`)
check('时间范围（今天）包含该条', e2.json?.entries?.some((e) => e.id === rowId))

const future = '2099-01-01'
const e3 = await get(`/api/dsh-memory/entries?table=logs&scope=${encodeURIComponent(SCOPE)}&from=${future}&limit=30`)
check('时间范围（未来）排除该条', !e3.json?.entries?.some((e) => e.id === rowId))

const e4 = await get(`/api/dsh-memory/entries?table=logs&scope=${encodeURIComponent(SCOPE)}&limit=1`)
check('分页 limit=1 生效', e4.json?.entries?.length === 1, `len=${e4.json?.entries?.length}`)

// ⚠️ 2026-11-17 修（审计代理 P0 #13）：
//
//   旧代码请求了 `status=deleted` 存进 `e5`，但断言检查的却是 **`e4`**
//   （`limit=1`，只有 1 条）—— 等于「软删不混进 active」这条防线退化成看 1 行，
//   而 `e5` 成了彻头彻尾的死变量。删掉 `limit=1` 那条路径也发现不了。
//
//   现在断言真的挂在 `e5` 上：它请求的是「deleted 列表」，
//   要求**每一行的 status 都必须是 deleted**（而不是混进 active 的）。
const e5 = await get(
  `/api/dsh-memory/entries?table=logs&scope=${encodeURIComponent(SCOPE)}&status=deleted&limit=50`,
)
const deletedRows = e5.json?.entries ?? []
check(
  'deleted 列表里每一行的 status 都是 deleted',
  Array.isArray(deletedRows) && deletedRows.every((e) => e.status === 'deleted'),
  `len=${deletedRows.length}`,
)

// 5) 中文 2 字词（自适应：从刚写入的正文里取）
// 不能写死「沙箱」这类历史词 —— 流水清空后就不存在了（2026-11-14 踩过）。
// 从条目正文里取第一个 2 汉字片段，验证「逐字分词 + unicode61」仍然可用。
const entryText = String(e1.json?.entry?.text ?? '')
const zhPair = entryText.match(/[\u4e00-\u9fa5]{2}/)
check('写入的正文里含中文双字词（供分词测试）', zhPair !== null, entryText.slice(0, 30))
if (zhPair) {
  const zh = await get(`/api/dsh-memory/search?q=${encodeURIComponent(zhPair[0])}&scope=${encodeURIComponent(SCOPE)}&summary=1&limit=3`)
  check(`中文 2 字词可检索（${zhPair[0]}）`, zh.json?.ok && zh.json.hits?.length > 0,
    `hits=${zh.json?.hits?.length}`)
}

// 6) 注入与状态一致
const st = await get('/api/dsh-memory/state')
check('schema=v5', st.json?.db?.schemaVersion === 5, String(st.json?.db?.schemaVersion))
check('健康自检 9 项全过', st.json?.health?.ok === true && st.json?.health?.total === 9)

console.log('\n────────────────\n' + `${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

