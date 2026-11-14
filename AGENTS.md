# FatFishDream

DeepSeek Harness 记忆插件（`dsh-fatfishdream-memory`，显示名「大肥鱼的梦」）的开发项目。

## 这个项目是什么

一个**零工具**的长期记忆插件。模型不调用任何工具，记忆读写靠数据通道：

| 能力 | 实现 |
|---|---|
| 读记忆 | `systemPrompt.context` 把结论注入每一轮 |
| 查记忆 | 模型用 pwsh 请求本机 HTTP 接口（`/api/dsh-memory/search`） |
| 写记忆 | 模型在**回复正文**里写 `mem-log` 标记，插件监听到后自己入库 |
| 情绪捕获 | 插件监听 `session/event`，自动写入，模型无感知 |
| 原文归档 | 插件把 user/assistant 原文**一条不落**写进 `archive`（v4），不注入、不进默认 `/search`。**只从 2026-11-14 04:45 起有**，更早未回填：查不到时说「我没有这段记录」，别说「没发生过」 |

**存储**：单库 `memory.db`（SQLite，WAL 模式，schema **v5**），四张业务表 + 一张原文层 ——
`profile`（画像）/ `rules`（规则）/ `emotion`（情绪，**不进检索**）/ `logs`（流水）/
**`archive`（原文，插件自动写，只按 `/api/dsh-memory/archive` 回溯）**。
schema 版本用 `PRAGMA user_version` 管理。

## 硬约束

**这一节只放「违反就会出事」的规矩。历史事故的来龙去脉见
[`docs/DECISIONS.md`](docs/DECISIONS.md)。**

1. **不要注册任何工具。**
   工具 schema 进每次请求的 `tools` 数组，反代会以「参数结构不符合要求」
   拒绝**整个请求** → 该 profile 下所有会话都发不出消息。
   2026-11-11 因此中断过两次，每次都要用户手动卸载插件才能恢复。

2. **往对话插消息必须走 `safePushMessage()`。**
   `turn-stopping` 是 serial 事件，抛异常会直接中断本轮会话。

3. **消息的 `source.kind` 必须是 `plugin:<包名>`。**
   写成裸 `'plugin'` 会让请求以 `format v4 message requires a
   producer-owned source kind` 失败。

4. **读用户可编辑的 JSON 必须走 `parseJson()`，不要裸 `JSON.parse`。**
   Windows 上记事本 / PowerShell 保存的 JSON 常带 UTF-8 BOM，裸解析会抛错，
   而外层 catch 会把它吞成「无数据」—— 表现为记忆突然读不到，比报错更难查。

5. **不要用 `write` / `edit` / pwsh 直写 `memory.db`。**
   不是被拒绝，是**损坏数据库**。改记忆数据只能走 HTTP 路由或 GUI。

6. **改结构性代码前先备份 `index.js`。**
   `Copy-Item index.js index.js.pre-<改动名>`，改完 `node --check`，
   通过再删备份。**禁止用「按字符串索引切割拼接」改函数结构** ——
   要移动或重写函数就整体重写那个函数。

7. **改 schema 必须写迁移，并验证旧数据能读。**
   顺序：备份原库 → 写 `MIGRATIONS` 条目 → 升 `SCHEMA_VERSION` →
   逐表校验条数 → 抽样比对原文 → 验证 FTS 可检索。
   这些是用户的真实数据，没有明确要求不要为了"更优雅"重构它。
   **⚠️ 备份必须在改 `SCHEMA_VERSION` 之前做** —— HMR 会把新代码立刻装进
   正在运行的插件并自动跑迁移，等你想起备份时库已经变了（2026-11-14 实踩，
   那份「迁移前备份」实际是迁移后的）。见 [`维护手册.md`](docs/维护手册.md) §3.1。
   **删表必须在迁移条目里带 `drops: true`**，否则不会 VACUUM，体积一分不省。

8. **批量数据脚本不能按 `kind` 一刀切。**
   必须区分「迁移遗留的旧数据」与「用户刚手工新建的条目」。
   2026-11-13 实际误伤过用户 5 分钟前刚建的两条。
   更保守的做法：只处理 `source` 非空、或 `created` 早于迁移时刻的条目。

9. **`POLICY_TEMPLATE` 改了什么，`policy.md` 也要同步。**
   模板只在**首次安装**时生成 `policy.md`，之后它是运行时数据。
   改了代码里的通用规则却忘了模板，新装用户收不到。
   且模板里**不能夹带本机个人偏好** —— 那是所有新用户的开箱默认值。

10. **GitHub 提交由用户本人完成**，不要代做 `git add` / `commit` / `push`。
    需要留痕时把改动说清楚，由用户自己提交。

