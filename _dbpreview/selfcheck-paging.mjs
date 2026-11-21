/**
 * 端到端自检：流水页分页（每页 30，可翻最近 100）。
 *
 * 模拟 GUI 的真实请求序列，验证：
 *   - 首页 / 各页 / 末页条数
 *   - total 封顶 100
 *   - 翻页无重复无遗漏
 *   - 项目切换后页码归零的语义（后端层面）
 *   - cap 与 scope 组合
 *   - 其他页签不受影响
 */
/**
 * ⚠️ 端口不能写死（踩过多次）：GUI 每次启动端口都变。
 * 优先 DSH_BASE，其次 DSH_WEB_URL（DSH 注入到进程环境），最后才用兜底值。
 * 兜底只是为了脚本能跑起来不报 undefined，不代表它是对的。
 */
const BASE = process.env.DSH_BASE || process.env.DSH_WEB_URL || 'http://127.0.0.1:5502'
const PAGE_SIZE = 30
const MAX_VIEWABLE = 100

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  OK   ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

const get = async (p) => await (await fetch(BASE + p)).json()

// 用户可能清空流水（2026-11-14 清过一次）。本测试要验证「四页 100 条 + 末页 10 条」，
// 数据不足 130 条时断言没有意义 —— 明确跳过，而不是假装通过或整片报错。
const probe = await get('/api/dsh-memory/entries?table=logs&status=active&limit=1')
if ((probe.total ?? 0) < 130) {
  console.log(`跳过：流水只有 ${probe.total ?? 0} 条（本测试需要 ≥130 条）—— 清空后这是预期状态`)
  console.log('分页/cap 逻辑由 selfcheck-cap.mjs（自建 150 条种子）覆盖。')
  process.exit(0)
}

const logUrl = (page, extra = '') =>
  `/api/dsh-memory/entries?table=logs&status=active&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&cap=${MAX_VIEWABLE}${extra}`

console.log('=== 1. 首页 ===')
const p0 = await get(logUrl(0))
check('ok', p0.ok === true)
check('首页 30 条', p0.entries.length === PAGE_SIZE, `${p0.entries.length}`)
check('total 封顶 100', p0.total === MAX_VIEWABLE, `${p0.total}`)
check('有 total 字段', typeof p0.total === 'number')

console.log('\n=== 2. 逐页取，检查不重不漏 ===')
const allIds = new Set()
const perPage = []
for (let i = 0; i < 4; i++) {
  const r = await get(logUrl(i))
  perPage.push(r.entries.length)
  for (const e of r.entries) {
    if (allIds.has(e.id)) check(`第 ${i + 1} 页重复 id=${e.id}`, false)
    allIds.add(e.id)
  }
}
console.log(`     各页条数: ${perPage.join(', ')}`)
check('四页合计 100 条无重复', allIds.size === MAX_VIEWABLE, `${allIds.size}`)
check('末页 10 条', perPage[3] === 10, `${perPage[3]}`)

console.log('\n=== 3. 越界页（第 5 页应空）===')
const p5 = await get(logUrl(5))
check('第 5 页返回空数组', p5.entries.length === 0)
check('第 5 页 total 仍为 100', p5.total === MAX_VIEWABLE)

