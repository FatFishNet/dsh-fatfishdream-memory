# FatFishDream · 大肥鱼的梦

面向 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）的长期记忆插件。

让模型在新的会话里仍然记得：**你是什么样的人**、**这个项目有哪些约定**、**上次做到哪儿了**。

仅依赖 DSH 客户端内置的 Node.js 原生 SQLite 模块，**零第三方运行时依赖**。

---

## 设计取舍：不注册任何工具

本插件**不向模型注册任何工具**。记忆的读写通过四条数据通道完成：

| 能力 | 通道 | 模型侧操作 |
|---|---|---|
| 读 | `systemPrompt.context` 每轮注入结论 | 无需操作 |
| 写 | 本机 HTTP 接口 `POST /api/dsh-memory/log` | 用 pwsh 发一次请求 |
| 查 | 本机 HTTP 接口 | 用 pwsh 发一次请求 |
| 情绪 | 插件监听用户消息自动记录 | 无感知 |

**为什么不注册工具**：工具 schema 会进入每次请求的 `tools` 数组。部分反代与中转
通道（已实测 WorkBuddy）会以「参数结构不符合要求」为由**拒绝整个请求**，导致该
profile 下所有会话无法发送消息。本项目因此实际中断过两次，每次都要手动卸载插件
才能恢复。

所以这里的取舍很明确：

> **放弃工具调用能力，换取「不因自身原因导致会话不可用」。**

---

## 写入通道的演进（这一段是本版最重要的变化）

### 早期做法：正文标记

模型在回复正文里内嵌一段标记，插件监听 `session/event` 解析后落库：

```
<!--mem-log topic=开发日志 summary=修好并发写库丢失 keywords=FTS｜bm25
正文写在这里
-->
```

功能上是通的，但它有一个**无法回避的副作用**：标记必须出现在正文里。于是界面上
只剩两种结局，二选一：

- **不擦除** → 标记永久占屏。窗口缩小时正文被挤掉，用户原话：
  「*我甚至看不到你回复的正文，全是流水占了大半屏幕*」。
- **擦除** → 标记被流式渲染显示后再抹去，表现为**闪烁**。用户原话：
  「*现在选择擦除后，开始闪了*」。

前五代擦除器都在「怎么擦得更隐蔽」上打补丁，结果分别栽在：跨段正则误伤说明文字、
`display:none` 包裹导致内容永久消失、`el.remove()` 触发 React 重建后反复闪、
全局 CSS `!important` 打断其他面板的滚动条。

**病根不是「怎么擦」，是「标记根本不该出现在正文里」。**

### 现在：HTTP 接口

模型用 pwsh `POST` 一次，标记不进正文：

```powershell
Invoke-RestMethod -Method Post "$env:DSH_WEB_URL/api/dsh-memory/log" `
  -ContentType 'application/json' `
  -Body (@{
    text      = '正文'
    topic     = '开发日志'
    summary   = '≤35 字概述'
    keywords  = '词A｜词B'
    sessionId = $env:DSH_SESSION_ID
    cwd       = (Get-Location).Path
  } | ConvertTo-Json)
```

**三重收益**：

1. **不占屏** —— 正文里没有标记，界面干净。
2. **不闪烁** —— 没有东西需要擦除。
3. **更省 token** —— 一条长标记约 300~600 token，且会**永久留在会话上下文**里。
   按 10 轮算就是几千 token 的纯开销，现在归零。

标记通道**保留作为兜底**：HTTP 不可用（端口变化、接口异常）时可退回写标记，
插件照常解析入库。两条通道通一条就够。

---

## 安装

```bash
# npm 安装（推荐）
dsh plugin --profile <profile> add dsh-fatfishdream-memory

# GitHub 安装（插件位于仓库子目录，用 #path: 指定）
dsh plugin --profile <profile> add "git+https://github.com/FatFishNet/dsh-fatfishdream-memory.git#path:/dsh-fatfishdream-memory"

# 本地安装
dsh plugin --profile <profile> add <clone 路径>/dsh-fatfishdream-memory
```

