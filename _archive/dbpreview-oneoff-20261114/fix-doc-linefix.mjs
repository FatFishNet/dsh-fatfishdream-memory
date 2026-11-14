/**
 * 一次性：把 docs/项目地图.md 等文档里的行号 / 名称 / 计数漂移修正。
 *
 * 纪律：每一处替换都声明「期望命中次数」，任何一处对不上就整体中止、不写文件。
 * 这样手误（写错原文、重复片段）不会静默改错 —— 见 AGENTS.md 硬步骤 8 的 diff 要求。
 */
import fs from 'node:fs'

/** 一组替换：[文件, 原文, 新文, 期望命中次数] */
const EDITS = []

// ─────────────────────────────────────────────── docs/项目地图.md
const MAP = 'docs/项目地图.md'

// §0 快照
EDITS.push([MAP, '| 代码规模 | `index.js` 3895 行 / 约 159KB，`client.js` 1253 行 / 约 44KB |',
  '| 代码规模 | `index.js` 4223 行 / 约 186KB，`client.js` 1455 行 / 约 59KB |', 1])
EDITS.push([MAP, '| 存储模块 | `db-schema.mjs`（235 行：schema + FTS）、`db-store.mjs`（710 行：存储适配层） |',
  '| 存储模块 | `db-schema.mjs`（235 行：schema + FTS）、`db-store.mjs`（770 行：存储适配层） |', 1])
EDITS.push([MAP, '| 记忆根目录 | `D:\\FatFishDream-memory`（配置在 `cordis.patch.yml`） |',
  '| 记忆根目录 | `D:\\dsh-fatfishdream-memory`（**不写在 `cordis.patch.yml`**，走 `resolveRoot` 四级选址 + 指针文件） |', 1])

// §2 文件清单
EDITS.push([MAP, '| `dsh-memory/index.js` | 3895 |', '| `dsh-memory/index.js` | 4223 |', 1])
EDITS.push([MAP, '| `dsh-memory/db-store.mjs` | 710 |', '| `dsh-memory/db-store.mjs` | 770 |', 1])
EDITS.push([MAP, '| `dsh-memory/db-migrate.mjs` | 325 |', '| `dsh-memory/db-migrate.mjs` | 394 |', 1])
EDITS.push([MAP, '| `dsh-memory/client.js` | 1253 |', '| `dsh-memory/client.js` | 1455 |', 1])
EDITS.push([MAP, '| `dsh-memory/cordis.patch.yml` | 45 |', '| `dsh-memory/cordis.patch.yml` | 63 |', 1])

// §3.1 模块级常量（全部按 chk-anchors2 实测值）
EDITS.push([MAP, '| 139 | `MEMORY_DIR_NAME` | `FatFishDream-memory`（所有 UI 文案都从这里取，不要写死） |',
  '| 148 | `MEMORY_DIR_NAME` | `dsh-fatfishdream-memory`（所有 UI 文案都从这里取，不要写死） |', 1])
EDITS.push([MAP, '| 144–191 | `systemDriveLetter` / `isSystemDriveTarget` / `expandRoot` / `listCandidateDrives` | 盘符相关的小工具 |',
  '| 153–200 | `systemDriveLetter` / `isSystemDriveTarget` / `expandRoot` / `listCandidateDrives` | 盘符相关的小工具 |', 1])
EDITS.push([MAP, '| 193 / 203–235 | `syncPathExists` / `POINTER_FILE`·`pointerPath`·`readPointer`·`writePointer` |',
  '| 202 / 212–262 | `syncPathExists` / `POINTER_FILE`·`pointerPath`·`readPointer`·`writePointer` |', 1])
EDITS.push([MAP, '| 254 | `systemFallbackRoot` | 系统盘兜底：`<文档>\\FatFishDream-memory` |',
  '| 263 | `systemFallbackRoot` | 系统盘兜底：`<文档>\\dsh-fatfishdream-memory` |', 1])
EDITS.push([MAP, '| 288 | `resolveRoot` |', '| 297 | `resolveRoot` |', 1])
EDITS.push([MAP, '| 348–390 | `pad` / `monthKey` / `stamp` / `localDay` / `daysBetween` / `projectNameOf` / `slugify` | 时间与项目名工具 |',
  '| 357–403 | `pad` / `monthKey` / `stamp` / `localDay` / `daysBetween` / `projectNameOf` / `slugify` | 时间与项目名工具 |', 1])
EDITS.push([MAP, '| 395–414 | `parseJson` / `shortHash` / `isSafeSlug` / `isInside` / `byteLength` | 解析与路径安全（**`parseJson` 是 BOM 的唯一防线**） |',
  '| 404–437 | `parseJson` / `shortHash` / `isSafeSlug` / `isInside` / `byteLength` | 解析与路径安全（**`parseJson` 是 BOM 的唯一防线**） |', 1])