console.log('\n=== 4. 项目筛选 + 分页 ===')
// ⚠️ 2026-11-13 改成动态取项目名与条数。
// 原先写死 '干杂活 total = 19'、'FatFishDream total 封顶 100' ——
// 工作区改名（FatFishDream → dsh-fatfishdream-memory）后直接崩，
// 而且加一条流水就会让 19 变 20，属于「测试比被测代码还脆」。
// 现在按实际数据找出条数最多和最少的两类来断言，换目录/加数据都不会失效。
const scopesResp = await get('/api/dsh-memory/entries?table=logs&status=active&limit=1')
const allScopes = (scopesResp.scopes ?? []).map((s) => (typeof s === 'string' ? s : s.scope)).filter(Boolean)
if (allScopes.length < 2) {
  console.log('  跳过：库里不足 2 个项目，无法对比')
} else {
  // 逐个查 scope 拿到真实条数。
  //
  // ⚠️ 2026-11-15 修：原来直接拿「cap 后的 total」当作真实条数，再断言它 === 100。
  // 那等于断言「必有一个项目超过 100 条」—— 数据掉到 100 以下就红，
  // 而代码完全没问题（本机实测：最多的项目 72 条）。
  // 这又是「测试比被测代码还脆」的老毛病，只是这次脆在**数据量**上。
  //
  // 现在分两步：① 不带 cap 查真实条数；② 断言 cap 后的 total === min(真实条数, 100)。
  // 这样无论库里 5 条还是 500 条都成立，而且 cap 语义仍然被严格验证。
  const withCounts = []
  for (const sc of allScopes) {
    // 不带 cap：拿到该 scope 的全部条数
    const raw = await get(
      `/api/dsh-memory/entries?table=logs&status=active&limit=1&scope=${encodeURIComponent(sc)}`,
    )
    // 带 cap：验证封顶语义
    const capped = await get(logUrl(0, '&scope=' + encodeURIComponent(sc)))
    withCounts.push({
      scope: sc,
      rawTotal: raw.total,
      total: capped.total,
      first: capped.entries.length,
      expect: Math.min(raw.total, MAX_VIEWABLE),
    })
  }
  withCounts.sort((a, b) => b.rawTotal - a.rawTotal)
  const big = withCounts[0]
  const small = withCounts[withCounts.length - 1]
  console.log(`  数据最多的项目：${big.scope}（真实 ${big.rawTotal} 条，cap 后 total=${big.total}）`)
  console.log(`  数据最少的项目：${small.scope}（真实 ${small.rawTotal} 条，cap 后 total=${small.total}）`)

  // 最多的那个：cap 后的 total 必须 = min(真实条数, 100)
  check(
    `${big.scope} total = min(真实 ${big.rawTotal}, ${MAX_VIEWABLE})`,
    big.total === big.expect,
    `${big.total}`,
  )
  // 首页条数 = min(真实条数, 30)：数据不足 30 条时不该硬要满页
  check(
    `${big.scope} 首页 ${Math.min(big.rawTotal, PAGE_SIZE)} 条`,
    big.first === Math.min(big.rawTotal, PAGE_SIZE),
    `${big.first}`,
  )

  // 回归：按 scope 过滤后，返回的条目必须全部属于该 scope
  const scopedCheck = await get(logUrl(0, '&scope=' + encodeURIComponent(big.scope)))
  check(`全部属于 ${big.scope}`, scopedCheck.entries.every((e) => e.scope === big.scope))
}

console.log('\n=== 5. 其他页签不分页（limit 300，无 cap）===')
const rules = await get('/api/dsh-memory/entries?table=rules&status=active&limit=300')
// 条数是活的，不写死 —— 只断言「limit 够大时能拿到全部 total」
check('rules 不受 cap 影响（返回条数 = total）', rules.entries.length === rules.total, `${rules.entries.length} vs ${rules.total}`)
console.log(`  rules total = ${rules.total}`)

console.log('\n=== 6. 清除筛选后回到第一页语义 ===')
const back = await get(logUrl(0))
check('回到第一页取到最新 30 条', back.entries.length === PAGE_SIZE)
check(
  '第一页第一条是最新的',
  back.entries[0].ts >= back.entries[back.entries.length - 1].ts,
)

console.log('\n=== 7. 分页边界处的稳定性（连续两次同页请求）===')
const a = await get(logUrl(1))
const b = await get(logUrl(1))
check(
  '同一页两次请求结果一致',
  JSON.stringify(a.entries.map((e) => e.id)) === JSON.stringify(b.entries.map((e) => e.id)),
)

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