10b. **交接文件（`.dsh-handoff/`）由用户本人决定，不要主动生成或改写。**
     2026-11-14 我自作主张写了一份 handoff、还把旧的加顶注标记「已过时」，
     用户原话：「你上次主动生成交接文件吓了我一跳」。
     **规则**：只在用户明确要求时写；「会话快满了」是用户的判断，不是我的行动信号。
     收尾该给的是**对话里的一句结论**，不是替他建文件。

10c. **发现文件不见 / 状态与预期不符时，先问「是不是你删的」，别急着修。**
     2026-11-14：用户删了包内的 `README.md` 和 `STORAGE.md`（打算重写），
     我一看没了就断定是自己批量替换时弄丢的，**从回收站捞回来撤销了他的删除**，
     还写了一段「改名丢文件」的假教训记进文档。
     用户原话：「抱歉 那个不用记 是我删的 我本打算让你重写个新的」。
     **规则**：
     - 状态异常时，**先确认是否用户主动操作**，再判断是不是自己的错；
     - 不擅自「恢复」用户删的东西 —— 那是覆盖他的决定，比丢文件更糟；
     - 从回收站/备份捞文件之前，先问一句。
     - 判据：`git status` 能看出来的改动多半是用户做的；自己刚做过的操作才可能是自己弄丢的。

11. **记忆尽量不放系统盘。** D 盘优先，
    只有系统盘时落 `%USERPROFILE%\Documents\dsh-fatfishdream-memory`。

11b. **记忆根目录必须留在工作区之外 —— 这是安全边界，不是疏忽。**
     用户 2026-11-14 原话：「工作区会让 LLM 随意操作，其他目录不会，
     这是记忆完整保存的一个保障。不然我如果哪天指令不准确，导致你误删东西就不好了。」
     **已实测生效**：`workspace-write` 权限下写 `D:\dsh-fatfishdream-memory\*`
     返回 `[sandbox: file access denied]`，文件不会生成。

     **所以**：
     - 不要把记忆根目录「优化」进工作区（那是拆掉防线）
     - 不要因为「改 policy.md 要提权很麻烦」就建议搬目录
     - 需要改 `policy.md` 时，**申请一次更高权限**，用完即止 —— 这个摩擦是故意的
     - 同理别把 `memory.db` 放工作区里「方便读写」：硬约束 5 说它会损坏，
       沙箱是第二道防线

     这条与硬约束 5（不要直写 memory.db）是一对：
     **5 是「不许」，沙箱是「不能」** —— 两道防线互相兜底。

12. **插件改名后必须重新装载**，不是改文件就行：
    `dsh plugin --profile <名> remove <包名>` + `add <路径>`，两条都要跑。
    装载后 `entryId` 仍是 `include:dsh-memory`（来自 patchId），
    但 `moduleName` 已是新包名 —— 看到 entryId 没变是正常的。

12b. **改目录名必须同时改 profile `package.json` 里那条 `link:` 规格。**
     2026-11-14 改 `dsh-memory/` → `dsh-fatfishdream-memory/` 时只重做了 junction，
     profile 里仍写着 `link:D:/workspace/.../dsh-memory`。
     后来**装另一个插件**触发 profile 级安装，宿主按这条过期规格重新链接 →
     指向不存在的旧目录 → 模块解析失败 → **插件整行从树里消失**：
     没有注入、没有路由、也没有任何报错，只有「记忆系统突然失效」。
     判据：`(Get-Item $env:DSH_PROFILE_DIR\node_modules\<包名>).LinkTarget` 是否指向现目录。
     记法：**junction 会被人重建，规格才是真相。**

13. **改名称类需求先分类「插件身份 vs 数据目录」。**
    跟着产品名走的：包名、`source.kind`、显示名、README 标题。
    **刻意不改**的：HTTP 路径 `/api/dsh-memory/*`、slot id、日志前缀、
    effect 标签 —— 改了没收益，反而扩大出错面。

14. **GUI 文字有两个来源，要一起改**：`locale/*.json` 的 `meta.title`
    → 插件列表/详情页；`client.js` 里 slot 注册的 `label`
    → 侧边栏菜单/面板标题。只改一边会不一致。
    **不要硬编码真实值**：目录名用 `overview().dirName`，
    主题色用 `Theme.listTokens` 返回的真实 token。

15. **主题 token 不能假设都存在。** 用了当前主题没有的 token 会静默回落成
    继承色，出现「文字与背景同色、按钮看着是空的」。改动视觉后要看**实际渲染**。