EDITS.push([MAP, '| 429 | `truncateBytes` |', '| 438 | `truncateBytes` |', 1])
EDITS.push([MAP, '| 451 / 461 | `SECRET_PATTERNS` / `findSecret` |', '| 460 / 470 | `SECRET_PATTERNS` / `findSecret` |', 1])
EDITS.push([MAP, '| 468–525 | `readIfExists` / `exists` / `atomicWrite` / `copyTree` | 文件层工具（回退路径仍在用） |',
  '| 477–587 | `readIfExists` / `exists` / `atomicWrite` / `copyTree` / `backupDbFile` | 文件层工具（回退路径仍在用；`backupDbFile` L568 是迁移专用，见 §3.2 注） |', 1])
EDITS.push([MAP, '| 550 | `FACTS_TEMPLATE` |', '| 607 | `FACTS_TEMPLATE` |', 1])
EDITS.push([MAP, '| 555 | `POLICY_TEMPLATE` |', '| 612 | `POLICY_TEMPLATE` |', 1])
EDITS.push([MAP, '| 616 | `projectTemplate` |', '| 677 | `projectTemplate` |', 1])
EDITS.push([MAP, '| 635 | `STRONG_THRESHOLD` | 情绪强信号阈值 0.62（`WEAK_THRESHOLD` 在 630） |',
  '| 696 | `STRONG_THRESHOLD` | 情绪强信号阈值 0.62（`WEAK_THRESHOLD` 在 697） |', 1])
EDITS.push([MAP, '| 638 | `LEXICON` | 中文情感词典（`LEXICON_EN` 697 / `EMOJI` 706） |',
  '| 699 | `LEXICON` | 中文情感词典（`LEXICON_EN` 764 / `EMOJI` 773） |', 1])
EDITS.push([MAP, '| 715–799 | `NEGATIONS`', '| 782–890 | `NEGATIONS`', 1])
EDITS.push([MAP, '| 824–926 | `looksIronic`', '| 891–1010 | `looksIronic`', 1])
EDITS.push([MAP, '| 950 | `analyzeEmotion` |', '| 1011 | `analyzeEmotion` |', 1])

// §3.2 存储层
EDITS.push([MAP, '| 文件系统（兜底） | `index.js` 的 `createStore`（L1095） |', '| 文件系统（兜底） | `index.js` 的 `createStore`（L1156） |', 1])
EDITS.push([MAP, '`createStore`（L1095–1965）是**旧的 .md 实现**', '`createStore`（L1156–2093）是**旧的 .md 实现**', 1])
EDITS.push([MAP, '以及**文档里另外几个仍被复用的工具**：`resolveProjectKey`（L1167）、\n`stripPolicyPhrases`（L1374）、`measureInjection`（L1530，A+B 预算反馈的实现）。',
  '以及**文档里另外几个仍被复用的工具**：`resolveProjectKey`（L1228）、\n`stripPolicyPhrases`（L1435）、`measureInjection`（L1591，A+B 预算反馈的实现）。', 1])
EDITS.push([MAP, '> 找它要先找 L1095 那一节。', '> 找它要先找 L1156 那一节。', 1])
EDITS.push([MAP, '**数据库初始化**（L2274–2323）：', '**数据库初始化**（L2262–2406：`dbPath` 声明 L2273、`initDbStore` 定义 L2292、首次调用 L2318、`rebindDbStore` L2335、`checkWritableRoot` L2381）：', 1])
EDITS.push([MAP, 'const dbPath = join(config.root, \'memory.db\')\nlet dbStore',
  'let dbPath = join(config.root, \'memory.db\')   // ⚠️ 是 let 不是 const\nlet dbStore', 1])
EDITS.push([MAP, 'L2188–2190 是三个取值器：`getDbStore()` / `dbStoreExists()` / `dbPathOf()`。',
  'L2349–2351 是三个取值器：`getDbStore()` / `dbStoreExists()` / `dbPathOf()`。', 1])

