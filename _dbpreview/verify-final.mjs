// 最终核对：空 topic 是否清零、残留分类是否已消除
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

const d = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })

function stat(sql) {
  return d.prepare(sql).get().c
}

console.log('=== 空 topic 检查 ===')
for (const t of ['logs', 'rules']) {
  const total = stat(`SELECT COUNT(*) c FROM ${t} WHERE status='active'`)
  const empty = stat(`SELECT COUNT(*) c FROM ${t} WHERE status='active' AND (topic IS NULL OR topic='')`)
  console.log(`  ${t.padEnd(6)} active ${String(total).padStart(3)} · 空 topic ${empty}`)
}

console.log('\n=== 已废弃分类的残留 ===')
for (const topic of ['测量/像素', '记忆机制']) {
  for (const t of ['logs', 'rules']) {
    const n = stat(`SELECT COUNT(*) c FROM ${t} WHERE status='active' AND topic='${topic}'`)
    if (n > 0) {
      console.log(`  ⚠️ ${t} 仍有「${topic}」${n} 条:`)
      for (const r of d.prepare(`SELECT id, scope, substr(replace(text, char(10), ' '), 1, 60) x FROM ${t} WHERE status='active' AND topic='${topic}' ORDER BY id`).all()) {
        console.log(`      #${r.id} [${String(r.scope).slice(0, 14)}] ${r.x}`)
      }
    } else {
      console.log(`  OK ${t} 已无「${topic}」`)
    }
  }
}

console.log('\n=== 最终 topic 总览（两表合计）===')
const agg = {}
for (const t of ['logs', 'rules']) {
  for (const r of d.prepare(`SELECT topic, COUNT(*) n FROM ${t} WHERE status='active' AND topic IS NOT NULL AND topic!='' GROUP BY topic`).all()) {
    agg[r.topic] = (agg[r.topic] ?? 0) + r.n
  }
}
for (const [t, n] of Object.entries(agg).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(14)} ${n}`)
}

console.log('\n=== 数据完整性 ===')
console.log('  integrity_check:', d.prepare('PRAGMA integrity_check').get().integrity_check)
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  console.log(`  ${t.padEnd(8)} ${stat(`SELECT COUNT(*) c FROM ${t}`)}`)
}
d.close()
