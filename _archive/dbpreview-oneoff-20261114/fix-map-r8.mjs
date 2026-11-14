/**
 * 第 8 轮后的地图全量重校。
 * 做法：把地图里「初始化顺序块」整体重写 + 关键散点按真值替换。
 */
import fs from 'node:fs'

const MAP = 'docs/项目地图.md'
let text = fs.readFileSync(MAP, 'utf8')

const T = {
  createStore: 1147,
  resolveProjectKey: 1218,
  stripPolicyPhrases: 1390,
  measureInjection: 1479,
  apply: 1879,
  initDbStore: 2013,
  sysPrompt: 2136,
  renderFromDb: 2194,
  finishInjection: 2264,
  usageLines: 2273,
  sessionEvent1: 2424,
  sessionEvent2: 2664,
  findTableById: 2520,
  readHeartbeat: 2540,
  writeHeartbeat: 2576,
  reportBudget: 2643,
  looksLikeRedline: 2659,
  WRITE_TOOLS: 2807,
  PWSH: 2819,
  isWriteLikeCall: 2845,
  toolsResult: 2859,
  turnStopping: 2920,
  agentCreated: 3002,
  commandsInject: 3052,
  webServerInject: 3243,
  routesArr: 3255,
  disposers: 3700,
  wsr: 3702,
  runHealthCheck: 3747,
  rhs: 3831,
  policyTemplate: 610,
  ensureLayout: 1190,
  overview: 1524,
  safeOn: 1935,
  checkWritableRoot: 2102,
  cwrSched: 2126,
  memMarker: 2378,
  topicWL: 2394,
  sanitizeTopic: 2398,
  injectedPrompt: 2181,
  registeredCommand: 3056,
}

let n = 0
function sub(re, to, label) {
  const before = text
  text = text.replace(re, to)
  if (text !== before) { n++; return true }
  return false
}

// 1) 初始化顺序块整体重写
const blockRe = /L\d+  apply 定义[\s\S]*?L\d+  runHealthCheck（定义；L\d+ 延迟 600ms 跑）/
const NB = [
  `L${T.apply}  apply 定义 / L${T.apply + 1} config 合并默认值`,
  `L${T.safeOn}  safeOn                         ← 安全注册事件（失败不中断 apply）`,
  `L${T.initDbStore - 19}  let dbPath / L${T.initDbStore - 18} let dbStore 声明（L${T.initDbStore} initDbStore 定义，L${T.initDbStore + 26} 首次调用）`,
  `L${T.checkWritableRoot}  checkWritableRoot（定义；L${T.cwrSched} 延迟 1500ms 跑）`,
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
  `L${T.webServerInject}  HTTP 路由（webServer inject；routes 数组 L${T.routesArr}，注册在 L${T.disposers}–${T.wsr}）`,
  `L${T.runHealthCheck}  runHealthCheck（定义；L${T.rhs} 延迟 600ms 跑）`,
].join('\n')
if (!blockRe.test(text)) { console.log('❌ 找不到初始化顺序块'); process.exit(1) }
text = text.replace(blockRe, NB)
n++

// 2) 散点
sub(/`createStore`（L\d+）/, `\`createStore\`（L${T.createStore}）`, 'createStore')
sub(/`createStore`（L\d+–\d+）/, `\`createStore\`（L${T.createStore}–${T.createStore + 700}）`, 'createStore range')
sub(/找它要先找 L\d+ 那一节/, `找它要先找 L${T.createStore} 那一节`, 'createStore hint')
sub(/`resolveProjectKey`（L\d+）/, `\`resolveProjectKey\`（L${T.resolveProjectKey}）`, 'rpj')
sub(/`stripPolicyPhrases`（L\d+）/, `\`stripPolicyPhrases\`（L${T.stripPolicyPhrases}）`, 'spp')
sub(/`measureInjection`（L\d+，/, `\`measureInjection\`（L${T.measureInjection}，`, 'mi')
sub(/`MEM_MARKER_RE`（L\d+，另见 L\d+ 白名单 \/ L\d+ `sanitizeTopic`）/,
  `\`MEM_MARKER_RE\`（L${T.memMarker}，另见 L${T.topicWL} 白名单 / L${T.sanitizeTopic} \`sanitizeTopic\`）`, 'marker')
