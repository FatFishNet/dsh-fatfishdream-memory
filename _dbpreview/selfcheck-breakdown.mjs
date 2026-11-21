/**
 * v5 库体积分层自检（`/api/dsh-memory/stats-breakdown`）。
 *
 * 为什么单独一个脚本：
 *   1. 这是 GUI「存储设置」页的数据源，坏了不会报错，只会显示错数字
 *      —— 而它的**全部意义**就是「让用户看懂库为什么这么大」；
 *   2. 它有个非显然的口径：`dbstat` **不列空闲页**，
 *      所以 `core + archive + system + free` 必须精确等于 `page_count × page_size`。
 *      这个等式一旦不成立，分类就是漏了对象（或重复计数）。
 *   3. 它有性能约束：全库页扫描，100MB 约 160ms，**绝不能进 `/state`**。
 *
 * 用法：
 *   node _dbpreview/selfcheck-breakdown.mjs             # 存储层 + HTTP
 *   node _dbpreview/selfcheck-breakdown.mjs --no-http   # 只跑存储层
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb, syncFts } from '../dsh-fatfishdream-memory/db-schema.mjs'
import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const TMP = path.join(ROOT, '_dbpreview', 'tmp')
fs.mkdirSync(TMP, { recursive: true })
const DB = path.join(TMP, 'breakdown.db')
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix) } catch {} }

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : '  ← ' + detail}`)
}

// ---------------------------------------------------------------- 造数据
console.log('=== ① 空库：分层应该全 0，但不能报错 ===\n')
const db0 = openMemoryDb(DatabaseSync, DB)
db0.close()
let store = createDbStore(DB, {}, () => {})
const empty = store.statsBreakdown()
check('空库也能返回（不抛）', empty !== null && typeof empty.total === 'number')
check('空库 core/archive 是数字或 0', Number.isFinite(empty.core) && Number.isFinite(empty.archive),
  `core=${empty.core} archive=${empty.archive}`)
if (!empty.unavailable) {
  check('空库分层合计 == total',
    empty.core + empty.archive + empty.system + empty.free === empty.total,
    `${empty.core}+${empty.archive}+${empty.system}+${empty.free} vs ${empty.total}`)
} else {
  console.log('  （dbstat 不可用，跳过合计断言）')
}
store.close()

// 重新建库并灌入可区分的数据
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + suffix) } catch {} }
store = createDbStore(DB, {}, () => {})

const logBody = '开发日志正文：用 VACUUM INTO 备份，busy_timeout 没生效，沙箱与行号预算口径。'
for (let i = 0; i < 40; i++) {
  store.appendLog('P', `${logBody} #${i}`, { topic: '开发日志', summary: `第${i}条`, keywords: 'VACUUM｜沙箱' })
}
for (let i = 0; i < 20; i++) {
  store.appendArchive({ scope: 'P', role: i % 2 ? 'user' : 'assistant', text: `${logBody} archive #${i}` })
}
for (let i = 0; i < 5; i++) {
  store.appendArchive({ scope: 'P', role: 'user', text: 'X'.repeat(3000) + ` #${i}` })
}

console.log('\n=== ② 有数据：分层口径 ===\n')
const b = store.statsBreakdown({ maxAgeMs: 0 })
check('返回 total / fileSize', Number.isFinite(b.total) && Number.isFinite(b.fileSize),
  `total=${b.total} fileSize=${b.fileSize}`)

if (b.unavailable) {
  console.log('  （dbstat 不可用，只验证降级路径）')
  check('dbstat 不可用时给出 unavailable 标记', b.unavailable === 'dbstat')
  check('降级时 core/archive 是 null（而不是骗人的 0）',
    b.core === null && b.archive === null)
} else {
  // ★ 核心等式：dbstat 不列空闲页，所以必须另加 free
  const sum = b.core + b.archive + b.system + b.free
  check('core+archive+system+free 精确等于 total（dbstat 不含空闲页）',
    sum === b.total, `${sum} vs ${b.total}，差 ${b.total - sum}`)

  check('free == freelist_count × page_size',
    b.free === b.freePages * b.pageSize,
    `free=${b.free} freePages=${b.freePages} pageSize=${b.pageSize}`)

  check('archive 层被单独识别出来（> 0）', b.archive > 0, `archive=${b.archive}`)
  check('core 层包含流水（> 0）', b.core > 0, `core=${b.core}`)
  check('占比加起来 ≈ 100%（允许四舍五入误差）',
    Math.abs(b.pct.core + b.pct.archive + b.pct.system + b.pct.free - 100) <= 0.4,
    `${b.pct.core}+${b.pct.archive}+${b.pct.system}+${b.pct.free}`)

  // 索引归属：idx_archive_* 必须算 archive，idx_logs_* 必须算 core
  const byName = Object.fromEntries(b.byObject.map((o) => [o.name, o.bucket]))
  const idxArchive = Object.entries(byName).filter(([n]) => n.startsWith('idx_archive_'))
  const idxLogs = Object.entries(byName).filter(([n]) => n.startsWith('idx_logs_'))
  check('idx_archive_* 归 archive 层（且确实存在）',
    idxArchive.length > 0 && idxArchive.every(([, k]) => k === 'archive'),
    JSON.stringify(idxArchive))
  check('idx_logs_* 归 core 层（且确实存在）',
    idxLogs.length > 0 && idxLogs.every(([, k]) => k === 'core'),
    JSON.stringify(idxLogs))
  check('archive_fts_* 归 archive 层',
    Object.entries(byName).filter(([n]) => n.startsWith('archive_fts')).every(([, k]) => k === 'archive'))
  check('sqlite_* 归 system 层', byName['sqlite_schema'] === 'system', String(byName['sqlite_schema']))
}

console.log('\n=== ③ 缓存行为 ===\n')
const first = store.statsBreakdown({ maxAgeMs: 0 })
check('fresh 时 cached=false', first.cached === false)
const second = store.statsBreakdown()
check('立即再取命中缓存', second.cached === true)
store.invalidateBreakdown()
const third = store.statsBreakdown()
check('invalidateBreakdown 后失效', third.cached === false)

console.log('\n=== ④ stats() 不该被污染（它不能碰 dbstat）===\n')
const src = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/db-store.mjs'), 'utf8')
const statsAt = src.indexOf('function stats()')
const statsEnd = src.indexOf('function listScopes', statsAt)
const statsBody = src.slice(statsAt, statsEnd > statsAt ? statsEnd : statsAt + 2000)
check('stats() 函数体里没有 dbstat', !/dbstat/.test(statsBody))
check('stats() 仍然返回 dbSize（GUI 兼容）', /dbSize/.test(statsBody))

store.close()

// ---------------------------------------------------------------- ⑤ HTTP
const skipHttp = process.argv.includes('--no-http')
const BASE = process.env.DSH_WEB_URL || process.env.DSH_BASE
if (skipHttp) {
  console.log('\n=== ⑤ HTTP（已跳过 --no-http）===')
} else if (!BASE) {
  console.log('\n=== ⑤ HTTP（跳过：没有 DSH_WEB_URL）===')
} else {
  console.log('\n=== ⑤ HTTP：真实库 ===\n')
  const get = async (p) => {
    const res = await fetch(BASE + p)
    let body = null
    try { body = await res.json() } catch {}
    return { status: res.status, body }
  }
  const r = await get('/api/dsh-memory/stats-breakdown')
  check('路由已注册（不是 401）', r.status !== 401, `status=${r.status}`)
  check('返回 200 且 ok', r.status === 200 && r.body?.ok === true, `status=${r.status}`)
  if (r.body?.ok && !r.body.unavailable) {
    check('真实库分层合计 == total',
      r.body.core + r.body.archive + r.body.system + r.body.free === r.body.total,
      `${r.body.core}+${r.body.archive}+${r.body.system}+${r.body.free} vs ${r.body.total}`)
  }
  const cached = await get('/api/dsh-memory/stats-breakdown')
  check('第二次请求命中缓存', cached.body?.cached === true, String(cached.body?.cached))
  const fresh = await get('/api/dsh-memory/stats-breakdown?fresh=1')
  check('?fresh=1 强制重算', fresh.body?.cached === false, String(fresh.body?.cached))

  // ★ 反向断言：/state 里不能出现分层字段（它必须保持轻量）
  const st = await get('/api/dsh-memory/state')
  check('/state 里没有 breakdown 字段（保持轻量）',
    st.body?.db?.core === undefined && st.body?.db?.archiveBytes === undefined,
    JSON.stringify(Object.keys(st.body?.db ?? {})))
}

console.log('\n' + '─'.repeat(70))
console.log(`${pass} 通过 / ${fail} 失败`)
if (fail === 0) {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
} else {
  console.log(`临时库保留在 ${TMP}`)
}
process.exit(fail === 0 ? 0 : 1)
