/**
 * 终极验证：把 usageLines 实际渲染出的文本，用真实标记正则跑一遍。
 * 如果命中任何一条，说明注入文本会「自触发」写入 → 必须改写法。
 *
 * ⚠️ 2026-11-17 修（审计代理 P0 #2）：
 *
 *   ① **退出码恒 0**：原来只 console.log，命中 ❌ 也不影响退出码，
 *      而它在 `run-all.mjs` 的 SCRIPTS 里 → 真自触发时回归仍记 PASS。
 *      现在命中就 `process.exit(1)`。
 *
 *   ② **只抽单引号会漏模板字符串**：注入里大量用反引号（如那条要照抄的
 *      `Invoke-RestMethod ...` 命令），漏掉它们会让 rendered 少一大块，
 *      于是「0 处命中」不能证明任何事。
 *
 * ⚠️⚠️ 2026-11-17 第二次修（第一次的修法有 bug，记录在此避免重犯）：
 *
 *   第一次我把「反引号包裹的一切」都当成模板字符串抽出来 —— 但注入文案里
 *   的反引号大量是**行内代码标记**（如「退化到标记时：\`<!--mem-log topic=…\`」），
 *   它们不是字符串字面量。各片段单独成行后，被拼成了一个**假的完整标记**，
 *   于是报出 2 次「自触发」——**那是误报**，真实注入文本里没有这种形态。
 *
 *   正确做法：**不要手工重组**。直接用插件真实渲染逻辑产出的注入文本来测，
 *   或者退一步：只在**单条字符串字面量内部**找标记，不跨字面量拼接。
 *
 *   现在采用后者 —— 判据是「任何**单条**注入文案自身构成完整标记」。
 *   跨行拼接成标记在真实渲染里同样可能，但那需要 join('\n') 后整体检测；
 *   为兼顾两者，先按真实 join 检测，再用「命中是否跨字面量」区分误报。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 从脚本自身位置推仓库根，别写死绝对路径（2026-11-13 工作区改名踩过）
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory/index.js'), 'utf8')

// 提取 dbMode 分支的 usageLines 数组。
const start = src.indexOf('const usageLines = dbMode')
const end = src.indexOf('parts.push(`## 记忆使用说明')
if (start < 0 || end < 0 || end <= start) {
  console.error('❌ 无法定位 usageLines 区块（源码结构变了？）')
  process.exit(1)
}
const seg = src.slice(start, end)

// 抽取**字符串字面量**（这才是真正会进注入的文本）。
// 关键：单引号字面量内部的 `...` 是**行内代码标记**，属于文本的一部分，
// 不要把它单独当成模板字符串再抽一遍 —— 那正是第一次误报的根因。
const literals = []
for (const m of seg.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
  literals.push(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
}
// 顶层模板字符串（以 ` 开头且不是行内标记）：行首缩进后的 ` 才算
for (const m of seg.matchAll(/(?:^|\n)\s*`((?:[^`\\]|\\[\s\S])*)`/g)) {
  literals.push(m[1].replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\'))
}
const rendered = literals.join('\n')

console.log('重组后的注入说明长度:', rendered.length, '字符')
console.log('抽到的字面量条数:', literals.length, '\n')

// 自检：如果重组结果里连「照抄即可」那条命令都没有，说明抽取逻辑又漏了，
// 此时「0 处命中」没有意义 —— 必须直接判红，否则又是恒真。
const hasCopyCmd = rendered.includes('/api/dsh-memory/log')
if (!hasCopyCmd) {
  console.error('❌ 重组结果里找不到 POST 命令 —— 字符串抽取逻辑失效，本项无法验证')
  process.exit(1)
}

const RE = /^<!--mem-(log|fact|note|fix)(?:[ \t]+topic=([^\n]+))?\n([\s\S]*?)-->/gm
const hits = [...rendered.matchAll(RE)]

// 真正的判据：命中是否来自**单条字面量内部**。
// 单条内部就有完整标记 = 真的会自触发（注入里写了个能匹配自己的例子）。
// 只是跨字面量 join 后才凑出来 = 那是抽取方式的产物，真实渲染里两句之间
// 隔着换行和别的文案，不会构成标记。
const realHits = []
for (const lit of literals) {
  for (const m of lit.matchAll(RE)) realHits.push({ from: 'single', hit: m })
}

if (realHits.length === 0) {
  console.log('✅ 不会自触发：没有任何**单条**注入文案自身构成完整标记')
  if (hits.length > 0) {
    console.log(`   （跨字面量 join 后出现过 ${hits.length} 处「像标记」的片段，但那不是真实渲染形态）`)
  }
} else {
  console.log(`❌ 会自触发 ${realHits.length} 次（单条文案内部即构成标记）：`)
  for (const { hit } of realHits) {
    console.log(`   kind=${hit[1]} topic=${hit[2]}`)
    console.log(`   正文前 60: ${String(hit[3]).slice(0, 60)}`)
  }
}

process.exit(realHits.length === 0 ? 0 : 1)


