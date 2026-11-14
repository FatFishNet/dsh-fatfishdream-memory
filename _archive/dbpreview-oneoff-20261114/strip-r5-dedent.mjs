/**
 * 第 5 轮收尾：去掉 /memory search 里遗留的裸块 `{ ... }`。
 *
 * 上一步把 `if (dbStoreExists()) {` 改成了守卫 + 裸块，
 * 功能正确但多一层无意义缩进。这里把块解开，代码更直。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const start = text.indexOf("                if (!dbStoreExists()) {\n                  return { kind: 'error', text: '记忆库不可用（只支持 SQLite），请检查 DSH 日志的 [db-FAILED]' }\n                }\n                {\n")
if (start < 0) {
  console.log('❌ 找不到锚点，中止')
  process.exit(1)
}

// 找这个裸块的结束：从 start 起，定位 "                }\n              }\n              if (action === 'show')"
const END_MARK = "                }\n              }\n              if (action === 'show') {"
const end = text.indexOf(END_MARK, start)
if (end < 0) {
  console.log('❌ 找不到块尾，中止')
  process.exit(1)
}

const blockStart = start + "                if (!dbStoreExists()) {\n                  return { kind: 'error', text: '记忆库不可用（只支持 SQLite），请检查 DSH 日志的 [db-FAILED]' }\n                }\n".length
const blockBody = text.slice(blockStart, end + "                }\n".length)

// body 以 "                {\n" 开头、以 "                }\n" 结尾
if (!blockBody.startsWith('                {\n')) {
  console.log('❌ 块体开头不符，中止')
  process.exit(1)
}
const inner = blockBody.slice('                {\n'.length, blockBody.length - '                }\n'.length)

// 整体减 2 个空格缩进
const dedented = inner
  .split('\n')
  .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
  .join('\n')

const replacement = `                if (!dbStoreExists()) {
                  return { kind: 'error', text: '记忆库不可用（只支持 SQLite），请检查 DSH 日志的 [db-FAILED]' }
                }
` + dedented

text = text.slice(0, start) + replacement + text.slice(end + "                }\n".length)

fs.writeFileSync(FILE, text, 'utf8')
console.log('✅ 已解开裸块并修正缩进')
