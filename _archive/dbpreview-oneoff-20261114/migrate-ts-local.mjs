/**
 * 一次性迁移：把库里所有带 Z 的 UTC 时间戳统一成本地时间（不带 Z）。
 *
 * 背景（2026-11-14）：
 *   库里混着两种写法 —— .md 迁移来的本地时间无后缀，新写入的 UTC 带 Z，
 *   字符串比较差 8 小时，导致时间筛选错位、模型把 UTC 当本地报。
 *   用户决定统一用**本地时间**。
 *
 * 安全要求（硬约束 1）：
 *   1. 迁移前必须已备份库（本脚本只读校验时会检查备份存在）
 *   2. 逐表校验条数不变
 *   3. 抽样比对：转换后本地时间分量必须等于转换前 UTC 转本地的分量
 *   4. 迁移后验证 FTS 可检索
 *
 * 用法：node _dbpreview/migrate-ts-local.mjs [--apply]
 *   不带 --apply 只做演练（不写库）。
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const DB = 'D:/dsh-fatfishdream-memory/memory.db'
const APPLY = process.argv.includes('--apply')

const pad = (n, w = 2) => String(n).padStart(w, '0')
/** Date → 本地时间字符串（与 db-store nowIso 同格式） */
const toLocalTs = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
  `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`

// ── 0. 备份检查 ────────────────────────────────────
const backups = fs.readdirSync('D:/dsh-fatfishdream-memory').filter((f) => f.startsWith('_backup-ts-local-'))
if (backups.length === 0) {
  console.error('❌ 没找到 _backup-ts-local-*.db 备份，拒绝迁移')
  process.exit(1)
}
console.log('✅ 备份存在:', backups[0])

const db = new DatabaseSync(DB)
const TABLES = ['profile', 'rules', 'emotion', 'logs']

// ── 1. 迁移前统计 ──────────────────────────────────
const before = {}
for (const t of TABLES) {
  before[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n
}
console.log('\n迁移前条数:', JSON.stringify(before))

// ── 2. 收集要转换的行 ──────────────────────────────
const jobs = []
for (const t of TABLES) {
  const rows = db.prepare(`SELECT id, ts FROM ${t} WHERE ts LIKE '%Z'`).all()
  for (const r of rows) {
    const d = new Date(r.ts)
    if (Number.isNaN(d.getTime())) {
      console.log(`⚠️ ${t}#${r.id} 无法解析 ts=${r.ts}，跳过`)
      continue
    }
    jobs.push({ table: t, id: r.id, oldTs: r.ts, newTs: toLocalTs(d) })
  }
}
console.log(`\n待转换 ${jobs.length} 条`)

// ── 3. 抽样预览（前 5 条 + 后 3 条）────────────────
console.log('\n抽样预览（前 5）:')
jobs.slice(0, 5).forEach((j) => console.log(`   ${j.table}#${j.id}  ${j.oldTs}  →  ${j.newTs}`))
console.log('抽样预览（后 3）:')
jobs.slice(-3).forEach((j) => console.log(`   ${j.table}#${j.id}  ${j.oldTs}  →  ${j.newTs}`))

if (!APPLY) {
  console.log('\n【演练】未写库。加 --apply 执行。')
  db.close()
  process.exit(0)
}

// ── 4. 执行迁移（事务）─────────────────────────────
db.exec('BEGIN')
try {
  const upd = {}
  for (const t of TABLES) upd[t] = db.prepare(`UPDATE ${t} SET ts=? WHERE id=?`)
  for (const j of jobs) upd[j.table].run(j.newTs, j.id)
  db.exec('COMMIT')
  console.log(`\n✅ 已提交，转换 ${jobs.length} 条`)
} catch (e) {
  db.exec('ROLLBACK')
  console.error('❌ 迁移失败已回滚:', e.message)
  db.close()
  process.exit(1)
}

// ── 5. 校验：条数不变 ──────────────────────────────
let countOk = true
for (const t of TABLES) {
  const n = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n
  const ok = n === before[t]
  if (!ok) countOk = false
  console.log(`${ok ? '✅' : '❌'} ${t} 条数 ${before[t]} → ${n}`)
}

// ── 6. 校验：不再有 Z；抽样比对语义正确 ────────────
let stillZ = 0
for (const t of TABLES) {
  stillZ += db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ts LIKE '%Z'`).get().n
}
console.log(`${stillZ === 0 ? '✅' : '❌'} 剩余带 Z 的记录: ${stillZ}`)

// 抽样比对：转换后字符串的本地分量，必须与「原 UTC 转本地」一致
let sampleOk = 0
let sampleBad = 0
for (const j of jobs.slice(0, 200)) {
  const row = db.prepare(`SELECT ts FROM ${j.table} WHERE id=?`).get(j.id)
  if (row?.ts === j.newTs) sampleOk++
  else { sampleBad++; console.log(`❌ ${j.table}#${j.id} 期望 ${j.newTs} 实际 ${row?.ts}`) }
}
console.log(`${sampleBad === 0 ? '✅' : '❌'} 抽样比对 ${sampleOk} 条一致`)

// ── 7. 校验：FTS 可检索 ────────────────────────────
const ftsHit = db.prepare(`
  SELECT COUNT(*) n FROM logs_fts f JOIN logs l ON l.id=f.rowid
  WHERE logs_fts MATCH ?
`).get('记忆')
console.log(`${ftsHit.n > 0 ? '✅' : '❌'} FTS 检索「记忆」命中 ${ftsHit.n} 条`)

db.close()
console.log('\n完成。')