// §3.3 apply 内部初始化顺序
EDITS.push([MAP, '### 3.3 `apply` 内部（L2064–3895）', '### 3.3 `apply` 内部（L2158–4223）', 1])
EDITS.push([MAP, `L2064  config 合并默认值
L2119  safeOn                         ← 安全注册事件（失败不中断 apply）
L2274  let dbStore / dbPath 声明（L2292 initDbStore 定义，L2318 首次调用）  ← 库优先；失败回退文件模式
L2231  checkWritableRoot（L2231 延迟 1500ms 跑）
L2274  注入层（systemPrompt.context）
L2582  标记写入监听（session/event，assistant/message）
L2689  findTableById
L2709  readHeartbeat
L2745  writeHeartbeat
L2812  reportBudget
L2817  looksLikeRedline
L2822  情绪录入监听（session/event，user/message）
L3185  WRITE_TOOLS
L2988  PWSH_WRITE_PATTERNS
L3014  isWriteLikeCall
L3225  tools/result 监听（实质改动判定）
L3025  turn-stopping 监听（**已不插对话**，仅日志）
L3317  agent/created 监听（登记项目 + 预建目录 + 隔天整理提醒）
L3163  /memory 命令（commands.register 在其后）
L3361  HTTP 路由（routes 数组 L3373，注册在 L3763）
L3810  runHealthCheck（L3894 延迟 600ms 跑）`, `L2158  apply 定义 / L2159 config 合并默认值
L2214  safeOn                         ← 安全注册事件（失败不中断 apply）
L2273  let dbPath / L2274 let dbStore 声明（L2292 initDbStore 定义，L2318 首次调用）  ← 库优先；失败回退文件模式
L2381  checkWritableRoot（定义；L2405 延迟 1500ms 跑）
L2415  注入层（systemPrompt.context）
L2786  标记写入监听（session/event，assistant/message）
L2898  findTableById
L2918  readHeartbeat
L2954  writeHeartbeat
L3021  reportBudget
L3037  looksLikeRedline
L3042  情绪录入监听（session/event，user/message）
L3185  WRITE_TOOLS
L3197  PWSH_WRITE_PATTERNS
L3223  isWriteLikeCall
L3237  tools/result 监听（实质改动判定）
L3298  turn-stopping 监听（**已不插对话**，仅日志）
L3380  agent/created 监听（登记项目 + 预建目录 + 隔天整理提醒）
L3436  /memory 命令（commands.register 在 L3441）
L3634  HTTP 路由（webServer inject；routes 数组 L3646，注册在 L4091–4093）
L4138  runHealthCheck（定义；L4222 延迟 600ms 跑）`, 1])

// §3.3 事件表
EDITS.push([MAP, '| `session/event` | **L2582** | **assistant/message** → 解析 `<!--mem-*-->` 标记 → 写库 |',
  '| `session/event` | **L2786** | **assistant/message** → 解析 `<!--mem-*-->` 标记 → 写库 |', 1])
EDITS.push([MAP, '| `session/event` | **L2822** | user/message → 情绪分析 → 强信号写库 / 弱信号入队 |',
  '| `session/event` | **L3042** | user/message → 情绪分析 → 强信号写库 / 弱信号入队 |', 1])
EDITS.push([MAP, '| `tools/result` | L3225 |', '| `tools/result` | L3237 |', 1])
EDITS.push([MAP, '| `agent/turn-stopping` | L3025 |', '| `agent/turn-stopping` | L3298 |', 1])
EDITS.push([MAP, '| `agent/created` | L3317 |', '| `agent/created` | L3380 |', 1])

// §3.4 注入层
EDITS.push([MAP, "`ctx.systemPrompt.context({ name: 'plugin:dsh-fatfishdream-memory', order: 300 })`，入口 **L2274**。",
  "`ctx.systemPrompt.context({ name: 'plugin:dsh-fatfishdream-memory', order: 300 })`，入口 **L2415**。", 1])
EDITS.push([MAP, '| `renderFromDb` | L2303 |', '| `renderFromDb` | L2464 |', 1])
EDITS.push([MAP, '| `renderFromFiles` | L2367 |', '| `renderFromFiles` | L2529 |', 1])
EDITS.push([MAP, '| `finishInjection` | L2578 |', '| `finishInjection` | L2583 |', 1])
EDITS.push([MAP, '| `usageLines` | L2430 |', '| `usageLines` | L2592 |', 1])

// §3.5 标记写入通道
EDITS.push([MAP, '### 3.5 标记写入通道（L2582）', '### 3.5 标记写入通道（L2786）', 1])
EDITS.push([MAP, 'assistant/message → `<!--mem-log|fact|note|fix-->` → MEM_MARKER_RE（L2556）→ 写库',
  'assistant/message → `<!--mem-log|fact|note|fix-->` → MEM_MARKER_RE（L2740，另见 L2756 白名单 / L2760 `sanitizeTopic`）→ 写库', 1])
EDITS.push([MAP, '写入成功后 `reportBudget`（L2812）检查预算', '写入成功后 `reportBudget`（L3021）检查预算', 1])

