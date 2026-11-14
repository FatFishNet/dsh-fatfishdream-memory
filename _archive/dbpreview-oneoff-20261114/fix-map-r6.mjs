/**
 * 最后一轮清扫后的地图重校（简化版）。
 *
 * 思路：不再逐条维护「旧值→新值」，而是
 *   1. 收集地图里所有 L#### 引用
 *   2. 对每个失效的，按它在**哪一行文字里**反查真正的锚点
 *   3. 用「函数名 → 真实行号」表直接替换
 *
 * 这样避免脆弱的上下文匹配。
 */
import fs from 'node:fs'

const IDX = fs.readFileSync('dsh-memory/index.js', 'utf8').split('\n')
const MAP = 'docs/项目地图.md'

function lineOf(re) {
  const hits = []
  IDX.forEach((l, i) => { if (re.test(l)) hits.push(i + 1) })
  return hits[0] ?? null
}

/** 函数名 → 真实行号（唯一真相源） */
const T = {
  name: lineOf(/^export const name/),
  inject: lineOf(/^export const inject/),
  PLUGIN_SOURCE_KIND: lineOf(/^const PLUGIN_SOURCE_KIND/),
  safePushMessage: lineOf(/^function safePushMessage/),
  healthState: lineOf(/^const healthState/),
  DEFAULT_CONFIG: lineOf(/^const DEFAULT_CONFIG/),
  MEMORY_DIR_NAME: lineOf(/^const MEMORY_DIR_NAME/),
  resolveRoot: lineOf(/^function resolveRoot/),
  truncateBytes: lineOf(/^function truncateBytes/),
  FACTS_TEMPLATE: lineOf(/^const FACTS_TEMPLATE/),
  POLICY_TEMPLATE: lineOf(/^const POLICY_TEMPLATE/),
  projectTemplate: lineOf(/^function projectTemplate/),
  STRONG_THRESHOLD: lineOf(/^const STRONG_THRESHOLD/),
  LEXICON: lineOf(/^const LEXICON = /),
  analyzeEmotion: lineOf(/^function analyzeEmotion/),
  createStore: lineOf(/^function createStore\(/),
  readStateSync: lineOf(/^function readStateSync/),
  apply: lineOf(/^export function apply/),
  systemFallbackRoot: lineOf(/^function systemFallbackRoot/),
  backupDbFile: lineOf(/async function backupDbFile/),
  ensureLayout: lineOf(/^\s*async function ensureLayout/),
  readState: lineOf(/^\s*async function readState\(/),
  writeState: lineOf(/^\s*async function writeState/),
  resolveProjectKey: lineOf(/^\s*function resolveProjectKey/),
  registerProject: lineOf(/^\s*async function registerProject/),
  policyTextSync: lineOf(/^\s*function policyTextSync/),
  stripPolicyPhrases: lineOf(/^\s*function stripPolicyPhrases/),
  measureInjection: lineOf(/^\s*function measureInjection/),
  safeOn: lineOf(/^\s*const safeOn/),
  getDbStore: lineOf(/^\s*const getDbStore/),
  dbStoreExists: lineOf(/^\s*const dbStoreExists/),
  dbPathOf: lineOf(/^\s*const dbPathOf/),
  checkWritableRoot: lineOf(/^\s*const checkWritableRoot/),
  checkWritableRootSched: lineOf(/setTimeout\(checkWritableRoot/),
  initDbStore: lineOf(/^\s*function initDbStore/),
  initDbStoreCall: lineOf(/^\s*initDbStore\(\)/),
  rebindDbStore: lineOf(/^\s*function rebindDbStore/),
  sysPrompt: lineOf(/^\s*const dispose = ctx\.systemPrompt\.context/),
  renderFromDb: lineOf(/^\s*function renderFromDb/),
  finishInjection: lineOf(/^\s*function finishInjection/),
  usageLines: lineOf(/^\s*const usageLines = dbMode/),
  sessionEvent1: lineOf(/safeOn\('session\/event'/),
  MEM_MARKER_RE: lineOf(/^\s*const MEM_MARKER_RE/),
  TOPIC_WHITELIST: lineOf(/^\s*const TOPIC_WHITELIST/),
  sanitizeTopic: lineOf(/^\s*function sanitizeTopic/),
  findTableById: lineOf(/^\s*function findTableById/),
  readHeartbeat: lineOf(/^\s*function readHeartbeat/),
  writeHeartbeat: lineOf(/^\s*async function writeHeartbeat/),
  reportBudget: lineOf(/^\s*function reportBudget/),
  looksLikeRedline: lineOf(/^\s*function looksLikeRedline/),
  toolsResult: lineOf(/safeOn\('tools\/result'/),
  turnStopping: lineOf(/safeOn\('agent\/turn-stopping'/),
  agentCreated: lineOf(/safeOn\('agent\/created'/),
  WRITE_TOOLS: lineOf(/^\s*const WRITE_TOOLS/),
  PWSH: lineOf(/^\s*const PWSH_WRITE_PATTERNS/),
  isWriteLikeCall: lineOf(/^\s*const isWriteLikeCall/),
  commandsInject: lineOf(/ctx\.inject\(\['commands'\]/),
  webServerInject: lineOf(/ctx\.inject\(\['webServer'\]/),
  routesArr: lineOf(/^\s*const routes = \[/),
  disposers: lineOf(/^\s*const disposers = routes/),
  webServerRegister: lineOf(/webServer\.register\(route\)/),
  runHealthCheck: lineOf(/^\s*const runHealthCheck/),
  runHealthCheckSched: lineOf(/setTimeout\(runHealthCheck/),
  injectedPromptSet: lineOf(/injectedPrompt = true/),
  registeredCommandSet: lineOf(/registeredCommand = true/),
  overviewSync: lineOf(/^\s*async function overview/),
}
// session/event 第二个
const se = []
IDX.forEach((l, i) => { if (/safeOn\('session\/event'/.test(l)) se.push(i + 1) })
T.sessionEvent2 = se[1]

const missing = Object.entries(T).filter(([, v]) => v === null || v === undefined)
if (missing.length) {
  console.log('❌ 有锚点找不到：', missing.map(([k]) => k).join(', '))
  process.exit(1)
}

// 用「文本特征 → 新行号」直接修
let text = fs.readFileSync(MAP, 'utf8')
let fixed = 0

function sub(re, to, label) {
  const before = text
  text = text.replace(re, to)
  if (text !== before) { fixed++; return true }
  console.log(`  ⚠️ 未匹配: ${label}`)
  return false
}

// ── 初始化顺序块：整体重写（最可靠）
const blockRe = /L\d+  apply 定义[\s\S]*?L\d+  runHealthCheck（定义；L\d+ 延迟 600ms 跑）/
const newBlock = [
  `L${T.apply}  apply 定义 / L${T.apply + 1} config 合并默认值`,
  `L${T.safeOn}  safeOn                         ← 安全注册事件（失败不中断 apply）`,
  `L${T.initDbStore - 19}  let dbPath / L${T.initDbStore - 18} let dbStore 声明（L${T.initDbStore} initDbStore 定义，L${T.initDbStoreCall} 首次调用）`,
  `L${T.checkWritableRoot}  checkWritableRoot（定义；L${T.checkWritableRootSched} 延迟 1500ms 跑）`,
  `L${T.sysPrompt}  注入层（systemPrompt.context）`,
  `L${T.sessionEvent1}  标记写入监听（session/event，assistant/message）`,
  `L${T.findTableById}  findTableById`,
  `L${T.readHeartbeat}  readHeartbeat`,
  `L${T.writeHeartbeat}  writeHeartbeat`,
  `L${T.reportBudget}  reportBudget`,
  `L${T.looksLikeRedline}  looksLikeRedline`,
  `L${T.sessionEvent2}  情绪录入监听（session/event，user/message）`,
  `L${T.WRITE_TOOLS}  WRITE_TOOLS`,
  `L${T.PWSH}  PWSH_WRITE_PATTERNS`,
  `L${T.isWriteLikeCall}  isWriteLikeCall`,
  `L${T.toolsResult}  tools/result 监听（实质改动判定）`,
  `L${T.turnStopping}  turn-stopping 监听（**已不插对话**，仅日志）`,
  `L${T.agentCreated}  agent/created 监听（登记项目 + 隔天整理提醒）`,
  `L${T.commandsInject}  /memory 命令（commands.register 在其后）`,
  `L${T.webServerInject}  HTTP 路由（webServer inject；routes 数组 L${T.routesArr}，注册在 L${T.disposers}–${T.webServerRegister}）`,
  `L${T.runHealthCheck}  runHealthCheck（定义；L${T.runHealthCheckSched} 延迟 600ms 跑）`,
].join('\n')

if (!blockRe.test(text)) { console.log('❌ 找不到初始化顺序块'); process.exit(1) }
text = text.replace(blockRe, newBlock)
fixed++

// ── 其它散点
sub(/（L\d+）(?=\s*\|\s*0\/8000)/, '', 'noop') // 防误伤
sub(/`createStore`（L\d+）/, `\`createStore\`（L${T.createStore}）`, 'createStore')
sub(/`createStore`（L\d+–\d+）/, `\`createStore\`（L${T.createStore}–${T.createStore + 923}）`, 'createStore range')
sub(/找它要先找 L\d+ 那一节/, `找它要先找 L${T.createStore} 那一节`, 'createStore 提示')
sub(/`resolveProjectKey`（L\d+）/, `\`resolveProjectKey\`（L${T.resolveProjectKey}）`, 'resolveProjectKey')
sub(/`stripPolicyPhrases`（L\d+）/, `\`stripPolicyPhrases\`（L${T.stripPolicyPhrases}）`, 'stripPolicyPhrases')
sub(/`measureInjection`（L\d+，/, `\`measureInjection\`（L${T.measureInjection}，`, 'measureInjection')
sub(/`MEM_MARKER_RE`（L\d+，另见 L\d+ 白名单 \/ L\d+ `sanitizeTopic`）/,
  `\`MEM_MARKER_RE\`（L${T.MEM_MARKER_RE}，另见 L${T.TOPIC_WHITELIST} 白名单 / L${T.sanitizeTopic} \`sanitizeTopic\`）`, 'MEM_MARKER_RE')
sub(/### 3\.5 标记写入通道（L\d+）/, `### 3.5 标记写入通道（L${T.sessionEvent1}）`, '3.5')
sub(/### 3\.6 轮次提醒（L\d+）/, `### 3.6 轮次提醒（L${T.turnStopping}）`, '3.6')
sub(/`reportBudget`（L\d+）/, `\`reportBudget\`（L${T.reportBudget}）`, 'reportBudget')
sub(/\| `renderFromDb` \| L\d+ \|/, `| \`renderFromDb\` | L${T.renderFromDb} |`, 'renderFromDb 表')
sub(/\| `finishInjection` \| L\d+ \|/, `| \`finishInjection\` | L${T.finishInjection} |`, 'finishInjection 表')
sub(/\| `usageLines` \| L\d+ \|/, `| \`usageLines\` | L${T.usageLines} |`, 'usageLines 表')
sub(/入口 \*\*L\d+\*\*。/, `入口 **L${T.sysPrompt}**。`, '注入入口')
sub(/systemPrompt\.context \(L\d+\)/, `systemPrompt.context (L${T.sysPrompt})`, '数据流 context')
sub(/renderFromDb \(L\d+\)/, `renderFromDb (L${T.renderFromDb})`, '数据流 renderFromDb')
sub(/finishInjection \(L\d+\)/, `finishInjection (L${T.finishInjection})`, '数据流 finishInjection')
sub(/session\/event（L\d+）→ analyzeEmotion/, `session/event（L${T.sessionEvent2}）→ analyzeEmotion`, '数据流 emotion')
sub(/turn-stopping（L\d+）时消费/, `turn-stopping（L${T.turnStopping}）时消费`, '数据流 turn')
sub(/\*\*`usageLines`（L\d+）\*\*/, `**\`usageLines\`（L${T.usageLines}）**`, '影响面 usageLines')
sub(/`findTableById`（L\d+）/, `\`findTableById\`（L${T.findTableById}）`, '影响面 findTableById')
sub(/`runHealthCheck` L\d+ 定义，L\d+ 调度/, `\`runHealthCheck\` L${T.runHealthCheck} 定义，L${T.runHealthCheckSched} 调度`, '健康自检')
sub(/`agent\/created`（L\d+）/, `\`agent/created\`（L${T.agentCreated}）`, '7.1 agentCreated')
sub(/`ensureLayout`（L\d+ 定义，调用在 L\d+）/, `\`ensureLayout\`（L${T.ensureLayout} 定义，调用在 L2373）`, '7.1 ensureLayout')
sub(/`index\.js` 的 `usageLines`（L\d+）/, `\`index.js\` 的 \`usageLines\`（L${T.usageLines}）`, '13 usageLines')
sub(/`POLICY_TEMPLATE`（L\d+）/, `\`POLICY_TEMPLATE\`（L${T.POLICY_TEMPLATE}）`, '13 POLICY_TEMPLATE')
// 事件表五条
sub(/\| \*\*L\d+\*\* \| \*\*assistant\/message\*\*/, `| **L${T.sessionEvent1}** | **assistant/message**`, '事件表 assistant')
sub(/\| \*\*L\d+\*\* \| user\/message/, `| **L${T.sessionEvent2}** | user/message`, '事件表 user')
sub(/\| L\d+ \| 检测沙箱拒绝/, `| L${T.toolsResult} | 检测沙箱拒绝`, '事件表 tools')
sub(/\| L\d+ \| 消费待判情绪队列/, `| L${T.turnStopping} | 消费待判情绪队列`, '事件表 turn')
sub(/\| L\d+ \| 登记项目/, `| L${T.agentCreated} | 登记项目`, '事件表 created')
// 健康自检两个标志
sub(/`injectedPrompt` 标志，L\d+ 声明 \/ L\d+ 置位/,
  `\`injectedPrompt\` 标志，L${T.apply + 23} 声明 / L${T.injectedPromptSet} 置位`, 'injectedPrompt')
sub(/`registeredCommand`，L\d+ 声明 \/ L\d+ 置位/,
  `\`registeredCommand\`，L${T.apply + 24} 声明 / L${T.registeredCommandSet} 置位`, 'registeredCommand')
// 3.1 表
sub(/\| \d+ \| `name` \|/, `| ${T.name} | \`name\` |`, '3.1 name')
sub(/\| \d+ \| `inject` \|/, `| ${T.inject} | \`inject\` |`, '3.1 inject')
sub(/\| \d+ \| `PLUGIN_SOURCE_KIND` \|/, `| ${T.PLUGIN_SOURCE_KIND} | \`PLUGIN_SOURCE_KIND\` |`, '3.1 PLUGIN_SOURCE_KIND')
sub(/\| \d+ \| `safePushMessage` \|/, `| ${T.safePushMessage} | \`safePushMessage\` |`, '3.1 safePushMessage')
sub(/\| \d+ \| `healthState` \|/, `| ${T.healthState} | \`healthState\` |`, '3.1 healthState')
sub(/\| \d+ \| `DEFAULT_CONFIG` \|/, `| ${T.DEFAULT_CONFIG} | \`DEFAULT_CONFIG\` |`, '3.1 DEFAULT_CONFIG')
sub(/\| \d+ \| `MEMORY_DIR_NAME` \|/, `| ${T.MEMORY_DIR_NAME} | \`MEMORY_DIR_NAME\` |`, '3.1 MEMORY_DIR_NAME')
sub(/\| \d+ \| `systemFallbackRoot` \|/, `| ${T.systemFallbackRoot} | \`systemFallbackRoot\` |`, '3.1 systemFallbackRoot')
sub(/\| \d+ \| `resolveRoot` \|/, `| ${T.resolveRoot} | \`resolveRoot\` |`, '3.1 resolveRoot')
sub(/\| \d+ \| `truncateBytes` \|/, `| ${T.truncateBytes} | \`truncateBytes\` |`, '3.1 truncateBytes')
sub(/\| \d+ \| `FACTS_TEMPLATE` \|/, `| ${T.FACTS_TEMPLATE} | \`FACTS_TEMPLATE\` |`, '3.1 FACTS_TEMPLATE')
sub(/\| \d+ \| `POLICY_TEMPLATE` \|/, `| ${T.POLICY_TEMPLATE} | \`POLICY_TEMPLATE\` |`, '3.1 POLICY_TEMPLATE')
sub(/\| \d+ \| `projectTemplate` \|/, `| ${T.projectTemplate} | \`projectTemplate\` |`, '3.1 projectTemplate')
sub(/\| \d+ \| `STRONG_THRESHOLD` \|/, `| ${T.STRONG_THRESHOLD} | \`STRONG_THRESHOLD\` |`, '3.1 STRONG_THRESHOLD')
sub(/\| \d+ \| `LEXICON` \|/, `| ${T.LEXICON} | \`LEXICON\` |`, '3.1 LEXICON')
sub(/\| \d+ \| `analyzeEmotion` \|/, `| ${T.analyzeEmotion} | \`analyzeEmotion\` |`, '3.1 analyzeEmotion')

fs.writeFileSync(MAP, text, 'utf8')
console.log(`\n完成，应用 ${fixed} 处`)
console.log('锚点表：')
for (const [k, v] of Object.entries(T)) if (v) console.log(`  ${k.padEnd(22)} L${v}`)
