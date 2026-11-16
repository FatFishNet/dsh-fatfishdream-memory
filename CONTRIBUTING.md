# 贡献指南

谢谢你看这个项目。它本来是为个人使用写的，欢迎 issue 与 PR，
但请先读完下面几行 —— 这里有几条**不是风格偏好，是真踩过坑**的规矩。

---

## 提 Issue

写清楚三件事，能省掉一整轮来回：

1. **你在做什么**（装了插件？改代码？只是想用某个功能？）
2. **发生了什么**（报错原文、界面截图、或「什么都没发生」）
3. **期望什么**

**报错一定要贴原文**，不要转述。这个项目里绝大多数事故的特征就是「没有报错」——
静默失败比崩溃多，所以任何一条日志都可能关键。

**先查一下日志**：`<记忆根目录>/logs/YYYY-MM-DD.log`。
启动是否正常看有没有这一行：

```
[health-check-verdict] 通过：9 项全部就位
```

缺哪项它会直接点名，比「记忆不好用了」有用得多。

### 安全提醒

贴日志 / 数据库片段之前**先脱敏**：里面可能有你的项目名、文件路径、对话原文。
不要把整个 `memory.db` 传到公开 issue 里 —— 那是你的真实记忆。

---

## 提 PR

### 三条硬规矩（违反会被要求重做）

1. **不要注册任何工具。** 这是设计前提，不是洁癖。
   工具 schema 会进每次请求的 `tools` 数组，某些中转通道会因此**拒绝整个请求**，
   导致该 profile 下所有会话都发不出消息。本项目因此实际中断过两次。

2. **不要直接改 `memory.db`。** 用编辑器或脚本直写 SQLite 二进制不是「被拒绝」，
   是**损坏数据库**（页结构、WAL、FTS 影子表会不同步）。改数据走 GUI 或 HTTP 接口。

3. **改了 `index.js` / `client.js` 的行数，必须重算 `docs/项目地图.md` 里的行号。**
   地图是绝对行号，插几行后面全漂。准绳是 `verify-map-content.mjs`，
   **不是** `verify-map`（后者只判「该行非空」，整片漂移它也全绿）。

其余约束（备份、schema 迁移、注入预算）见仓库根的 `AGENTS.md`，
那份文件就是本项目的工程约定全集，每条都带事故日期。

### 提交前跑一遍

**不依赖 DSH 在运行**的最小验证（下面这 12 个，够挡住绝大多数回归）：

```powershell
$node = "<你的 node 路径>"
foreach ($s in 'verify-functions','verify-map','verify-map-content','selfcheck-full',
               'selfcheck-isolation','selfcheck-marker-hardened','selfcheck-dom-strip',
               'selfcheck-scrubber-loop','selfcheck-topic-clean','test-marker-forms',
               'selfcheck-search-tier','verify-doc-links') {
  & $node "_dbpreview\$s.mjs"
  "{0,-30} exit={1}" -f $s, $LASTEXITCODE
}
```

**改了 UI（`client.js`）的话**：它是浏览器模块，
禁用→启用插件**不会**重新加载它，必须**完整重启客户端**再看效果。

**改了 Host 代码（`index.js` / `db-store.mjs` / `db-schema.mjs`）的话**：
改完必须**禁用→启用插件**。HMR 有两种坏法（只重装入口、或干脆不触发），
别指望它，也别拿「日志里有 `[apply-start]`」当生效判据 —— 只能按行为验一次。

完整回归清单（含硬依赖 DSH 的 3 个脚本）见 `docs/TESTING.md`。

> **「不需要 DSH」的判定是实测的，不是看代码里有没有 `DSH_BASE` 猜的**（2026-11-15）：
> 清空 `DSH_BASE` / `DSH_WEB_URL` 后把当前清单里的脚本全跑一遍，只有 3 个失败 ——
> `selfcheck-e2e-memory`、`selfcheck-entry-by-id`、`selfcheck-paging`。
> 另外 4 个虽然会读环境变量，但缺环境时**自动跳过 HTTP 段并以 0 退出**：
> `selfcheck-archive`（存储层 36 项照跑）、`selfcheck-breakdown`（存储层 18 项）、
> `verify-injection-consistency`、`selfcheck-log-alive`。所以**硬依赖只有那 3 个**。
> 脚本总数不写死 —— 唯一真相是 `run-all.mjs` 的 `SCRIPTS` 数组（当前 37 个）。

### 代码风格

- **注释用中文，解释「为什么」而不是「做了什么」。**
  这个项目里每一个不显然的决定都附了日期和事故经过 —— 新增代码请沿用。
- 没有构建步骤、没有第三方依赖。别引入 `dependencies`：
  这个插件只该用 Node 内置模块（`node:sqlite` / `node:fs` / `node:path` …）。
- 提交信息用中文一句话说清「改了什么、为什么」，不要 `update` / `fix`。

---

## 开发环境

```bash
git clone https://github.com/FatFishNet/dsh-fatfishdream-memory.git
cd dsh-fatfishdream-memory

# 装进你的 DSH（插件在子目录里，用 #path: 指定）
dsh plugin --profile <你的profile> add "git+https://github.com/FatFishNet/dsh-fatfishdream-memory.git#path:/dsh-fatfishdream-memory"
```

或已 clone 到本地时，直接指向包目录：

```bash
dsh plugin --profile <你的profile> add <clone 路径>/dsh-fatfishdream-memory
```

**运行要求**：Node ≥ 20（用 `node:sqlite`，不需要装任何数据库驱动）。

---

## 许可

提交 PR 即表示你同意以本项目的 [MIT 许可](LICENSE) 发布你的贡献。
