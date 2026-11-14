/** 查 emotion 表 #12 这条记录：#12 情绪记录为什么那么长，用户当时说了什么 */
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

console.log('=== emotion 表全部记录（按 id）===\n')
const all = db.prepare('SELECT id, ts, cls, confidence, score, status, length(quote) qlen, length(text) tlen FROM emotion ORDER BY id').all()
for (const r of all) {
  const mark = r.id === 12 ? ' <<<< 用户问的这条' : ''
  console.log(`  #${String(r.id).padEnd(3)} ${String(r.ts).padEnd(26)} [${String(r.cls).padEnd(4)}] ${String(r.confidence).padEnd(6)} score=${String(r.score).padEnd(5)} quote=${String(r.qlen).padStart(4)}字 text=${String(r.tlen).padStart(4)}字${mark}`)
}

console.log('\n=== #12 完整内容 ===\n')
const r12 = db.prepare('SELECT * FROM emotion WHERE id=12').get()
if (!r12) {
  console.log('  ✗ 没有 #12')
} else {
  for (const [k, v] of Object.entries(r12)) {
    const s = String(v ?? '')
    console.log(`  ${k}:`)
    console.log(`    ${s.length > 500 ? s.slice(0, 500) + `\n    …（共 ${s.length} 字，已截断）` : s}`)
  }
}

console.log('\n=== #12 与邻居的时间关系 ===\n')
for (const id of [11, 12, 13]) {
  const r = db.prepare('SELECT id, ts, cls, length(text) tlen, substr(text,1,80) t FROM emotion WHERE id=?').get(id)
  if (r) console.log(`  #${r.id} ${r.ts} [${r.cls}] ${r.tlen}字  ${r.t}`)
}

db.close()