安装后须**完整重启 DSH 客户端**。禁用再启用**不能替代重启** —— `client.js` 是
浏览器模块，禁用/启用不会触发它重新加载。

安装成功的判据是日志出现：

```
[health-check-verdict] 通过：9 项全部就位
```

九项为：四个事件监听、注入层、`/memory` 命令、HTTP 路由、库可读、根目录可读。
任一缺失会在日志里列出失败项 —— 这是排查「DSH 升级后插件静默失效」的第一现场。

---

## 七个页签

侧边栏「大肥鱼的梦」入口展开后：

| 页签 | 用途 |
|---|---|
| 用户画像 | 跨项目的事实与偏好 |
| 规则与偏好 | 按项目维护的约定，可按项目/类型筛选 |
| 情绪记录 | 插件自动记录，可人工修正误判 |
| 记忆流水 | 模型写入的工作日志，按项目与时间筛选 |
| 工作区改名 | 改名或合并：选源 → 预览数据量 → 确认 → 执行并比对迁前迁后 |
| 收尾语 | 每轮固定结尾语句 |
| 存储设置 | 记忆根目录迁移、库体积构成 |

---

## 存储

单库 SQLite（`<记忆根目录>/memory.db`，WAL 模式），四张业务表 + 一张原文层：

| 表 | 内容 | 是否注入 | 写入方 |
|---|---|---|---|
| `profile` | 用户画像（跨项目） | 是，每轮 | 用户在 GUI |
| `rules` | 规则与偏好（含 `scope` / `kind`） | 是，按项目 | 用户在 GUI |
| `emotion` | 情绪记录 | 否，也不进检索 | 插件自动 |
| `logs` | 记忆流水 | 否，仅检索 | 模型经 HTTP |
| `archive` | user/assistant 原文逐条留存 | 否，仅按 `/archive` 回溯 | 插件自动 |

**结论层 vs 原文层**：`logs` 是模型整理过的结论，会遗漏也会误判；`archive` 是
一条不落的原文，不可变、可追溯。检索默认只查结论层（原文会淹没结论），
需要回溯时走 `/archive`。

> `archive` 自 2026-11-14 04:45（v4）起才有，此前对话未回填。
> 查不到时应说「无此段记录」，而不是「未发生过」。

`emotion` 是唯一**既不注入也不进检索**的表 —— 它只给用户自己看。
搜不到情绪记录是设计如此，不是失效。

根目录选址、FTS 设计、备份迁移、体积构成详见
[`dsh-fatfishdream-memory/STORAGE.md`](dsh-fatfishdream-memory/STORAGE.md)。

---

## 模型侧用法

### 写流水

见上文「HTTP 接口」。只接受 `POST`，返回 `{ok, id, scope, bytes, topic, scopeFrom}`。

| 参数 | 约束 |
|---|---|
| `text` | **必填**，为空返回 400 |
| `topic` | 13 个分类之一，封闭集合；写错会被拒收置空 |
| `summary` | ≤35 字；超出会截断并记诊断日志 |
| `keywords` | 全角竖线 `｜` 分隔；无名词写 `无` |
| `scope` | 可省，省略时按 `cwd` 解析 |
| `cwd` | **目录必须真实存在**，否则 400（防止写错路径凭空造出假工作区） |
| `sessionId` | 建议传。不传则「本轮已写流水」不计入，连续未写提醒会误报 |

13 个 topic：开发日志 / 技术讨论 / 构建/编译 / 注入/预算 / 插件/装载 / 路径/沙箱 /
格式/编码 / 文档/行号 / 情绪判据 / 用户画像 / 数据清理 / GUI/界面 / Git

### 查记忆

