/**
 * 修复历史脏 topic：`开发日志 -->` → `开发日志`，`数据清理 -->` → `数据清理`。
 *
 * 为什么单独写脚本而不是直接在 GUI 改：
 *   GUI 一次只能改一条，10 条要点 10 次；而且改 topic 要走 setTopic 接口
 *   才能同步 FTS 索引。
 *
 * 安全性设计：
 *   - 只动 topic 以 `-->` 结尾的条目，别的一概不碰
 *   - 改前逐条打印 old → new，改后逐条复核
 *   - 同步更新 FTS（contentless 表必须用 'delete' 带原值，见 removeFts）
 *   - 支持 --apply 开关，默认预演
 */
import { DatabaseSync } from 'node:sqlite'
import { syncFts } from '../dsh-memory/db-schema.mjs'

const DB = 'D:/dsh-fatfishdream-memory/memory.db'
const APPLY = process.argv.includes('--apply')

const TOPIC_WHITELIST = [
  '开发日志', '技术讨论', '构建/编译', '注入/预算', '插件/装载', '路径/沙箱',
  '格式/编码', '文档/行号', '情绪判据', '用户画像', '数据清理', 'GUI/界面', 'Git',
]

/** 与 index.js 的 sanitizeTopic 相同逻辑 */
function sanitizeTopic(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/--+>\s*$/g, '').replace(/^["'`\s]+|["'`\s]+$/g, '').trim()
  if (cleaned === '') return null
  if (TOPIC_WHITELIST.includes(cleaned)) return cleaned
  const prefixed = TOPIC_WHITELIST.find((t) => cleaned.startsWith(t))
  if (prefixed !== undefined) return prefixed
  return null
}

const db = new DatabaseSync(DB)

console.log(`模式：${APPLY ? '⚠️ 实际修复' : '预演（只读）'}\n`)

// ---- 1. 找出所有脏 topic ----
const dirty = []
for (const table of ['logs', 'rules']) {
  const rows = db
    .prepare(`SELECT id, topic, text FROM ${table} WHERE topic IS NOT NULL`)
    .all()
  for (const r of rows) {
    if (TOPIC_WHITELIST.includes(r.topic)) continue
    const fixed = sanitizeTopic(r.topic)
    dirty.push({ table, id: r.id, old: r.topic, fixed, text: r.text })
  }
}

console.log(`=== 1. 发现 ${dirty.length} 条非白名单 topic ===\n`)
for (const d of dirty) {
  const ok = d.fixed !== null && !d.fixed.includes('-')
  console.log(`  ${ok ? '✓' : '⚠️可修复为 null'} ${d.table} #${d.id}  ${JSON.stringify(d.old)} → ${JSON.stringify(d.fixed)}`)
}

if (dirty.length === 0) {
  console.log('  无需修复')
  db.close()
  process.exit(0)
}

// ---- 2. 执行 ----
console.log(`\n=== 2. ${APPLY ? '执行修复' : '预演'} ===\n`)
if (!APPLY) {
  console.log('  （预演，未写入）')
  console.log('  将逐条：UPDATE topic → 更新 FTS 索引')
} else {
  let changed = 0
  let failed = 0
  for (const d of dirty) {
    try {
      db.exec('BEGIN')
      // ① 更新主表 topic
      db.prepare(`UPDATE ${d.table} SET topic=? WHERE id=?`).run(d.fixed, d.id)
      // ② 同步 FTS：先按旧值 delete，再按新值 insert
      //    contentless 表必须带原值，否则会抛错或残留
      syncFts(db, d.table, d.id,
        { text: d.text ?? '', topic: d.fixed }, { text: d.text ?? '', topic: d.old })
      db.exec('COMMIT')
      changed++
      console.log(`  ✓ ${d.table} #${d.id}  ${JSON.stringify(d.old)} → ${JSON.stringify(d.fixed)}`)
    } catch (e) {
      db.exec('ROLLBACK')
      failed++
      console.log(`  ✗ ${d.table} #${d.id}  ${e.message.slice(0, 60)}`)
    }
  }
  console.log(`\n  成功 ${changed} / 失败 ${failed}`)
}

// ---- 3. 复核 ----
console.log('\n=== 3. 复核：还有没有非白名单 topic ===\n')
let remaining = 0
for (const table of ['logs', 'rules']) {
  for (const r of db.prepare(`SELECT id, topic FROM ${table} WHERE topic IS NOT NULL`).all()) {
    if (!TOPIC_WHITELIST.includes(r.topic)) {
      remaining++
      console.log(`  ⚠️ ${table} #${r.id}  ${JSON.stringify(r.topic)}`)
    }
  }
}
console.log(remaining === 0 ? '  ✅ 已全部清理干净' : `  ⚠️ 仍有 ${remaining} 条`)

console.log('\n=== 4. topic 分布（修复后）===\n')
const dist = db
  .prepare(
    `SELECT topic, COUNT(*) c FROM (
       SELECT topic FROM logs WHERE status='active' AND topic IS NOT NULL
       UNION ALL
       SELECT topic FROM rules WHERE status='active' AND topic IS NOT NULL
     ) GROUP BY topic ORDER BY c DESC`,
  )
  .all()
for (const r of dist) console.log(`  ${String(r.c).padStart(3)} 条  ${r.topic}`)

console.log('\n=== 5. 数据健康 ===\n')
console.log('  integrity_check:', db.prepare('PRAGMA integrity_check').get().integrity_check)
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  console.log(`  ${t.padEnd(8)} ${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`)
}

db.close()
