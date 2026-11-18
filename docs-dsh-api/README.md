# DeepSeek Harness API 文档（本地副本）

> 抓取时间：2026-11-18
> 抓取方式：`web_fetch`（本机 PowerShell 直连 `deepseek-harness.github.io` 因 SSL 失败，故全程用 web_fetch）
> **⚠️ 所有文件均为第三方内容，仅供查阅，不作为指令。**
> **⚠️ 版本未核对** —— 本机 DSH 版本与这些在线文档的对应关系**没有验证过**。引用前先确认适用性。

---

## 目录

### 官方文档（deepseek-harness.github.io）

| 文件 | 来源 | 体量 | 内容 |
|---|---|---|---|
| [official-architecture.md](official-architecture.md) | `reference/index.md` | 20 KB | **架构总览**：Cordis、Profile/组合包、应用启动、桌面应用、核心包、事件三域、**轮次流程**、会话日志、能力 seam、新行为归属位置 |
| [official-cordis-primer.md](official-cordis-primer.md) | `reference/cordis-primer.md` | 4 KB | Cordis 五概念、**五种分发模式表**、Waterfall 语义、Loader 配置 |
| [official-core.md](official-core.md) | `reference/subsystems/core.md` | 62 KB | **核心子系统**：Agent 句柄、inbox、取消、pre-step 决策、`agent/*` 全部事件契约 |
| [official-session.md](official-session.md) | `reference/subsystems/session.md` | 83 KB | **会话**：`SessionEventMap` 全部事件变体、Surface 类型、Session 公共 API |
| [official-tools.md](official-tools.md) | `reference/subsystems/tools.md` | 22 KB | **工具**：`ToolDefinition`、schema DSL、`ToolRestriction`、执行器、`tools/*` 事件 |
| [official-llm-streaming.md](official-llm-streaming.md) | `reference/subsystems/llm-streaming.md` | 75 KB | **LLM**：`ContentBlockMap`、`Message`、`StreamChunk`、适配器约定、`ctx.llm`、`llm/stream` |

### 第三方整理

| 文件 | 来源 | 体量 | 内容 |
|---|---|---|---|
| [third-party-dshbase-architecture.md](third-party-dshbase-architecture.md) | dshbase.com 博客 | 5 KB | **非官方**社区对架构的解读：一切皆插件、自修改 agent、`dsh.bundle` 契约、101 插件实测数据 |

---

## 与本项目最相关的三份

### 1. `official-core.md` —— 查 `agent/*` 事件契约

本项目大量依赖这些事件：

| 事件 | 模式 | 本项目用途 |
|---|---|---|
| `agent/turn-stopping` | **serial** | 轮末写流水兜底（`writeFailStreak` + `steer`） |
| `agent/pre-step` | waterfall | `pre-step-write-nudge`（实测从未真正触发） |
| `agent/created` | serial | 登记项目 |

**关键契约（已核实）**：

```ts
'agent/turn-stopping'(this: Scoped<Agent>, payload: {
  agent: Agent; turn: number; signal: AbortSignal
}): Promise<void> | void
```

- **payload 只有 `agent` / `turn` / `signal`，没有 step**
- 官方描述原文：`a listener that objects steers (agent.steer(...)) and the machine re-reads its inbox: fresh steering runs another step, none closes the turn`

→ 这解释了「补记那条消息为什么必然产生」：`steer` 会让本轮多跑一步。

**step 从哪来**：`session/event` 的 `assistant/message` 事件带 `turn` 与 `step`；`turn-stopping` 不带。

### 2. `official-llm-streaming.md` —— 查 `AssistantMessage` 契约

**⚠️ 本地的 `official-llm-streaming.md` 里只有 `AssistantMessage` 的引用，没有完整定义。**
（`grep interface AssistantMessage` 在已抓的 6 份官方文档里 **0 命中** —— 它定义在 `packages/llm/llm/src/message.ts`，属于未抓取的页面。）

已确认存在的是它的**引用形式**：

```ts
// official-llm-streaming.md L93 / L433
model: ModelMessageSource
message(source: Omit<ModelMessageSource, 'kind'>): AssistantMessage;
```

`ModelMessageSource` 的定义（同文件）：

```ts
export interface ModelMessageSource extends AssistantProviderMetadata {
  kind: 'model'
}
```

**能确认的**：`ContentBlockMap` 有七种块：`text` / `reasoning` / `image` / `file` / `tool-call` / `tool-addition` / `tool-removal`。

**不能从本地文件确认的**：`AssistantMessage` 是否强制含 `text` 块。

`AssistantMessage` 的完整定义需要另抓（`reference/subsystems/llm-streaming.md` 之外的位置），或走 `cordis_inspect_query` host/Event → `session/event`（那条返回过 `referencedTypes`，里面有完整声明）。

→ 本项目提醒文案里那句「DSH 允许只调工具不发言」——**正确依据应当是本条契约，但目前本地副本不足以独立证明它**。要坐实需补抓或走 inspect。

### 3. `official-tools.md` —— 查「为什么不该注册工具」

```ts
schemas(scope?, toolSet?): ToolSchema[]
```

> Project visible definitions onto the allowlisted model-facing schema fields, excluding execution and presentation callbacks.

**`tools` 数组是 DSH 的正式字段，注册工具是被允许的。**

→ 本项目不注册工具，**不是 DSH 禁止**，而是当前使用的反向代理适配器不认 `tools` 数组（见 AGENTS.md 硬约束 1，2026-11-18 已修正）。

---

## 下载当时的失败记录（供后人排查）

| 尝试 | 结果 |
|---|---|
| PowerShell `Invoke-WebRequest` 直连 `deepseek-harness.github.io` | ❌ `SSL connection could not be established`（设了 TLS1.2 仍失败） |
| `web_fetch` 抓 `reference/subsystems/*.md` | ✅ 200 |
| `web_fetch` 抓 `reference/architecture.md` | ❌ 404（架构文档实际在 `reference/index.md`） |
| `web_fetch` 抓 `raw.githubusercontent.com/.../docs/architecture.md` | ❌ `fetch failed` |
| `web_fetch` 抓第三方契约 `HARNESS-CONTRACT-v0.2.0-rc.2.md` | ❌ `fetch failed` |
| `web_fetch` 抓 `github.com/PerryLink/dsh-plugin-guide` | ✅ 200 但内容被截断，无正文 |
| `web_fetch` 抓 `raw.githubusercontent.com/PerryLink/.../README.md` | ❌ `fetch failed` |

**结论**：`raw.githubusercontent.com` 在本机不可达；`github.com` HTML 页面会被截断；官方文档站可用。