```powershell
# 结论层检索（scope 必填，缺省返回 400）
$env:DSH_WEB_URL/api/dsh-memory/search?q=<关键词>&scope=<项目名>&summary=1

# 按 id 取全文（table 必填，四表 id 各自编号）
$env:DSH_WEB_URL/api/dsh-memory/entry?id=<id>&table=<table>

# 原文层回溯
$env:DSH_WEB_URL/api/dsh-memory/archive?scope=<项目名>&q=<关键词>&limit=50
```

| 端点 | 返回字段 | 说明 |
|---|---|---|
| `/search` | `hits` | 仅结论层（流水 / 规则 / 画像） |
| `/archive` | `rows` | 仅原文层，分页 `limit` / `offset` |
| `/entries` | `entries` | GUI 分页，`table` 必填 |
| `/entry` | `entry` | 按 id 取单条，须带 `table` |

**端口每次启动都变**，必须读 `$env:DSH_WEB_URL`，不要硬编码。

结论层检索为**三表轮流取样**（`profile → rules → logs`），表内按相关度排序。
同一张表连续出现属正常，不是排序异常。

### 写入（兜底）：正文标记

HTTP 不可用时使用。参数顺序固定 `topic` → `summary` → `keywords`，且与 `topic`
同行 —— 顺序颠倒时后续参数会被前一参数整段吞并，**且不报错**。

三条禁止写法（`node --check` 查不出）：

| 禁止 | 后果 |
|---|---|
| 写 `<!--/mem-log-->` 这类闭合标签 | 不会被剥离，永久入库并逐轮注入 |
| 开标签自带 `-->` 后再加闭合标签 | 同上 |
| 整条压成一行 | 正则不匹配，**整条静默丢失**，零报错 |

---

## 情绪捕获

插件自动识别并记录用户消息中的情绪，模型无感知。

- 六个类别：爱意 / 夸赞 / 吐槽 / 友善 / 喜悦 / 低落
- 判定 = 情感词典打分 + 否定 / 程度 / 转折规则 + 反讽检测 + 后置限定词降权
- 命中即记：逐条入库，`confidence` 只标强（≥0.62）/ 弱，**不按阈值丢弃**
- 只处理真实用户消息（代码块、行内代码、被讨论的引号内容、URL 不计入）
- 不注入、不进检索，仅供用户在 GUI 查看

> **为什么「命中即记」**：误判可以靠 `archive` 原文追溯，漏判则永久丢失。
> 修正误判通过扩充复合词词典实现，不退回按阈值丢弃。
>
> 后置限定词：`modifierBefore()` 只能看命中词**前面** 3 个字，而中文的
> 「一半 / 一点 / 部分」大量出现在**后面** —— 于是「成功了一半」曾按 0.8 强置信
> 记成喜悦。现在补 `limiterAfter()` 看词后（一半/部分→0.45，一点/一些→0.5，
> 只降不升）。

---

## 开发

改动前先读 [`docs/项目地图.md`](docs/项目地图.md)（函数在哪、谁调谁、改哪影响什么）。

```
FatFishDream/
  dsh-fatfishdream-memory/   插件本体（可独立安装）
    index.js                 Host：注入、情绪、写入通道、归档、HTTP 路由、健康自检
    client.js                Client：侧边栏入口 + 七页签面板 + 标记擦除器
    db-schema.mjs            schema 定义 + 迁移 + FTS 辅助
    db-store.mjs             存储适配层
    cordis.patch.yml         bundle patch（各段预算）
  docs/                      开发文档（地图 / 维护手册 / 决策 / 测试）
  _dbpreview/                回归测试与变异测试
  _dbbackup/                 真实库备份（回退点，不可删）
```

硬约束清单见 [`AGENTS.md`](AGENTS.md)，踩过的坑见
[`docs/DECISIONS.md`](docs/DECISIONS.md)。

### 测试