// §3.6
EDITS.push([MAP, '### 3.6 轮次提醒（L3025）—— 已改为不打扰', '### 3.6 轮次提醒（L3298）—— 已改为不打扰', 1])

// §4.4
EDITS.push([MAP, '启动时检查（`openMemoryDb` L208）', '启动时检查（`openMemoryDb` L208）', 1])

// §5 db-store
EDITS.push([MAP, '`createDbStore(dbPath, config, log)`（L84）返回的对象：', '`createDbStore(dbPath, config, log)`（L146）返回的对象：', 1])
EDITS.push([MAP, '| `factsTextSync(maxBytes)` | 155 |', '| `factsTextSync(maxBytes)` | 217 |', 1])
EDITS.push([MAP, '| `projectTextSync(name, maxBytes)` | 169 |', '| `projectTextSync(name, maxBytes)` | 231 |', 1])
EDITS.push([MAP, '| `routeTable(name)` | 187 |', '| `routeTable(name)` | 249 |', 1])
EDITS.push([MAP, '| `appendLog(project, content, topic)` | 245 |', '| `appendLog(project, content, topic)` | 307 |', 1])
EDITS.push([MAP, '| `appendFact(content)` | 254 |', '| `appendFact(content)` | 316 |', 1])
EDITS.push([MAP, '| `appendProjectNote(project, content, kind)` | 266 |', '| `appendProjectNote(project, content, kind)` | 328 |', 1])
EDITS.push([MAP, '| `recordEmotion({kind, evidence, text, confidence, score})` | 281 |', '| `recordEmotion({kind, evidence, text, confidence, score})` | 343 |', 1])
EDITS.push([MAP, '| `createEntry({scope, kind, text, table})` | 297 |', '| `createEntry({scope, kind, text, table})` | 359 |', 1])
EDITS.push([MAP, '| `updateText(table, id, text)` | 332 |', '| `updateText(table, id, text)` | 394 |', 1])
EDITS.push([MAP, '| `setStatus(table, id, status)` | 347 |', '| `setStatus(table, id, status)` | 429 |', 1])
EDITS.push([MAP, '| `softDelete(table, id)` | 357 |', '| `softDelete(table, id)` | 439 |', 1])
EDITS.push([MAP, '| `setReview(table, id, review, note)` | 361 |', '| `setReview(table, id, review, note)` | 473 |', 1])
EDITS.push([MAP, '| `upgradeToGlobal(id)` | 368 |', '| `upgradeToGlobal(id)` | 480 |', 1])
EDITS.push([MAP, '| `removeGlobalByRegex(pattern)` | 378 |', '| `removeGlobalByRegex(pattern)` | 490 |', 1])
EDITS.push([MAP, '| `search(query, {limit, projectName, crossProject})` | 477 |', '| `search(query, {limit, projectName, crossProject})` | 539 |', 1])
EDITS.push([MAP, '| `listEntries(table, {...})` | 548 |', '| `listEntries(table, {...})` | 610 |', 1])
EDITS.push([MAP, '| `getById(table, id)` | 500 |', '| `getById(table, id)` | 678 |', 1])
EDITS.push([MAP, '| `stats()` | 506 |', '| `stats()` | 684 |', 1])
EDITS.push([MAP, '| `listScopes()` | 666 |', '| `listScopes()` | 726 |', 1])
EDITS.push([MAP, '| `scanPersona()` | 555 |', '| `scanPersona()` | 740 |', 1])
EDITS.push([MAP, '**另有导出**：`PERSONA_FORBIDDEN`（L36）、`checkPersona`（L52）。',
  '**另有导出**：`PERSONA_FORBIDDEN`（L36）、`checkPersona`（L52）。`TS_ORDER` 常量在 L144（排序键，见 §9）。', 1])

// §6 client
EDITS.push([MAP, '**注册方式**（L1236–1249）', '**注册方式**（L1435–1451）', 1])
EDITS.push([MAP, '**面板六页签**（`MemoryPanel`，L562；页签按钮在 L810–815）：', '**面板六页签**（`MemoryPanel`，L582；页签按钮在 L810–815）：', 1])
EDITS.push([MAP, '`TAB_TABLE`（L266）把页签映射到表；`KIND_LABEL`（L248）是 kind 的中文名。',
  '`TAB_TABLE`（L266）把页签映射到表；`KIND_LABEL`（L248）是 kind 的中文名；`fmtTime` 在 L228。', 1])
