/**
 * 定阈值：真实用户情绪发言到底多长？
 *
 * 用户给的实测范围：一般 < 30 字，偶尔可到 300 字。
 * 本脚本用库里现有数据交叉验证，并找出「异常长」的那几条长什么样。
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
const rows = db
  .prepare(`SELECT id, cls, confidence, quote, length(quote) q, length(text) t
            FROM emotion WHERE status='active' ORDER BY length(quote)`)
  .all()

console.log('=== active 情绪记录按长度排序 ===\n')
for (const r of rows) {
  const lines = r.quote.split('\n').length
  const en = /[a-zA-Z]{4,}/.test(r.quote) && !/[\u4e00-\u9fa5]{4,}/.test(r.quote)
  console.log(
    `  #${String(r.id).padEnd(3)} ${String(r.cls ?? '-').padEnd(5)} ` +
      `quote=${String(r.q).padStart(7)}字  行=${String(lines).padStart(3)}  ` +
      `${en ? '[英文]' : '[中文]'}  ${r.quote.slice(0, 34).replace(/\n/g, ' ')}`,
  )
}

const normal = rows.filter((r) => r.id !== 12)
const maxNormal = Math.max(...normal.map((r) => r.q))
const maxNormalLines = Math.max(...normal.map((r) => r.quote.split('\n').length))
console.log('\n=== 统计 ===\n')
console.log(`  除 #12 外最长: ${maxNormal} 字`)
console.log(`  除 #12 外最多行数: ${maxNormalLines} 行`)
console.log(`  #12 本体    : 28016 字 / 382 行`)

console.log('\n=== 阈值建议推演 ===\n')
const candidates = [
  { chars: 1000, lines: 20 },
  { chars: 1500, lines: 30 },
  { chars: 2000, lines: 40 },
  { chars: 4000, lines: 60 },
]
for (const c of candidates) {
  const hit = rows.filter((r) => r.q > c.chars || r.quote.split('\n').length > c.lines)
  console.log(`  长度>${String(c.chars).padStart(4)} 字 或 行数>${c.lines}  →  命中 ${hit.length} 条：${hit.map((r) => '#' + r.id).join(', ') || '无'}`)
}

console.log('\n=== 结论 ===')
console.log('  用户说「一般 <30 字，偶尔 300 字」。')
console.log('  库里除 #12 外最长的真实压抑是 ' + maxNormal + ' 字，仍在正常范围。')
console.log('  所以阈值可以定得比 4000 更紧 —— 见上面推演。')
console.log('  ⚠️ 但「含系统提示特征」这条检查不能省：')
console.log('     reasoning-distill 的注入内容若恰好很短，只靠长度拦不住。')

db.close()