sub(/### 3\.5 标记写入通道（L\d+）/, `### 3.5 标记写入通道（L${T.sessionEvent1}）`, '3.5')
sub(/### 3\.6 轮次提醒（L\d+）/, `### 3.6 轮次提醒（L${T.turnStopping}）`, '3.6')
sub(/`reportBudget`（L\d+）/, `\`reportBudget\`（L${T.reportBudget}）`, 'rb')
sub(/\| `renderFromDb` \| L\d+ \|/, `| \`renderFromDb\` | L${T.renderFromDb} |`, 'rdb')
sub(/\| `finishInjection` \| L\d+ \|/, `| \`finishInjection\` | L${T.finishInjection} |`, 'fi')
sub(/\| `usageLines` \| L\d+ \|/, `| \`usageLines\` | L${T.usageLines} |`, 'ul')
sub(/入口 \*\*L\d+\*\*。/, `入口 **L${T.sysPrompt}**。`, 'entry')
sub(/systemPrompt\.context \(L\d+\)/, `systemPrompt.context (L${T.sysPrompt})`, 'flow-ctx')
sub(/renderFromDb \(L\d+\)/, `renderFromDb (L${T.renderFromDb})`, 'flow-rdb')
sub(/finishInjection \(L\d+\)/, `finishInjection (L${T.finishInjection})`, 'flow-fi')
sub(/session\/event（L\d+）→ analyzeEmotion/, `session/event（L${T.sessionEvent2}）→ analyzeEmotion`, 'flow-emo')
sub(/turn-stopping（L\d+）时消费/, `turn-stopping（L${T.turnStopping}）时消费`, 'flow-ts')
sub(/\*\*`usageLines`（L\d+）\*\*/, `**\`usageLines\`（L${T.usageLines}）**`, 'impact-ul')
sub(/`findTableById`（L\d+）/, `\`findTableById\`（L${T.findTableById}）`, 'impact-ft')
sub(/`runHealthCheck` L\d+ 定义，L\d+ 调度/, `\`runHealthCheck\` L${T.runHealthCheck} 定义，L${T.rhs} 调度`, 'health')
sub(/`agent\/created`（L\d+）/, `\`agent/created\`（L${T.agentCreated}）`, 'ac')
sub(/`ensureLayout`（L\d+ 定义，调用在 L\d+）/, `\`ensureLayout\`（L${T.ensureLayout} 定义，调用在 L2080）`, 'el')
sub(/`index\.js` 的 `usageLines`（L\d+）/, `\`index.js\` 的 \`usageLines\`（L${T.usageLines}）`, '13-ul')
sub(/`POLICY_TEMPLATE`（L\d+）/, `\`POLICY_TEMPLATE\`（L${T.policyTemplate}）`, '13-pt')
sub(/\| \*\*L\d+\*\* \| \*\*assistant\/message\*\*/, `| **L${T.sessionEvent1}** | **assistant/message**`, 'ev-a')
sub(/\| \*\*L\d+\*\* \| user\/message/, `| **L${T.sessionEvent2}** | user/message`, 'ev-u')
sub(/\| L\d+ \| 检测沙箱拒绝/, `| L${T.toolsResult} | 检测沙箱拒绝`, 'ev-t')
sub(/\| L\d+ \| 消费待判情绪队列/, `| L${T.turnStopping} | 消费待判情绪队列`, 'ev-ts')
sub(/\| L\d+ \| 登记项目/, `| L${T.agentCreated} | 登记项目`, 'ev-ac')
sub(/`injectedPrompt` 标志，L\d+ 声明 \/ L\d+ 置位/,
  `\`injectedPrompt\` 标志，L${T.apply + 23} 声明 / L${T.injectedPrompt} 置位`, 'ip')
sub(/`registeredCommand`，L\d+ 声明 \/ L\d+ 置位/,
  `\`registeredCommand\`，L${T.apply + 24} 声明 / L${T.registeredCommand} 置位`, 'rc')

// 3) 3.1 表里删掉 FACTS_TEMPLATE / projectTemplate 行
text = text.replace(/^\| \d+ \| `FACTS_TEMPLATE` \|[^\n]*\n/m, '')
text = text.replace(/^\| \d+ \| `projectTemplate` \|[^\n]*\n/m, '')
n += 2

fs.writeFileSync(MAP, text, 'utf8')
console.log(`已应用 ${n} 处`)

// 校验
console.log('\n=== 校验：地图里是否还有 FACTS_TEMPLATE / projectTemplate ===')
console.log((text.match(/FACTS_TEMPLATE|projectTemplate/g) || []).length, '处')