EDITS.push([MAP, '> **流水页的项目下拉（2026-11-13 新增）**：`logScope` 状态（L597）', '> **流水页的项目下拉（2026-11-13 新增）**：`logScope` 状态（L597）', 1])
EDITS.push([MAP, '**组件**：`EntryRow`（L291，单条记忆）· `AddRuleForm`（L434）· `PersonaNormCard`（L529）·\n`MemoryPanel`（L582）· `SidebarIcon`（L1209）。',
  '**组件**：`EntryRow`（L291，单条记忆）· `AddRuleForm`（L434）· `PersonaNormCard`（L529）·\n`MemoryPanel`（L582）· `SidebarIcon`（L1209）。\n\n**标记擦除器**（2026-11-13 新增）：`MEM_STRIP_RE`（L1260）/ `MEM_PARTIAL_RE`（L1274）/\n`stripMemMarkers`（L1282）/ `installMarkerScrubber`（L1340），挂载在 `ctx.effect`（L1430）。', 1])

// §7.1
EDITS.push([MAP, '### 7.1 记忆根目录（`D:\\FatFishDream-memory`）', '### 7.1 记忆根目录（`D:\\dsh-fatfishdream-memory`）', 1])
EDITS.push([MAP, '`agent/created`（L3180）加了 `!dbStoreExists()` 判据', '`agent/created`（L3380）加了 `!dbStoreExists()` 判据', 1])
EDITS.push([MAP, '因为 `ensureLayout`（L1199 定义，调用在 L2360）和 `agent/created` 的预建调用（L3317）当时都不看模式。',
  '因为 `ensureLayout`（L1199 定义，调用在 L2360）和 `agent/created` 的预建调用（L3380）当时都不看模式。', 1])

// §8 数据流
EDITS.push([MAP, `systemPrompt.context (L2274)
  → getDbStore() ?
      ├─ 是：renderFromDb (L2303)`, `systemPrompt.context (L2415)
  → getDbStore() ?
      ├─ 是：renderFromDb (L2464)`, 1])
EDITS.push([MAP, '      └─ 否：renderFromFiles (L2367)（旧的 .md 路径，无索引）\n  → finishInjection (L2578)（加使用说明）',
  '      └─ 否：renderFromFiles (L2529)（旧的 .md 路径，无索引）\n  → finishInjection (L2583)（加使用说明）', 1])
EDITS.push([MAP, '  → session/event 收到 assistant/message           （L2582）', '  → session/event 收到 assistant/message           （L2786）', 1])
EDITS.push([MAP, '用户消息 → session/event（L2822）→ analyzeEmotion', '用户消息 → session/event（L3042）→ analyzeEmotion', 1])
EDITS.push([MAP, '                      → turn-stopping（L3025）时消费并告知', '                      → turn-stopping（L3298）时消费并告知', 1])

// §9 影响面
EDITS.push([MAP, '| **`usageLines`（L2430）** |', '| **`usageLines`（L2592）** |', 1])
EDITS.push([MAP, '| `findTableById`（L2689） |', '| `findTableById`（L2898） |', 1])
EDITS.push([MAP, '`routes` 曾写死 `=== 3`，加到 13 条后一直 FAIL。', '`routes` 曾写死 `=== 3`，加到 14 条后一直 FAIL。', 1])
EDITS.push([MAP, '2026-11-13 拆表后又漂了一次，最大偏 **124 行**（`runHealthCheck` 3514 → 3639）。',
  '2026-11-13 拆表后又漂了一次，最大偏 **124 行**（`runHealthCheck` 3514 → 3639）。\n2026-11-13 深夜再漂一次：迁移三 bug 修完后 `createStore` 1095 → 1156、\n`usageLines` 2430 → 2592、`runHealthCheck` 3810 → 4138，**89 处引用里 40 处对不上**，\n而 `verify-map.mjs` 只判「该行非空」，全绿通过 —— 假绿。见 §13 的 `chk-map-lines.mjs`。', 1])

// §10 外部依赖
EDITS.push([MAP, '| `ctx.webServer` | 可选（`ctx.inject`） | **13 条** HTTP 路由 |', '| `ctx.webServer` | 可选（`ctx.inject`） | **14 条** HTTP 路由 |', 1])

