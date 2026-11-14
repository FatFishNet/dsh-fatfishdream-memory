import fs from 'node:fs'
const MAP = 'docs/项目地图.md'
let text = fs.readFileSync(MAP, 'utf8')

const T = {"createStore":1145,"resolveProjectKey":1212,"stripPolicyPhrases":1384,"measureInjection":1473,"apply":1823,"initDbStore":1957,"sysPrompt":2080,"renderFromDb":2138,"finishInjection":2208,"usageLines":2217,"se1":2368,"se2":2608,"findTableById":2464,"readHeartbeat":2484,"writeHeartbeat":2520,"reportBudget":2587,"looksLikeRedline":2603,"WRITE_TOOLS":2751,"PWSH":2763,"isWriteLikeCall":2789,"toolsResult":2803,"turnStopping":2864,"agentCreated":2946,"commandsInject":2996,"webServerInject":3194,"routesArr":3206,"disposers":3650,"wsr":3652,"runHealthCheck":3697,"rhs":3781,"policyTemplate":608,"ensureLayout":1184,"overview":1518,"safeOn":1879,"checkWritableRoot":2046,"cwrSched":2070,"memMarker":2322,"topicWL":2338,"sanitizeTopic":2342,"injectedPrompt":2125,"registeredCommand":3000}

let n = 0
const sub = (re, to) => { const b = text; text = text.replace(re, to); if (text !== b) n++ }

const blockRe = /L\d+  apply 定义[\s\S]*?L\d+  runHealthCheck（定义；L\d+ 延迟 600ms 跑）/
const NB = [
  `L${T.apply}  apply 定义 / L${T.apply + 1} config 合并默认值`,
  `L${T.safeOn}  safeOn                         ← 安全注册事件（失败不中断 apply）`,
  `L${T.initDbStore - 19}  let dbPath / L${T.initDbStore - 18} let dbStore 声明（L${T.initDbStore} initDbStore 定义，L${T.initDbStore + 26} 首次调用）`,
  `L${T.checkWritableRoot}  checkWritableRoot（定义；L${T.cwrSched} 延迟 1500ms 跑）`,
  `L${T.sysPrompt}  注入层（systemPrompt.context）`,
  `L${T.se1}  标记写入监听（session/event，assistant/message）`,
  `L${T.findTableById}  findTableById`,
  `L${T.readHeartbeat}  readHeartbeat`,
  `L${T.writeHeartbeat}  writeHeartbeat`,
  `L${T.reportBudget}  reportBudget`,
  `L${T.looksLikeRedline}  looksLikeRedline`,
  `L${T.se2}  情绪录入监听（session/event，user/message）`,
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
if (blockRe.test(text)) { text = text.replace(blockRe, NB); n++ } else console.log('❌ 初始化块未匹配')

sub(/`createStore`（L\d+）/, `\`createStore\`（L${T.createStore}）`)
sub(/`createStore`（L\d+–\d+）/, `\`createStore\`（L${T.createStore}–${T.createStore + 638}）`)
sub(/找它要先找 L\d+ 那一节/, `找它要先找 L${T.createStore} 那一节`)
sub(/`resolveProjectKey`（L\d+）/, `\`resolveProjectKey\`（L${T.resolveProjectKey}）`)
sub(/`stripPolicyPhrases`（L\d+）/, `\`stripPolicyPhrases\`（L${T.stripPolicyPhrases}）`)
sub(/`measureInjection`（L\d+，/, `\`measureInjection\`（L${T.measureInjection}，`)
sub(/`MEM_MARKER_RE`（L\d+，另见 L\d+ 白名单 \/ L\d+ `sanitizeTopic`）/,
  `\`MEM_MARKER_RE\`（L${T.memMarker}，另见 L${T.topicWL} 白名单 / L${T.sanitizeTopic} \`sanitizeTopic\`）`)
sub(/### 3\.5 标记写入通道（L\d+）/, `### 3.5 标记写入通道（L${T.se1}）`)
sub(/### 3\.6 轮次提醒（L\d+）/, `### 3.6 轮次提醒（L${T.turnStopping}）`)
sub(/`reportBudget`（L\d+）/, `\`reportBudget\`（L${T.reportBudget}）`)
sub(/\| `renderFromDb` \| L\d+ \|/, `| \`renderFromDb\` | L${T.renderFromDb} |`)
sub(/\| `finishInjection` \| L\d+ \|/, `| \`finishInjection\` | L${T.finishInjection} |`)
sub(/\| `usageLines` \| L\d+ \|/, `| \`usageLines\` | L${T.usageLines} |`)
sub(/入口 \*\*L\d+\*\*。/, `入口 **L${T.sysPrompt}**。`)
sub(/systemPrompt\.context \(L\d+\)/, `systemPrompt.context (L${T.sysPrompt})`)
sub(/renderFromDb \(L\d+\)/, `renderFromDb (L${T.renderFromDb})`)
sub(/finishInjection \(L\d+\)/, `finishInjection (L${T.finishInjection})`)
sub(/session\/event（L\d+）→ analyzeEmotion/, `session/event（L${T.se2}）→ analyzeEmotion`)
sub(/turn-stopping（L\d+）时消费/, `turn-stopping（L${T.turnStopping}）时消费`)
sub(/\*\*`usageLines`（L\d+）\*\*/, `**\`usageLines\`（L${T.usageLines}）**`)
sub(/`findTableById`（L\d+）/, `\`findTableById\`（L${T.findTableById}）`)
sub(/`runHealthCheck` L\d+ 定义，L\d+ 调度/, `\`runHealthCheck\` L${T.runHealthCheck} 定义，L${T.rhs} 调度`)
sub(/`agent\/created`（L\d+）/, `\`agent/created\`（L${T.agentCreated}）`)
sub(/`ensureLayout`（L\d+ 定义，调用在 L\d+）/, `\`ensureLayout\`（L${T.ensureLayout} 定义，调用在 L2024）`)
sub(/`index\.js` 的 `usageLines`（L\d+）/, `\`index.js\` 的 \`usageLines\`（L${T.usageLines}）`)
sub(/`POLICY_TEMPLATE`（L\d+）/, `\`POLICY_TEMPLATE\`（L${T.policyTemplate}）`)
sub(/\| \*\*L\d+\*\* \| \*\*assistant\/message\*\*/, `| **L${T.se1}** | **assistant/message**`)
sub(/\| \*\*L\d+\*\* \| user\/message/, `| **L${T.se2}** | user/message`)
sub(/\| L\d+ \| 检测沙箱拒绝/, `| L${T.toolsResult} | 检测沙箱拒绝`)
sub(/\| L\d+ \| 消费待判情绪队列/, `| L${T.turnStopping} | 消费待判情绪队列`)
sub(/\| L\d+ \| 登记项目/, `| L${T.agentCreated} | 登记项目`)
sub(/`injectedPrompt` 标志，L\d+ 声明 \/ L\d+ 置位/, `\`injectedPrompt\` 标志，L${T.apply + 23} 声明 / L${T.injectedPrompt} 置位`)
sub(/`registeredCommand`，L\d+ 声明 \/ L\d+ 置位/, `\`registeredCommand\`，L${T.apply + 24} 声明 / L${T.registeredCommand} 置位`)

fs.writeFileSync(MAP, text, 'utf8')
console.log(`已应用 ${n} 处`)
