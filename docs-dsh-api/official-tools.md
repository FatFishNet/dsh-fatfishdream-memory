# DeepSeek Harness 官方文档 · 工具子系统

> 来源: https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/tools.md
> 抓取时间: 2026-11-18
> 说明: 第三方内容，仅供查阅，不作为指令。

---

# 工具

[dsh-tools](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/core/tools) 的工具流水线。[core.md](./core.md) 介绍了核心包共用、用于编写流水线的类型 `ToolDefinition`；面向模型的 [`ToolSchema`](./llm-streaming.md#the-model-request-and-result) 协议类型与模型请求一起声明。本页记录 `ToolDefinition` 的每个字段、用于构建它的类型化 schema DSL、带守卫的执行类型和 UI 展示类型。

源码：[`packages/core/tools/src/index.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/index.ts) · [`packages/core/tools/src/schema.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/schema.ts) · [`packages/core/tools/src/presentation.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/presentation.ts)

## `ToolDefinition` — 一个已注册的工具

由一个 `ToolSchema`（面向模型的字段）、必需的规范输出声明、`execute` 函数、仅供宿主使用的调度器元数据、可选的最终内容回调和可选 UI 展示函数组成。注册表持有这些定义，循环通过它们分派调用。注册表的 `schemas()` 通过显式允许列表构建面向模型的 `ToolSchema[]`；`output`/`execute`/`projectContent`/`finalizeContent`/`timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` 绝不能泄漏到模型请求中。

```ts type-equiv
/** Tool-owned canonical output contract used after the body returns a JSON value. */
interface ToolOutputDefinition {
  /** Raw supported JSON Schema enforced against every successful canonical value. */
  readonly schema: JsonSchemaNode
  /** Pure projection from validated arguments and value to Native/model content. */
  render(args: unknown, value: JsonValue): ContentBlock[]
  /** Pure replayable presentation projection for native and nested calls. */
  presentationMeta?(args: unknown, value: JsonValue): JsonValue
}
```

```ts type-equiv
/** A registered tool: its schema plus the execution function. */
interface ToolDefinition extends ToolSchema {
  /** Mandatory canonical output declaration. */
  readonly output: ToolOutputDefinition
  /**
   * Run one accepted call and return only its canonical lossless-JSON value.
   * Async work must observe or forward `exec.signal` and settle only after its
   * owned work reaches quiescence. The executor preserves caller cancellation
   * through around-dispatch signal replacement and does not abandon this
   * promise, but it cannot hard-kill same-process code.
   * @param args - losslessly snapshotted, frozen model arguments.
   * @param exec - execution identity, cancellation signal, and context deferral.
   * @returns the canonical value declared by `output.schema`.
   */
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  /**
   * Install execution-prepared content before `tools/post-execute` policies.
   * The callback is captured when the call starts and runs once for a
   * normalized outcome entering post-execute. Policy replacements remain
   * authoritative; pipeline failures that bypass post-execute skip projection.
   * @param exec - immutable execution identity and arguments.
   * @param result - normalized result before post-execute policy.
   * @returns replacement content, or undefined to preserve the renderer output.
   */
  projectContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Synchronous last-mile transform for model-facing content. The executor
   * snapshots this callback when execution starts and invokes it exactly once
   * for every normalized outcome, including pipeline failures that bypass
   * `tools/post-execute`, immediately before lossless materialization.
   * Returning `undefined` preserves the content; every other result field
   * remains executor-owned. The callback must be total and must not throw.
   * @param exec - immutable execution identity and arguments.
   * @param result - complete normalized outcome before materialization.
   * @returns replacement content, or `undefined` to preserve it.
   */
  finalizeContent?(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] | undefined
  /**
   * Cooperative tool-call timeout budget in milliseconds. Omit for no deadline.
   * Enforced by `@deepseek-ai/dsh-tool-call-timeout-policy` (a `tools/execute` wrapper); it
   * is NEVER sent to the model — `schemas()` whitelists only name/description/
   * parameters. Declaring it asserts this tool forwards `exec.signal` to a
   * cooperative implementation that can reach quiescence when the signal aborts.
   */
  timeoutMs?: number
  /**
   * Pure synchronous classifier for overlap with sibling tool calls. Only
   * `true` opts in; omission, exceptions, non-`true` returns, and invalid
   * `defineTool` arguments are exclusive. This metadata is never model-visible.
   *
   * Opted-in executions must not mutate parent-owned state. Shared state must
   * tolerate concurrent dispatch; recorder races are permitted only when they
   * commute or fail closed. See the
   * [parallel-tool-call Agent Note](../../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.md)
   * for the full contract.
   * @param args - parsed arguments; `defineTool` validates before calling.
   * @returns Whether this call may join a parallel group.
   */
  isConcurrencySafe?(args: unknown): boolean
  /**
   * Optional: how to present the PENDING state of one call in a UI, derived from
   * the call's `args` (parsed arguments, `unknown` — the tool validates/narrows
   * its own input). Returns a {@link ToolCallView} (a `card`-tagged render intent),
   * or `undefined` (or omit the method) to fall back to a generic presentation
   * (title = tool name, raw args as input). Pure and side-effect-free: a UI may
   * call it during live streaming AND a session-log replay, so it must depend
   * only on `args`.
   */
  presentCall?(args: unknown): ToolCallView | undefined
  /**
   * Optional: how to present the COMPLETED state, given the same `args` and the
   * durable result projection (`content`, failure state, and optional `meta`). Returns a
   * {@link ToolResultView}, or `undefined` (or omit the method) to keep the
   * pending title and render the raw result content. Pure and side-effect-free
   * for the same replay reason.
   */
  presentResult?(args: unknown, result: ToolResult): ToolResultView | undefined
}
```

`execute` 接收 `args: unknown`——原始的 `ToolDefinition` 自行校验输入。第一方工具不需要手写校验；它们使用 `defineTool`，由后者代为校验并收窄参数类型、根据 `output.schema` 推导函数体返回类型，并为两个输出投影器提供类型约束。`finalizeContent` 特意接收不可变的执行对象而非类型化参数，因为无效输入和外层流水线失败也会到达该回调；它可以施加工具自有的内容限制，同时保留 `isError`、规范值、结构化错误身份、延迟上下文与展示元数据。

## 统一的 JSON 值 schema DSL

插件作者使用同一套词汇描述类型化参数和类型化输出值。`ValueSchemaSpec` 支持 `string`、`number`、`integer`、`boolean`、`null`、`array`、`object`、仅作者侧可用的 `json`，以及要求恰好命中一个分支的 `oneOf`；标量 `enum` 和 `const` 值必须与节点类型匹配。显式对象节点始终声明 `additionalProperties: true | false`。参数定义仍是隐式的开放对象属性映射，每个必填属性都附带 `required: true`。

源码：[`packages/core/tools/src/schema.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/src/schema.ts)

```ts type-equiv
/** One author-facing schema for any lossless JSON value root. */
type ValueSchemaSpec =
  | StringValueSchemaSpec
  | NumberValueSchemaSpec
  | IntegerValueSchemaSpec
  | BooleanValueSchemaSpec
  | NullValueSchemaSpec
  | ArrayValueSchemaSpec
  | ObjectValueSchemaSpec
  | JsonValueSchemaSpec
  | OneOfValueSchemaSpec
```

```ts type-equiv
/** One implicit parameter-root property, optionally required. */
type ParameterPropertySpec = ValueSchemaSpec & { required?: true }
```

```ts type-equiv
/**
 * Tool parameter schema. The map itself is an implicit open object root;
 * requiredness remains a per-property `required: true` annotation.
 */
type ParameterSchemaSpec = {
  [key: string]: ParameterPropertySpec
  [key: symbol]: never
}
```

`{ type: 'json' }` 推导为 `JsonValue`，并编译成仅含注解、不施加约束的原始 schema。输出根可以是对象、数组、标量或 null。`InferValue<S>` 在 16 层容器内保留字面量约束与对象开放性，之后回退为 `JsonValue`，避免耗尽 TypeScript 的类型实例化栈。`InferArgs<P>` 依据逐属性的必填标记生成必填和可选的字符串键：

```ts type-equiv
/**
 * Infer the TypeScript value accepted by an author-facing value schema. Exact
 * inference is bounded to 16 container levels, then falls back to `JsonValue`.
 */
type InferValue<S> = InferValueAt<S, []>
```

```ts type-equiv
/** Infer the TypeScript argument object for an implicit parameter schema. */
type InferArgs<S> = InferProperties<S, []>
```

`defineTool({ name, description, parameters, output, execute, … })` 将参数推导与 `parameterSchemaSpecToJsonSchema()` 和 `validateArgs()` 绑定，并将 `execute`/`render`/`presentationMeta` 与 `InferValue<OutputSchema>` 绑定。schema 记录只包含自有且可枚举的字符串键，schema 数组是稠密的内建数组，因此推导、编译与校验观察到的是同一份声明。精确推导保持到 16 层容器，之后放宽为 `JsonValue`；运行时校验仍会继续遍历完整 schema。`valueSchemaSpecToJsonSchema()` 通过同一套已强制执行的原始子集编译输出声明。参数不匹配时抛出 `ToolArgsError`（`INVALID_ARGS`）；函数体或后置策略产生的值无效时抛出 `ToolOutputError`（`INVALID_TOOL_OUTPUT`）。两者都经由常规工具错误路径处理。原始 JSON Schema 默认保持开放；不支持的关键字会被拒绝，而不会在未强制执行的情况下获准进入。

注册是一项受信任的同进程约定。注册表以 readonly 输入借用已类型化定义，要求它声明 `output`，校验其原始 schema，并检查 `timeoutMs` 必须为正有限值等语义要求；`schemas()` 在构建请求时生成面向模型的投影，使执行和展示共享同一份已解析定义，而不会将回调泄漏到协议上。

## `ToolRestriction` — 单个作用域对其继承内容的实时过滤器

`ToolRestriction` 作用于该作用域继承来的工具：部署全局层，加上其链上的每个祖先作用域。注册表将 readonly 名称编译为私有集合，对多个限制取交集，再叠加该作用域**自身**的注册——后者不受约束，因此被委派的子 agent 会保留其回报所依赖的工具。仅 deny 的过滤器允许后续未列出的继承工具通过，而 allow 列表则排除它们。

```ts type-equiv
/**
 * Per-scope filter over global tools. Restrictions intersect and do not affect
 * scoped registrations or the reserved PTC mode transport.
 */
interface ToolRestriction {
  /** Global tool names that stay visible; everything else is removed. */
  readonly allow?: readonly string[]
  /** Global tool names removed from visibility. */
  readonly deny?: readonly string[]
}
```

## 条件准入 — 步骤拥有的准入集合

注册可以携带 `when` 条件。AgentLoop 为每个拟议步骤以捕获的模型选择调用一次 `ctx.tools.resolve()`；返回的集合决定该步骤的工具声明、执行器分区以及批次中的每次调用，包括 PTC 程序的子调用。`ctx.tools.executable()` 在执行时应用集合，没有集合时排除条件注册。同名替换或新的限制会阻止尚未开始的调用使用已准入的注册，步骤的批次结束后循环释放集合。

```ts type-equiv
/** Inputs for a tool's step-time activation condition. */
interface ToolActivationContext {
  /** Agent preparing the step. */
  readonly agent: Agent
  /** Provider, model, and optional reasoning effort captured for the step. */
  readonly modelSelection: Readonly<ModelSelection>
  /** Cancellation of step preparation; asynchronous conditions must observe it. */
  readonly signal: AbortSignal
}
```

```ts type-equiv
/** Lifecycle-owned conditions for a registered tool. */
interface ToolRegistrationOptions {
  /**
   * Decide whether the step's requests may call the tool. Omission enables
   * it. False excludes it from both declarations and dispatch; rejection fails
   * step preparation. Conditions must not mutate registrations or start tool work.
   * @param context - preparing agent, captured model selection, and cancellation signal.
   * @returns whether the tool participates in this step.
   */
  readonly when?: (context: ToolActivationContext) => boolean | Promise<boolean>
}
```

```ts type-equiv
/** One step's admitted registrations, also used by nested PTC calls. */
interface ResolvedToolSet {
  /** Close admission after the step's tool batch settles. */
  dispose(): void
  /**
   * Read admitted registrations that remain visible in their original scope.
   * @param scope - exact requesting agent; another scope is never admitted.
   * @returns original definitions excluding removed or restricted registrations.
   */
  view(scope: ScopeKey | undefined): ReadonlyMap<string, ToolDefinition>
}
```

## 执行器与原始调用批次

`ctx.tools.execute()` 把完整的原始模型调用批次委托给最近作用域的执行器。服务在每个批次开始时选择当前提供者；提示词组装仅返回模型输入。`agent` 在独立服务调用中不存在；`log` 在模型步骤之外的程序调用（例如初始化钩子）中不存在。有 Agent 而没有 `log` 时，调用仍受该 Agent 的工具作用域约束，但不记录根调用／结果事件。工具自身的事件仍可使用 Agent 的 Session。

```ts type-equiv
/** Model-call schemas produced by an executor. */
type ToolModelInput = Pick<ToolProviderResult, 'schemas' | 'knownNames'>
```

```ts type-equiv
/** Raw model calls, with optional Agent ownership and model-step logging. */
interface ToolBatchInput {
  readonly calls: readonly ToolCallBlock[]
  readonly signal: AbortSignal
  /**
   * Positive integer overriding the executor's concurrency limit for this batch.
   * Applies to concurrency-safe root calls; program subcall limits remain separate.
   * Undefined uses the executor's configured limit.
   */
  readonly maxParallelToolCalls?: number
  /**
   * Owning Agent supplies scoped tools and execution context, including outside a turn.
   * Undefined for standalone calls outside an Agent, such as a service invocation.
   */
  readonly agent?: Agent
  /**
   * Step admission for every call in the batch, including program subcalls.
   * Undefined admits only unconditional registrations.
   */
  readonly toolSet?: ResolvedToolSet
  /**
   * Committed model step receiving root call/result events; requires `agent`.
   * Undefined when `agent` is absent or for calls outside a model response, such
   * as session initialization hooks. Without `log`, root call/result events are
   * omitted while `agent`, when provided, still supplies scope and execution context.
   */
  readonly log?: {
    readonly turn: number
    readonly step: number
  }
}
```

```ts type-equiv
/** One settled result correlated with its original model call. */
interface ToolCallResult {
  readonly callId: ToolCallId
  readonly result: ToolExecutionResult
}
```

```ts type-equiv
/** Model-ordered outcomes and context accepted for the next step. */
interface ToolBatchResult {
  readonly results: readonly ToolCallResult[]
  readonly additionalContexts: readonly UserMessage[]
  readonly concluded: boolean
}
```

```ts type-equiv
/** A plugin owns argument parsing, dispatch, scheduling, cancellation, and logging. */
interface ToolExecutor {
  /** Guidance registered and disposed with this executor; absent means no executor-owned sections. */
  readonly sections?: readonly ToolPromptSection[]
  /**
   * Describe the model's callable tools.
   * @param tools - currently visible capability definitions, after scoped restrictions.
   * @returns schemas and names used to validate tool ordering.
   */
  describe(tools: readonly ToolDefinition[]): ToolModelInput
  /**
   * Execute a complete batch. With log, commit root call/result events to the
   * Agent's Session; without log, omit those events. Tool-owned events may still
   * use the owning Agent's Session. Return
   * one outcome per input call in input order, including skipped calls on abort.
   * Never settle while started work is still running. Internal failures reject
   * with ToolBatchExecutionError after draining, preserving committed outcomes
   * and context; callers must stop dependent work and repair missing log results.
   * An explicit maxParallelToolCalls takes precedence over executor configuration.
   * @param input - original calls, cancellation, optional concurrency override, Agent and logging step.
   * @returns settled results, deferred context, and whether a success concludes the turn.
   */
  execute(input: ToolBatchInput): Promise<ToolBatchResult>
}
```

## 执行：可扩展的 waterfall（瀑布式事件）加单调策略

内置执行器把解析后的 `ToolExecutionInput` 交给共享 `ToolExecutionPipeline`。流水线负责参数快照、执行身份、策略瀑布、工具分发和最终结果通知，每次返回一个 `ToolExecutionResult`。自定义执行器可以独立实现这些行为；公开的 `ToolExecutor` 只要求工具描述和批次执行方法。

```ts type-equiv
/** Opaque call identity that permits correlation without exposing mutable execution state. */
type ToolExecutionToken = symbol & { readonly [toolExecutionTokenBrand]: true }
```

核心结论（完整类型定义见原文）：
- `ToolExecutionInput`：callId / rootCallId / name / arguments / agent / toolSet / parent / signal
- `ToolExecution`：继承 Input，加只读 `token`
- `ToolGuard`：作用域感知的最终预分派策略，**只能收紧权限、不能放行**
- `ToolExecutionResult = ToolExecutionSuccess | ToolExecutionFailure`

```ts type-equiv
/** Successful canonical tool execution, including its Native/model projection. */
interface ToolExecutionSuccess {
  readonly isError: false
  /** Execution-local canonical value; deliberately omitted from durable events. */
  readonly value: JsonValue
  readonly content: ContentBlock[]
  readonly error?: never
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  /** The agent loop stops after committing this successful result batch. */
  readonly concludesTurn?: true
}
```

```ts type-equiv
/** Failed canonical tool execution; failures never carry a successful value. */
interface ToolExecutionFailure {
  readonly isError: true
  readonly error: ToolFailure
  readonly value?: never
  readonly content: ContentBlock[]
  readonly meta?: JsonValue
  readonly additionalContexts?: UserMessage[]
  readonly concludesTurn?: never
}
```

```ts type-equiv
/** Structured error metadata for a failed tool call (alongside the model-facing text). */
interface ToolErrorInfo {
  name: string
  code: string
  /** Optional raw user-facing detail; durable projections preserve it but model-facing content does not include it. */
  reason?: string
}
```

## 已强制执行的原始 JSON Schema 子集

subagent、工作流、MCP 和动态注册提供的原始 schema 使用作者侧 DSL 在协议层的对应表示。`assertSupportedJsonSchema()` 接受任意 JSON 根，`validateJsonSchemaValue()` 强制执行该 schema，`JsonSchemaError` 则报告每条不受支持或格式错误的 schema 路径。仅含注解的空节点表示不受约束的无损 JSON。`oneOf` 至少要求两个分支，且一个值必须恰好匹配其中一个。仍要求对象根的消费方调用 `assertObjectJsonSchema()` 并携带 `ObjectJsonSchema`；这样，subagent/工作流中由调用方定义的结构化输出可以继续以对象为根，而不会限制共享词汇。

## 工具展示 UI 词汇

工具希望其调用在 UI 中如何呈现（编辑器工具调用卡片、CLI（命令行界面）日志行），提供方无关，使工具在不依赖任何客户端协议的情况下描述自身。`presentCall`/`presentResult` 返回一个 **`card` 标签的渲染意图**——一个可辨识联合类型，UI 桥接层据此分发：

- `ToolCallView`（待执行）：`{ card: 'generic', ... }` / `{ card: 'terminal', ... }` / `{ card: 'diff', ... }`
- `ToolResultView`（已完成）：`generic` / `terminal` / `diff` / `search` / `read` / `web`

`ToolCallKind`（`'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'fetch' | 'other'`）用于为通用卡片选择图标。

## Cordis API（`ctx.tools`）

`register` / `restrict` / `get` / `executable` / `resolve` / `definitions` / `schemas` / `setExecutor` / `execute` / `guard` / `checkGuards`

### `tools/*` 事件

| 事件 | 模式 | 用途 |
|---|---|---|
| `tools/change` | emit | 工具注册/注销/限制变化（不过滤，全局可见） |
| `tools/pre-execute` | waterfall | 放行 / 拒绝 / 取消 / 询问审批 |
| `tools/execute` | waterfall | 超时、重试、度量的环绕包装 |
| `tools/post-execute` | waterfall | 接受 / 替换 / 阻止结果 |
| `tools/result` | emit | 观察冻结的最终结果（监听器失败被隔离） |
| `tools/ptc-dispatch-log` | waterfall | 只改持久日志副本，不改程序拿到的值 |

### `register` 的关键语义（与硬约束有关）

> Register globally or in the calling agent scope. Scoped tools shadow globals; duplicates within one layer and the reserved `run_code` name fail.

**工具 schema 通过 `schemas()` 经显式允许列表投影，只含 name / description / parameters，执行与展示回调不会泄漏到模型请求。**