// §11 路由表（标题 + 行号 + 补 client-report）
EDITS.push([MAP, '## 11. HTTP 路由（GUI 数据源，共 13 条）', '## 11. HTTP 路由（GUI 数据源，共 14 条）', 1])
EDITS.push([MAP, '| GET | `/api/dsh-memory/state` | 3376 |', '| GET | `/api/dsh-memory/state` | 3649 |', 1])
EDITS.push([MAP, '| GET | `/api/dsh-memory/entries` | 3425 |', '| GET | `/api/dsh-memory/entries` | 3711 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/entry/update` | 3463 |', '| POST | `/api/dsh-memory/entry/update` | 3749 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/entry/create` | 3487 |', '| POST | `/api/dsh-memory/entry/create` | 3773 |', 1])
EDITS.push([MAP, '| GET/POST | `/api/dsh-memory/heartbeat` | 3521 |', '| GET/POST | `/api/dsh-memory/heartbeat` | 3807 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/entry/delete` | 3539 |', '| POST | `/api/dsh-memory/entry/delete` | 3825 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/entry/topic` | 3566 |', '| POST | `/api/dsh-memory/entry/topic` | 3852 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/entry/status` | 3610 |', '| POST | `/api/dsh-memory/entry/status` | 3896 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/entry/upgrade-global` | 3633 |', '| POST | `/api/dsh-memory/entry/upgrade-global` | 3919 |', 1])
EDITS.push([MAP, '| GET | `/api/dsh-memory/persona-check` | 3653 |', '| GET | `/api/dsh-memory/persona-check` | 3939 |', 1])
EDITS.push([MAP, '| GET | `/api/dsh-memory/search` | 3671 |', '| GET | `/api/dsh-memory/client-report` | 3965 | 浏览器侧擦除器的诊断回传（`diag(\'client-scrubber\')`），`client.js` 的 `report()` 打这里 |\n| GET | `/api/dsh-memory/search` | 3980 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/root/move` | 3702 |', '| POST | `/api/dsh-memory/root/move` | 4011 |', 1])
EDITS.push([MAP, '| POST | `/api/dsh-memory/project/move` | 3745 |', '| POST | `/api/dsh-memory/project/move` | 4073 |', 1])

// §12 健康自检
EDITS.push([MAP, '启动后 600ms 跑一次（L3894），结论写 `logs/` 与 `healthState`', '启动后 600ms 跑一次（`runHealthCheck` L4138 定义，L4222 调度），结论写 `logs/` 与 `healthState`', 1])
EDITS.push([MAP, '| `inject:systemPrompt` | 注入器是否注册（`injectedPrompt` 标志，L2177 声明 / L2430 置位） |',
  '| `inject:systemPrompt` | 注入器是否注册（`injectedPrompt` 标志，L2198 声明 / L2451 置位） |', 1])
EDITS.push([MAP, '| `command:memory` | 命令是否注册（`registeredCommand`，L2199 声明 / L3440 置位） |',
  '| `command:memory` | 命令是否注册（`registeredCommand`，L2199 声明 / L3440 置位） |', 1])
EDITS.push([MAP, '| `routes` | 路由数 **≥ 3**（不写死精确值） |', '| `routes` | 路由数 **≥ 3**（不写死精确值；当前 14 条） |', 1])
EDITS.push([MAP, '> **写死数量会造成假报警**：`routes === 3` 在加到 12 条后一直失败。',
  '> **写死数量会造成假报警**：`routes === 3` 在加到 14 条后一直失败。', 1])

// §13 维护协议
EDITS.push([MAP, '| `_dbpreview/verify-map.mjs` | 地图里 87 处 `L####` 按章节归属到四个源文件，逐条打印实际内容 |',
  '| `_dbpreview/chk-map-lines.mjs` | **地图里每处 `L####` 的真实源码内容逐条打印**，人工比对「这里该是什么函数」—— 判据是内容对得上，不是「该行非空」 |\n| `_dbpreview/verify-map.mjs` | 地图里 89 处 `L####` 是否越界/落空（**只判非空行，行号整体漂移它不报，别当准绳**） |', 1])
EDITS.push([MAP, '| **改 fact/note 判据、分层规则** | **`index.js` 的 `usageLines`（L2430）** ← 最容易漏；另外 `POLICY_TEMPLATE`（L555）决定新装的默认值 |',
  '| **改 fact/note 判据、分层规则** | **`index.js` 的 `usageLines`（L2592）** ← 最容易漏；另外 `POLICY_TEMPLATE`（L612）决定新装的默认值 |', 1])

// ─────────────────────────────────────────────── docs/TESTING.md
const T = 'docs/TESTING.md'
EDITS.push([T, '## 0. 全量回归（一条命令跑完 228 项断言）', '## 0. 全量回归（一条命令跑完 355 项断言 / 22 个脚本）', 1])
EDITS.push([T, `'verify-functions','verify-map','selfcheck-full','selfcheck-cap','selfcheck-isolation',
'selfcheck-paging','selfcheck-marker-hardened','selfcheck-dom-strip',
'selfcheck-scrubber-loop','selfcheck-ts-sort','selfcheck-migrate-order',
'verify-no-self-trigger','verify-final','verify-doc-links' |`, `'verify-functions','verify-map','selfcheck-full','selfcheck-cap','selfcheck-isolation',
'selfcheck-paging','selfcheck-marker-hardened','selfcheck-dom-strip',
'selfcheck-scrubber-loop','selfcheck-ts-sort','selfcheck-migrate-order',
'selfcheck-migrate-db','selfcheck-copytree-empty','selfcheck-topic-clean',
'selfcheck-injection-wording','verify-injection-consistency','selfcheck-emotion-guard',
'selfcheck-dir-name','verify-no-self-trigger','verify-final','verify-doc-links',
'verify-topic-fixed' |`, 1])
EDITS.push([T, '| `verify-map` | 87 处引用 | 地图 `L####` 是否落空 |',
  '| `verify-map` | 89 处引用 | 地图 `L####` 是否越界/落空（**只判非空行，漂移不报**） |\n| `chk-map-lines` | 89 处 | 逐条打印每处 `L####` 的真实内容，人工核对「该行是不是说的那个函数」 |', 1])
