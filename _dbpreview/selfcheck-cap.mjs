/**
 * 自检：listEntries 的 cap 分页逻辑。
 *
 * 要验证的不是「能返回数据」，而是：
 *   - total 是否等于 cap（而不是全表）
 *   - 翻页是否不重不漏
 *   - 超过 cap 的老数据是否真的被排除
 *   - 混合 scope / 时间筛选时 cap 是否仍然正确
 */
// 从脚本自身位置推仓库根 —— 2026-11-13 工作区改名后，
// 原先写死的 D:/workspace/FatFishDream 会导致 import 失败。
// 改成相对解析后，仓库放到任何目录（甚至换机器）都能跑。
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

// 记忆根目录从指针文件读，不要写死 —— 迁移根目录后脚本会全崩。
// 指针由插件自己维护（~/.dsh/memory-root.json）。
const resolveMemoryRoot = () => {
  const cands = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'memory-root.json'),
  ]
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      if (j && typeof j.root === 'string' && j.root !== '') return j.root
    } catch {
      /* 下一个候选 */
    }
  }
  return 'D:\\dsh-fatfishdream-memory'
}
const MEM_ROOT = resolveMemoryRoot().replace(/\\/g, '/')
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createDbStore } = await import(`file://${path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs').replace(/\\/g, '/')}`)

// ⚠️ 不依赖真实流水：用户随时可能清空 logs（2026-11-14 就清过）。
// 用一个临时库造 150 条固定数据来测 cap 逻辑；用完删掉。
// 以前直接用真实库，清空后本测试会成片失败 —— 测试比被测代码还脆。
const TMP = path.join(REPO, '_dbpreview', 'tmp')
fs.mkdirSync(TMP, { recursive: true })
const TMP_DB = path.join(TMP, 'cap-seed.db')
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix) } catch {} }

const s = createDbStore(TMP_DB, {}, () => {})
const SEED_TOTAL = 150
const SEED_SCOPE = 'FatFishDream'
for (let i = 0; i < SEED_TOTAL; i++) {
  s.appendLog(i % 3 === 0 ? SEED_SCOPE : '测试项目', `cap 自检种子 #${i}`, {
    topic: '技术讨论',
    summary: `cap 种子 ${i}`,
    keywords: `CAPSEED${i}`,
  })
}
const seededTotal = s.stats().byTable.logs
const cleanup = () => {
  try { s.close() } catch {}
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix) } catch {} }
  try { fs.rmdirSync(TMP) } catch {}
}
let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {  if (ok) {
    pass++
    console.log(`  OK   ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

check('种子数据条数 = 150', seededTotal === SEED_TOTAL, `${seededTotal}`)

console.log('=== 1. 无 cap（旧行为）应等于全表 ===')
const all = s.listEntries('logs', { limit: 1000, status: undefined })
const realTotal = seededTotal
check('无 cap 时 total = 全表条数', all.total === realTotal, `${all.total} vs ${realTotal}`)
check('无 cap 时 rows 长度 = total', all.rows.length === all.total, `${all.rows.length}`)

console.log('\n=== 2. cap=100：total 应封顶 100 ===')
const capped = s.listEntries('logs', { limit: 30, cap: 100, status: undefined })
check('total 封顶为 100', capped.total === 100, `实际 ${capped.total}`)
check('第一页 30 条', capped.rows.length === 30, `${capped.rows.length} 条`)

console.log('\n=== 3. 翻页不重不漏 ===')
const seen = new Set()
let pages = 0
for (let offset = 0; offset < 100; offset += 30) {
  const p = s.listEntries('logs', { limit: 30, offset, cap: 100, status: undefined })
  pages++
  for (const r of p.rows) {
    if (seen.has(r.id)) check(`第 ${pages} 页出现重复 id=${r.id}`, false)
    seen.add(r.id)
  }
  console.log(`     第 ${pages} 页(offset=${offset}): ${p.rows.length} 条`)
}
check('四页合计 100 条且无重复', seen.size === 100, `去重后 ${seen.size}`)

console.log('\n=== 4. 被 cap 排除的应该是更早的 ===')
// ⚠️ 2026-11-13 改了判据：排序已从 ts 改为 id（见 db-store.mjs 的 TS_ORDER 注释）。
// 原因：库里 ts 有两种互不可比的写法（无 Z / 带 Z），且迁移造成 4 处时间逆序，
// 任何「按 ts 排」的写法都会把最新记录压到后面。id 是插入顺序，全库连续无断号，
// 才真正对应「最近写入的」。
// 所以「更早」= id 更小，不是 ts 更小。这条断言必须跟着排序键走。
const cappedRows = capped.rows.length === 100 ? capped.rows : s.listEntries('logs', { limit: 100, cap: 100, status: undefined }).rows
const boundary = cappedRows[cappedRows.length - 1]
const allRows = s.listEntries('logs', { limit: 1000, status: undefined }).rows
const cappedIds = new Set(cappedRows.map((r) => r.id))
const excluded = allRows.filter((r) => !cappedIds.has(r.id))
check('存在被排除的旧条目', excluded.length > 0, `${excluded.length} 条被排除`)
check(
  '被排除的全部 id 小于保留边界（= 更早插入）',
  excluded.every((r) => r.id < boundary.id),
  `边界 id=${boundary.id}`,
)

console.log('\n=== 5. cap + scope 组合（min(cap, 该scope总数)）===')
const scoped = s.listEntries('logs', { scope: SEED_SCOPE, limit: 30, cap: 100, status: undefined })
const scopedAll = s.listEntries('logs', { scope: SEED_SCOPE, limit: 1000, status: undefined })
check(
  'cap 后 total = min(100, 该scope总数)',
  scoped.total === Math.min(100, scopedAll.total),
  `cap 后 ${scoped.total}，scope 全量 ${scopedAll.total}`,
)

console.log('\n=== 6. cap 比总数大时无影响 ===')
const big = s.listEntries('logs', { limit: 30, cap: 9999, status: undefined })
check('cap=9999 时 total = 全表', big.total === realTotal, `${big.total} vs ${realTotal}`)

console.log('\n=== 7. cap=0 表示不限 ===')
const zero = s.listEntries('logs', { limit: 30, cap: 0, status: undefined })
check('cap=0 时 total = 全表', zero.total === realTotal, `${zero.total} vs ${realTotal}`)

console.log('\n=== 8. rules / emotion 无 cap 时行为不变 ===')
const rules = s.listEntries('rules', { limit: 200 })
check('rules 返回 {rows,total} 结构', Array.isArray(rules.rows) && typeof rules.total === 'number', `total=${rules.total}`)
const emo = s.listEntries('emotion', { limit: 30 })
check('emotion 返回 {rows,total} 结构', Array.isArray(emo.rows) && typeof emo.total === 'number', `total=${emo.total}`)

cleanup()
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
