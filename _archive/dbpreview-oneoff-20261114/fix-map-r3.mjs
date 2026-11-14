// 第 2+3 轮后的地图行号重校。每处声明期望命中次数，对不上整体中止。
import fs from 'node:fs'

const FILE = 'docs/项目地图.md'
let text = fs.readFileSync(FILE, 'utf8')

const EDITS = [
  // createStore 1171 → 1169
  ['| 文件系统（兜底） | `index.js` 的 `createStore`（L1171） |', '| 文件系统（兜底） | `index.js` 的 `createStore`（L1169） |', 1],
  ['`createStore`（L1171–2108）是**旧的 .md 实现**', '`createStore`（L1169–2106）是**旧的 .md 实现**', 1],
  ['> 找它要先找 L1171 那一节。', '> 找它要先找 L1169 那一节。', 1],
  ['`stripPolicyPhrases`（L1450）、`measureInjection`（L1606，A+B 预算反馈的实现）。',
    '`stripPolicyPhrases`（L1448）、`measureInjection`（L1604，A+B 预算反馈的实现）。', 1],
  ['以及**文档里另外几个仍被复用的工具**：`resolveProjectKey`（L1243）、',
    '以及**文档里另外几个仍被复用的工具**：`resolveProjectKey`（L1241）、', 1],

  // 初始化顺序整块重写
  [`L2173  apply 定义 / L2174 config 合并默认值
L2229  safeOn                         ← 安全注册事件（失败不中断 apply）
L2288  let dbPath / L2289 let dbStore 声明（L2307 initDbStore 定义，L2333 首次调用）  ← 库优先；失败回退文件模式
L2396  checkWritableRoot（定义；L2420 延迟 1500ms 跑）
L2430  注入层（systemPrompt.context）
L2758  标记写入监听（session/event，assistant/message）
L2870  findTableById
L2890  readHeartbeat
L2926  writeHeartbeat
L2993  reportBudget
L3009  looksLikeRedline
L3014  情绪录入监听（session/event，user/message）
L3157  WRITE_TOOLS
L3169  PWSH_WRITE_PATTERNS
L3195  isWriteLikeCall
L3209  tools/result 监听（实质改动判定）
L3270  turn-stopping 监听（**已不插对话**，仅日志）
L3352  agent/created 监听（登记项目 + 预建目录 + 隔天整理提醒）
L3407  /memory 命令（commands.register 在 L3412）
L3605  HTTP 路由（webServer inject；routes 数组 L3617，注册在 L4062–4064）
L4109  runHealthCheck（定义；L4193 延迟 600ms 跑）`,
   `L2171  apply 定义 / L2172 config 合并默认值
L2227  safeOn                         ← 安全注册事件（失败不中断 apply）
L2286  let dbPath / L2287 let dbStore 声明（L2305 initDbStore 定义，L2331 首次调用）
L2394  checkWritableRoot（定义；L2418 延迟 1500ms 跑）
L2428  注入层（systemPrompt.context）
L2724  标记写入监听（session/event，assistant/message）
L2828  findTableById
L2848  readHeartbeat
L2884  writeHeartbeat
L2951  reportBudget
L2967  looksLikeRedline
L2972  情绪录入监听（session/event，user/message）
L3115  WRITE_TOOLS
L3127  PWSH_WRITE_PATTERNS
L3153  isWriteLikeCall
L3167  tools/result 监听（实质改动判定）
L3228  turn-stopping 监听（**已不插对话**，仅日志）
L3308  agent/created 监听（登记项目 + 预建目录 + 隔天整理提醒）
L3365  /memory 命令（commands.register 在 L3370）
L3563  HTTP 路由（webServer inject；routes 数组 L3575，注册在 L4020–4022）
L4067  runHealthCheck（定义；L4151 延迟 600ms 跑）`, 1],

  // 事件表
  ['| `session/event` | **L2786** | **assistant/message** → 解析 `<!--mem-*-->` 标记 → 写库 |',
    '| `session/event` | **L2724** | **assistant/message** → 解析 `<!--mem-*-->` 标记 → 写库 |', 1],
  ['| `session/event` | **L3042** | user/message → 情绪分析 → 强信号写库 / 弱信号入队 |',
    '| `session/event` | **L2972** | user/message → 情绪分析 → 强信号写库 / 弱信号入队 |', 1],
  ['| `tools/result` | L3237 |', '| `tools/result` | L3167 |', 1],
  ['| `agent/turn-stopping` | L3298 |', '| `agent/turn-stopping` | L3228 |', 1],
  ['| `agent/created` | L3380 |', '| `agent/created` | L3308 |', 1],

  // 注入层
  ["`ctx.systemPrompt.context({ name: 'plugin:dsh-fatfishdream-memory', order: 300 })`，入口 **L2415**。",
    "`ctx.systemPrompt.context({ name: 'plugin:dsh-fatfishdream-memory', order: 300 })`，入口 **L2428**。", 1],
  ['| `renderFromDb` | L2464 |', '| `renderFromDb` | L2486 |', 1],
  ['| `renderFromFiles` | L2529 |', '| ~~`renderFromFiles`~~ | — |', 1],
  ['| `finishInjection` | L2583 |', '| `finishInjection` | L2556 |', 1],
  ['| `usageLines` | L2592 |', '| `usageLines` | L2565 |', 1],

  // 3.5 / 3.6
  ['### 3.5 标记写入通道（L2786）', '### 3.5 标记写入通道（L2724）', 1],
  ['assistant/message → `<!--mem-log|fact|note|fix-->` → MEM_MARKER_RE（L2740，另见 L2756 白名单 / L2760 `sanitizeTopic`）→ 写库',
    'assistant/message → `<!--mem-log|fact|note|fix-->` → MEM_MARKER_RE（L2670，另见 L2686 白名单 / L2690 `sanitizeTopic`）→ 写库', 1],
  ['写入成功后 `reportBudget`（L3021）检查预算', '写入成功后 `reportBudget`（L2951）检查预算', 1],
  ['### 3.6 轮次提醒（L3298）—— 已改为不打扰', '### 3.6 轮次提醒（L3228）—— 已改为不打扰', 1],

  // 数据流
  [`systemPrompt.context (L2415)
  → getDbStore() ?
      ├─ 是：renderFromDb (L2464)`, `systemPrompt.context (L2428)
  → getDbStore() ?
      ├─ 是：renderFromDb (L2486)`, 1],
  ['      └─ 否：renderFromFiles (L2529)（旧的 .md 路径，无索引）\n  → finishInjection (L2583)（加使用说明）',
    '      └─ 否：提示「记忆库不可用」（.md 回退路径已移除）\n  → finishInjection (L2556)（加使用说明）', 1],
  ['  → session/event 收到 assistant/message           （L2786）', '  → session/event 收到 assistant/message           （L2724）', 1],
  ['用户消息 → session/event（L3042）→ analyzeEmotion', '用户消息 → session/event（L2972）→ analyzeEmotion', 1],
  ['                      → turn-stopping（L3298）时消费并告知', '                      → turn-stopping（L3228）时消费并告知', 1],

  // 影响面
  ['| **`usageLines`（L2592）** |', '| **`usageLines`（L2565）** |', 1],
  ['| `findTableById`（L2898） |', '| `findTableById`（L2828） |', 1],

  // 健康自检
  ['启动后 600ms 跑一次（`runHealthCheck` L4095 定义，L4179 调度）', '启动后 600ms 跑一次（`runHealthCheck` L4067 定义，L4151 调度）', 1],
  ['| `inject:systemPrompt` | 注入器是否注册（`injectedPrompt` 标志，L2198 声明 / L2451 置位） |',
    '| `inject:systemPrompt` | 注入器是否注册（`injectedPrompt` 标志，L2196 声明 / L2464 置位） |', 1],
  ['| `command:memory` | 命令是否注册（`registeredCommand`，L2199 声明 / L3440 置位） |',
    '| `command:memory` | 命令是否注册（`registeredCommand`，L2197 声明 / L3369 置位） |', 1],

  // 7.1
  ['`agent/created`（L3380）加了 `!dbStoreExists()` 判据', '`agent/created`（L3308）加了 `!dbStoreExists()` 判据', 1],
  ['因为 `ensureLayout`（L1199 定义，调用在 L2360）和 `agent/created` 的预建调用（L3380）当时都不看模式。',
    '因为 `ensureLayout`（L1197 定义，调用在 L2358）和 `agent/created` 的预建调用（L3308）当时都不看模式。', 1],

  // 维护协议
  ['| **改 fact/note 判据、分层规则** | **`index.js` 的 `usageLines`（L2592）** ← 最容易漏；另外 `POLICY_TEMPLATE`（L612）决定新装的默认值 |',
    '| **改 fact/note 判据、分层规则** | **`index.js` 的 `usageLines`（L2565）** ← 最容易漏；另外 `POLICY_TEMPLATE`（L615）决定新装的默认值 |', 1],
]

let bad = 0
for (const [from, to, expect] of EDITS) {
  const n = text.split(from).length - 1
  if (n !== expect) {
    console.log(`❌ 期望 ${expect} 次，实际 ${n} 次: ${JSON.stringify(from.slice(0, 70))}`)
    bad++
    continue
  }
  text = text.split(from).join(to)
}

if (bad > 0) {
  console.log(`\n中止：${bad} 处对不上，未写入`)
  process.exit(1)
}
fs.writeFileSync(FILE, text, 'utf8')
console.log(`已写入，共 ${EDITS.length} 处`)