EDITS.push([T, '| `selfcheck-paging` | 18 | 流水页分页（**需 `DSH_BASE`**） |',
  '| `selfcheck-paging` | 15 | 流水页分页（**需 `DSH_BASE`**；脚本内置的默认端口 5502 早已失效，不设 `DSH_BASE` 必 CONNREFUSED） |', 1])
EDITS.push([T, '| `selfcheck-migrate-order` | 9 | 迁移时全局按时间排序 |',
  '| `selfcheck-migrate-order` | 9 | 迁移时全局按时间排序 |\n| `selfcheck-migrate-db` | 11 | 迁移时用 VACUUM INTO 复制主库（含「文本复制会损坏库」反证） |\n| `selfcheck-copytree-empty` | 14 | 空目录迁移不产生空壳 |\n| `selfcheck-topic-clean` | 37 | topic 不被 `-->` 污染（含白名单） |\n| `selfcheck-injection-wording` | 17 | 注入文案无自相矛盾 |\n| `verify-injection-consistency` | 13 | 注入里「写禁读通」表述一致 |\n| `selfcheck-emotion-guard` | 19 | 情绪录入的形态闸门（不误吞提示词） |\n| `selfcheck-dir-name` | 10 | 目录名可移植（四种安装场景） |\n| `verify-topic-fixed` | 9 | 修复后主表 / FTS 一致 |', 1])
EDITS.push([T, `$link = 'C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\@local\\dsh-memory'
(Get-Item -LiteralPath $link -Force).Target
\`\`\`

应指向 \`D:\\workspace\\FatFishDream\\dsh-memory\`。`, `$link = 'C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\dsh-fatfishdream-memory'
(Get-Item -LiteralPath $link -Force).Target
\`\`\`

应指向 \`D:\\workspace\\dsh-fatfishdream-memory\\dsh-memory\`。
（**不要查 \`node_modules\\@local\\dsh-memory\`** —— 那是一个指向已删除的
\`D:\\workspace\\FatFishDream\\dsh-memory\` 的**断链 Junction**，只剩历史残留。）`, 1])
EDITS.push([T, "(Get-FileHash 'D:\\workspace\\FatFishDream\\dsh-memory\\index.js' -Algorithm SHA256).Hash\n(Get-FileHash 'C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\@local\\dsh-memory\\index.js' -Algorithm SHA256).Hash",
  "(Get-FileHash 'D:\\workspace\\dsh-fatfishdream-memory\\dsh-memory\\index.js' -Algorithm SHA256).Hash\n(Get-FileHash 'C:\\Users\\<user>\\.dsh\\profiles\\desktop\\node_modules\\dsh-fatfishdream-memory\\index.js' -Algorithm SHA256).Hash", 1])
EDITS.push([T, "`D:\\FatFishDream-memory\\logs\\YYYY-MM-DD.log`。排查时临时加几行回报，", "`D:\\dsh-fatfishdream-memory\\logs\\YYYY-MM-DD.log`。排查时临时加几行回报，", 1])
EDITS.push([T, "const d=new DatabaseSync('D:/FatFishDream-memory/memory.db',{readOnly:true});", "const d=new DatabaseSync('D:/dsh-fatfishdream-memory/memory.db',{readOnly:true});", 1])
EDITS.push([T, "const b=fs.readFileSync('D:/FatFishDream-memory/state.json')", "const b=fs.readFileSync('D:/dsh-fatfishdream-memory/state.json')", 1])
EDITS.push([T, "D:\\FatFishDream-memory\\logs\\YYYY-MM-DD.log", "D:\\dsh-fatfishdream-memory\\logs\\YYYY-MM-DD.log", 1])
EDITS.push([T, "POST /api/dsh-memory/root/move     {\"root\":\"D:\\\\FatFishDream-memory\"}", "POST /api/dsh-memory/root/move     {\"root\":\"D:\\\\dsh-fatfishdream-memory\"}", 1])