16. **包内要分发的文档，不能放在被 `.gitignore` 或 `package.json files`
    排除的目录下** —— 会 git 不上传、npm 不打包，README 里的链接永久断链。
    改完跑 `verify-doc-links.mjs` 核对。

## 标记擦除器（`client.js`）

正文里的 `mem-log` 标记在界面上是**被 DOM 擦掉的**，不是渲染器隐藏的。
**看到标记 ≠ 记忆没写进去**（插件读事件原文，与显示层解耦）。

改动纪律、为什么不能 `display:none`、排查回传通道 —— 见
[`docs/维护手册.md`](docs/维护手册.md) §1。**改 `client.js` 前必读。**

## 标记通道：语法与纪律

正确形状（topic 与 summary 必填，keywords 可空，抽不出名词写 `无`）：

```
<!--mem-log topic=开发日志 summary=修好并发写库丢失 keywords=FTS｜bm25
正文写在这里，可以多行
-->
```

**参数顺序固定 `topic` → `summary` → `keywords`，与 topic 同一行。**
写成别的顺序时，后面的参数会被前一个整段吞掉（summary 丢失、keywords 被污染），
而且**不报错**。运行时有截断兜底，但正确写法只有一个。

**三条禁令**（每条都实际踩过，`node --check` 查不出来）：

| 禁止 | 会发生什么 |
|---|---|
| 写 `<!--/mem-log-->` 这类闭合标签 | 它不会被剥离，变成正文**永久写进库并每轮注入** |
| 开标签自带 `-->` 后再加闭合标签 | 同上 |
| 整条压成一行 `<!--mem-log topic=x 正文 -->` | **正则匹配不上，整条静默丢失，无任何报错** |

**收尾的 `-->` 必须单独起一行。** 正文里要提到标记字样就拆开写
（反引号包住也不行 —— 解析器看原文，不看渲染结果）。
**topic 必须是 13 类之一，且独占标记行**；topic 与正文挤同一行会被白名单拒收。

**改标记正则必须跑 `_dbpreview/test-marker-forms.mjs`**：正则须保持
**5 个捕获组** `[1]=kind [2]=topic [3]=summary [4]=keywords [5]=正文`。
kind 组丢失会导致所有带标记回复**静默丢弃**且 `node --check` 查不出。

**只认 `mem-log`**（`mem-fact` / `mem-note` / `mem-fix` 已移除）。
`policy.md` 末尾的同名小节只给人看、**不进注入**；改注入文案只改 `usageLines`。

更多细节（文本位置、三类事故经过、七种写法自检）见
[`docs/维护手册.md`](docs/维护手册.md) §2。

## 已知行为与坑

升级 DSH 后先看日志的 `health-check-verdict`（「通过：9 项全部就位」）。
**改动前后必查的 6 条速查：**

- **端口每次启动都变**：脚本和指引必须读 `$env:DSH_WEB_URL`，不要写死。
- **`client.js` 是浏览器模块**：改完必须**完整重启客户端**，禁用→启用插件不刷新浏览器代码。
- **改完 Host 代码（`index.js` / `db-store.mjs` / `db-schema.mjs`）一律「禁用→启用」插件**（2026-11-14 两次实测）：
  ① 改 `db-store.mjs` 时 HMR 只重装入口，存储模块在进程里是**旧副本** —— 日志有 `[apply-start]`、
  注入文案也变新了，但 `search()` 行为还是旧的；
  ② 改 `index.js` 的注入文案时，**HMR 根本没有触发**（日志无 `[apply-start]`，下一轮注入仍是旧句子）。
  **别指望 HMR、也别只看日志**：唯一判据是「用一个能区分的行为验一次」（注入文案就看下一轮注入、`search` 就看排序）。
- **热重载后 `session/event` 可能失效**（日志没有 `[user-message]`）：完整重启 DSH。
- **DSH 更新后插件消失**：先查 node_modules 里的 junction 指向，指向旧路径就 `rmdir` + `mklink /J` 再启用。
- **流水可为空**：用户清空 logs 后「记忆索引」只剩 rules 的 topic 计数，是正常状态。
- **本机 `git` / `npm` 都不在 PATH**（2026-11-14 实测，给用户写命令时踩过）：
  用户终端里 `git add` 会报「术语 'git' 不会被识别」。

  ```
  git ：D:\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\
        Microsoft\TeamFoundation\Team Explorer\Git\cmd\git.exe   ← VS 自带的
  npm ：**没有**。DSH 只带 node 与 pnpm，发布用 pnpm publish。
  pnpm：D:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs
  node：（同上目录）\node\bin\node.exe
  ```

  **所以给用户的命令必须写成 `& $git ...` / `& $node $pnpm ...`**，
  先定义变量再调用 —— 直接写裸露的 `git` / `npm` 一定会失败。
  发 npm 包用 `& $node $pnpm publish --access public --no-git-checks`。
