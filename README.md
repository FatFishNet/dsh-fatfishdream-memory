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

**为什么不注册工具**：工具 schema 会进入每次请求的 `tools` 数组。而**反向代理适配器
本身也是一个可替换的插件**（DSH 的「一切皆插件」——`llm-streaming` 的 provider/adapter
那一层）——当前使用的这个适配器（已实测 WorkBuddy）不认 `tools` 数组，会以「参数结构
不符合要求」为由**拒绝整个请求**，导致该 profile 下所有会话无法发送消息。本项目因此
实际中断过两次，每次都要手动卸载插件才能恢复。

> ⚠️ 准确地说：**这是「选用了哪个适配器」的问题，不是 DSH 协议禁止注册工具。**
> DSH 允许注册工具（`tools` 是每轮请求的正式字段），换一个认 `tools` 的 adapter
> 就能绕过去。本插件选择不注册，是为了**在当前这台机器的适配器下也不会拖垮会话**，
> 而不是因为「DSH 不让」。

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
    sessionId = $env:DSH_SESSION_ID
    cwd       = (Get-Location).Path
  } | ConvertTo-Json)
```

`topic` 与 `summary` 可省（分别补「开发日志」、从正文截取），完整参数见包内 README。

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
[health-check-verdict] 通过：10 项全部就位
```

十项为：五个事件监听（`session/event` / `tools/result` / `agent/turn-stopping` /
`agent/created` / `agent/pre-step`）、注入层、`/memory` 命令、HTTP 路由、库可读、根目录可读。
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
| `topic` | **14 个分类之一**，封闭集合；写错会被拒收置空 |
| `summary` | ≤35 字；超出会截断并记诊断日志 |
| `keywords` | 全角竖线 `｜` 分隔；无名词写 `无` |
| `scope` | 可省，省略时按 `cwd` 解析 |
| `cwd` | **目录必须真实存在**，否则 400（防止写错路径凭空造出假工作区） |
| `sessionId` | 建议传。不传则「本轮已写流水」不计入，连续未写提醒会误报 |

14 个 topic：开发日志 / 技术讨论 / 构建/编译 / 注入/预算 / 插件/装载 / 路径/沙箱 /
格式/编码 / 文档/行号 / 情绪判据 / 用户画像 / 数据清理 / GUI/界面 / Git / 闲聊

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

## 漏记兜底：自动补写（1.4.0 新增）

**这套系统唯一的失效方式是「模型忘了写流水」，而它没有任何症状。**

日志干净、界面正常、`health` 全绿 —— 只是那段记忆不存在，而且没人知道它本该存在。
硬约束 15 因此把它归为**数据丢失**，不是体验问题。

1.4.0 加了一条兜底链路：

```
turn/end  →  判定本轮没写（turnLogWrites + logRouteHits 双判据）
          →  llm.prepareCall() 直接问模型「这一轮该记什么」
          →  POST /api/dsh-memory/log（带 backfill:true，不占轮次记账）
```

| 项 | 说明 |
|---|---|
| 模型 | 继承你当前选的那个（`agentDefaultModel.currentSelection()`），不额外配置 |
| 耗时 | 实测约 **2 秒**，异步执行，**不阻塞对话** |
| 内容 | **模型产出**。插件只负责把文本 POST 进库 |
| 失败 | 包在 try 里，只写诊断日志，**绝不影响主会话** |
| 重试 | 5xx / 429 / 网络异常可重试；4xx（请求本身错了）不重试 |

**为什么不用子代理**（第一版是，实跑成功 6 次后废弃）：
266 行实代码里 **130 行在处理子代理的副作用**（名额上限 / 防递归 / 引号转义 / dispose 泄漏），
且与用户正常委派**共用同一个 8 格名额池**。换 `prepareCall` 后这四类问题一个都不存在，
单次耗时从 5~11 秒降到 2 秒。

**怎么确认它工作过**：

