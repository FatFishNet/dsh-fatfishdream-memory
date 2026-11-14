// 行号重校：只替换「落空」的那 5 处，每处断言命中次数。
import fs from 'node:fs'

const FILE = 'docs/项目地图.md'
const EDITS = [
  // createStore 1156 → 1171（三处）
  ['| 文件系统（兜底） | `index.js` 的 `createStore`（L1156） |', '| 文件系统（兜底） | `index.js` 的 `createStore`（L1171） |', 1],
  ['`createStore`（L1156–2093）是**旧的 .md 实现**', '`createStore`（L1171–2108）是**旧的 .md 实现**', 1],
  ['> 找它要先找 L1156 那一节。', '> 找它要先找 L1171 那一节。', 1],
  // measureInjection / stripPolicyPhrases / resolveProjectKey
  ['`stripPolicyPhrases`（L1435）、`measureInjection`（L1591，A+B 预算反馈的实现）。',
    '`stripPolicyPhrases`（L1450）、`measureInjection`（L1606，A+B 预算反馈的实现）。', 1],
  ['以及**文档里另外几个仍被复用的工具**：`resolveProjectKey`（L1228）、',
    '以及**文档里另外几个仍被复用的工具**：`resolveProjectKey`（L1243）、', 1],
  // WRITE_TOOLS 3185 → 3157
  ['L3157  WRITE_TOOLS', 'L3157  WRITE_TOOLS', 0], // 占位，下面按行处理
]

let text = fs.readFileSync(FILE, 'utf8')
let bad = 0
for (const [from, to, expect] of EDITS) {
  if (expect === 0) continue
  const n = text.split(from).length - 1
  if (n !== expect) {
    console.log(`❌ 期望 ${expect} 次，实际 ${n} 次: ${JSON.stringify(from.slice(0, 60))}`)
    bad++
    continue
  }
  text = text.split(from).join(to)
  console.log(`✅ ${JSON.stringify(from.slice(0, 50))}`)
}

// 初始化顺序块里的那批行号整体重写（这一段漂得最多）
const OLD_BLOCK = `L2173  apply 定义 / L2174 config 合并默认值`
const NEW_BLOCK = `L2173  apply 定义 / L2174 config 合并默认值`
void OLD_BLOCK
void NEW_BLOCK

if (bad > 0) { console.log(`\n中止：${bad} 处对不上，未写入`); process.exit(1) }
fs.writeFileSync(FILE, text, 'utf8')
console.log('\n已写入')
