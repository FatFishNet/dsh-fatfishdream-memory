/**
 * 核对 #12 的删除是否干净。
 *
 * 重点不只是「主表里还有没有这行」，而是三处：
 *   1. emotion 主表
 *   2. emotion_fts（contentless FTS 表 —— 如果没按规矩删，索引会残留）
 *   3. 是否有孤儿 FTS 行指向已不存在的 id
 */
import { DatabaseSync } from 'node:sqlite'
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

const db = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })

console.log('=== 1. emotion 主表 ===\n')
const total = db.prepare('SELECT COUNT(*) c FROM emotion').get().c
console.log(`  总行数: ${total}`)
const r12 = db.prepare('SELECT * FROM emotion WHERE id=12').get()
if (r12 === undefined) {
  console.log('  ✅ #12 已从主表删除')
} else {
  console.log(`  ⚠️ #12 仍在（status=${r12.status}，quote ${String(r12.quote ?? '').length} 字）`)
}

console.log('\n=== 2. 现有记录一览 ===\n')
for (const r of db.prepare('SELECT id, ts, cls, status, length(quote) q FROM emotion ORDER BY id').all()) {
  console.log(`  #${String(r.id).padEnd(3)} ${String(r.ts).padEnd(26)} ${String(r.cls ?? '-').padEnd(5)} ${String(r.status).padEnd(8)} ${String(r.q).padStart(6)} 字`)
}

console.log('\n=== 3. FTS 索引核对 ===\n')
// contentless FTS 表：COUNT(*) 就是索引里的行数
let ftsCount
try {
  ftsCount = db.prepare('SELECT COUNT(*) c FROM emotion_fts').get().c
  console.log(`  emotion_fts 行数: ${ftsCount}`)
} catch (e) {
  console.log(`  ⚠️ 查不到 emotion_fts: ${e.message}`)
  ftsCount = undefined
}

const liveIds = db.prepare('SELECT id FROM emotion ORDER BY id').all().map((r) => r.id)
console.log(`  emotion 主表 id: ${liveIds.join(', ')}`)

// contentless FTS 的 rowid 应当与主表 id 对应
if (ftsCount !== undefined) {
  if (ftsCount === liveIds.length) {
    console.log(`  ✅ FTS 行数(${ftsCount}) == 主表行数(${liveIds.length})，无孤儿索引`)
  } else {
    console.log(`  ⚠️ FTS ${ftsCount} 行 vs 主表 ${liveIds.length} 行 —— 可能有残留`)
  }
}

console.log('\n=== 4. 用 FTS 搜 #12 的特征串，看索引是否还留着 ===\n')
// contentless FTS 的 MATCH 需要分词后的形式，这里用几个独特的英文词试
const probes = ['unsaid', 'boundaries', 'rewrite']
for (const p of probes) {
  try {
    const hits = db.prepare(`SELECT rowid FROM emotion_fts WHERE emotion_fts MATCH ? LIMIT 5`).all(p)
    console.log(`  MATCH "${p}" → ${hits.length} 行${hits.length ? '：rowid ' + hits.map((h) => h.rowid).join(',') : ''}`)
  } catch (e) {
    console.log(`  MATCH "${p}" → 查询失败（${e.message.slice(0, 40)}）`)
  }
}

console.log('\n=== 5. 数据库健康 ===\n')
console.log('  integrity_check:', db.prepare('PRAGMA integrity_check').get().integrity_check)
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  console.log(`  ${t.padEnd(8)} ${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`)
}

db.close()
