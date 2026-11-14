/**
 * 第 4 轮后的地图全量重校。
 *
 * 做法：不手抄行号 —— 从源码按**函数名正则**重新定位每处锚点，
 * 再把地图里对应的数字批量替换。替换带命中数断言，对不上就中止。
 */
import fs from 'node:fs'

const IDX = fs.readFileSync('dsh-memory/index.js', 'utf8').split('\n')
const MAP = 'docs/项目地图.md'

/** 按正则找唯一行号 */
function lineOf(re, label) {
  const hits = []
  IDX.forEach((l, i) => { if (re.test(l)) hits.push(i + 1) })
  if (hits.length === 0) {
    console.log(`  ?? 找不到锚点: ${label}`)
    return null
  }
  return hits[0]
}

// 锚点表：地图里的旧值 → 重新定位用的正则
const ANCHORS = [
  ['createStore', /^function createStore\(/],
  ['resolveProjectKey', /^\s*function resolveProjectKey/],
  ['stripPolicyPhrases', /^\s*function stripPolicyPhrases/],
  ['measureInjection', /^\s*function measureInjection/],
  ['WRITE_TOOLS', /^\s*const WRITE_TOOLS/],
  ['PWSH_WRITE_PATTERNS', /^\s*const PWSH_WRITE_PATTERNS/],
  ['isWriteLikeCall', /^\s*const isWriteLikeCall/],
  ['findTableById', /^\s*function findTableById/],
  ['readHeartbeat', /^\s*function readHeartbeat/],
  ['writeHeartbeat', /^\s*async function writeHeartbeat/],
  ['reportBudget', /^\s*function reportBudget/],
  ['looksLikeRedline', /^\s*function looksLikeRedline/],
  ['MEM_MARKER_RE', /^\s*const MEM_MARKER_RE/],
  ['TOPIC_WHITELIST', /^\s*const TOPIC_WHITELIST/],
  ['sanitizeTopic', /^\s*function sanitizeTopic/],
  ['systemPrompt.context', /^\s*const dispose = ctx\.systemPrompt\.context/],
  ['renderFromDb', /^\s*function renderFromDb/],
  ['finishInjection', /^\s*function finishInjection/],
  ['usageLines', /^\s*const usageLines = dbMode/],
  ['initDbStore', /^\s*function initDbStore/],
  ['rebindDbStore', /^\s*function rebindDbStore/],
  ['getDbStore', /^\s*const getDbStore/],
  ['checkWritableRoot', /^\s*const checkWritableRoot/],
  ['checkWritableRoot 调度', /setTimeout\(checkWritableRoot/],
  ['safeOn', /^\s*const safeOn/],
  ['apply', /^export function apply/],
  ['routes 数组', /^\s*const routes = \[/],
  ['webServer inject', /ctx\.inject\(\['webServer'\]/],
  ['webServer.register', /webServer\.register\(route\)/],
  ['commands inject', /ctx\.inject\(\['commands'\]/],
  ['runHealthCheck', /^\s*const runHealthCheck/],
  ['runHealthCheck 调度', /setTimeout\(runHealthCheck/],
  ['overview', /^\s*async function overview/],
  ['ensureLayout', /^\s*async function ensureLayout/],
  ['POLICY_TEMPLATE', /^const POLICY_TEMPLATE/],
  ['agent/created', /safeOn\('agent\/created'/],
  ['session/event #1', /safeOn\('session\/event'/],
  ['tools/result', /safeOn\('tools\/result'/],
  ['turn-stopping', /safeOn\('agent\/turn-stopping'/],
  ['injectedPrompt 置位', /injectedPrompt = true/],
  ['registeredCommand 置位', /registeredCommand = true/],
]

const REAL = new Map()
console.log('=== 重定位结果 ===')
for (const [name, re] of ANCHORS) {
  const n = lineOf(re, name)
  REAL.set(name, n)
  console.log(`${name.padEnd(24)} ${n ? 'L' + n : '缺失'}`)
}

// 派生：user/message 是第二个 session/event
const se = []
IDX.forEach((l, i) => { if (/safeOn\('session\/event'/.test(l)) se.push(i + 1) })
console.log(`${'session/event #2'.padEnd(24)} ${se[1] ? 'L' + se[1] : '缺失'}`)

let text = fs.readFileSync(MAP, 'utf8')
const EDITS = []
const E = (from, to, expect = 1) => EDITS.push([from, to, expect])

// ── §2 文件清单
E('（L1169）', `（L${REAL.get('createStore')}）`)
E('（L1169–2106）', `（L${REAL.get('createStore')}–${REAL.get('createStore') + 937}）`)
E('> 找它要先找 L1169 那一节。', `> 找它要先找 L${REAL.get('createStore')} 那一节。`)
E('（L1241）', `（L${REAL.get('resolveProjectKey')}）`)
E('（L1448）、`measureInjection`（L1604', `（L${REAL.get('stripPolicyPhrases')}）、\`measureInjection\`（L${REAL.get('measureInjection')}`)

// ── §3.3 初始化顺序整块
const BLOCK_NEW = `L${REAL.get('apply')}  apply 定义 / L${REAL.get('apply') + 1} config 合并默认值
L${REAL.get('safeOn')}  safeOn                         ← 安全注册事件（失败不中断 apply）
L${REAL.get('initDbStore') - 19}  let dbPath / L${REAL.get('initDbStore') - 18} let dbStore 声明（L${REAL.get('initDbStore')} initDbStore 定义，L${REAL.get('initDbStore') + 26} 首次调用）
L${REAL.get('checkWritableRoot')}  checkWritableRoot（定义；L${REAL.get('checkWritableRoot 调度')} 延迟 1500ms 跑）
L${REAL.get('systemPrompt.context')}  注入层（systemPrompt.context）
L${REAL.get('session/event #1')}  标记写入监听（session/event，assistant/message）
L${REAL.get('findTableById')}  findTableById
L${REAL.get('readHeartbeat')}  readHeartbeat
L${REAL.get('writeHeartbeat')}  writeHeartbeat
L${REAL.get('reportBudget')}  reportBudget
L${REAL.get('looksLikeRedline')}  looksLikeRedline
L${se[1]}  情绪录入监听（session/event，user/message）
L${REAL.get('WRITE_TOOLS')}  WRITE_TOOLS
L${REAL.get('PWSH_WRITE_PATTERNS')}  PWSH_WRITE_PATTERNS
L${REAL.get('isWriteLikeCall')}  isWriteLikeCall
L${REAL.get('tools/result')}  tools/result 监听（实质改动判定）
L${REAL.get('turn-stopping')}  turn-stopping 监听（**已不插对话**，仅日志）
L${REAL.get('agent/created')}  agent/created 监听（登记项目 + 隔天整理提醒）
L${REAL.get('commands inject')}  /memory 命令（commands.register 在其后）
L${REAL.get('webServer inject')}  HTTP 路由（webServer inject；routes 数组 L${REAL.get('routes 数组')}，注册在 L${REAL.get('webServer.register') - 2}–${REAL.get('webServer.register')}）
L${REAL.get('runHealthCheck')}  runHealthCheck（定义；L${REAL.get('runHealthCheck 调度')} 延迟 600ms 跑）`

const blockRe = /L\d+  apply 定义[\s\S]*?L\d+  runHealthCheck（定义；L\d+ 延迟 600ms 跑）/
if (!blockRe.test(text)) {
  console.log('❌ 找不到「初始化顺序」块，中止')
  process.exit(1)
}
text = text.replace(blockRe, BLOCK_NEW)

// ── §3.3 事件表
E('| `session/event` | **L2724** |', `| \`session/event\` | **L${REAL.get('session/event #1')}** |`)
E('| `session/event` | **L2972** |', `| \`session/event\` | **L${se[1]}** |`)
E('| `tools/result` | L3167 |', `| \`tools/result\` | L${REAL.get('tools/result')} |`)
E('| `agent/turn-stopping` | L3228 |', `| \`agent/turn-stopping\` | L${REAL.get('turn-stopping')} |`)
E('| `agent/created` | L3310 |', `| \`agent/created\` | L${REAL.get('agent/created')} |`)

// ── §3.4 注入层
E('入口 **L2428**。', `入口 **L${REAL.get('systemPrompt.context')}**。`)
E('| `renderFromDb` | L2486 |', `| \`renderFromDb\` | L${REAL.get('renderFromDb')} |`)
E('| `finishInjection` | L2556 |', `| \`finishInjection\` | L${REAL.get('finishInjection')} |`)
E('| `usageLines` | L2565 |', `| \`usageLines\` | L${REAL.get('usageLines')} |`)

// ── §3.5 / §3.6
E('### 3.5 标记写入通道（L2724）', `### 3.5 标记写入通道（L${REAL.get('session/event #1')}）`)
E('MEM_MARKER_RE（L2670，另见 L2686 白名单 / L2690 `sanitizeTopic`）',
  `MEM_MARKER_RE（L${REAL.get('MEM_MARKER_RE')}，另见 L${REAL.get('TOPIC_WHITELIST')} 白名单 / L${REAL.get('sanitizeTopic')} \`sanitizeTopic\`）`)
E('`reportBudget`（L2951）检查预算', `\`reportBudget\`（L${REAL.get('reportBudget')}）检查预算`)
E('### 3.6 轮次提醒（L3228）', `### 3.6 轮次提醒（L${REAL.get('turn-stopping')}）`)

// ── §8 数据流
E(`systemPrompt.context (L2428)`, `systemPrompt.context (L${REAL.get('systemPrompt.context')})`)
E('├─ 是：renderFromDb (L2486)', `├─ 是：renderFromDb (L${REAL.get('renderFromDb')})`)
E('→ finishInjection (L2556)（加使用说明）', `→ finishInjection (L${REAL.get('finishInjection')})（加使用说明）`)
E('（L2724）', `（L${REAL.get('session/event #1')}）`)
E('session/event（L2972）→ analyzeEmotion', `session/event（L${se[1]}）→ analyzeEmotion`)
E('turn-stopping（L3228）时消费并告知', `turn-stopping（L${REAL.get('turn-stopping')}）时消费并告知`)

// ── §9 影响面
E('| **`usageLines`（L2565）** |', `| **\`usageLines\`（L${REAL.get('usageLines')}）** |`)
E('| `findTableById`（L2828） |', `| \`findTableById\`（L${REAL.get('findTableById')}） |`)

// ── §12 健康自检
E('`runHealthCheck` L4067 定义，L4151 调度', `\`runHealthCheck\` L${REAL.get('runHealthCheck')} 定义，L${REAL.get('runHealthCheck 调度')} 调度`)
E('L2196 声明 / L2464 置位', `L${REAL.get('apply') + 25} 声明 / L${REAL.get('injectedPrompt 置位')} 置位`)
E('L2197 声明 / L3369 置位', `L${REAL.get('apply') + 26} 声明 / L${REAL.get('registeredCommand 置位')} 置位`)

// ── §7.1
E('`agent/created`（L3310）加了', `\`agent/created\`（L${REAL.get('agent/created')}）加了`)
E('`ensureLayout`（L1197 定义，调用在 L2358）', `\`ensureLayout\`（L${REAL.get('ensureLayout')} 定义，调用在 L2373）`)
E('预建调用（L3310）当时都不看模式', `预建调用（L${REAL.get('agent/created')}）当时都不看模式`)

// ── §13 维护协议
E('**`index.js` 的 `usageLines`（L2565）** ← 最容易漏；另外 `POLICY_TEMPLATE`（L615）',
  `**\`index.js\` 的 \`usageLines\`（L${REAL.get('usageLines')}）** ← 最容易漏；另外 \`POLICY_TEMPLATE\`（L${REAL.get('POLICY_TEMPLATE')}）`)

let bad = 0
for (const [from, to, expect] of EDITS) {
  const n = text.split(from).length - 1
  if (n !== expect) {
    console.log(`❌ 期望 ${expect} 实际 ${n}: ${JSON.stringify(from.slice(0, 70))}`)
    bad++
    continue
  }
  text = text.split(from).join(to)
}

if (bad > 0) {
  console.log(`\n中止：${bad} 处对不上，未写入`)
  process.exit(1)
}
fs.writeFileSync(MAP, text, 'utf8')
console.log(`\n已写入 ${EDITS.length} 处`)
