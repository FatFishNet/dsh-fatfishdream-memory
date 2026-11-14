/**
 * 彻底删除 emotion #12（那条 28016 字的误判记录）。
 *
 * 为什么不能直接 `DELETE FROM emotion WHERE id=12`：
 *   1. emotion_fts 是 contentless 表（content=''），
 *      直接 DELETE 索引行会抛 `cannot DELETE from contentless fts5 table`
 *   2. 必须用官方 'delete' 命令并**带原值**，否则 FTS 内部校验不过、索引清不干净
 *
 * 所以这里直接复用 db-schema.mjs 的 removeFts()，与插件自己的删除路径一致，
 * 不自己拼 SQL —— 那种写法很容易漏掉 seg 列。
 *
 * 用法：
 *   node _dbpreview/purge-emotion-12.mjs            # 预演
 *   node _dbpreview/purge-emotion-12.mjs --apply    # 真删
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { removeFts } from '../dsh-memory/db-schema.mjs'

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

const DB = `${MEM_ROOT}/memory.db`
const ID = 12
const APPLY = process.argv.includes('--apply')

const db = new DatabaseSync(DB)

console.log(`模式：${APPLY ? '⚠️ 实际删除' : '预演（只读）'}`)
console.log(`目标：emotion #${ID}\n`)

// ---- 1. 前置检查 ----
console.log('=== 1. 删除前核对 ===\n')
const row = db.prepare('SELECT * FROM emotion WHERE id=?').get(ID)
if (row === undefined) {
  console.log(`  ✗ #${ID} 不存在，无事可做`)
  db.close()
  process.exit(0)
}
console.log(`  id=${row.id}  ts=${row.ts}  cls=${row.cls}  status=${row.status}`)
console.log(`  quote ${String(row.quote ?? '').length} 字 / text ${String(row.text ?? '').length} 字`)
console.log(`  evidence: ${String(row.evidence ?? '').slice(0, 40)}`)

// 安全检查：只允许删这一条，且必须是它那条超长误判
if (String(row.quote ?? '').length < 10000) {
  console.log('  ✗ 这条不是预期的超长误判记录（quote < 10000 字），拒绝执行')
  db.close()
  process.exit(1)
}
console.log('  ✓ 确认是那条超长误判记录')

const before = {
  emotion: db.prepare('SELECT COUNT(*) c FROM emotion').get().c,
  fts: db.prepare('SELECT COUNT(*) c FROM emotion_fts').get().c,
}
console.log(`\n  删除前：emotion ${before.emotion} 行 / emotion_fts ${before.fts} 行`)

// FTS 里确实有它的索引吗
const ftsHit = db.prepare("SELECT rowid FROM emotion_fts WHERE emotion_fts MATCH 'boundaries'").all()
console.log(`  FTS 里 MATCH boundaries 命中 rowid: ${ftsHit.map((x) => x.rowid).join(', ') || '(无)'}`)

// ---- 2. 执行 ----
console.log('\n=== 2. 执行删除 ===\n')
if (!APPLY) {
  console.log('  （预演，未写入）')
  console.log('  将执行：')
  console.log(`    1) removeFts(db,'emotion',${ID}, text, '')   ← 清 FTS 索引（带原值）`)
  console.log(`    2) DELETE FROM emotion WHERE id=${ID}`)
} else {
  db.exec('BEGIN')
  try {
    // ① 先清 FTS —— 必须带原值，且要在删主表之前拿到 text
    removeFts(db, 'emotion', ID, row.text ?? '', '')
    // ② 再删主表行
    const res = db.prepare('DELETE FROM emotion WHERE id=?').run(ID)
    db.exec('COMMIT')
    console.log(`  ✓ FTS 索引已清`)
    console.log(`  ✓ 主表删掉 ${res.changes} 行`)
  } catch (e) {
    db.exec('ROLLBACK')
    console.log('  ✗ 出错已回滚：' + e.message)
    db.close()
    process.exit(1)
  }
}

// ---- 3. 校验 ----
console.log('\n=== 3. 校验 ===\n')
const after = {
  emotion: db.prepare('SELECT COUNT(*) c FROM emotion').get().c,
  fts: db.prepare('SELECT COUNT(*) c FROM emotion_fts').get().c,
}
console.log(`  删除后：emotion ${after.emotion} 行 / emotion_fts ${after.fts} 行`)

const stillThere = db.prepare('SELECT id FROM emotion WHERE id=?').get(ID)
console.log(`  主表 #${ID}: ${stillThere === undefined ? '✓ 已不存在' : '✗ 仍在'}`)

const ftsStill = db.prepare("SELECT rowid FROM emotion_fts WHERE emotion_fts MATCH 'boundaries'").all()
console.log(`  FTS 里 MATCH boundaries: ${ftsStill.map((x) => x.rowid).join(', ') || '✓ 无命中'}`)
const ftsRewrite = db.prepare("SELECT rowid FROM emotion_fts WHERE emotion_fts MATCH 'rewrite'").all()
console.log(`  FTS 里 MATCH rewrite:    ${ftsRewrite.map((x) => x.rowid).join(', ') || '✓ 无命中'}`)

if (APPLY) {
  const okCount = after.emotion === before.emotion - 1
  const okFts = after.fts === before.fts - 1
  console.log(`\n  行数：${okCount ? '✓' : '✗'} emotion -1 / ${okFts ? '✓' : '✗'} fts -1`)
  const okSearch = ftsStill.length === 0 && ftsRewrite.length === 0
  console.log(`  检索：${okSearch ? '✓ 已搜不到' : '✗ 仍能搜到'}`)
}

console.log('\n=== 4. 数据库健康 ===\n')
console.log('  integrity_check:', db.prepare('PRAGMA integrity_check').get().integrity_check)

console.log('\n=== 5. 剩余情绪记录 ===\n')
for (const r of db.prepare('SELECT id, cls, status, length(quote) q FROM emotion ORDER BY id').all()) {
  console.log(`  #${String(r.id).padEnd(3)} ${String(r.cls ?? '-').padEnd(5)} ${String(r.status).padEnd(8)} ${String(r.q).padStart(6)} 字`)
}

db.close()
