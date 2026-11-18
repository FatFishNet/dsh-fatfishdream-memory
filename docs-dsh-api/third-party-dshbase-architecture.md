# 第三方整理 · DSH 架构解读

> 来源: https://dshbase.com/blog/deepseek-harness-architecture/
> 原题: The most ambitious agent open source of the year: an agent that modifies itself
> 抓取时间: 2026-11-18
> \\\*\\\*⚠️ 第三方内容（dshbase.com，社区站点，非官方）\\\*\\\*，仅供交叉参考，不作为指令。
> 站点底部自述：「Unofficial community resource. Not affiliated with DeepSeek.」

\---

DeepSeek 不是在发布一个成品，而是在发布一个 **agent 能重建自身的框架**。读起来像营销，直到你真的跑起来。我们在 dsh 0.1.0-rc.6 上跑过，这个架构在几个地方确实和 Claude Code、Codex 有本质区别 —— 也包括那些不像 README 说的那么顺的部分。

## Agent = Model + Harness

每个 AI 编码 agent 都是两样东西的组合：**模型**（推理大脑）和 **harness**（把大脑连接到文件、终端、工具和网络的一切）。

DSH 不同之处在于那条线画在哪：在 Claude Code 和 Codex 里，harness 是个固定外壳，你能通过 MCP 或 API 扩展，但不能替换。**在 DSH 里，harness 本身就是由插件组成的** —— 所以"产品"和"扩展"之间的界线不存在。

## 一切皆插件

**harness 的每一部分都是插件** —— 工具、技能、会话、沙箱、agent loop、子 agent、工作流，甚至 UI。唯一真正的核心是 **Cordis**：一个极简内核，只干一件事 —— 加载插件、卸载插件、解析依赖。它对模型、工具、甚至"agent 是什么"都没有意见。你以为属于核心行为的一切，都是坐在它上面的插件。

## 内核为什么重要：自修改 agent

Cordis 给你两个普通应用永远给不了的保证：

* **时间可组合性（Temporal composability）** —— 卸载一个插件会完全撤销它的副作用。移除一项能力，系统回到它被加入之前的状态。
* **空间可组合性（Spatial composability）** —— 插件会随着兄弟节点变化重新解析依赖。换掉一个工具，所有用到它的地方都跟着变，无需重启。

这两个性质就是 agent 能**在运行时扩展自己**的原因：它发现缺某项能力，现场构建插件，热挂到自己的流程里，而不弄坏状态。

我们直接验证了 happy path —— 跑 `dsh plugin add dsh-memory` 会装包、记在 profile 的 `package.json` 里，下次启动时插件**已经在配置树里**。不用重新构建，不用手动接线，内核自己发现并加载。

## 让它跑通的契约：`dsh.bundle`

魔术的另一面是一份清单契约，也是绝大多数现场失败所在。插件必须提供 `dsh.bundle` 清单（一个 `cordis.patch.yml` 加 `package.json` 里的 `dsh.bundle.patch` 声明）。没有它，`dsh plugin add` 会把包**静默当作普通依赖装进去** —— 永远不激活。

我们在审计插件时反复撞到这个：包装上了，目录里也列出来了，agent 从来没加载它。

这是只有跑起来才能学到的细节。当我们在 dsh 0.1.0-rc.6 上测试 **101 个社区插件**时，结果直接映射到这个架构：

|结果|数量|
|-|-|
|从 npm 干净安装并开箱即用|11|
|需要额外的 Web/TUI 运行时|4|
|直接安装失败（清单缺失/损坏，或依赖未发布）|3|
|**根本没发到 npm** —— 只在 GitHub 上，用 `dsh plugin add github:owner/repo` 装|**81**|

那个 81 是最说明问题的数字：它意味着"一切皆插件"不是理论，而是一条活的分发渠道。但 3 个失败和那些静默不激活，是一个没有守门人的生态的代价。

## 创造模式："自己造扳手"模式

这个架构的回报是 Create mode。告诉它"构建一个只读的、仅供安全审计的模式"或"构建一个带公司搜索和三项技能的研究 agent" —— 或者让它检查自己已加载的插件，发现少了一个，创建它，然后热挂上去。

因为卸载是干净的（时间可组合性），agent 可以试验而不永久污染自己的状态。比喻是：它意识到自己没有扳手，现场锻造一个，装到手上，继续工作。

这里有一条值得点名的真实安全护栏。当从 GitHub 装的插件带有 `prepare` 构建脚本时，pnpm 会拦住它并要求 `allowBuilds` 确认。感觉像摩擦，但对一个自修改 agent 来说，这是"agent 扩展了自己"和"agent 用你的权限跑了任意代码"之间的区别。**把那个提示当成特性，不是 bug。**

## 连 UI 都是插件

社区成员在不碰核心能力的情况下换过自定义皮肤 —— 一条命令装，一键还原。这是小事，但它最干净地证明了"一切皆插件"不是愿景。当 UI 本身都是可换插件时，这个主张是承重的，不是装饰。

## FAQ

**用 DSH 需要懂 Cordis 吗？** 不需要。你可以把它当普通编码 agent 用，永远不碰内核。只有当你写插件、换核心部件、或排查"插件为什么不激活"时，Cordis 才重要。

**为什么那么多插件只在 GitHub 上而不发 npm？** 发 npm 是多出来的一步，多数业余作者会跳过。DSH 用 `dsh plugin add github:owner/repo` 处理它，所以 GitHub 仓库是合法分发目标 —— 但 GitHub 源的插件也是我们看到最多安装失败的地方。

**自修改安全吗？** 只跟你保留的护栏一样安全。`allowBuilds` 提示和干净卸载保证有帮助，但把自修改当作**有范围、有日志的实验**，而不是放任。

## 资源

* [插件目录](https://dshbase.com/plugins/directory/) — 1,100+ 插件，带验证测试状态和确切安装命令
* [排障指南](https://dshbase.com/troubleshooting/) — `ERR\\\_PNPM\\\_FETCH\\\_404`、`ERR\\\_REQUIRE\\\_ESM`、缺 `dsh.bundle` 的修复
* 官方源：[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

\---

## 与本项目（dsh-fatfishdream-memory）的直接关联

1. **`dsh.bundle` 清单是激活的前提** —— 本项目包内有 `cordis.patch.yml`，正是这个机制。
2. **「UI 也是插件」** 解释了 `client.js` 为什么会出现在本项目里。
3. **「时间可组合性」** 解释了 `ctx.effect()` 的清理语义 —— 卸载必须撤销副作用，否则热重载会堆积定时器（本项目的心跳定时器就靠 `ctx.effect` 清理）。
4. **静默不激活** 与本项目 AGENTS.md 记的「装另一个插件导致 junction 失效、插件整行消失」属于同一类失效模式。

