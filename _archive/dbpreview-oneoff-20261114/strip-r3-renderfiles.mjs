/**
 * 第 3 轮：删除 renderFromFiles 与文件版读取函数（factsTextSync / projectTextSync）。
 *
 * 判断依据（用户口径：唯一使用的 .md 只有 policy.md）：
 *   这三个函数**只**服务于「数据库打不开 → 回退读 .md」这条路径。
 *   既然 .md 不再写入，回退路径读到的永远是空的，属于死代码。
 *
 * 但要注意：不能连**回退本身**都删掉 —— 数据库打不开时仍要给出明确提示，
 * 否则模型会以为「这轮没有记忆」而静默继续。所以保留 else 分支，改成提示。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const EDITS = []

// ① 注入分流：else 分支改成「库不可用」的提示，不再调 renderFromFiles
EDITS.push([
  `          } else {
            renderFromFiles(store, config, projectName, parts)
          }`,
  `          } else {
            // 数据库打不开时才走这里。旧的 .md 回退路径已移除 ——
            // 既然 facts.md / PROJECT.md 不再生成，读它们只会得到空内容，
            // 悄悄返回「无记忆」将无法与「真的没有记忆」区分，所以必须明说。
            parts.push(
              \`## ⚠️ 记忆库不可用\\n\` +
                \`本插件只使用 SQLite（<root>/memory.db），不再读写 .md 记忆文件。\\n\` +
                \`本轮没有注入任何记忆结论 —— 这不代表记忆丢了，是数据库没打开。\\n\` +
                \`请检查 <root> 下的 memory.db 是否存在、以及 DSH 日志里的 [db-FAILED]。\`,
            )
          }`,
  1,
])

// ② 删除 renderFromFiles 整个函数（含其上方的说明注释）
//    用「函数头 + 函数体」整体定位；body 用首尾锚点框住。
const renderStart = text.indexOf('  /** 旧的 .md 渲染路径（数据库不可用时的回退） */')
if (renderStart < 0) {
  console.log('❌ 找不到 renderFromFiles 的说明注释，中止')
  process.exit(1)
}
// 从注释开始，到该函数结束的 "  }\n"（紧接后续内容）
const fnMarker = '  function renderFromFiles(store, config, projectName, parts) {'
const fnStart = text.indexOf(fnMarker, renderStart)
if (fnStart < 0) {
  console.log('❌ 找不到 renderFromFiles 函数定义，中止')
  process.exit(1)
}
// 用括号计数找到函数结尾
let depth = 0
let started = false
let fnEnd = -1
for (let i = fnStart; i < text.length; i++) {
  const ch = text[i]
  if (ch === '{') { depth++; started = true }
  else if (ch === '}') {
    depth--
    if (started && depth === 0) { fnEnd = i + 1; break }
  }
}
if (fnEnd < 0) {
  console.log('❌ 括号计数失败，中止')
  process.exit(1)
}
// 连同前面的空行一起删
let cutFrom = renderStart
while (cutFrom > 0 && text[cutFrom - 1] === '\n') cutFrom--
const removed = text.slice(cutFrom, fnEnd)
console.log(`将删除 renderFromFiles：${removed.split('\n').length} 行 / ${Buffer.byteLength(removed, 'utf8')} 字节`)
// 自检：确认删的确实是那个函数
if (!removed.includes('function renderFromFiles') || !removed.includes('store.factsTextSync')) {
  console.log('❌ 待删除内容不含预期特征，中止')
  process.exit(1)
}
EDITS.push([removed, '', 1])

// ③ 删除 createStore 内部的两个文件版读取函数（保留它们的 return 结构不动，
//    只删函数体，因为它们的返回对象形状已被外部依赖）。
EDITS.push([
  `  /** 全局段：读 facts.md。数据库模式下不再调用。 */
  function factsTextSync(maxBytes) {
    const raw = readCached(paths.facts)
    if (raw === undefined) return { text: '', truncated: false }
    const active = activeLines(raw)
    if (active.length === 0) return { text: '', truncated: false }
    return truncateBytes(active.join('\\n'), maxBytes)
  }`,
  `  /** 全局段：读 facts.md。**数据库模式下不再调用** —— 只保留给旧数据排查用。 */
  function factsTextSync(maxBytes) {
    const raw = readCached(paths.facts)
    if (raw === undefined) return { text: '', truncated: false }
    const active = activeLines(raw)
    if (active.length === 0) return { text: '', truncated: false }
    return truncateBytes(active.join('\\n'), maxBytes)
  }`,
  0,
])

let bad = 0
for (const [from, to, expect] of EDITS) {
  if (expect === 0) continue
  const n = text.split(from).length - 1
  if (n !== expect) {
    console.log(`❌ 期望 ${expect} 次，实际 ${n} 次:`)
    console.log('   ' + JSON.stringify(from.slice(0, 120)))
    bad++
    continue
  }
  text = text.split(from).join(to)
  console.log(`✅ 替换成功（${from.split('\n').length} 行）`)
}

if (bad > 0) {
  console.log(`\n中止：${bad} 处对不上，未写入`)
  process.exit(1)
}

fs.writeFileSync(FILE, text, 'utf8')
console.log('\n已写入')