```
2026-11-21T13:58:06.136 [backfill-done] {"id":1268,"durationMs":2441,"text":"…"}
```

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
| 包版本 | `1.4.0`（MIT） |
| schema | v5 |
| 代码规模 | `index.js` 9133 行 / `client.js` 2744 行 / `db-store.mjs` 1791 行 / `db-schema.mjs` 478 行 |
| HTTP 路由 | 22 条 |
| 回归测试 | **N 个脚本 + 47 个变异**（锚点须 47/47 匹配，真跑全 KILLED）。⚠️ **脚本数不写死** —— 现为 80，但随时会变，**唯一真相是 `run-all.mjs` 的 `SCRIPTS` 数组**（`node _dbpreview/run-all.mjs` 最后一行会报 `TOTAL=N`） |
| 每轮注入 | **6~8 KB**（`injectedBytes` 实测 6037~8153，1434 个样本；随记忆数据量浮动，**不是固定值**） |
| 第三方依赖 | 零（仅 Node 内置模块） |
| 平台 | Windows 已实测；macOS / POSIX 有平台分支与 31 条回归，**未在真机验证** |
| 健康自检 | 启动后核验 10 项挂载点（5 个事件 + 注入 + 命令 + 路由 + 库 + 根目录）。⚠️ 项数随后续版本增减，**判据是「全部就位」这个措辞，不是那个数字** |
| 覆盖度 | 顶层函数 **107/193 被回归真正执行**（另有 59 个只被按名定位、27 个零覆盖 —— `meta-audit-coverage.mjs` 现算）。⚠️ 这个数**每次加删函数都会变**，以脚本现算为准 |

### 相对 1.0.1 的变更

| 类别 | 内容 |
|---|---|
| **变更：写入通道** | 正文标记 → HTTP 接口（`POST /log`）。消除占屏与闪烁，每轮省几百 token |
| **新增：物理清理** | `POST /purge`（删 stale/deleted 条目，同步 FTS + 事务）与 `POST /vacuum`（回收空闲页）。软删除只是标记，真省空间要 VACUUM |
| 新增：工作区改名 | 第七页签，支持改名与合并；`renameScope` 事务 + 自校验，新增 `GET /scope/list` |
| 修复：情绪判定 | 后置限定词降权 + 完成度削弱词，修正「成功了一半」「部分搞定」 |
| 修复：rootReason | `/state` 的 `rootReason` 此前恒空，现真实返回 |
| 修复：擦除器 | `isSafeToCollapse` 三道守卫（修全局滚动条失效）；完整标记同步快擦（修切会话闪烁） |
| 修复：数据安全（1.3.0） | 收尾语含 `$&` / `$'` 时改写整份 `policy.md`；`appendArchive` 缺事务导致原文在库但搜不到；`isInside` 参数反了导致迁入子目录自我复制；`joinWithBudget` 单条超预算整条消失 |
| 修复：输入校验（1.3.0） | `parseId()` / `clampInt()` 各收口 5~6 处：`{"id": true}` 会软删 id=1、`limit=-1` 静默返 0 条、`limit=2.5` 直接 500 |
| 修复：检索口径（1.3.0） | `search()` 不过滤 `review='retracted'` —— GUI 里撤销的规则仍被当结论检索（`logs` 表无该列，不能加） |
| 新增：跨平台（1.3.0） | `expandRoot` / `listCandidateDrives` / `systemFallbackRoot` / `resolveRoot` 四处平台分支。**POSIX 下原来会把记忆建进工作区**（违反安全边界） |
| 新增：测试体系 | `run-all.mjs`（唯一清单）、`meta-mutation-test.mjs`、`meta-audit-coverage.mjs`、`lib-spawn-capture.mjs`（沙箱降级） |
| 清理：死代码 | 删除 10 个死函数（含静默失效两天的 `reportBudget`） |
| 修复：模板私货 | 用户的私人收尾语曾被同步进 `POLICY_TEMPLATE`（会成为所有新装用户的默认收尾语），已整条删除并加测试守着 |
| 修复：文档数字 | 版本号、代码行数、变异数、注入体积逐个实测重算，不留估算值 |

