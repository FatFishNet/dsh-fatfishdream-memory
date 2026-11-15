# FatFishDream · 大肥鱼的梦

面向 [DeepSeek Harness](https://github.com/deepseek-ai)（下称 DSH）的长期记忆插件。

仅依赖 DSH 客户端内置的 Node.js 原生 SQLite 模块，**零第三方运行时依赖**。

插件在会话之间持久化记忆数据，使模型在新会话中仍可访问此前记录的结论、规则与流水。

---

## 功能

本插件采用**零工具**设计：不向模型注册任何工具，记忆的读写通过四条数据通道完成。

| 能力 | 通道 | 模型侧操作 |
|---|---|---|
| 读 | `systemPrompt.context` 每轮注入结论 | 无需操作 |
| 写 | 回复正文内嵌 `mem-log` 标记 | 插件监听 `session/event` 自行落库 |
| 查 | 本机 HTTP 接口 | 通过 pwsh 发起请求 |
| 情绪 | 插件自动监听用户消息 | 无感知 |

**不使用工具的原因**：工具 schema 会进入每次请求的 `tools` 数组。部分反代/中转通道
（已实测 WorkBuddy）会以「参数结构不符合要求」为由拒绝整个请求，导致该 profile
下所有会话无法发送消息。本项目因此实际中断过两次，均需手动卸载插件才能恢复。

据此作出的取舍是：**放弃工具调用能力，换取「不因自身原因导致会话不可用」**。

---

## 适用场景

面向**个人开发者或一至两人的小型项目**。

本插件假定记忆数据归属单一用户，不提供多用户隔离、跨设备同步或集中审计能力。
需要上述能力的团队或平台场景不适用。

---

## 安装

```bash
# npm 安装（推荐）
dsh plugin --profile <profile> add dsh-fatfishdream-memory

# GitHub 安装（插件位于仓库子目录，通过 #path: 指定）
dsh plugin --profile <profile> add "git+https://github.com/FatFishNet/dsh-fatfishdream-memory.git#path:/dsh-fatfishdream-memory"

# 本地安装（已 clone 至本地时）
dsh plugin --profile <profile> add <clone 路径>/dsh-fatfishdream-memory
```

安装后须**完整重启 DSH 客户端**。禁用后重新启用不能替代重启 —— `client.js`
为浏览器模块，禁用/启用不会触发其重新加载。

安装成功的判定依据是日志中出现：

```
[health-check-verdict] 通过：9 项全部就位
```

九项分别为：四个事件监听、注入层、`/memory` 命令、HTTP 路由、库可读、根目录可读。
任一缺失会在日志中明确列出失败项，用于排查 DSH 升级后的静默失效。

安装完成后，侧边栏出现「大肥鱼的梦」入口，展开为七个页签：

| 页签 | 用途 |
|---|---|
| 用户画像 | 跨项目的事实与偏好，支持增删改与停用 |
| 规则与偏好 | 按项目维护的约定，支持按项目/类型筛选 |
| 情绪记录 | 插件自动记录，可修正误判 |
| 记忆流水 | 模型写入的工作日志，按项目与时间筛选 |
| 工作区改名 | 改名或合并：选源 → 预览数据量 → 确认 → 执行并比对迁前迁后；目标已有数据时自动转为合并 |
| 收尾语 | 每轮固定结尾语句 |
| 存储设置 | 记忆根目录迁移、库体积构成 |

---

## 存储

单库 SQLite（`<记忆根目录>/memory.db`，WAL 模式），含四张业务表与一张原文层：

| 表 | 内容 | 是否注入 | 写入方 |
|---|---|---|---|
| `profile` | 用户画像（跨项目） | 是，每轮 | 用户在 GUI |
| `rules` | 规则与偏好（含 `scope` / `kind`） | 是，按项目 | 用户在 GUI |
| `emotion` | 情绪记录 | 否，也不进检索 | 插件自动 |
| `logs` | 记忆流水 | 否，仅检索 | 模型标记 |
| `archive` | user/assistant 原文逐条留存 | 否，仅按 `/archive` 回溯 | 插件自动 |

> `archive` 仅从 2026-11-14 04:45（v4 起）开始留存原文，此前对话未回填。
> 查询无结果时应表述为「无此段记录」，而非「未发生过」。

`logs` 为结论层（经整理），`archive` 为原文层（不可变、可追溯）。
结论整理可能遗漏或误判，但原文留存使数据可回溯。

根目录选址、表结构、FTS 设计、备份迁移与体积构成详见
[`dsh-fatfishdream-memory/STORAGE.md`](dsh-fatfishdream-memory/STORAGE.md)。

---

## 使用（模型侧）

### 写入：回复正文内嵌标记

```
<!--mem-log topic=开发日志 summary=修好并发写库丢失 keywords=FTS｜bm25
正文写在这里，可以多行
-->
```

参数顺序固定为 `topic` → `summary` → `keywords`，且与 `topic` 同行。
顺序颠倒时，后续参数会被前一参数整体吞并（summary 丢失、keywords 污染），且不报错。

| 参数 | 约束 |
|---|---|
| `topic` | 13 个分类之一，封闭集合，不在集合内会被白名单拒绝 |
| `summary` | 一句话概述，**≤35 字**；超出会被截断并记录诊断日志 |
| `keywords` | 检索用技术名词，以全角竖线 `｜` 分隔（不用逗号）；无名词时写 `无` |

13 个 topic：开发日志 / 技术讨论 / 构建/编译 / 注入/预算 / 插件/装载 / 路径/沙箱 /
格式/编码 / 文档/行号 / 情绪判据 / 用户画像 / 数据清理 / GUI/界面 / Git

三条禁止写法（均无法通过 `node --check` 发现）：

| 禁止 | 后果 |
|---|---|
| 书写 `<!--/mem-log-->` 闭合标签 | 不会被剥离，作为正文永久入库并逐轮注入 |
| 开标签自带 `-->` 后再加闭合标签 | 同上 |
| 整条压缩为一行 | 正则不匹配，整条静默丢失，无报错 |

结尾 `-->` 必须独占一行。正文需提及标记字样时须拆分书写（反引号包裹亦无效，解析器处理的是原文）。

### 查询：本机 HTTP 接口

```powershell
# 结论层检索（scope 必填，缺省返回 400）
$env:DSH_WEB_URL/api/dsh-memory/search?q=<关键词>&scope=<项目名>&summary=1

# 先取摘要，确认相关后按 id 取全文
$env:DSH_WEB_URL/api/dsh-memory/entry?id=<id>&table=<table>

# 原文层回溯（不在默认 search 范围内）
$env:DSH_WEB_URL/api/dsh-memory/archive?scope=<项目名>&q=<关键词>&limit=50
```

| 端点 | 返回字段 | 说明 |
|---|---|---|
| `/search` | `hits` | 仅检索结论层（流水 / 规则 / 画像） |
| `/archive` | `rows` | 仅检索原文层，分页参数 `limit` / `offset` |
| `/entries` | `entries` | GUI 分页，`table` 必填（四表 id 各自编号） |
| `/entry` | `entry` | 按 id 取单条，须携带 `table` |

端口在每次启动时变化，须读取 `$env:DSH_WEB_URL`，不得硬编码。

---

## 情绪捕获

插件自动识别并记录用户消息中的情绪，模型无感知。

- 六个类别：爱意 / 夸赞 / 吐槽 / 友善 / 喜悦 / 低落
- 判定由情感词典打分叠加否定、程度、转折规则与反讽检测、后置限定词降权构成
- 命中即记：逐条入库，`confidence` 仅标强（≥0.62）/ 弱，不按阈值丢弃
- 仅处理真实用户消息，代码块、行内代码、被讨论的引号内容与 URL 不计入
- 不进检索、不进注入，仅供用户在 GUI 查看

> 「命中即记」的依据：误判可通过 `archive` 原文追溯，漏判则永久丢失。
> 修正误判通过扩充复合词词典实现，不退回按阈值丢弃。

---

## 开发

改动前须先阅读 [`docs/项目地图.md`](docs/项目地图.md)（结构索引）。

```
FatFishDream/
  dsh-fatfishdream-memory/   插件本体（可独立安装）
    index.js                 Host：注入、情绪分析、标记写入、原文归档、HTTP 路由、健康自检
    client.js                Client：侧边栏入口 + 主面板（七页签）+ 标记擦除器
    db-schema.mjs            schema 定义 + 迁移 + FTS 辅助
    db-store.mjs             存储适配层
    cordis.patch.yml         bundle patch（各段预算；root 刻意留空）
  docs/                      开发文档
  _dbpreview/                回归测试脚本
  _dbbackup/                 真实库备份（回退点，不可删除）
```

完整开发文档见 `docs/` 目录，硬约束清单见 [`AGENTS.md`](AGENTS.md)。

### 测试

```powershell
$node = "D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_BASE = $env:DSH_WEB_URL
& $node _dbpreview\run-all.mjs
```

完整清单见 [`docs/TESTING.md`](docs/TESTING.md)。

---

## 当前状态

| 项 | 值 |
|---|---|
| 包版本 | `1.1.0`（MIT，npm 最新版） |
| schema | v5 |
| 代码规模 | `index.js` 4657 行 / `client.js` 2361 行 / `db-store.mjs` 1375 行 / `db-schema.mjs` 422 行 |
| HTTP 路由 | 19 条 |
| 回归测试 | 33 个脚本全量回归 + 23 个变异测试 |
| 每轮注入 | 约 5.6 KB / 约 1243 token（按实际内容计费） |
| 第三方依赖 | 零（仅 Node 内置模块） |
| 平台 | Windows（macOS 未验证） |
| 健康自检 | 启动后核验 9 项挂载点 |

### 相对 1.0.1 的变更

| 类别 | 内容 |
|---|---|
| 新增：工作区改名 | 第七页签，支持改名与合并；后端 `renameScope` 重写为事务 + 自校验，新增 `GET /scope/list` |
| 修复：情绪判定 | 新增后置限定词降权与完成度削弱词，修正「成功了一半」「部分搞定」等误判 |
| 修复：rootReason 字段 | `/state` 的 `rootReason` 此前恒为空，现已真实返回 |
| 修复：擦除器 | `isSafeToCollapse` 三道守卫，修正全局滚动条失效 |
| 新增：测试体系 | `run-all.mjs`（唯一清单）、`meta-mutation-test.mjs`（变异）、`meta-audit-coverage.mjs`（覆盖率）、`lib-spawn-capture.mjs`（沙箱降级） |
| 变更：注入规则 | 「正文不写空行」「情绪不豁免记流水」「marker-unmatched 区分提及与写错」 |
| 清理：死代码 | 删除 10 个死函数（含静默失效的 `reportBudget`） |
| 新增：写入失败提醒 | 连续 4 轮「写了标记却零落库」时经 `safePushMessage` 提醒一次 |

### 已知限制

| 限制 | 说明 |
|---|---|
| macOS 未验证 | 选址逻辑基于 Windows 盘符体系 |
| `archive` 只增不减 | 无保留期或体积上限 |
| 情绪无法识别反讽 | 词典 + 规则，无法识别客套、压抑、委婉否定 |
| 标记写错静默丢失 | 整条压缩为一行时不匹配、零报错 |
| 检索为关键词匹配 | 非语义检索，换用表述即无法命中 |

---

## 许可

MIT。见 [`dsh-fatfishdream-memory/LICENSE`](dsh-fatfishdream-memory/LICENSE)。

本插件早期版本衍生自 [chidaic/dsh-light-memory](https://github.com/chidaic/dsh-light-memory)
（作者 chidaic，MIT）。当前版本在存储架构、写入通道、注入策略上均已重写，
衍生关系与差异清单见 [`dsh-fatfishdream-memory/NOTICE`](dsh-fatfishdream-memory/NOTICE)。
