/**
 * 终极验证：把 usageLines 实际渲染出的文本，用真实标记正则跑一遍。
 * 如果命中任何一条，说明注入文本会「自触发」写入 → 必须改写法。
 */
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// 从脚本自身位置推仓库根，别写死绝对路径（2026-11-13 工作区改名踩过）
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory/index.js'), 'utf8')

// 提取 dbMode 分支的 usageLines 数组（简单起见：手工重组关键行）
const start = src.indexOf('const usageLines = dbMode')
const end = src.indexOf('parts.push(`## 记忆使用说明')
const seg = src.slice(start, end)

// 取出所有单引号字符串字面量，模拟 join('\n')
const literals = [...seg.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) =>
  m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'),
)
const rendered = literals.join('\n')

console.log('重组后的注入说明长度:', rendered.length, '字符\n')

const RE = /^<!--mem-(log|fact|note|fix)(?:[ \t]+topic=([^\n]+))?\n([\s\S]*?)-->/gm
const hits = [...rendered.matchAll(RE)]

if (hits.length === 0) {
  console.log('✅ 不会自触发：注入文本里没有可被匹配的完整标记')
} else {
  console.log(`❌ 会自触发 ${hits.length} 次：`)
  for (const h of hits) {
    console.log(`   kind=${h[1]} topic=${h[2]}`)
    console.log(`   正文前 60: ${String(h[3]).slice(0, 60)}`)
  }
}

// 顺便展示渲染结果的关键段落
console.log('\n=== 渲染结果中的「怎么写」段落 ===')
const i = rendered.indexOf('## 怎么写')
console.log(rendered.slice(i, i + 700))