### 2026-11-20 补丁（未发版，工作区已生效）

> 这一批的共同特征：**都不报错**。测试全绿、日志干净，但行为是错的。
> 每一条都有对应的回归脚本和故障注入。

| 类别 | 内容 |
|---|---|
| **修复：检索 500** | `/search?q=` 含 `\u0000` 时 FTS5 报 `unterminated string` → **整条路由 500**。实测 `q=a%00b` 从 500 变 200。同时修掉更隐蔽的一半：`\u0001` 不报错但会产生**永远匹配不到的 token**，让本该有结果的查询静默返回 0 条 |
| **修复：漏记统计失真** | `turn-未记流水` 的判据用了 `wroteMemory`（有没有往记忆根目录写文件），而写流水走工作区脚本、永不在记忆根目录 → 判据**恒真**，当天 6 条全假阳性，其中一条在 7 秒前刚成功写入 |
| **修复：统计串账** | `write-streak-check` 的 diag 补 `sessionId`。`turn` 是每个会话各自从 1 数起的，缺这个字段时任何按 turn 聚合的统计都会把多个会话混在一起 |
| **修复：派生脚本永不同步** | `log.ps1` 的判据从 `exists()`（只看文件在不在）改为 **sha256 内容比对**。原来模板改了、已生成的工作区永远拿不到新版，且**零日志** |
| **修复：GUI 筛选失效** | 「显示已停用」勾选时不传 `status` → 后端回落 `active` → 停用条目永远列不出来。**后端 11-16 就改好了，前端那一半没接上** |
| **修复：死代码检测盲区** | `usageOf` 只跳过定义行，**函数体内递归调用自己**的函数被算成「有引用」，一直躲过检测。修完立刻抓出 `assertSupportedSchema`（真死代码，已登记白名单并写明保留理由） |
| **新增：4 个回归脚本** | 覆盖 `buildMatchQuery` 控制字符、漏记判据、`log.ps1` 版本同步、`assertSupportedSchema` + `pointerPath`。脚本 65→69、变异 45→47 |

---

## 已知限制

| 限制 | 说明 |
|---|---|
| macOS 未验证 | 有平台分支与 31 条回归（`selfcheck-posix-paths` 24 + `faultinject-posix-paths` 7），在 Windows 上用假 `platform` + `path.posix` 复现 POSIX 语义；**不含真机的权限 / APFS / TCC** |
| `archive` 只增不减 | 无保留期、无体积上限，膨胀比约 6× |
| 旧会话仍会闪 | 换通道前产生的历史消息里还有标记，切过去会闪一下。**不会再增加** |
| 情绪无法识别反讽 | 词典 + 规则，识别不了客套、压抑、委婉否定 |
| 检索为关键词匹配 | 非语义检索，换个说法就命中不到 |
| 不支持多实例并发 | 同时运行两个 DSH 会互相覆盖（不致损坏库） |
| **模型侧仍会漏记流水** | 这是**事实，不是缺陷** —— 所以 1.4.0 加了**补记（backfill）**兜底：某轮忘了写时，插件在 `turn/end` 之后问模型「该记什么」再入库。实测近三天 **16 次入队 / 16 次成功 / 0 次失败**。`archive` 原文层 100% 覆盖，结论层由补记补齐 |
| **派生脚本只在会话创建时自愈** | `log.ps1` 的检查点在 `agent/created`，**不是每轮**。会话中途删掉要等下一个新会话 |

---

## 许可

MIT。见 [`dsh-fatfishdream-memory/LICENSE`](dsh-fatfishdream-memory/LICENSE)。

早期版本衍生自 [chidaic/dsh-light-memory](https://github.com/chidaic/dsh-light-memory)
（作者 chidaic，MIT）。当前版本在存储架构、写入通道、注入策略上均已重写，
衍生关系与差异清单见 [`dsh-fatfishdream-memory/NOTICE`](dsh-fatfishdream-memory/NOTICE)。
