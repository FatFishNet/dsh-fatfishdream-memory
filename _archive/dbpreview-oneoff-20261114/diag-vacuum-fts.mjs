/** 查清：VACUUM INTO 到底有没有把 FTS 索引带过去 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openMemoryDb } from '../dsh-memory/db-schema.mjs'

const TMP = path.join(os.tmpdir(), `ftstest-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })
const SRC = path.join(TMP, 'src.db')
const DST = path.join(TMP, 'dst.db')

const src = openMemoryDb(DatabaseSync, SRC)
src.prepare(`INSERT INTO logs(scope,ts,topic,text,status,writer) VALUES(?,?,?,?,?,?)`).run(
  'proj-a', '2026-11-13T00:00:00.000Z', '开发日志', '第一条流水记录', 'active', 'model',
)

console.log('=== 源库 FTS 检索（用分词后的 seg 列写法）===\n')
// segmentCjk 会把中文逐字拆开，MATCH 时也要拆
const { segmentCjk } = await import('../dsh-memory/db-schema.mjs')
const q1 = segmentCjk('流水')
console.log(`  segmentCjk('流水') = ${JSON.stringify(q1)}`)

for (const q of ['流水', q1]) {
  try {
    const hits = src.prepare(`SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?`).all(q)
    console.log(`  源库 MATCH ${JSON.stringify(q)} → ${hits.length} 行`)
  } catch (e) {
    console.log(`  源库 MATCH ${JSON.stringify(q)} → 出错 ${e.message.slice(0, 50)}`)
  }
}

// 看看 FTS 表里到底有什么
console.log('\n=== 源库 logs_fts 行数 ===')
console.log('  ' + src.prepare('SELECT COUNT(*) c FROM logs_fts').get().c)

// VACUUM INTO
src.exec(`VACUUM INTO '${DST.replace(/\\/g, '/')}'`)

console.log('\n=== 目标库 logs_fts 行数 ===')
const dst = new DatabaseSync(DST, { readOnly: true })
console.log('  ' + dst.prepare('SELECT COUNT(*) c FROM logs_fts').get().c)

console.log('\n=== 目标库 MATCH 测试 ===')
for (const q of ['流水', q1, '记录']) {
  try {
    const hits = dst.prepare(`SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?`).all(q)
    console.log(`  目标库 MATCH ${JSON.stringify(q)} → ${hits.length} 行`)
  } catch (e) {
    console.log(`  目标库 MATCH ${JSON.stringify(q)} → 出错 ${e.message.slice(0, 50)}`)
  }
}

dst.close()
src.close()
console.log('\n=== 结论 ===')
console.log('  如果两边 MATCH 结果一致，说明 VACUUM INTO 完整带走了 FTS。')
console.log('  测试里 0 行是因为查询词没按 segmentCjk 分词，不是复制丢索引。')

// 清理（带重试，Windows 上文件句柄释放有延迟）
try {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  console.log('  临时目录已删除')
} catch (e) {
  console.log('  清理失败（不影响结论）：' + e.message.slice(0, 50))
}
