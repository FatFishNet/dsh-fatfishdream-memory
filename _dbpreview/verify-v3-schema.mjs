/**
 * 验证 schema v3（三层记忆）的两条路径。
 *
 * ① 现有库迁移：拿 _dbbackup 里 v2 的备份副本 → openMemoryDb → 检查
 *    user_version / 字段 / 摘要兜底 / FTS 重建 / 中文与英文可检索 / 完整性。
 * ② 空库全量建：新文件 → openMemoryDb → 结构应与 ① 完全一致。
 *
 * 不碰真实库（用的是 _dbpreview/tmp 下的副本）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  openMemoryDb, SCHEMA_VERSION, buildMatchQuery, syncFts, FTS_COLUMNS,
} from '../dsh-fatfishdream-memory/db-schema.mjs'
import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const TMP = path.join(ROOT, '_dbpreview', 'tmp')
fs.mkdirSync(TMP, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : '  ← ' + detail}`)
}

function backupSource() {
  const dir = path.join(ROOT, '_dbbackup')
  const files = fs.readdirSync(dir).filter((f) => f.includes('before-v3')).sort()
  if (files.length === 0) throw new Error('_dbbackup 里找不到 before-v3 备份')
  return path.join(dir, files[files.length - 1])
}

function ftsCols(db, table) {
  return db.prepare(`PRAGMA table_info(${table}_fts)`).all().map((c) => c.name)
}

function count(db, table) {
  return db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c
}

// ---------------------------------------------------------------- ① 迁移
console.log('=== ① 现有库迁移（v2 → v3）===\n')
const src = backupSource()
const migrated = path.join(TMP, 'migrated-v3.db')
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(migrated + suffix) } catch {}
}
fs.copyFileSync(src, migrated)
console.log('源: ' + path.basename(src) + '\n')

const db = openMemoryDb(DatabaseSync, migrated)

check('SCHEMA_VERSION = 5', SCHEMA_VERSION === 5, String(SCHEMA_VERSION))
check('user_version 已升到 5',
  db.prepare('PRAGMA user_version').get().user_version === 5,
  String(db.prepare('PRAGMA user_version').get().user_version))

const logCols = db.prepare('PRAGMA table_info(logs)').all().map((c) => c.name)
check('logs 有 summary 列', logCols.includes('summary'))
check('logs 有 keywords 列', logCols.includes('keywords'))
check('logs_fts 是 5 列', ftsCols(db, 'logs').length === 5, ftsCols(db, 'logs').join(','))

// ---- v4：原始对话归档 ----
const archCols = db.prepare('PRAGMA table_info(archive)').all().map((c) => c.name)
check('archive 表存在且列齐全',
  ['ts', 'scope', 'role', 'text', 'session_id', 'turn', 'step'].every((c) => archCols.includes(c)),
  archCols.join(','))
check('archive_fts 是 2 列（text, seg）',
  ftsCols(db, 'archive').join(',') === 'text,seg', ftsCols(db, 'archive').join(','))
check('FTS_COLUMNS.archive 与建表一致',
  FTS_COLUMNS.archive.join(',') === ftsCols(db, 'archive').join(','))
check('logs_fts 列顺序 = summary,keywords,text,topic,seg',
  ftsCols(db, 'logs').join(',') === 'summary,keywords,text,topic,seg',
  ftsCols(db, 'logs').join(','))
check('FTS_COLUMNS.logs 与建表列一致',
  FTS_COLUMNS.logs.join(',') === ftsCols(db, 'logs').join(','))

const nLogs = count(db, 'logs')
check('流水条数与备份一致（487）', nLogs === 487, String(nLogs))
check('其他三表条数不变（profile 11 / rules 136 / emotion 17）',
  count(db, 'profile') === 11 && count(db, 'rules') === 136 && count(db, 'emotion') === 17,
  `${count(db, 'profile')}/${count(db, 'rules')}/${count(db, 'emotion')}`)

const nullSummary = db.prepare('SELECT COUNT(*) c FROM logs WHERE summary IS NULL').get().c
const emptySummary = db.prepare("SELECT COUNT(*) c FROM logs WHERE summary=''").get().c
check('所有流水都有 summary 兜底（无 NULL / 空串）',
  nullSummary === 0 && emptySummary === 0, `NULL=${nullSummary} 空=${emptySummary}`)

// 抽样：summary 必须是 text 前 40 字（JULIAN 之外还要真比对，不能只看条数）
const samples = db.prepare('SELECT id,text,summary FROM logs ORDER BY id LIMIT 5').all()
const sampleOk = samples.every((r) => r.summary === String(r.text).slice(0, 40))
check('抽样 5 条：summary = text 前 40 字', sampleOk,
  samples.map((r) => `#${r.id} ${JSON.stringify(r.summary)}`).join(' | '))

// FTS 重建：中文逐字（seg 列）与英文（text 列）都要能命中
const zh = buildMatchQuery('行号')
const en = buildMatchQuery('bm25')
const zhHit = db.prepare(
  `SELECT COUNT(*) c FROM logs_fts f JOIN logs l ON l.id=f.rowid WHERE logs_fts MATCH ?`,
).get(zh).c
const enHit = db.prepare(
  `SELECT COUNT(*) c FROM logs_fts f JOIN logs l ON l.id=f.rowid WHERE logs_fts MATCH ?`,
).get(en).c
check('中文（逐字）能检索到', zhHit > 0, `MATCH ${zh} → ${zhHit}`)
check('英文技术词能检索到', enHit > 0, `MATCH ${en} → ${enHit}`)

// bm25 5 权重必须能跑（个数不对会直接抛）
let weightOk = false
let weightErr = ''
try {
  const row = db.prepare(
    `SELECT l.id, bm25(logs_fts, 3.0, 2.0, 1.0, 1.0, 1.0) score FROM logs_fts f
     JOIN logs l ON l.id=f.rowid WHERE logs_fts MATCH ? ORDER BY score ASC LIMIT 3`,
  ).all(zh)
  weightOk = row.length > 0 && typeof row[0].score === 'number'
} catch (e) {
  weightErr = e.message
}
check('bm25 接受 5 个权重且能排序', weightOk, weightErr)

// 更新路径：syncFts 用 'delete' 带原值，5 列 contentless 表必须能删
let updateOk = false
let updateErr = ''
try {
  const r = db.prepare('SELECT id,text,topic,summary,keywords FROM logs ORDER BY id LIMIT 1').get()
  const next = { ...r, summary: '改过的摘要' }
  db.exec('BEGIN')
  syncFts(db, 'logs', r.id, next, r)
  db.prepare('UPDATE logs SET summary=? WHERE id=?').run(next.summary, r.id)
  db.exec('COMMIT')
  const hit = db.prepare('SELECT COUNT(*) c FROM logs_fts WHERE logs_fts MATCH ?')
    .get(buildMatchQuery('改过')).c
  updateOk = hit > 0
} catch (e) {
  try { db.exec('ROLLBACK') } catch {}
  updateErr = e.message
}
check('更新时 contentless FTS 可 delete + 重插', updateOk, updateErr)

const integ = db.prepare('PRAGMA integrity_check').get().integrity_check
check('integrity_check = ok', integ === 'ok', integ)
db.close()

// 二次打开不得重复迁移（迁移按 user_version 跳过）
const again = openMemoryDb(DatabaseSync, migrated)
check('二次打开不重跑迁移，条数不变', count(again, 'logs') === 487, String(count(again, 'logs')))
again.close()

// ---------------------------------------------------------------- ② 空库
console.log('\n=== ② 空库全量建 ===\n')
const fresh = path.join(TMP, 'fresh-v3.db')
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(fresh + suffix) } catch {}
}
const nd = openMemoryDb(DatabaseSync, fresh)
check('空库 user_version = 5', nd.prepare('PRAGMA user_version').get().user_version === 5)
check('空库 archive_fts 也是 2 列',
  ftsCols(nd, 'archive').join(',') === 'text,seg', ftsCols(nd, 'archive').join(','))
check('空库 logs_fts 也是 5 列',
  ftsCols(nd, 'logs').join(',') === 'summary,keywords,text,topic,seg',
  ftsCols(nd, 'logs').join(','))
check('空库三张旧表 FTS 仍是 3 列',
  ftsCols(nd, 'profile').join(',') === 'text,topic,seg')
// 空库走一遍真实写入路径
syncFts(nd, 'logs', 1, { text: '空库写入测试 busy_timeout', topic: '开发日志', summary: '空库摘要', keywords: 'VACUUM INTO｜busy_timeout' })
const fh = nd.prepare('SELECT COUNT(*) c FROM logs_fts WHERE logs_fts MATCH ?').get(buildMatchQuery('busy_timeout')).c
check('空库写入后可按关键词检索', fh > 0, String(fh))
nd.close()

// ---------------------------------------------------------------- ③ 存储层
console.log('\n=== ③ 存储层（db-store）===\n')
const storePath = path.join(TMP, 'store-v3.db')
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(storePath + suffix) } catch {}
}
const store = createDbStore(storePath, {}, () => {})

const w = store.appendLog('测试项目', '正文：用 VACUUM INTO 备份，busy_timeout 没生效', {
  topic: '开发日志', summary: 'VACUUM 备份踩坑', keywords: 'VACUUM INTO｜busy_timeout',
})
check('appendLog 返回 summary', w.summary === 'VACUUM 备份踩坑', String(w.summary))

const enHit2 = store.search('busy_timeout', { projectName: '测试项目' })
check('按英文关键词命中', enHit2.length === 1, String(enHit2.length))
check('命中带 summary', enHit2[0]?.summary === 'VACUUM 备份踩坑', String(enHit2[0]?.summary))
check('命中带 keywords', enHit2[0]?.keywords === 'VACUUM INTO｜busy_timeout', String(enHit2[0]?.keywords))
check('命中带 topic', enHit2[0]?.topic === '开发日志', String(enHit2[0]?.topic))

const zhHit2 = store.search('备份踩坑', { projectName: '测试项目' })
check('中文摘要里的词也能命中（seg 含 summary）', zhHit2.length === 1, String(zhHit2.length))

const otherScope = store.search('busy_timeout', { projectName: '别的项目' })
check('scope 隔离仍然有效', otherScope.length === 0, String(otherScope.length))

const ls = store.listEntries('logs', { scope: '测试项目' })
check('listEntries 返回 summary/keywords',
  ls.rows[0]?.summary === 'VACUUM 备份踩坑' && ls.rows[0]?.keywords === 'VACUUM INTO｜busy_timeout',
  JSON.stringify(ls.rows[0]))

// 手写摘要（非兜底）改正文时不应被覆盖
store.updateText('logs', w.id, '改后的正文，不再提那个技术词')
const after = store.getById('logs', w.id)
check('改正文保留手写摘要', after.summary === 'VACUUM 备份踩坑', String(after.summary))
check('keywords 不随正文改动丢失（仍可被该词命中）',
  store.search('busy_timeout', { projectName: '测试项目' }).length === 1)

// 没有摘要的老式写入：改正文时应自动补上前 40 字兜底
const w2 = store.appendLog('测试项目', '原本没有摘要的一行正文')
check('无摘要时 summary 为空', w2.summary === null, String(w2.summary))
store.updateText('logs', w2.id, '改过的正文，长度足够拿来当摘要兜底')
const after2 = store.getById('logs', w2.id)
check('改正文后自动补摘要兜底',
  after2.summary === '改过的正文，长度足够拿来当摘要兜底', String(after2.summary))
check('旧正文已从 FTS 移除',
  store.search('原本', { projectName: '测试项目' }).length === 0,
  String(store.search('原本', { projectName: '测试项目' }).length))

// ---------------------------------------------------------------- ④ archive
// v4 的原文归档层：写入不挑内容、检索按项目/角色/关键词。
// 这一段用**临时库**，不碰真实库，也不依赖插件是否已重载。
console.log('\n=== ④ archive 原文归档（存储层）===\n')

const a1 = store.appendArchive({
  scope: '测试项目', role: 'user', text: '今天在沙箱里把 VACUUM INTO 跑通了',
  sessionId: 's1', turn: 1, step: 0,
})
check('appendArchive 写入 user 成功', a1.written === true && Number.isInteger(a1.id), JSON.stringify(a1))

const a2 = store.appendArchive({
  scope: '测试项目', role: 'assistant', text: '好，那就把结论写进流水',
  sessionId: 's1', turn: 1, step: 1,
})
check('appendArchive 写入 assistant 成功', a2.written === true, JSON.stringify(a2))

const a3 = store.appendArchive({ scope: '别的项目', role: 'user', text: '这个项目的原文' })
check('不同 scope 也能写入', a3.written === true, JSON.stringify(a3))

check('空文本不写（written=false / empty）',
  store.appendArchive({ scope: '测试项目', role: 'user', text: '   ' }).written === false &&
  store.appendArchive({ scope: '测试项目', role: 'user', text: '' }).written === false)

const badRole = store.appendArchive({ scope: '测试项目', role: 'system', text: '不该写进去' })
check('非法 role 不写（reason 指出来）',
  badRole.written === false && String(badRole.reason).startsWith('bad-role'), JSON.stringify(badRole))

const all = store.listArchive({ scope: '测试项目' })
check('listArchive 按 scope 只返回本项目（2 条）', all.total === 2 && all.rows.length === 2,
  `total=${all.total} len=${all.rows.length}`)
check('listArchive 返回 id DESC（最新在前）',
  all.rows[0]?.id === a2.id && all.rows[1]?.id === a1.id,
  all.rows.map((r) => r.id).join(','))
check('listArchive 字段齐全（ts/scope/role/text/session_id/turn/step）',
  ['ts', 'scope', 'role', 'text', 'session_id', 'turn', 'step'].every((c) => c in (all.rows[0] ?? {})),
  Object.keys(all.rows[0] ?? {}).join(','))

const byRole = store.listArchive({ scope: '测试项目', role: 'user' })
check('role 过滤生效', byRole.total === 1 && byRole.rows[0]?.role === 'user', String(byRole.total))

// 中文逐字检索：unicode61 认不出整段中文，靠 seg 列拆字
const zhArchive = store.listArchive({ scope: '测试项目', q: '沙箱' })
check('FTS 中文二字词可检索（沙箱）',
  zhArchive.total === 1 && String(zhArchive.rows[0]?.text).includes('沙箱'),
  `total=${zhArchive.total}`)
const enArchive = store.listArchive({ scope: '测试项目', q: 'VACUUM' })
check('FTS 英文技术词可检索（VACUUM）', enArchive.total === 1, `total=${enArchive.total}`)
const missArchive = store.listArchive({ scope: '测试项目', q: '不存在的词藻' })
check('检索不到时返回空集而不是报错', missArchive.total === 0 && missArchive.rows.length === 0,
  `total=${missArchive.total}`)

const paged = store.listArchive({ scope: '测试项目', limit: 1, offset: 1 })
check('limit/offset 生效且 total 仍是全量',
  paged.rows.length === 1 && paged.rows[0]?.id === a1.id && paged.total === 2,
  `len=${paged.rows.length} id=${paged.rows[0]?.id} total=${paged.total}`)

const st = store.stats()
check('stats().archive 单独计数（不混进 byTable）',
  st.archive === 3 && st.byTable.archive === undefined, `archive=${st.archive}`)

// archive 不该出现在默认 /search 里（原文层不淹没结论层）
check('默认 search 不含 archive 原文',
  store.search('沙箱', { projectName: '测试项目' }).every((h) => h.table !== 'archive'),
  JSON.stringify(store.search('沙箱', { projectName: '测试项目' }).map((h) => h.table)))

store.close()

// FTS 与表是否一致（关掉后重新打开，确认落盘了）
const verifyStore = createDbStore(storePath, {}, () => {})
verifyStore.close()
const adb = openMemoryDb(DatabaseSync, storePath)
const aTotal = count(adb, 'archive')
const aFts = adb.prepare('SELECT COUNT(*) c FROM archive_fts').get().c
check('archive_fts 与 archive 全量一致', aFts === aTotal, `表=${aTotal} fts=${aFts}`)
check('归档原文按原样保存（不乱码、不截断）',
  adb.prepare('SELECT text FROM archive WHERE role=? ORDER BY id LIMIT 1').get('user')?.text
    === '今天在沙箱里把 VACUUM INTO 跑通了')
adb.close()

console.log('\n' + '─'.repeat(70))
console.log(`${pass} 通过 / ${fail} 失败`)
// 成功后清掉临时副本（2.6MB 库），失败时保留以便排查
if (fail === 0) {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}
process.exit(fail === 0 ? 0 : 1)