- **验证「发布成功」只用一种方法：装一次。**（2026-11-14 实踩）
  我自己写脚本去 GET tarball 判断「有没有传上去」，脚本路径不对就得出
  「半发布」的结论，差点让用户去退 dist-tag —— 而包其实一直是好的。
  ```
  mkdir <临时目录>; cd <临时目录>
  & $node $pnpm add dsh-fatfishdream-memory@<版本>
  ```
  看到 `downloaded 1, added 1` 就是好的。**别用探测脚本绕圈子**，
  更不要基于探测结果让用户改 dist-tag / 重发版本。

其余坑（中文检索 / contentless FTS / junction 细节 / 依赖面 / 日志路径）见
[`docs/维护手册.md`](docs/维护手册.md) §3。

## 项目结构

```
FatFishDream/
  dsh-fatfishdream-memory/              插件本体（可独立安装）
    index.js               Host：注入、情绪分析、标记写入、HTTP 路由、健康自检
    client.js              Client：侧边栏入口 + 主面板 + 标记擦除器
    db-schema.mjs          schema 定义 + 迁移 + FTS 辅助
    db-store.mjs           存储适配层（读写检索维护）
    cordis.patch.yml       bundle patch（记忆根目录、各段预算）
    README.md / STORAGE.md 给使用者的说明
  docs/
    项目地图.md             结构索引：函数在哪、谁调谁、改哪影响什么 ← 动手前先读
    维护手册.md             擦除器/标记细节/已知坑/改项目流程 ← 改代码前按需读
    DECISIONS.md           关键决策与历史事故（含行号重算全过程）
    TESTING.md             怎么验证
    TODO.md                已知待办
  _archive/                已退役内容（旧迁移脚本、一次性脚本、旧备份）
  _dbbackup/               真实库备份（★ 回退点，**绝不能删**）
  _backup-local/           插件历史备份
```

## 记忆位置

插件自己的工作记忆在 `D:\dsh-fatfishdream-memory\memory.db`。
`policy.md` 是行为规则（每轮注入，不进数据库）；
`logs/YYYY-MM-DD.log` 是插件诊断日志（不是记忆）。

写记忆：回复正文里写 `mem-log` 标记。**不要用 `write` / `edit`（会损坏数据库）**。

## 怎么改这个项目

**动手前先读 [`docs/项目地图.md`](docs/项目地图.md)（结构索引），
细节流程读 [`docs/维护手册.md`](docs/维护手册.md) §4。**

最短流程（完整版见维护手册，别跳过备份与回归）：

1. 读地图定位函数，确认 §9 影响面
2. **备份 `index.js`**（硬约束 6）
3. 改代码 → `node --check`
4. 改 schema 时按硬约束 7 写迁移
5. 跑 `_dbpreview/` 回归（清单 `docs/TESTING.md`）
6. 重载插件或重启 DSH → 看日志
7. 改了 `index.js` 必须**按符号名**重算地图行号（准绳 `verify-map-content.mjs`）
8. 同步受影响文档（表见维护手册 §4）

**改注入比改文档更重要** —— 文档错了没人看，注入错了每轮都错。

## 文档与记忆的边界

- **每轮都要用、删了不会失传** → 记忆（`rules` / `profile`，用户在 GUI 维护）
- **偶尔要查、但要完整** → `docs/` 与 `AGENTS.md`（本文件启动时读一次）
- **只是这次的过程记录** → 流水（`logs` 表，不注入）

> ⚠️ **不要把长期有效的约定只放在 `rules` 里。** 用户在 GUI 随时会删
> （实测 84 → 7 条），删了就没有副本。**跨会话必须一直生效的行为要求，
> 至少要在 `AGENTS.md` 留一份。**
>
> 流程规矩（备份、行数核对、文档同步）属于文档，不属于记忆 —— 2026-11-13
> 曾把开发流程塞进记忆规则，占了近一半预算。完整讨论见
> [`docs/维护手册.md`](docs/维护手册.md) §5。

## 关于「下一个会话的我」

会话结束之后，今天的我不会记得这里的任何事。

**「记得」在这套系统里只有一种实现：写下来。** 没写下的就等于没发生过。

每次收尾前问：**下一个会话的我，会在什么情况下需要这条信息？**

- 每轮都要用 → 写记忆
- 只在改这部分代码时需要 → 写这份文件
- 只是这次的过程记录 → 写流水
