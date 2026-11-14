/** 查 #12 那条超长 quote 的来源：是 user/message 原文，还是插件回填的 */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'

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
const r = db.prepare('SELECT quote, evidence FROM emotion WHERE id=12').get()
const q = r.quote

console.log('=== #12 quote 结构分析 ===\n')
console.log('总长度:', q.length, '字')
console.log('行数  :', q.split('\n').length)
console.log('开头 80 字 :', JSON.stringify(q.slice(0, 80)))
console.log('结尾 80 字 :', JSON.stringify(q.slice(-80)))

console.log('\n=== 是否含「用户说的话」的特征 ===\n')
// 用户消息通常会带引用块 > 或简短口语
const lines = q.split('\n')
const markedQuote = lines.filter((l) => l.startsWith('>')).length
console.log('以 > 开头的行数:', markedQuote)
console.log('空行数:', lines.filter((l) => l.trim() === '').length)

console.log('\n=== 是否含 reasoning-distill 的标志文本 ===\n')
const marks = [
  'private chain of thought',
  'untrusted-data boundaries',
  'labelled sections',
  'fraction of the token cost',
  '<signature>',
]
for (const m of marks) {
  const n = q.split(m).length - 1
  console.log(`  ${n > 0 ? '✓' : ' '} ${m.padEnd(32)} 出现 ${n} 次`)
}

console.log('\n=== 证据词 that is wrong 出现在哪 ===\n')
const idx = q.toLowerCase().indexOf("that's wrong")
if (idx >= 0) {
  console.log(`  位置 ${idx}（占比 ${((idx / q.length) * 100).toFixed(1)}%）`)
  console.log('  上下文:')
  console.log('  ' + JSON.stringify(q.slice(Math.max(0, idx - 200), idx + 200)))
} else {
  console.log('  未找到（evidence 是别的来源？）')
}

console.log('\n=== 该时段（00:00~00:10 UTC）的插件日志 ===\n')
const logFile = `${MEM_ROOT}/logs/2026-11-13.log`
const log = fs.readFileSync(logFile, 'utf8').split('\n')
const hits = log.filter((l) => {
  const m = l.match(/^2026-11-13T00:0[0-9]:/)
  return m && (l.includes('emotion') || l.includes('user-message'))
})
for (const l of hits.slice(0, 10)) {
  // 日志里 emotion-analysis 会把 text 截断，正好看它当时收到的长度
  console.log('  ' + l.slice(0, 300))
}

db.close()
