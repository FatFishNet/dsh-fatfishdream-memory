/**
 * v1 → v2 数据迁移：单表 entries 拆到 profile / rules / emotion / logs 四张表。
 *
 * 原则：
 *   1. **旧 entries 表保留不删** —— 拆表若出错还能回退
 *   2. 全部迁移（含已删除/停用的），一条不丢
 *   3. 迁移后逐表校验条数，并抽样比对原文
 *   4. 备份原库文件（.v1-backup）再动手
 *
 * 用法：node db-migrate-v2.mjs <db路径>
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb, syncFts, SCHEMA_VERSION } from './db-schema.mjs'

const DB = process.argv[2]
if (!DB) {
  console.error('用法: node db-migrate-v2.mjs <db路径>')
  process.exit(1)
}

// ---- 0. 备份 ----
const backup = `${DB}.v1-backup`
if (!fs.existsSync(backup)) {
  fs.copyFileSync(DB, backup)
  // WAL 里可能还有未合并的数据，一并备份
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(DB + suffix)) fs.copyFileSync(DB + suffix, backup + suffix)
  }
  console.log(`已备份原库 → ${path.basename(backup)}`)
} else {
  console.log(`备份已存在，跳过：${path.basename(backup)}`)
}

const db = openMemoryDb(DatabaseSync, DB)
const version = db.prepare('PRAGMA user_version').get().user_version
console.log(`当前 schema 版本：${version}（目标 ${SCHEMA_VERSION}）`)

// ---- 1. 读 v1 数据 ----
const hasV1 = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='entries'`)
  .get()
if (!hasV1) {
  console.log('没有 v1 的 entries 表，无需迁移')
  db.close()
  process.exit(0)
}

const v1 = db.prepare('SELECT * FROM entries').all()
console.log(`v1 条目总数：${v1.length}`)

// ---- 2. 分类 ----
const buckets = { profile: [], rules: [], emotion: [], logs: [] }
for (const r of v1) {
  if (r.kind === 'log') {
    buckets.logs.push(r)
  } else if (r.kind === 'emotion') {
    buckets.emotion.push(r)
  } else if (r.scope === '__global__') {
    // 全局的 pref/fact/state → 用户画像
    buckets.profile.push(r)
  } else {
    buckets.rules.push(r)
  }
}
console.log('分类结果：')
for (const [k, v] of Object.entries(buckets)) console.log(`  ${k.padEnd(8)} ${v.length} 条`)

// ---- 3. 检查目标表是否已有数据（防重复迁移）----
const existing = {}
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  existing[t] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
}
if (Object.values(existing).some((n) => n > 0)) {
  console.log('⚠️ 目标表已有数据，为避免重复迁移已中止：', existing)
  console.log('   如确认要重新迁移，请先清空目标表或恢复备份。')
  db.close()
  process.exit(1)
}

// ---- 4. 写入四张表 ----
const insProfile = db.prepare(
  `INSERT INTO profile(ts,topic,text,status,writer,review,review_note,updated) VALUES(?,?,?,?,?,?,?,?)`,
)
const insRules = db.prepare(
  `INSERT INTO rules(scope,kind,ts,topic,text,status,writer,review,review_note,updated) VALUES(?,?,?,?,?,?,?,?,?,?)`,
)
const insEmotion = db.prepare(
  `INSERT INTO emotion(ts,cls,quote,evidence,confidence,score,text,status,review,review_note,writer) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
)
const insLogs = db.prepare(
  `INSERT INTO logs(scope,ts,topic,text,status,writer) VALUES(?,?,?,?,?,?)`,
)

const now = new Date().toISOString()
const ids = { profile: [], rules: [], emotion: [], logs: [] }

db.exec('BEGIN')
try {
  for (const r of buckets.profile) {
    const res = insProfile.run(
      r.ts ?? null, r.topic ?? null, r.text, r.status, r.writer ?? 'model',
      r.review ?? null, r.review_note ?? null, now,
    )
    const id = Number(res.lastInsertRowid)
    ids.profile.push(id)
    syncFts(db, 'profile', id, r.text, r.topic ?? '')
  }

  for (const r of buckets.rules) {
    const res = insRules.run(
      r.scope ?? '__global__', r.kind ?? 'pref', r.ts ?? null, r.topic ?? null,
      r.text, r.status, r.writer ?? 'model', r.review ?? null, r.review_note ?? null, now,
    )
    const id = Number(res.lastInsertRowid)
    ids.rules.push(id)
    syncFts(db, 'rules', id, r.text, r.topic ?? '')
  }

  for (const r of buckets.emotion) {
    // v1 的情绪把整行塞在 text 里，形如：
    //   用户表达爱意（喜欢·高置信·0.90）：我喜欢你 大肥鱼
    // 这里拆出 cls / quote / evidence，同时保留整行到 text 便于展示
    const m = r.text.match(/^用户表达(.+?)（(.+?)）\s*[：:]\s*([\s\S]*)$/)
    const cls = m ? m[1] : null
    const detail = m ? m[2] : null
    const quote = m ? m[3].trim() : r.text
    // detail 形如「喜欢·高置信·0.90」
    const parts = detail ? detail.split('·') : []
    const evidence = parts[0] ?? null
    const confidence = parts[1] ?? null
    const score = parts[2] !== undefined ? Number(parts[2]) : null
    const res = insEmotion.run(
      r.ts ?? r.created ?? now, cls, quote, evidence, confidence,
      Number.isFinite(score) ? score : null, r.text, r.status,
      r.review ?? null, r.review_note ?? null, 'plugin',
    )
    const id = Number(res.lastInsertRowid)
    ids.emotion.push(id)
    syncFts(db, 'emotion', id, r.text, r.topic ?? '')
  }

  for (const r of buckets.logs) {
    const res = insLogs.run(
      r.scope ?? '__global__', r.ts ?? null, r.topic ?? null, r.text, r.status, r.writer ?? 'model',
    )
    const id = Number(res.lastInsertRowid)
    ids.logs.push(id)
    syncFts(db, 'logs', id, r.text, r.topic ?? '')
  }

  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('迁移失败，已回滚：', e.message)
  db.close()
  process.exit(1)
}

// ---- 5. 校验 ----
console.log('\n=== 迁移校验 ===')
let ok = true
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  const got = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  const want = buckets[t].length
  const pass = got === want
  if (!pass) ok = false
  console.log(`  ${t.padEnd(8)} ${String(got).padStart(4)} / 期望 ${String(want).padStart(4)}  ${pass ? '✓' : '✗'}`)
}

// 抽样比对原文
console.log('\n--- 抽样比对（新表文本应能在 v1 里找到）---')
const v1Texts = new Set(v1.map((r) => r.text))
for (const t of ['profile', 'rules', 'logs']) {
  const rows = db.prepare(`SELECT text FROM ${t} LIMIT 3`).all()
  for (const r of rows) {
    const found = v1Texts.has(r.text)
    if (!found) ok = false
    console.log(`  ${found ? '✓' : '✗'} [${t}] ${r.text.slice(0, 44).replace(/\n/g, ' ')}`)
  }
}

// FTS 可用性
console.log('\n--- FTS 检索可用性 ---')
for (const [t, kw] of [['rules', '沙箱'], ['logs', '沙箱'], ['profile', '大肥鱼']]) {
  const q = kw.split('').map((c) => `"${c}"`).join(' AND ')
  let n = 0
  try {
    n = db.prepare(
      `SELECT COUNT(*) c FROM ${t}_fts f JOIN ${t} x ON x.id=f.rowid WHERE ${t}_fts MATCH ?`,
    ).get(q).c
  } catch (e) {
    ok = false
    console.log(`  ✗ [${t}] 检索失败：${e.message}`)
    continue
  }
  console.log(`  ${n > 0 ? '✓' : '?'} [${t}] 搜「${kw}」→ ${n} 条`)
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const size = fs.statSync(DB).size
console.log(`\n库体积：${(size / 1024).toFixed(0)} KB`)
console.log(ok ? '✅ v2 迁移完成，全部校验通过' : '⚠️ 迁移完成但有校验未通过，请检查上面的 ✗')
db.close()
