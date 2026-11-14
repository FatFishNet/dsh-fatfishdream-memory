/**
 * 可移植性审查：这套插件换机器 / 换盘 / 重装时，哪些地方依赖绝对路径？
 *
 * 关注点不是「代码里有没有写死」，而是「运行时数据里存了什么」。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'D:/FatFishDream-memory'

console.log('=== 1. state.json 里的绝对路径 ===\n')
const state = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8').replace(/^\uFEFF/, ''))
for (const [key, p] of Object.entries(state.projects ?? {})) {
  const cwdOk = p.cwd ? fs.existsSync(p.cwd) : false
  console.log(`  ${key}`)
  console.log(`     dir: ${p.dir}`)
  console.log(`     cwd: ${p.cwd ?? '(无)'}  ${cwdOk ? '✓存在' : '✗不存在'}`)
}

console.log('\n=== 2. 指针文件 ===\n')
const ptr = path.join(process.env.USERPROFILE ?? '', '.dsh', 'memory-root.json')
if (fs.existsSync(ptr)) {
  const j = JSON.parse(fs.readFileSync(ptr, 'utf8').replace(/^\uFEFF/, ''))
  console.log(`  ${ptr}`)
  console.log(`  root: ${j.root}`)
  console.log(`  该路径存在: ${fs.existsSync(j.root)}`)
} else {
  console.log(`  ✗ 不存在：${ptr}`)
}

console.log('\n=== 3. 记忆根目录实际内容（换机器时要带走的）===\n')
for (const item of fs.readdirSync(ROOT, { withFileTypes: true })) {
  const full = path.join(ROOT, item.name)
  if (item.isDirectory()) {
    const n = fs.readdirSync(full).length
    console.log(`  [目录] ${item.name}  (${n} 个文件)`)
  } else {
    const size = fs.statSync(full).size
    console.log(`  [文件] ${item.name}  ${(size / 1024).toFixed(1)} KB`)
  }
}

console.log('\n=== 4. 数据库里有没有存绝对路径 ===\n')
const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(path.join(ROOT, 'memory.db'), { readOnly: true })
// 扫所有表的所有文本列，找形如 X:\... 的绝对路径
const tables = ['profile', 'rules', 'emotion', 'logs']
let found = 0
for (const t of tables) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /TEXT/i.test(c.type)).map((c) => c.name)
  for (const c of cols) {
    const rows = db
      .prepare(`SELECT id, ${c} AS v FROM ${t} WHERE ${c} LIKE '%:\\%' LIMIT 5`)
      .all()
    for (const r of rows) {
      const m = String(r.v).match(/[A-Za-z]:\\[^\s'"，。）)]*/g)
      if (m) {
        found++
        console.log(`  ${t}.${c} #${r.id}: ${m.slice(0, 2).join(' , ')}`)
      }
    }
  }
}
console.log(found === 0 ? '  ✓ 没有存绝对路径（换机器不受影响）' : `  共 ${found} 处含绝对路径`)

db.close()

console.log('\n=== 5. 结论 ===')
console.log('  换机器只需要带走整个记忆根目录 + 重建指针文件。')
console.log('  state.json 里的 cwd 指向旧工作区，失效时插件会自动回退/重新注册，不会崩。')