```powershell
$node = "D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_BASE = $env:DSH_WEB_URL
& $node _dbpreview\run-all.mjs          # 全量回归
& $node _dbpreview\meta-mutation-test.mjs --dry-run   # 先看变异锚点是否全匹配
```

**变异测试会临时改坏生产文件**，跑之前先看 `--dry-run`，且工作区应干净。
完整清单见 [`docs/TESTING.md`](docs/TESTING.md)。

---

## 当前状态

| 项 | 值 |
|---|---|
| 包版本 | `1.3.0`（MIT） |
| schema | v5 |
| 代码规模 | `index.js` 5843 行 / `client.js` 2499 行 / `db-store.mjs` 1694 行 / `db-schema.mjs` 422 行 |
| HTTP 路由 | 22 条 |
| 回归测试 | 50 个脚本 + 40 个变异（锚点须 40/40 匹配，真跑 40/40 KILLED） |
| 每轮注入 | 约 6.5 KB / 约 1467 token（随记忆数据量浮动，非固定值） |
| 第三方依赖 | 零（仅 Node 内置模块） |
| 平台 | Windows（macOS 未验证） |
| 健康自检 | 启动后核验 9 项挂载点 |

### 相对 1.0.1 的变更

| 类别 | 内容 |
|---|---|
| **变更：写入通道** | 正文标记 → HTTP 接口（`POST /log`）。消除占屏与闪烁，每轮省几百 token |
| **新增：物理清理** | `POST /purge`（删 stale/deleted 条目，同步 FTS + 事务）与 `POST /vacuum`（回收空闲页）。软删除只是标记，真省空间要 VACUUM |
| 新增：工作区改名 | 第七页签，支持改名与合并；`renameScope` 事务 + 自校验，新增 `GET /scope/list` |
| 修复：情绪判定 | 后置限定词降权 + 完成度削弱词，修正「成功了一半」「部分搞定」 |
| 修复：rootReason | `/state` 的 `rootReason` 此前恒空，现真实返回 |
| 修复：擦除器 | `isSafeToCollapse` 三道守卫（修全局滚动条失效）；完整标记同步快擦（修切会话闪烁） |
| 新增：测试体系 | `run-all.mjs`（唯一清单）、`meta-mutation-test.mjs`、`meta-audit-coverage.mjs`、`lib-spawn-capture.mjs`（沙箱降级） |
| 清理：死代码 | 删除 10 个死函数（含静默失效两天的 `reportBudget`） |
| 修复：模板私货 | 用户的私人收尾语曾被同步进 `POLICY_TEMPLATE`（会成为所有新装用户的默认收尾语），已整条删除并加测试守着 |
| 修复：文档数字 | 版本号、代码行数、变异数、注入体积逐个实测重算，不留估算值 |

---

## 已知限制

| 限制 | 说明 |
|---|---|
| macOS 未验证 | 选址逻辑基于 Windows 盘符体系 |
| `archive` 只增不减 | 无保留期、无体积上限，膨胀比约 6× |
| 旧会话仍会闪 | 换通道前产生的历史消息里还有标记，切过去会闪一下。**不会再增加** |
| 情绪无法识别反讽 | 词典 + 规则，识别不了客套、压抑、委婉否定 |
| 检索为关键词匹配 | 非语义检索，换个说法就命中不到 |
| 不支持多实例并发 | 同时运行两个 DSH 会互相覆盖（不致损坏库） |

---

## 许可

MIT。见 [`dsh-fatfishdream-memory/LICENSE`](dsh-fatfishdream-memory/LICENSE)。

早期版本衍生自 [chidaic/dsh-light-memory](https://github.com/chidaic/dsh-light-memory)
（作者 chidaic，MIT）。当前版本在存储架构、写入通道、注入策略上均已重写，
衍生关系与差异清单见 [`dsh-fatfishdream-memory/NOTICE`](dsh-fatfishdream-memory/NOTICE)。
