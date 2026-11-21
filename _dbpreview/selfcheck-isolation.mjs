/**
 * 验证：检索硬隔离是否正确。
 *
 * 要验证的边界：
 *   1. projectName 隔离时，只返回本项目 + 全局规则
 *   2. profile / emotion 不隔离（画像与情绪属于用户，不属于项目）
 *   3. crossProject: true 能恢复全库
 *   4. 不传 projectName 时保持全库（兼容旧调用/测试）
 *
 * ⚠️ 2026-11-14 起：**自建临时库 + 固定种子**，不再依赖真实流水。
 * 原因：用户会清空 logs（当天就清过一次），旧版靠真实数据里的
 * 「Altezza / 咬地鲨 / 大肥鱼」做断言，清空后整份测试永久失败 ——
 * 测试不该依赖用户数据。种子用完即删。
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createDbStore } = await import(`file://${path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs').replace(/\\/g, '/')}`)

const TMP = path.join(REPO, '_dbpreview', 'tmp')
fs.mkdirSync(TMP, { recursive: true })
const TMP_DB = path.join(TMP, 'isolation-seed.db')
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix) } catch {} }

const s = createDbStore(TMP_DB, {}, () => {})

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

// ---------------------------------------------------------------- 种子
const P = 'ProjectP'
const Q = 'ProjectQ'
const R = 'ProjectR'
s.createEntry({ table: 'profile', text: '用户称呼 AI 为大肥鱼（昵称）' })
s.appendFact('跨项目通用：大肥鱼是昵称')
s.appendProjectNote(P, 'ProjectP 规则：记忆索引按 topic 统计')
s.appendProjectNote(Q, 'ProjectQ 规则：只在本项目生效')
s.appendLog(P, 'ProjectP 流水：咬地鲨 底盘数据要在本项目查', {
  topic: '技术讨论', summary: '咬地鲨底盘', keywords: '咬地鲨',
})
s.appendLog(Q, 'ProjectQ 流水：Altezza 与咬地鲨 的旧记录', {
  topic: '技术讨论', summary: 'Altezza 旧记录', keywords: 'Altezza｜咬地鲨',
})
s.appendLog(R, 'ProjectR 流水：Altezza 设计记录', {
  topic: '技术讨论', summary: 'Altezza 设计', keywords: 'Altezza',
})
// v5 断言要用到的种子：一条带模板句的情绪记录。
// 以前这种行的 text 会把「爱意 / 高置信 / 用户表达」全写进 FTS，
// 导致搜这些词命中的全是情绪而不是结论 —— 正是本次要锁死的回归点。
s.recordEmotion({ kind: '爱意', evidence: '喜欢', text: '大肥鱼我喜欢你', confidence: 'high', score: 0.9 })
check('种子数据已建立', s.stats().byTable.logs === 3 && s.stats().byTable.rules === 3, JSON.stringify(s.stats().byTable))
check('情绪种子已建立（供 v5 断言用）', s.stats().byTable.emotion === 1, JSON.stringify(s.stats().byTable))

console.log('\n=== 1. 跨项目关键词：Altezza（只在 Q / R）===')
const aIsolated = s.search('Altezza', { limit: 50, projectName: P })
const aAll = s.search('Altezza', { limit: 50, crossProject: true, projectName: P })
const aNoParam = s.search('Altezza', { limit: 50 })
check('隔离后搜不到 Altezza', aIsolated.length === 0, `${aIsolated.length} 条`)
check('crossProject 能搜到', aAll.length > 0, `${aAll.length} 条`)
check('不传 projectName 保持全库', aNoParam.length > 0, `${aNoParam.length} 条`)

console.log('\n=== 2. 本项目关键词：咬地鲨 ===')
const bIsolated = s.search('咬地鲨', { limit: 50, projectName: P })
const bAll = s.search('咬地鲨', { limit: 50, crossProject: true, projectName: P })
check('隔离后只剩本项目', bIsolated.every((r) => r.scope === P || r.scope === '__global__'), `${bIsolated.length} 条`)
check('隔离后条数 < 全库', bIsolated.length < bAll.length, `${bIsolated.length} < ${bAll.length}`)
check('跨项目会带出 ProjectQ', bAll.some((r) => r.scope === Q))

console.log('\n=== 3. 全局规则必须保留 ===')
const globalRule = s.search('大肥鱼', { limit: 50, projectName: P })
check(
  '全局/画像内容仍可见',
  globalRule.length > 0,
  `${globalRule.length} 条，scope: ${[...new Set(globalRule.map((r) => r.scope))].join(',')}`,
)

console.log('\n=== 4. profile 不隔离 / emotion 不在检索池 ===')
const prof = s.search('大肥鱼', { limit: 50, projectName: 'NonexistentProject' })
check(
  '不存在的项目也能搜到 profile',
  prof.some((r) => r.table === 'profile'),
  `profile 命中 ${prof.filter((r) => r.table === 'profile').length} 条`,
)
// 2026-11-14 v5：emotion 彻底退出检索池（个人兴趣记录，不进上下文）。
// 隔离测试里那个「允许 emotion」的过滤条件留着没有害处，但**不能**再假设
// 它会出现 —— 这里补一条正向断言，防止以后有人把它偷偷塞回 search()。
for (const q of ['爱意', '用户表达', '高置信', '喜欢']) {
  const r = s.search(q, { limit: 50, projectName: P })
  check(`「${q}」不返回 emotion`, r.every((x) => x.table !== 'emotion'),
    r.filter((x) => x.table === 'emotion').map((x) => x.id).join(','))
}

console.log('\n=== 5. 隔离对 rules 的边界（含 __global__）===')
const rulesOnly = s.search('规则', { limit: 50, projectName: P }).filter((r) => r.table === 'rules')
const scopes = [...new Set(rulesOnly.map((r) => r.scope))]
check('rules 只返回本项目 + __global__', scopes.every((x) => x === P || x === '__global__'), scopes.join(','))

console.log('\n=== 6. 各项目互不串味 ===')
for (const proj of [P, Q, R]) {
  const r = s.search('记忆', { limit: 50, projectName: proj })
  const bad = r.filter((x) => x.table !== 'profile' && x.table !== 'emotion' && x.scope !== proj && x.scope !== '__global__')
  check(`${proj} 无外来 scope`, bad.length === 0, bad.length ? bad.map((x) => x.scope).join(',') : '')
}

// ---------------------------------------------------------------- 清理
try { s.close() } catch {}
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix) } catch {} }
try { fs.rmdirSync(TMP) } catch {}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
