/**
 * 自检：本轮所有改动的回归面。
 *
 * 本轮改了四处：
 *   1. listScopes(table) —— 按表统计
 *   2. entries 路由传 table 给 listScopes
 *   3. client.js 加 logScope + 下拉框（无条数）
 *   4. overview({includeFacts}) / ensureLayout({fileMode}) / ensureProject 加模式判据
 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'

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

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('=== A. 源码静态检查 ===')

const clientSrc = fs.readFileSync('dsh-fatfishdream-memory/client.js', 'utf8')
const indexSrc = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')
const storeSrc = fs.readFileSync('dsh-fatfishdream-memory/db-store.mjs', 'utf8')

// 1. 流水下拉不应再有条数（要定位到 log 那个分支，不能用 indexOf 盲切）
const logIdx = clientSrc.indexOf("tab === 'log'\n                ? h(")
const logBlock = logIdx >= 0 ? clientSrc.slice(logIdx, logIdx + 1800) : ''
check(
  '流水下拉不带条数',
  logBlock.length > 0 &&
    !logBlock.includes('（${s.n}）') &&
    logBlock.includes("h('option', { key: s.scope, value: s.scope }, s.scope)"),
  logBlock.length > 0 ? '' : '未定位到 log 分支',
)
// 2. 规则页下拉仍带条数
check('规则页下拉仍带条数', /\$\{s\.scope\}（\$\{s\.n\}）/.test(clientSrc))
// 3. load 依赖含 logScope（分页后还多了 page）
check(
  'load 依赖数组含 logScope 与 page',
  /\[tab, kind, scope, query, showInactive, fromDate, toDate, logScope, page\]/.test(clientSrc),
)
// 4. load 在流水页传 scope
check('load 在流水页传 scope', /tab === 'log' && logScope/.test(clientSrc))
// 5. 路由把 table 传给 listScopes
check('路由传 table 给 listScopes', /listScopes\(table\)/.test(indexSrc))
// 6. listScopes 有白名单
check('listScopes 有表名白名单', /table === 'logs' \? 'logs' : 'rules'/.test(storeSrc))
// 7. ensureLayout 不再有 fileMode 分支（2026-11-13 剥离后只剩 policy.md 需要预建）
check('ensureLayout 不再预建 facts.md', !/fileMode && !\(await exists\(paths\.facts\)\)/.test(indexSrc))
check('ensureLayout 仍预建 policy.md', /atomicWrite\(paths\.policy, POLICY_TEMPLATE\)/.test(indexSrc))
// 8. agent/created 不再预建任何 .md（2026-11-13 剥离后，整段已删除）
check('agent/created 不再调用 ensureProject', !/store\.ensureProject\(resolved/.test(indexSrc))
check('agent/created 不再调用 ensureMonthlyLog', !/store\.ensureMonthlyLog\(resolved/.test(indexSrc))
// 9. overview 已移除 includeFacts（2026-11-13 剥离后不再有文件式回退）
check('overview 不再有 includeFacts 参数', !/options\.includeFacts !== false/.test(indexSrc))
check('overview 返回 statsSource=db', /statsSource: 'db'/.test(indexSrc))

// ---- v4：全量记录（原文归档 + 情绪全记）----
// 这几条是「静态能查、但改坏了要等用户数据丢了才发现」的地方：
//   · 归档必须两个监听都写（user 少写 = 用户原话永远丢）
//   · 归档必须在情绪闸门**之前**（被拦下的提示词形态也要留档）
//   · 情绪不能再按阈值丢弃（否则又变回「取舍」）
const storeSrcSchema = fs.readFileSync('dsh-fatfishdream-memory/db-schema.mjs', 'utf8')
check('SCHEMA_VERSION = 5', /export const SCHEMA_VERSION = 5/.test(storeSrcSchema))
check('FTS_COLUMNS 含 archive（2 列）',
  /archive: \['text', 'seg'\]/.test(storeSrcSchema))
check('index.js 两处写 archive（user + assistant）',
  (indexSrc.match(/dbStore\.appendArchive\(/g) ?? []).length >= 2,
  `${(indexSrc.match(/dbStore\.appendArchive\(/g) ?? []).length} 处`)
// 顺序判据用「user 归档块」与「情绪闸门」在源码里的相对位置。
// 用角色字面量定位归档块：user 侧那处带有 `role: 'user',` 且紧跟 text。
const userArchAt = indexSrc.indexOf("role: 'user',\n            text,")
const gateAt = indexSrc.indexOf('const skipReason = (() => {')
check('user 归档在情绪闸门之前（被拦下的提示词也要留档）',
  userArchAt > -1 && gateAt > -1 && userArchAt < gateAt,
  `archive@${userArchAt} gate@${gateAt}`)
check('情绪不再按阈值丢弃（遍历全部 hits）',
  /for \(const hit of analysis\.hits\)/.test(indexSrc) &&
  !/hit\.score >= STRONG_THRESHOLD\)\.map|filter\(\(hit\) => hit\.score >= STRONG_THRESHOLD\)/.test(indexSrc))
check('注入里给了 archive 查询入口', /archive\?scope=/.test(indexSrc))

// ---- v5：emotion 退出检索池 + confidence 归一化 + entries 已删 ----
// 静态侧（源码）：search() 里不能再有 emotion 那段。
const storeSrcFile = fs.readFileSync('dsh-fatfishdream-memory/db-store.mjs', 'utf8')
const searchFnAt = storeSrcFile.indexOf('function search(query,')
const searchFnEnd = storeSrcFile.indexOf('function listEntries', searchFnAt)
const searchBody = searchFnAt > -1 && searchFnEnd > searchFnAt
  ? storeSrcFile.slice(searchFnAt, searchFnEnd)
  : ''
check('search() 里没有 emotion 查询', !/push\('emotion'/.test(searchBody),
  searchBody ? '' : '未定位到 search() 函数体')
check('search() 也不 query emotion_fts', !/FROM emotion_fts/.test(searchBody))
// 反过来：别把 emotion_fts 整个删掉 —— GUI 情绪页签的搜索框还要用
check('emotion_fts 仍存在（GUI 页签用）', /emotion_fts/.test(storeSrcFile) &&
  /emotion_fts/.test(storeSrcSchema))
// 迁移里必须保留「先删虚拟表本体再清影子表」的顺序
check('v5 迁移先 DROP entries_fts 本体（否则影子表报错）',
  storeSrcSchema.indexOf("DROP TABLE IF EXISTS entries_fts'") > -1 &&
  storeSrcSchema.indexOf("DROP TABLE IF EXISTS entries_fts'") <
    storeSrcSchema.indexOf('DROP TABLE IF EXISTS "entries_fts'))

console.log('\n=== B. 数据完整性 ===')
const d = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })
check('integrity_check', d.prepare('PRAGMA integrity_check').get().integrity_check === 'ok')
const uv = d.prepare('PRAGMA user_version').get().user_version
check('schema v5', uv === 5, `v${uv}`)
const counts = {}
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  counts[t] = d.prepare(`SELECT COUNT(*) c FROM ${t} WHERE status='active'`).get().c
}
// 流水允许为空：用户会主动清空 logs（2026-11-14 清过一次）。
// 断言「画像/规则/情绪必须有数据」，流水只报告条数、不要求 >0。
check('画像/规则/情绪有数据（流水允许为空）',
  ['profile', 'rules', 'emotion'].every((t) => counts[t] > 0), JSON.stringify(counts))

// v4 原文归档：**不进 byTable**，单独计数（它不是「记忆条目」）。
// 迁移前库里没有这张表 —— 那说明插件还没重载，不是本脚本的问题，直接报出来。
let archiveCount = null
try {
  archiveCount = d.prepare('SELECT COUNT(*) c FROM archive').get().c
} catch {
  archiveCount = null
}
check('archive 表存在（v4 已迁移）', archiveCount !== null,
  archiveCount === null ? '没有 archive 表 → 插件还没重载' : '')
// 条数只报告、不断言 —— 和 logs 同一个道理：测试不该依赖用户对话量。
// 迁移**不回填历史对话**，所以刚迁完 archive=0 是正常的，
// 「写不写得进去」由 selfcheck-archive 的存储层断言 + 真实发一句话验证（TESTING §10.1.1）。
console.log(`  ℹ️ archive 现有 ${archiveCount} 条原文（迁移不回填历史，0 条属正常）`)

// v5：v1 的 entries 冷存档已删。留着它的残留表说明迁移没跑干净。
const legacyTables = d.prepare(
  `SELECT name FROM sqlite_master WHERE type='table' AND (name='entries' OR name LIKE 'entries_fts%')`,
).all().map((r) => r.name)
check('v1 entries 冷存档已彻底移除（v5）', legacyTables.length === 0, legacyTables.join(','))

// v5：confidence 只能是 high / low / legacy 三种（历史上还混过中文『高置信』）。
const confRows = d.prepare('SELECT confidence, COUNT(*) n FROM emotion GROUP BY confidence').all()
const badConf = confRows.filter((r) => !['high', 'low', 'legacy'].includes(r.confidence))
check('emotion.confidence 已归一化（无中文/无 NULL）', badConf.length === 0,
  JSON.stringify(confRows))

console.log('\n=== C. FTS 索引与表是否一致（应比全量，不是 active）===')
// archive 也有一张 contentless FTS，同样要逐表比对，否则原文层会「写进去但搜不到」。
for (const t of ['profile', 'rules', 'emotion', 'logs', 'archive']) {  let total
  try {
    total = d.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  } catch {
    console.log(`  （跳过：没有 ${t} 表）`)
    continue
  }
  const fts = d.prepare(`SELECT COUNT(*) c FROM ${t}_fts`).get().c
  check(`${t}_fts 与表全量一致`, fts === total, `表=${total} fts=${fts}`)
}

console.log('\n=== D. 中文检索仍然可用 ===')
// 依赖「历史关键词在流水里」：流水被清空/只剩几条时这些词自然 0 条，
// 断言没意义。检索能力由 selfcheck-e2e-memory（真实写入+检索）与
// selfcheck-cap（自建种子）覆盖。
if (counts.logs < 50) {
  console.log(`  （跳过：流水只有 ${counts.logs} 条，不做历史关键词断言）`)
} else {
  for (const q of ['沙箱', '行号', '预算']) {
    const seg = String(q).replace(/[\u4e00-\u9fa5]/g, (c) => ` ${c} `).trim()
    const mq = seg.split(/\s+/).filter(Boolean).map((s) => `"${s}"`).join(' AND ')
    let hits = 0
    try {
      hits = d.prepare(`SELECT COUNT(*) c FROM logs_fts WHERE logs_fts MATCH ?`).get(mq).c
    } catch {
      hits = -1
    }
    check(`检索「${q}」`, hits > 0, `${hits} 条`)
  }
}

console.log('\n=== E. 记忆根目录清洁度 ===')
const rootFiles = fs.readdirSync(MEM_ROOT)
check('无 facts.md', !rootFiles.includes('facts.md'))
check('有 memory.db', rootFiles.includes('memory.db'))
check('有 policy.md', rootFiles.includes('policy.md'))
check('有 state.json', rootFiles.includes('state.json'))
check('无项目模板目录', !rootFiles.some((f) => f !== 'logs' && fs.statSync(`${MEM_ROOT}/${f}`).isDirectory()))

d.close()

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