// ─────────────────────────────────────────────── AGENTS.md
const A = 'AGENTS.md'
EDITS.push([A, '`%USERPROFILE%\\Documents\\FatFishDream-memory`。', '`%USERPROFILE%\\Documents\\dsh-fatfishdream-memory`。', 1])
EDITS.push([A, '日志在 `D:\\FatFishDream-memory\\logs\\YYYY-MM-DD.log`，', '日志在 `D:\\dsh-fatfishdream-memory\\logs\\YYYY-MM-DD.log`，', 1])
EDITS.push([A, '插件只依赖 8 个接口（`systemPrompt.context` / `commands` / `webServer` /', '插件只依赖 9 个接口（`systemPrompt.context` / `commands` / `webServer` /', 1])
EDITS.push([A, '插件自己的工作记忆在 `D:\\FatFishDream-memory\\memory.db`：', '插件自己的工作记忆在 `D:\\dsh-fatfishdream-memory\\memory.db`：', 1])
EDITS.push([A, '8. 看 `D:\\FatFishDream-memory\\logs\\YYYY-MM-DD.log` 确认加载正常', '8. 看 `D:\\dsh-fatfishdream-memory\\logs\\YYYY-MM-DD.log` 确认加载正常', 1])
EDITS.push([A, '看 `[health-check-verdict]` 那行是不是「通过：N 项全部就位」。', '看 `[health-check-verdict]` 那行是不是「通过：9 项全部就位」。', 1])

// ─────────────────────────────────────────────── README.md（外层）
const R = 'README.md'
EDITS.push([R, '默认 `D:\\FatFishDream-memory`；没有 D 盘则落在\n`%USERPROFILE%\\Documents\\FatFishDream-memory`。',
  '默认 `D:\\dsh-fatfishdream-memory`；没有 D 盘则落在\n`%USERPROFILE%\\Documents\\dsh-fatfishdream-memory`。', 1])
EDITS.push([R, '| **轮次提醒** | 本轮有实质改动时，问一句「有没有值得留一笔的」（命令类工具的写操作也算） |',
  '| **轮次提醒** | 本轮有实质改动时**只记日志不插话**（2026-11-13 起，原版两天触发 217 次太吵） |', 1])
EDITS.push([R, '| **健康自检** | 启动后核验 8 个挂载点，DSH 升级后能立刻指出哪一项坏了 |',
  '| **健康自检** | 启动后核验 9 个挂载点，DSH 升级后能立刻指出哪一项坏了 |', 1])
EDITS.push([R, '| **跨项目检索** | `/memory search 关键词` 搜所有项目历史 |',
  '| **检索** | `/memory search 关键词` 默认只搜本项目（+ 全局规则/画像/情绪）；`/memory search! 关键词` 才跨项目 |', 1])

// ─────────────────────────────────────────────── dsh-memory/README.md（包内）
const PR = 'dsh-memory/README.md'
EDITS.push([PR, 'facts.md                       用户级结论（跨项目通用）',
  'memory.db                      主存储（SQLite；profile/rules/emotion/logs 四张表）', 1])
EDITS.push([PR, '| **健康自检** | 启动后核验 8 个挂载点，出问题第一时间指出是哪一项 |',
  '| **健康自检** | 启动后核验 9 个挂载点，出问题第一时间指出是哪一项 |', 1])
EDITS.push([PR, '| 只依赖 8 个宿主接口 | 变更面小，容易核对 |', '| 只依赖 9 个宿主接口 | 变更面小，容易核对 |', 1])

// ─────────────────────────────────────────────── 执行
const cache = new Map()
let bad = 0
const applied = []

for (const [file, from, to, expect] of EDITS) {
  if (!cache.has(file)) cache.set(file, fs.readFileSync(file, 'utf8'))
  let text = cache.get(file)
  const count = text.split(from).length - 1
  if (count !== expect) {
    console.log(`❌ ${file}：期望命中 ${expect} 次，实际 ${count} 次\n   原文片段: ${JSON.stringify(from.slice(0, 90))}`)
    bad++
    continue
  }
  cache.set(file, text.split(from).join(to))
  applied.push(file)
}

if (bad > 0) {
  console.log(`\n中止：${bad} 处对不上，**没有写入任何文件**。`)
  process.exit(1)
}

for (const [file, text] of cache) fs.writeFileSync(file, text, 'utf8')
console.log(`✅ 共 ${EDITS.length} 处替换，全部命中，已写入 ${cache.size} 个文件：`)
for (const [file, text] of cache) console.log(`   ${file}  ${text.length} 字符`)
