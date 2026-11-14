/** 查 emotion_fts 的结构与现有索引内容，为彻底删除 #12 做准备 */
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

console.log('=== emotion_fts 建表语句 ===\n')
const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='emotion_fts'").get()?.sql
console.log(sql ?? '(无)')

console.log('\n=== emotion_fts 的列（PRAGMA table_info）===\n')
for (const c of db.prepare('PRAGMA table_info(emotion_fts)').all()) {
  console.log(`  ${c.name}  ${c.type}`)
}

console.log('\n=== emotion 表列 ===\n')
console.log('  ' + db.prepare('PRAGMA table_info(emotion)').all().map((c) => c.name).join(', '))

console.log('\n=== #12 的完整字段（删除前留档）===\n')
const r = db.prepare('SELECT * FROM emotion WHERE id=12').get()
for (const [k, v] of Object.entries(r ?? {})) {
  const s = String(v ?? '')
  console.log(`  ${k}: ${s.length > 100 ? s.slice(0, 100) + ` …（${s.length} 字）` : s}`)
}

console.log('\n=== FTS 里 #12 的索引内容 ===\n')
// contentless FTS 可以用 'integrity-check' 或直接按 rowid 查（不行，contentless 不能 SELECT 内容）
// 但可以 MATCH 出 rowid 列表
try {
  const rows = db.prepare("SELECT rowid FROM emotion_fts WHERE emotion_fts MATCH 'boundaries'").all()
  console.log(`  MATCH boundaries → rowid: ${rows.map((x) => x.rowid).join(', ')}`)
} catch (e) {
  console.log('  查询失败: ' + e.message)
}

console.log('\n=== 对照：db-store.mjs 里现成的删除实现 ===\n')
console.log('  下面的实现是插件的标准做法，我的清理脚本会照抄它。')

db.close()
