/**
 * 第 7 轮：删除 createStore 里 6 个已无调用者的 .md 写入方法。
 *
 * 前置核实（本轮已做）：
 *   ensureProject / ensureMonthlyLog / fixFactsByRegex  → 零外部调用
 *   appendLog / appendFact / appendProjectNote          → 外部只调 dbStore 版本，文件版零调用
 *
 * 连带：FACTS_TEMPLATE 与 projectTemplate 的调用者全在这 6 个方法内，
 * 删完后它们才真正变成零调用常量，可另作处理。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const NAMES = [
  'ensureProject',
  'ensureMonthlyLog',
  'appendLog',
  'appendFact',
  'appendProjectNote',
  'fixFactsByRegex',
]

/** 用括号计数从函数头找到函数尾 */
function findFn(src, name) {
  // 直接定位 "async function <name>(" 这四个字，不匹配缩进
  const needle = 'async function ' + name + '('
  const at = src.indexOf(needle)
  if (at < 0) return null
  // 回退到该行行首（吞掉缩进）
  let start = at
  while (start > 0 && src[start - 1] !== '\n') start--
  // 用括号计数找函数结尾
  let depth = 0
  let started = false
  let end = -1
  for (let i = at; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') {
      depth--
      if (started && depth === 0) { end = i + 1; break }
    }
  }
  return end < 0 ? null : { start, end, nameAt: at }
}

let totalRemoved = 0
const removedInfo = []

for (const name of NAMES) {
  const r = findFn(text, name)
  if (!r) {
    console.log(`❌ 找不到 ${name}`)
    process.exit(1)
  }

  // 往前只吃「紧邻的 /** ... */ 文档注释 + 空行」，且必须紧贴函数头
  let from = r.start
  const head = text.slice(0, from)
  // 去掉尾部空行后看是否紧贴注释结尾
  let probe = from
  while (probe > 0 && text[probe - 1] === '\n') probe--
  // 若 probe 往前是 '/', 且能找到最近的 '/**'，则把注释也纳入
  if (text.slice(Math.max(0, probe - 2), probe) === '*/') {
    const openIdx = text.lastIndexOf('/**', probe)
    if (openIdx >= 0) {
      from = openIdx
      while (from > 0 && text[from - 1] === '\n') from--
    }
  }

  const chunk = text.slice(from, r.end)
  // 自检：切除范围必须包含函数头
  if (!chunk.includes('async function ' + name + '(')) {
    console.log(`❌ ${name} 切除范围不含函数头（from=${from} start=${r.start}），中止`)
    process.exit(1)
  }
  removedInfo.push({ name, lines: chunk.split('\n').length })
  totalRemoved += chunk.split('\n').length

  text = text.slice(0, from) + '\n\n' + text.slice(r.end).replace(/^\n+/, '')
  console.log(`✅ 删除 ${name}（${removedInfo.at(-1).lines} 行）`)
}

// 导出表：删掉这 6 项
for (const name of NAMES) {
  const line = '    ' + name + ',\n'
  const c = text.split(line).length - 1
  if (c === 1) {
    text = text.split(line).join('')
    console.log(`✅ 导出表移除 ${name}`)
  } else {
    console.log(`⚠️ 导出表 ${name} 出现 ${c} 次，跳过`)
  }
}

fs.writeFileSync(FILE, text, 'utf8')
console.log(`\n合计删除 ${totalRemoved} 行`)
