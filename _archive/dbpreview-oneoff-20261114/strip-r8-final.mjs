/**
 * 第 8 轮（收尾）：删除最后一组零调用代码。
 *
 * 已核实：
 *   recordEmotion（文件版）→ 外部只调 dbStore.recordEmotion，零调用
 *   projectTemplate        → 零调用
 *   FACTS_TEMPLATE         → 只剩 recordEmotion 与 ensureLayout 里引用，
 *                            而 ensureLayout 的 fileMode 分支在数据库模式下永不执行
 *
 * 处理策略：
 *   1. 删 recordEmotion（文件版）整个方法 + 导出项
 *   2. 删 projectTemplate + 导出项（如果有）
 *   3. ensureLayout 去掉 fileMode 分支（数据库模式唯一在用的路径）
 *      —— 这样 FACTS_TEMPLATE 就彻底零引用，可删常量
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

// ── 1. recordEmotion（文件版）
function findFn(src, name) {
  const needle = 'async function ' + name + '('
  const at = src.indexOf(needle)
  if (at < 0) return null
  let start = at
  while (start > 0 && src[start - 1] !== '\n') start--
  let depth = 0, started = false, end = -1
  for (let i = at; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth--; if (started && depth === 0) { end = i + 1; break } }
  }
  return end < 0 ? null : { start, end }
}

// 删 recordEmotion 之前，先确认外部没有 store.recordEmotion(
if (/store\.recordEmotion\(/.test(text)) {
  console.log('❌ 仍有 store.recordEmotion 调用，中止')
  process.exit(1)
}

const re = findFn(text, 'recordEmotion')
if (!re) { console.log('❌ 找不到 recordEmotion'); process.exit(1) }

// 往前吃掉紧邻的 /** */ 注释
let from = re.start
let probe = from
while (probe > 0 && text[probe - 1] === '\n') probe--
if (text.slice(Math.max(0, probe - 2), probe) === '*/') {
  const openIdx = text.lastIndexOf('/**', probe)
  if (openIdx >= 0) { from = openIdx; while (from > 0 && text[from - 1] === '\n') from-- }
}
const chunk = text.slice(from, re.end)
if (!chunk.includes('async function recordEmotion(')) { console.log('❌ 切除范围不含函数头'); process.exit(1) }
console.log(`✅ 删除 recordEmotion（${chunk.split('\n').length} 行）`)
text = text.slice(0, from) + '\n\n' + text.slice(re.end).replace(/^\n+/, '')

// 导出项
for (const line of ['    recordEmotion,\n']) {
  if (text.split(line).length - 1 === 1) { text = text.split(line).join(''); console.log('✅ 导出表移除 recordEmotion') }
}

// ── 2. projectTemplate
const ptStart = text.indexOf('function projectTemplate(name) {')
if (ptStart >= 0) {
  let s = ptStart; while (s > 0 && text[s - 1] !== '\n') s--
  let depth = 0, started = false, e = -1
  for (let i = ptStart; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth--; if (started && depth === 0) { e = i + 1; break } }
  }
  if (e > 0) {
    // 吃掉前面的 /** */ 注释
    let f = s
    let p = f
    while (p > 0 && text[p - 1] === '\n') p--
    if (text.slice(Math.max(0, p - 2), p) === '*/') {
      const oi = text.lastIndexOf('/**', p)
      if (oi >= 0) { f = oi; while (f > 0 && text[f - 1] === '\n') f-- }
    }
    const c2 = text.slice(f, e)
    console.log(`✅ 删除 projectTemplate（${c2.split('\n').length} 行）`)
    text = text.slice(0, f) + '\n\n' + text.slice(e).replace(/^\n+/, '')
  }
}

// ── 3. ensureLayout 去掉 fileMode 分支
const OLD_LAYOUT = `  async function ensureLayout(options = {}) {
    const fileMode = options.fileMode === true
    await mkdir(root, { recursive: true })
    if (fileMode && !(await exists(paths.facts))) await atomicWrite(paths.facts, FACTS_TEMPLATE)
    if (!(await exists(paths.policy))) await atomicWrite(paths.policy, POLICY_TEMPLATE)
  }`
const NEW_LAYOUT = `  async function ensureLayout() {
    await mkdir(root, { recursive: true })
    // 唯一需要预建的文件：policy.md（行为规则，不进数据库）
    if (!(await exists(paths.policy))) await atomicWrite(paths.policy, POLICY_TEMPLATE)
  }`
if (text.split(OLD_LAYOUT).length - 1 === 1) {
  text = text.split(OLD_LAYOUT).join(NEW_LAYOUT)
  console.log('✅ ensureLayout 去掉 fileMode 分支')
} else {
  console.log('⚠️ ensureLayout 原文不匹配，跳过（需人工核对）')
}

// 调用方：ensureLayout({ fileMode: ... }) → ensureLayout()
const CALL_RE = /store\.ensureLayout\(\{ fileMode: !dbStoreExists\(\) \}\)/g
const nCall = (text.match(CALL_RE) || []).length
if (nCall === 1) {
  text = text.replace(CALL_RE, 'store.ensureLayout()')
  console.log('✅ 调用方改为无参')
}

// ── 4. 现在 FACTS_TEMPLATE 应零引用
const left = (text.match(/FACTS_TEMPLATE/g) || []).length
console.log(`FACTS_TEMPLATE 剩余引用: ${left} 次（含定义 1 次）`)

fs.writeFileSync(FILE, text, 'utf8')
console.log('已写入')
