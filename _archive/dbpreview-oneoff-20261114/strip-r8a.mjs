/**
 * 第 8 轮（重做）：只删 recordEmotion（文件版）+ projectTemplate，
 * 并去掉 ensureLayout 的 fileMode 分支。
 *
 * 上一版失败原因：删除 recordEmotion 后，项目模板函数的定位使用了
 * 「往前吃注释」逻辑，在文件已被修改过的情况下吃掉了不该吃的内容，
 * 导致 L1441 出现孤立的 `) {`。这次改为**用精确文本块整体替换**，
 * 且每步都单独校验语法。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

// ─────────────────────────────────────────────── 1) recordEmotion
// 用「文档注释开头 → 函数结尾」的精确切片
const RE_START = `  /**\n   * 写入一条情绪记录。`
const iStart = text.indexOf(RE_START)
if (iStart < 0) { console.log('❌ 找不到 recordEmotion 的注释开头'); process.exit(1) }

const FN = 'async function recordEmotion('
const iFn = text.indexOf(FN, iStart)
if (iFn < 0) { console.log('❌ 找不到 recordEmotion 定义'); process.exit(1) }

// ⚠️ 函数参数是解构写法 `{ kind, evidence, ... }`，参数列表里就有 `{` 和 `}`，
//    所以不能从 iFn 开始数括号 —— 要先跳过参数列表，从函数体的 `{` 开始。
let bodyOpen = -1
{
  let paren = 0
  for (let i = iFn; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') paren++
    else if (ch === ')') {
      paren--
      if (paren === 0) {
        // 参数列表结束，往后找第一个 '{'
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === '{') { bodyOpen = j; break }
          if (text[j] === '\n') continue
        }
        break
      }
    }
  }
}
if (bodyOpen < 0) { console.log('❌ 找不到函数体起始 {'); process.exit(1) }

let depth = 0, started = false, iEnd = -1
for (let i = bodyOpen; i < text.length; i++) {
  const ch = text[i]
  if (ch === '{') { depth++; started = true }
  else if (ch === '}') { depth--; if (started && depth === 0) { iEnd = i + 1; break } }
}
if (iEnd < 0) { console.log('❌ 括号计数失败'); process.exit(1) }

const removed = text.slice(iStart, iEnd)
// 特征：必须含函数头；含「facts」或「atomicWrite」（它写的是 .md 文件）
if (!removed.includes('async function recordEmotion(')) {
  console.log('❌ 待删块不含 recordEmotion 函数头，中止')
  process.exit(1)
}
if (!/facts|atomicWrite|readIfExists/.test(removed)) {
  console.log('❌ 待删块不像文件写入实现，中止')
  console.log('   实际结尾 200 字符:', JSON.stringify(removed.slice(-200)))
  process.exit(1)
}
console.log(`✅ 准备删除 recordEmotion 块：${removed.split('\n').length} 行`)

// 连同其后的空行一起删
let cutEnd = iEnd
while (cutEnd < text.length && text[cutEnd] === '\n') cutEnd++
text = text.slice(0, iStart) + text.slice(cutEnd)

// 导出项
const expLine = '    recordEmotion,\n'
if (text.split(expLine).length - 1 === 1) {
  text = text.split(expLine).join('')
  console.log('✅ 导出表移除 recordEmotion')
} else {
  console.log('⚠️ recordEmotion 导出项数量异常，跳过')
}

// ─────────────────────────────────────────────── 2) projectTemplate
const PT_START = 'function projectTemplate(name) {'
const iPt = text.indexOf(PT_START)
if (iPt >= 0) {
  // 往前找该行的行首
  let s = iPt
  while (s > 0 && text[s - 1] !== '\n') s--
  // 往前吃紧邻的 /** */ 注释（仅当中间只有空白）
  let p = s
  let f = s
  const before = text.slice(0, s)
  const cmMatch = before.match(/\/\*\*[\s\S]*?\*\/\n\n$/)
  if (cmMatch) {
    f = s - cmMatch[0].length
  }
  let d = 0, beg = false, e = -1
  for (let i = iPt; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') { d++; beg = true }
    else if (ch === '}') { d--; if (beg && d === 0) { e = i + 1; break } }
  }
  if (e > 0) {
    let cutTo = e
    while (cutTo < text.length && text[cutTo] === '\n') cutTo++
    const c2 = text.slice(f, cutTo)
    if (c2.includes(PT_START)) {
      console.log(`✅ 删除 projectTemplate：${c2.split('\n').length} 行`)
      text = text.slice(0, f) + text.slice(cutTo)
    } else {
      console.log('⚠️ projectTemplate 切除范围异常，跳过')
    }
  }
}

fs.writeFileSync(FILE, text, 'utf8')
console.log('已写入第一步（recordEmotion + projectTemplate）')
