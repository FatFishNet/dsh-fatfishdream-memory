/**
 * 第 5 轮：删除 createStore 里的文件版 search（读 log/*.md 做 grep）。
 *
 * 依据：唯一调用点 `/memory search` 的文件回退分支已删；
 * 导出表里的 `search,` 也无人使用（dbStore.search 是另一个方法）。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const START_MARK = '  async function search(query, months, onlyProject) {'
const idx = text.indexOf(START_MARK)
if (idx < 0) {
  console.log('❌ 找不到文件版 search 定义，中止')
  process.exit(1)
}

// 用括号计数找函数结尾
let depth = 0
let started = false
let end = -1
for (let i = idx; i < text.length; i++) {
  const ch = text[i]
  if (ch === '{') { depth++; started = true }
  else if (ch === '}') {
    depth--
    if (started && depth === 0) { end = i + 1; break }
  }
}
if (end < 0) {
  console.log('❌ 括号计数失败，中止')
  process.exit(1)
}

const removed = text.slice(idx, end)
if (!removed.includes('recentLogs') || !removed.includes('shards')) {
  console.log('❌ 待删内容不含预期特征（应读 log 分片），中止')
  process.exit(1)
}
console.log(`将删除文件版 search：${removed.split('\n').length} 行 / ${Buffer.byteLength(removed, 'utf8')} 字节`)

// 连同前面的空行一起删
let from = idx
while (from > 0 && text[from - 1] === '\n') from--
text = text.slice(0, from) + '\n\n' + text.slice(end).replace(/^\n+/, '')

// 删导出表里的 `  search,`
const exportLine = '    search,\n'
const n = text.split(exportLine).length - 1
if (n !== 1) {
  console.log(`❌ 导出表 search 期望 1 次，实际 ${n} 次，中止`)
  process.exit(1)
}
text = text.split(exportLine).join('')
console.log('✅ 已从导出表移除 search')

fs.writeFileSync(FILE, text, 'utf8')
console.log('已写入')
