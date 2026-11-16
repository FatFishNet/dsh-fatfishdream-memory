# 怎么验证

改动后按这个清单走一遍。标 ⚠️ 的是**必须重启 DSH** 才能可靠验证的项。

## 0. 全量回归（41 个脚本进清单，一条命令跑完）

改完代码先跑这个，全绿再往下走。

> **流水为空时会跳过部分数据相关断言**（`selfcheck-paging` 整个脚本跳过、
> `selfcheck-full` 的 D 段、`selfcheck-ts-sort` 的真实库段）。这是预期状态 ——
> 用户随时可能清空 logs，测试不该依赖用户数据；分页 / cap 逻辑改由
> `selfcheck-cap.mjs` 自建 150 条种子覆盖，检索隔离由
> `selfcheck-isolation.mjs` 自建 3 个项目种子覆盖。

```powershell
# 本机 node 不在 PATH，用 DSH 自带的运行时；路径模板如下，按你的安装位置替换。
$node = "<DSH 安装目录>\dsh\node_modules\@deepseek-ai\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
$env:DSH_BASE = 'http://127.0.0.1:<当前端口>'   # 端口每重启都变，见 §6 注

# 跑全部（脚本清单只在 run-all.mjs 里维护一份，别在这儿手抄）
& $node _dbpreview\run-all.mjs

# 加 --verbose 看每个脚本的 exit
& $node _dbpreview\run-all.mjs --verbose

# 只跑指定的几个（调试用）
& $node _dbpreview\run-all.mjs --only verify-functions,selfcheck-scope-rename
```

### ⚠️ 受限权限下这一点必须知道（2026-11-15）

**症状**：`workspace-write` / `read-only` 权限下跑 `run-all.mjs`，
曾报出 **`TOTAL=32 FAIL=32`，每个都是 `exit=-1`** —— 而同一时刻用 pwsh
`foreach` 循环跑，基线是 **32/32 全绿**。（32 是当时的脚本数，现在是 37 ——
这条记的是**现象与判据**，不是当前清单。）

**根因**：整个脚本没有真的跑起来。受限沙箱**不允许程序开命名管道**，
而 `spawnSync(..., { encoding:'utf8' })` 默认 `stdio: 'pipe'` → 每个子进程
都拿回 `EPERM`、`status = null`。旧代码写的是 `const code = r.status ?? -1`，
于是「一个都没跑起来」被算成「32 个全部失败」。

**这是假红，不是插件坏了。** 判据很好记：

| 你看到 | 含义 |
|---|---|
| 全部脚本都是 `exit=-1` 且 `note` 空白 | 管道被拒，**环境问题**，不是代码问题 |
| 少数几个 `FAIL`，附带了脚本自己的输出 | 真的失败 |

**现在已修**：`run-all.mjs` 走 `_dbpreview/lib-spawn-capture.mjs` —— 先试管道，
被拒就退回**临时文件捕获**。受限模式下会自动降级，正常输出 `TOTAL=37 FAIL=0`。
输出里若出现 `（输出经临时文件捕获：… 属正常降级）`，说明走的正是这条降级路径。

**⚠️ 别再用 `r.status ?? -1` 把「没启动」归进失败计数。** 同理，
任何自写脚本捕获子进程输出都应 import 这个 helper，不要自己 `spawnSync` 带 `encoding`。

**另一种假绿，方向相反，一并记着**：`ERROR`（压根没跑起来）**不计入 `FAIL=`**，
但整体 exit 会 ≠0。这样变异测试才能把「runner 自己崩了」判成 ERROR 而不是
「测试抓到了 bug」。**看到 `FAIL=0` 但 exit≠0，就是有脚本没跑起来，本轮结果无效。**

> **⚠️ 2026-11-15 起不再手抄脚本清单。**
> 以前文档里有一份、pwsh 里有一份，加脚本时漏改过好几次
> （`selfcheck-collapse-guard` / `selfcheck-pure-utils` 都差点漏）。
> 现在唯一真相是 `run-all.mjs` 的 `SCRIPTS` 数组。
> **新增脚本只改那一处**，文档与命令自动跟上。

| 脚本 | 断言数 | 查什么 |
|---|---|---|
| `verify-functions` | 108 通过 + 124 个符号死代码扫描 | 两段：**A** 地图里每个「行号 → 函数名」是否对上（现算锚点，不平移旧行号）；**C 死代码检测** 自动扫描缩进 ≤2 格的函数声明，统计「除定义行、除注释行」外的引用次数，为 0 即死代码（2026-11-15 加，当场查出 10 个，其中 `reportBudget` 已造成预算告警静默失效） |
| `verify-map` | 110 处引用 | 地图 `L####` 是否越界/落空（**只判非空行，漂移不报**）。⚠️ 它**看不见 §3.1 的裸数字表**与 §5 的裸数字表，那两张由 `verify-symbol-lines` / `verify-map-forms` 守 |
| `verify-map-content` | 35（34 个锚点现算） | **地图准绳**：每处「`符号`（L####）」那一行必须含该符号；锚点由源码现算 |
| **`verify-map-forms`** | **122** | **2026-11-17 新增，补齐既有三脚本的盲区**。覆盖另外 **9 种**行号形态：A 表格列 / B 行首 / C 裸数字表 / D 正文内联 / F `符号` 声明 L#### / G 行首号在前 / **H §11 路由表** / I `符号(参数)` \| 裸数字（§5） / E 加粗行号。判据按符号类型分派：**普通符号** → 源码里找 `function`/`const` 定义行；**事件名**（含 `/`，如 `tools/result`）→ 找 `safeOn('事件名'` 注册行；**对象方法调用**（如 `ctx.effect`）→ 多文件全部命中里任一匹配即算对；**路由** → 找 `path: '<路径>'`。符号定位不到时**不判红**（只计入「无法核对」，避免描述性文字制造噪音），但**路由条数不一致判红**。⚠️ 还特意排除「字节预算表」（`\| `factsBytes` \| 8000 \|` 里的 8000 是字节不是行号，判据：超出源码行数上界或行内有 `bytes/预算/patch.yml`）。加它之前：§5 表 30 行全错（差 59~315）、§11 路由表 20 行全错（差 +762~+941）、3 处事件名错 700~900 行 |
| `chk-map-lines` | 110 处 | 逐条打印每处 `L####` 的真实内容，人工核对「该行是不是说的那个函数」 |
| `selfcheck-full` | 41 | 存储与注入总检（含 `schema v5`、`archive` 表与 FTS 一致性、**entries 已删 / confidence 已归一化 / search 不含 emotion**；流水为空时跳过中文检索段） |
| `selfcheck-cap` | 13 | cap 分页逻辑（**自建 150 条种子**，不依赖真实流水） |
| `selfcheck-isolation` | 18 | 检索按项目隔离（**自建 3 个项目种子**）；含 4 项「emotion 不在检索池」断言 |
| `selfcheck-paging` | 15 | 流水页分页（**需 `DSH_BASE`**；流水 <130 条时整脚本跳过）。**2026-11-15 修**：原来断言「最多的项目 total === 100」，等于要求库里必有项目超过 100 条 —— 数据掉下来就红。现在先查真实条数再断言 `total === min(真实, 100)`，与数据量解耦 |
| `selfcheck-marker-hardened` | 32（正则 + 源码级 + 按轮计数） | 标记正则行首锚点；**D 段断言解析失败必须记账**（`markerMatched`/`markerWritten`/`marker-unmatched`/`marker-dropped`/`empty-body`）；**E 段**区分「写错标记」与「只是提到标记」；**F 段**写入失败提醒；**G 段** `writeFailStreak` 按轮计数（不是按条） |
| `selfcheck-dom-strip` | 22 | 界面擦除正则（含「别吃掉说明文字」） |
| `selfcheck-scrubber-loop` | **23** | **擦除器调度（第五代：静止窗口 + 第六代：完整标记同步快擦）**：连续变化只在安静后扫一次、一直不安静时有兜底上限、无变化不扫；**段 5 守第六代**（`hasCompleteMarker` 判据、`fastStrip` 只擦完整标记、接线在 `addedNodes`、未闭合仍走延迟、`characterData` 不抢跑、异常退回 `schedule`），共 10 条 |
| `selfcheck-ts-sort` | 9（+真实库段） | 流水排序（锁定「三种按时间排的写法全错」；真实库段在空库时跳过） |
| `selfcheck-migrate-order` | 9 | 迁移时全局按时间排序 |
| `selfcheck-migrate-db` | 11 | 迁移时用 VACUUM INTO 复制主库（含「文本复制会损坏库」反证） |
| `selfcheck-copytree-empty` | 14 | 空目录迁移不产生空壳 |
| `selfcheck-topic-clean` | 37 | topic 不被 `-->` 污染（含白名单） |
| `selfcheck-injection-wording` | 25 | 注入文案无自相矛盾 |
| `verify-injection-consistency` | 69 | 注入里「写禁读通」表述一致（含 `archive?scope=` 入口、**情绪不在检索里**两句必须存在）；2026-11-16 起守「每轮必记」且**反向断言不得出现任何判据措辞**；**段 10 守 `POLICY_TEMPLATE` 不夹带本机个人偏好**（模板不含「大肥鱼」、不含任何默认收尾语行 —— 用户私人收尾语曾被同步进模板） |
| `selfcheck-emotion-guard` | 19 | 情绪录入的形态闸门（不误吞提示词） |
| `selfcheck-emotion-lexicon` | 27 | **情绪词典复合词闸门**：麻烦≠烦 / 积累≠累 / 无语义≠无语，且不误伤「好烦」「累死了」 |
| **`selfcheck-emotion-limiter`** | **10** | **后置限定词降权**（「成功了一半」不得判 strong）。不复刻逻辑 —— 从源码抽出 `analyzeEmotion` 函数体 + 注入闭包依赖，用 `new Function` **直接执行真实代码** |
| `selfcheck-entry-by-id` | 13 | **按 id 取单条全文**（`/entry?id=&table=`）：正文一致、缺参数 400、未知表 400、不存在 404；旧 `/entry/<id>` 仍 401 |
| **`selfcheck-log-alive`** | **31** | **流水通道存活检查**（需 `DSH_BASE`）。**判据在 2026-11-16 22:40 第三次也是最后一次改写，读之前先看下面这段**。<br>① **进程存活度**：诊断日志最新一行的时戳距今 < 15 分钟（心跳 5 分钟一行）+ 日志里必须能看到 `[heartbeat]`（防止「日志有行但不是心跳」蒙混）；② 源码级断言**标记通道**整条链路（`MEM_MARKER_RE` → `appendLog` → `mem-写流水` diag）；③ **段 5 守 HTTP 写入通道**（路由注册、复用三套 `sanitize*`、置位 `wroteLog`、拒绝非 POST、`cwd` 不存在时拒绝）。`KNOWN_BAD_IDS` 精确豁免历史空 topic 条目。<br>**⚠️「上一轮写没写流水」这条判据已被彻底删除，不要加回来。** 它前后写过三版（距今 N 分钟 / 最近一条 user 之后有无流水 / 已封口区间有无流水），每版都在测「模型有没有在场」，而**回归测试不该测模型行为**——结果与代码无关，用户歇几小时回来它必然红。用户 2026-11-16 22:26 原话：「我中间歇了几个小时，真的需要让你更改断言吗」。<br>**现在的分工是三个维度各读一处，互不顶替**：进程活着 → 本段；记忆在写入 → `writeFailStreak`（运行时 turn-stopping，**连续 2 轮没写就提醒**——2026-11-17 从 4 降到 2，因为实测漏记规模常是 3 轮，阈值 4 在最常见的规模上失效）；代码没坏 → 本段之外的源码/行为断言。 |
| **`selfcheck-archive`** | **49（存储 36 + HTTP 13）** | **v4 原文归档**：存储层（写入/过滤/FTS 中文/分页/统计口径/不污染 `/search`）+ HTTP（`/archive` 200 形状、`role=x` 400、limit）。加 `--no-http` 可只跑存储层 |
| **`selfcheck-breakdown`** | **24（存储 18 + HTTP 6）** | **v5 库体积分层**：`dbstat` 不列空闲页所以 `core+archive+system+free` 必须**精确等于** `page_count×page_size`；索引归属（`idx_archive_*`→archive、`idx_logs_*`→core）；缓存与失效；**反向断言 `stats()` 里没有 dbstat**。加 `--no-http` 只跑存储层 |
| **`selfcheck-scope-rename`** | **84** | **工作区改名 + 迁前/迁后数据量比对**（自建临时库）。①`snapshotScope` 口径（all/active/minId/maxId、archive 无 status 列）②正常改名三表九项校验全过 ③异常路径（目标占用/`__global__`/同名/空名/空工作区）④**事务回滚**：用触发器模拟第二张表失败，断言 rules 仍在旧 scope（没事务的话它会被改走）⑤`countScope` 的 `activeOnly` ⑥**`listScopesWithData` 必须包含「全是停用条目」的工作区**（`byScope` 会漏的那种），且默认排除 `__global__` ⑦**合并**：目标已有数据时默认拒绝并提示可勾选合并，`allowMerge:true` 后条数 = 源+目标、行集合取并集（独立临时库，20 项）⑧源码级：`resolveProjectKey` 返回 `scope`、写入用 scope 不用 key、死代码已删 |
| `selfcheck-dir-name` | 11 | 目录名可移植（四种安装场景）。**2026-11-16 修恒真断言**：改为按 `/state` 的真实 `rootReason` 判断走了哪一级（`configured` / `pointer` / `discovered-on-X` / `first-install-X`），未知值判失败 |
| **`selfcheck-search-tier`** | **12** | **检索按表分层**（自建种子）：段序固定 profile→rules→logs、小 limit 时三表各露一条、组内仍按 bm25、`lastLogTs()` 按 id 取最新；另 3 条源码级断言守着「整理提醒不再只看 `lastConsolidate`」 |
| `verify-no-self-trigger` | — | 注入文本不会被自己匹配 |
| `verify-final` | — | 数据总览 |
| `verify-doc-links` | 51 处 | 文档路径引用无断链（防开源后失效） |
| `verify-v3-schema` | 55 | **三层记忆 v3 + 原文归档 v4 + v5 收尾**：现有库迁移 / 空库全建 / 存储层读写检索 / `archive` 写入与回溯（用 `_dbbackup` 副本，不碰真实库） |
| `test-marker-forms` | 30 | 标记七种写法自检（**改标记正则必须跑**：须保持 5 个捕获组，kind 组丢失会让所有带标记回复静默丢弃） |
| **`selfcheck-policy-sync`** | **74** | **policy.md 一次性覆盖的真实行为回归**（2026-11-16 新增）。**唯一真正 import 并执行 `createStore.ensureLayout` 的脚本** —— 之前所有测试只查「源码里有没有那几行字」，从不执行覆盖逻辑，于是漏掉了「升级时收尾语随覆盖丢失」这个真 bug。覆盖 10 个场景：①老用户升级 ②二次启动不覆盖 ③state.json 丢失 ④无收尾语不写空行 ⑤全新安装不产生冗余备份 ⑥覆盖后格式合法 ⑦**替换不吞后续标题** ⑧**折行时不留孤儿续行** ⑨**删除分支**（含「必须复用 blockRe、不得内联正则」的源码级断言）⑩**异常输入**（state 损坏 / 空文件 / 重复收尾语均不崩）。场景 7/8/9 都从源码提取真实 `blockRe` 执行，不是抄一份逻辑 |
| **`selfcheck-message-key`** | **26** | **消息去重键的真实行为回归**（2026-11-16 新增）。守的是「**不同会话的同一 `turn:step` 不能撞键**」—— 撞了那条既不进 `archive`（原文永久丢失）也不解析标记，且无任何日志。修复原先**内联在监听器里，无法黑盒验证**（需要伪造两个会话消费相同 turn:step；单会话测试里 `sid` 恒定，加不加前缀行为一样 → 那种测试会绿却证明不了任何事）。现在逻辑抽成顶层纯函数 `makeMessageKey(session, payload)`，本脚本从源码抽取函数体执行，用两个不同 session 调两次断言键不等。另覆盖：`id`/`turn`/`step` 为 `0` 时**不得**被当成缺失（`??` vs `\|\|`）、缺失字段降级为 `?` 不抛错、返回值恒为 string |
| **`verify-symbol-lines`** | **72** | **§3.1 裸数字行号表的核对**（2026-11-16 新增）。`verify-map` 只认带 `L` 前缀的引用（`L1234`），而 §3.1 那张表写的是**裸数字**（`\| 45 \| \`name\` \|`）→ 它**完全不受任何校验**。实测：表里 15 行**全部指向错位置**（`name` 表说 45、实际 83；`POLICY_TEMPLATE` 说 610、实际 790），而 `verify-map` 一直报「111 处引用，0 处落空」。本脚本按符号名**现算**真实行号（不写死期望值），逐条断言一致，并额外断言「至少核对 10 个符号」防止表格被改坏后静默零覆盖 |

> **哪些不需要 DSH**（2026-11-15 实测：清空 `DSH_BASE` / `DSH_WEB_URL` 后全跑，
> 只有 3 个失败）：**硬依赖只有 `selfcheck-e2e-memory` / `selfcheck-entry-by-id` /
> `selfcheck-paging` 这 3 个**。另外 4 个会读环境变量但缺省时自动跳过 HTTP 段、以 0 退出：
> `selfcheck-archive`（存储层 36 项照跑，加 `--no-http` 效果相同）、
> `selfcheck-breakdown`（存储层 18 项）、`verify-injection-consistency`（纯源码文本断言）、
> `selfcheck-log-alive`（2026-11-16 实测：打印「跳过：没有 DSH_BASE」并 exit 0）。
> 其余全是纯静态或自建临时库，插件没跑也能验证。
> ⚠️ `selfcheck-log-alive` 跳过后**等于没查流水** —— 它守的就是「通道还活着」，
> 所以流水相关的排查必须在 `DSH_BASE` 有值的前提下跑，别把跳过当通过。
>
> **改注入文案后**额外跑 `show-injection.mjs`：它打印分段字节账 + token 估算
> （2026-11-16 实测：5470 字节 / 约 1209 token；改文案前后各跑一次对比）。

## 0.01 完整自检（`audit-full`）—— 阶段性的全面体检

**平时不用。** 日常改代码走 §0 的全量回归就够；这个用于「准备动大手术」
或「很久没体检」时。**由人决定时机，脚本不自己触发。**

```powershell
# 全跑（含 D 段回归，最慢）
& $node _dbpreview\audit-full.mjs

# 只打结论（给模型读，省 token）
& $node _dbpreview\audit-full.mjs --brief

# 跳过 D 段（秒级）
& $node _dbpreview\audit-full.mjs --no-deep
```

### 它和第 7 轮「9 个子代理逐行读 9736 行」的关系

**不能替代逐行审阅。** 说清楚差别：

| | 第 7 轮逐行审查 | `audit-full` |
|---|---|---|
| 成本 | **O(全部行数)** ≈ 13 万 token，每次重付 | **O(规则数)**，秒级 |
| 能发现 | 形态问题 **+ 语义问题**（方向写反、加成顺序错） | 只有**形态**问题 |
| 语义问题 | ✅ | ❌ 但会**指出确切位置**（C 段） |

它的真正价值：**把「读全部代码」降级成「读可疑的那几处」。**
2026-11-16 实测，`--brief` 输出 **148 字节（≈42 token）**，
而第 7 轮读四个文件是 **458 KB（≈13 万 token）**。

### 四段

| 段 | 查什么 |
|---|---|
| **A** | 4 文件 `node --check`、包名一致、`source.kind` 带包名、**没注册工具**（硬约束 1/3） |
| **B** | 9 条静态规则扫描；先跑规则自检，再与基线比对 |
| **C** | 语义类待看 —— 只打印位置与判据，**不判定、不判红** |
| **D** | 调 `run-all` 全量回归 + `meta-mutation-test --dry-run`（`--no-deep` 跳过） |

### B 段的三种状态

| 状态 | 含义 | 判红 |
|---|---|---|
| 🔴 新增 | 规则命中，基线里没有 | ✅ 是 |
| 🟡 已知 | 基线里登记过 | ❌ 否 |
| 🟢 已修复 | 基线里有、这次没命中 | ❌ 否（提示可以删条目） |

**只有新增命中判红。** 否则 29 条已知未修每次都红，跑两次就没人看了 ——
那和「全绿」是同一种失效。

### ⚠️ 规则必须自带失败测试（最重要的设计）

本项目反复踩过同一类坑：`reportBudget` 静默失效两天、变异测试把 `SKIP`
当通过、`check(name, true)` 恒真断言。**静态规则集是同一风险的高发区**：
正则写歪 → 什么都抓不到 → 输出「新增 0」→ 看起来一切正常。

所以 `audit-rules.mjs` 里**每条规则必须带两个样本**：

| 字段 | 要求 | 抓不到/误抓的后果 |
|---|---|---|
| `mustCatch` | 一条已知有问题的代码，scan **必须**抓到 | 规则失效（静默漏报） |
| `mustMiss` | 一条已知没问题的代码，scan **必须**放过 | 规则过宽（假警报） |

`audit-full` 每次都会先跑这一步。**任何一条规则失效即判红**，
绝不允许「规则坏了但输出看起来正常」。

### 维护基线

```powershell
# 把当前命中生成成基线条目（全部标 TODO），然后逐条填 note
& $node _dbpreview\audit-full.mjs --adopt
```

`audit-baseline.mjs` 里每条的 `note` 必须能回答「为什么不修」或「什么时候修」，
分三类标注：

- `【待修】` 确认是缺陷，排进某批
- `【设计】` 刻意如此，写明为什么
- `【误报】` 规则形态匹配但语义安全 → **应改进规则**，别长期靠基线压着

> ⚠️ **不要为了「跑绿」批量往基线里塞条目。** 答不出「为什么不修」的，
> 说明该去修代码。
>
> ⚠️ 基线用**行内容 + 唯一上下文**的指纹，不用行号 —— 行号会漂移，
> 用行号的基线第二天就全废且是静默失效。2026-11-16 实测踩到：
> 9 个写路由的 `await readBody(req)` 行内容完全相同，只按行内容算指纹
> 会 9 处共用同一个 hash → 修好一处另外 8 处一起显示「已修复」。
> **这和「变异锚点必须唯一」是同一个病。**

### 当前基线（2026-11-16）

29 条，全部来自第 7 轮审查：待修 14 / 设计 13 / 误报 2。
9 条语义待看（C 段）。**`audit-full` 全绿 ≠ 代码没问题** ——
它只证明「已知的形态类问题没有新增」。

## 0.05 测试能力自检：这些测试真的管用吗？
**只看断言数量没有意义。** 这个项目曾经有 112 条断言全绿，而
`reportBudget` 从 1.0.0 起就没有调用点（功能静默失效两天没人发现）。
断言测的是「符号还在文件里」，不是「行为对不对」。

所以有两个 meta 工具，定期跑一次。

### `meta-mutation-test.mjs` —— 改坏代码，看测试红不红

**⚠️ 这是唯一会修改生产文件的工具。跑之前先读下面「三项保护」。**

```powershell
# 先看一眼会改哪里（不动文件，安全）
& $node _dbpreview\meta-mutation-test.mjs --dry-run

# 真的跑（会临时改坏生产文件）
& $node _dbpreview\meta-mutation-test.mjs
```

做法：对每个变异点，备份 → 注入一处语义改变 → 跑全量回归 → 恢复。

| 结果 | 含义 |
|---|---|
**KILLED** | 有测试红了 → 这个变异被抓住，测试有效 |
**SURVIVED** | 全绿 → **测试盲区**，改坏了没人管 |
**ERROR** | runner 自己崩了 → **本次结果无效**，先修工具 |
**SKIP** | 变异点没匹配上源码（源码变了）→ 更新 `MUTATIONS` |

⚠️ **必须区分 KILLED 和 ERROR。** 2026-11-15 首版用
`execSync('node ...')`，而本机 node **不在 PATH** —— 每个变异都执行失败，
却全被判成 KILLED，报出「100% 杀伤率」。那是假绿：结论完美，证据是空的。
现在用 `process.execPath`，且解析不出 `TOTAL=/FAIL=` 就记 ERROR。

#### 三项中断保护（2026-11-15 补）

这个工具靠 `try/finally` 恢复，但**进程被 kill 时 `finally` 不一定执行**。
所以加了三项：

| 保护 | 行为 |
|---|---|
① **启动查 `.mutbak` 残留** | 有残留就**拒绝运行**并提示手动恢复 —— 残留说明生产文件可能还是被改坏的状态，此时跑会把坏文件当成「原文」备份，把问题固化 |
② **恢复后校验 sha256** | 恢复完重新读文件、与原文 hash 比对，不一致就**抛错并打印 `git checkout -- <文件>`** 。（此前注释声称「验证 hash 一致」，代码里却没有校验 —— 一句没兑现的承诺） |
③ **`--dry-run`** | 只列出每个变异会改哪个文件、哪个片段、是否匹配，**不改任何文件**；**全匹配 exit 0，有任何一个未匹配 exit 1**（2026-11-16 改：原来无条件 exit 0，于是锚点失配在自动检查里完全看不见） |

**仍然要求：`git status` 干净时才真跑。** 当前工作区若有大量未提交改动，
中断后改坏的内容会和未提交改动混在一起分不清（⑩ §三.⑦ 的教训）。
`--dry-run` 可以随时跑，不受这条限制。

**当前基线（2026-11-16）：40 个变异，KILLED 40 / SURVIVED 0 / SKIP 0 / ERROR 0**，
杀伤率 100%；`--dry-run` 显示 **40/40 变异点已匹配**。

> 2026-11-16 新增第 39/40 条 `message-key-no-session` 与 `message-key-uses-or`：
> 守 `selfcheck-message-key`。前者把去重键里的 `${sid}:` 去掉（跨会话撞键 → 原文永久丢失），
> 后者把 `id === undefined || id === null` 改成 `id ? … : …`（`id=0` 被当成缺失）。
> **这两条是「修复本身也要有防线」的直接落地** —— 去重键修复此前只做了源码事实核对，
> 没有任何断言能区分「有 sid」与「没 sid」的行为差异。
> ⚠️ 锚点必须带 `makeMessageKey` 独有的 `return \`${sid}:` 前缀：只写
> `\`${turn ?? '?'}:${step ?? '?'}\`` 在 index.js 里形态不唯一，变异会静默打错地方
> （见 AGENTS.md「变异锚点必须唯一」）。

> 2026-11-16 新增第 34 条 `policy-template-private-closing`：往 `POLICY_TEMPLATE`
> 里塞回一条默认收尾语，守 `verify-injection-consistency` 段 10 的两条断言
> （模板不含「大肥鱼」/ 模板不含任何默认收尾语行）。
>
> 2026-11-16 新增第 35 条 `policy-sync-heartbeat-lost`：覆盖 `policy.md` 前不再
> 提取收尾语，守 `selfcheck-policy-sync`（升级后收尾语随覆盖丢失）。
>
> 2026-11-16 新增第 36/37 条，守**同一条正则的两次错误版本**（这条线反复过，
> 两个错版本都不能退回去）：
> - `heartbeat-regex-eats-heading`：退回「吞标题」版 —— 会吞掉收尾语后面所有
>   不以 `-` 开头的行（空行 + `##` 标题）。实锤事故：用户 policy.md 一次 GUI
>   保存就从 13850 → 13791 字节、232 → 230 行，**零报错**。
> - `heartbeat-regex-orphan-continuation`：退回「不跟踪续行」版 —— 用户手写
>   折行时替换后留下**孤立的缩进续行**（修前一个时矫枉过正引入的回归）。
>
> 正确形态是只跟踪「缩进续行」：`(?:\n[ \t]+[^\n]*)*\n?`。场景 7 守前者、
> 场景 8 守后者。
>
> 2026-11-16 新增第 38 条 `heartbeat-delete-inlines-regex`：把**删除分支**的
> `current.replace(blockRe, '')` 改成内联另一个正则。这条守的是**测试自身的盲区**，
> 不是产品 bug —— 实测发现：行为测试测的是「blockRe 变量里的正则对不对」，
> 若调用处改用内联正则，blockRe 没变 → 正则层断言全绿，而真正执行的代码已坏
> （该变异在补充源码级断言前是 SURVIVED）。修法是场景 9 里补一条
> 「删除分支必须复用 blockRe」的源码级断言。
>
> 全量真跑已验（38/38 KILLED），生产文件 sha256 与跑前备份逐字节一致。

> ⚠️ **`--dry-run` 必须 N/N 全匹配，有任何一个 ⚠️ 就等于那条防线是空的。**
> 锚点失配时真跑是 **SKIP**，而 SKIP 不计入 KILLED —— 表面上「没红」，
> 实际是那个变异根本没注入进去。2026-11-16 实际踩过：`log-alive-write-broken`
> 的锚点还写着 `appendLog(projectKey, cleaned, ...)`，而「空正文降级写入」
> 那次改动已把实参改名为 `finalText` → 该变异静默失配，流水写入链路无人守。
> **判据**：改过 `index.js` 之后先跑 `--dry-run`，数字必须与变异总数一致。

首轮跑出过一个真盲区：`scrubber-guard` 存活。原因是断言写成
`/isSafeToCollapse\s*\(\s*el\s*\)/`，而函数定义 `function isSafeToCollapse(el)`
**也匹配** —— 把 if 条件里的调用删掉（改成 `true`），断言照样通过。
已改成「打标记语句前 400 字符内必须出现该调用」。

### `meta-audit-coverage.mjs` —— 哪些函数从没被测试执行过

```powershell
& $node _dbpreview\meta-audit-coverage.mjs
```

区分三种状态（这个区分很重要）：

| 状态 | 含义 |
|---|---|
`CALLED` | 测试代码里真的调用了 |
`NAMED` | **只在按名字定位的断言里出现 → 等于没测** |
`NONE` | 完全没出现 |

**当前基线（2026-11-16）：154 个函数，CALLED 58（38%）/ NAMED 48（31%）/ NONE 48（31%）。**

`NAMED` 这一列最有价值：它暴露的是「看起来有测试、实际没有」的假覆盖。

### 补测试的优先级

零覆盖里**优先补纯函数**（无 I/O、无宿主依赖、出错代价高）：

| 函数 | 出错后果 |
|---|---|
`parseJson` | BOM 让裸 `JSON.parse` 抛错，外层 catch 吞成「无数据」→ 记忆突然读不到 |
`isInside` | 迁移/路径判断错 → 数据搬到子目录里 |
`slugify` / `isSafeSlug` | 项目名映射错 / 路径穿越 |
`serialize` | 并发写库互相覆盖（实测丢到只剩 1 条） |

`selfcheck-pure-utils.mjs` 已覆盖前四个（39 项断言），做法是
**从源码抽取函数体执行**（不是复制一份逻辑），源码改了测试跟着变。

---
## 0.1 语法检查

```bash
node --check dsh-fatfishdream-memory/index.js
node --check dsh-fatfishdream-memory/client.js
node --check dsh-fatfishdream-memory/db-store.mjs
node --check dsh-fatfishdream-memory/db-schema.mjs
```

> **本机 `node` 不在 PATH**：用 `$env:DSH_NODE_EXECUTABLE`（Electron 主程序）+ 
> `$env:ELECTRON_RUN_AS_NODE=1` 当 node 用：
>
> ```powershell
> $env:ELECTRON_RUN_AS_NODE = 1
> & $env:DSH_NODE_EXECUTABLE --check dsh-fatfishdream-memory\index.js
> ```
>
> ⚠️ **临时脚本用 `write` 工具落盘，不要用 pwsh 的 `Set-Content`**：
> 2026-11-14 实测两次「写完 `Test-Path=True`，node 却报 `MODULE_NOT_FOUND`」，
> 会让人误判成脚本语法错。详见 [`维护手册.md`](维护手册.md) §3。

## 0.5 确认跑的是最新代码

改完代码后，最容易出的错是「文件改了，但运行时还是旧模块」。
三层检查，从弱到强：

### ① 安装是否指向当前源码

```powershell
# 用环境变量取 profile 目录，别写死用户名
$link = "$env:DSH_PROFILE_DIR\node_modules\dsh-fatfishdream-memory"
(Get-Item -LiteralPath $link -Force).LinkTarget
```

应指向**你自己 clone 下来的** `dsh-fatfishdream-memory/` 目录。
如果不是，见 [`维护手册.md`](维护手册.md) 与 `AGENTS.md` 硬约束 12 / 12b：
**junction 会被人重建，profile `package.json` 里的 `link:` 规格才是真相。**
如果是拷贝而不是 Junction，改源码不会影响已安装的副本。

### ② 内容是否一致

```powershell
(Get-FileHash '.\dsh-fatfishdream-memory\index.js' -Algorithm SHA256).Hash
(Get-FileHash "$env:DSH_PROFILE_DIR\node_modules\dsh-fatfishdream-memory\index.js" -Algorithm SHA256).Hash
```

两个哈希必须相同。Junction 安装下这里一定相同，但**不能证明运行时已重载** ——
ESM 模块有进程级缓存，文件变了不代表内存里的模块变了。

### ③ 运行时是否真的重载了（决定性）

对比「源码最后改动时间」和「最后一次 `apply-start` 时间」：

```powershell
$srcTime = (Get-Item 'D:\workspace\dsh-fatfishdream-memory\dsh-fatfishdream-memory\index.js').LastWriteTime
$log = Get-ChildItem 'D:\dsh-fatfishdream-memory\logs\*.log' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$lastApply = (Get-Content $log.FullName -Encoding UTF8 | Select-String 'apply-start' | Select-Object -Last 1).Line
$applyUtc = [datetime]::ParseExact($lastApply.Substring(0,24), "yyyy-MM-ddTHH:mm:ss.fffZ", $null, [System.Globalization.DateTimeStyles]::AdjustToUniversal)
"源码改动: $($srcTime.ToString('HH:mm:ss'))"
"最后加载: $($applyUtc.ToLocalTime().ToString('HH:mm:ss'))"
"已重载: $($applyUtc.ToLocalTime() -ge $srcTime)"
```

`已重载: True` 才说明运行的是最新代码。

**注意**：日志里的时间戳是 UTC，换算本地时间要 +8（东八区）。

**更直接的验证**：找一个只在最新版里存在的特征，比如日志里的阶段标记。
新增功能时留意它产生了哪条 `[xxx]` 日志，然后确认那条日志出现。

## 1. 插件加载

重新加载插件（禁用→启用）或重启 DSH，然后看日志：

```
D:\dsh-fatfishdream-memory\logs\YYYY-MM-DD.log
```

必须看到这几行：

```
[apply-start]      {"rawRoot":"D:\\dsh-fatfishdream-memory"}
[root-resolved]    {"root":"D:\\dsh-fatfishdream-memory","reason":"configured","logDir":"..."}
[db-ready]         {"path":"D:\\dsh-fatfishdream-memory\\memory.db"}   ← 库不可用时是 [db-FAILED]
[tools-none]       不注册工具（记忆靠注入 + 现有工具）
[apply-complete]   {"tools":"none"}
[command-registered]
[route-registered]  ×14
[health-check-verdict]  通过：9 项全部就位
```

**没有 `[tools-none]`** → 说明又在注册工具了，立刻停下检查
（见 `DECISIONS.md` 坑 1）。

## 2. 注入生效

看当前会话的 system prompt 里有没有「记忆（dsh-memory）」这一段。

**更严格的验证**：用 GUI 在「规则与偏好」页新建一条本项目规则（暗号），
下一轮问模型能否复述。能复述 = 注入链路通。

> **唯一验证路径**：GUI 新建 → `rules` 表 → 下一轮注入。
> 模型侧已经不能写规则了（`mem-note` 标记 2026-11-13 移除），
> 想验证写入通道就写 `mem-log` 流水，查 `logs` 表有没有落库。

## 3. 情绪捕获 ⚠️

**必须由真人用户发消息**，assistant 自己的输出不触发 `user/message`。

让用户发一句带情绪的话，然后检查：

```
日志：    [user-message] {"sourceKind":"user"}
          [emotion-analysis] {"text":"...","hits":["夸赞:1.00"],"weak":false}
emotion： SELECT * FROM emotion ORDER BY id DESC LIMIT 1;
          → cls='夸赞', quote='你好可爱', evidence='可爱', confidence='高置信', score=1.0
```

常用测试句：

| 输入 | 期望类别 |
|---|---|
| 你好可爱 | 夸赞 |
| 谢谢你 | 友善 |
| 太好了 | 喜悦 |
| 你怎么又忘了 | 吐槽 |
| 我不觉得这有什么好的 | 不触发 |

**不生效时**：先看日志有没有 `[user-message]`。
没有 → 监听失效，完整重启 DSH；有但 `hits:[]` → 词典问题。

## 4. ~~轮次提醒~~ 已取消（2026-11-13）

**这个功能已经砍掉了，不再是测试项。** 原来「本轮有写操作且没写记忆时，
下一轮开头插一句问用户要不要记」—— 两天触发 **217 次**，太吵。

**现在只写日志，不打扰对话**：

```
[turn-未记流水] {"writes":3,"note":"有写操作但未写记忆（仅记录，不打扰）"}
```

**新的验证点**：注入里应该有「什么时候记」清单（模型靠它自己判断）。
如果发现模型该记却不记，看这条日志——有它说明确实是漏了，不是功能坏了。

## 5. `/memory` 命令

```
/memory status        库状态：四张表条数、按项目分布、健康自检
/memory projects      同 status（两者共用同一分支）
/memory search <词>   跨四张表检索（FTS，中文按字匹配）
/memory show <id>     看某条全文（会显示它在哪张表）
/memory emotions      情绪记录列表（最近 30）
/memory review <id> retract|delete|restore   标记「说过但当时不算」/「记错了」/恢复
/memory append <内容> 手动追加流水
/memory consolidate   触发一次整理
```

> **`/memory status` 曾是必崩命令**（2026-11-13 修）：它读 `stats().byKind` 并直接 `.map()`，
> 而该字段不存在 —— 每次执行都抛 `TypeError: Cannot read properties of undefined`。
> 现在读 `byTable`（对象）。测这条命令时**不要只看有没有输出**，要确认「按表：」那行
> 四种表都列出来了。

`/memory search` 用中文关键词测（如「沙箱」「工具」「BOM」），应该能命中。

**特别注意测中文 2 字词**（「沙箱」）：这是 FTS5 分词最容易失效的地方，
详见 `db-schema.mjs` 的 `segmentCjk`。

## 6. HTTP 路由

```powershell
Invoke-WebRequest 'http://127.0.0.1:<port>/api/dsh-memory/state' | Select -Expand Content
```

应返回 `ok: true`、`root`、`health`、`db`、`drives`、`onSystemDrive`、`heartbeat`。

**`db` 里必须有 `byTable`**（对象：`{profile, rules, emotion, logs}`，四项之和等于 `total`）
和 `byScope`（数组）。2026-11-13 之前这里读错字段名（`byKind`），
`JSON.stringify` 把 `undefined` 吞掉，**字段静默消失且不报错** ——
所以这一项要显式核对，不能只看 `ok: true`：

```powershell
$j = (Invoke-WebRequest 'http://127.0.0.1:<port>/api/dsh-memory/state' -UseBasicParsing).Content | ConvertFrom-Json
$j.db.byTable            # 必须有值
$j.db.byTable.Profile    # 拿不到就说明字段又丢了
($j.db.byTable.PSObject.Properties.Value | Measure-Object -Sum).Sum -eq $j.db.total   # 应 True
```

**条目接口**（GUI 与模型共用，共 18 条路由）：

```
GET  /api/dsh-memory/entries?table=rules&scope=__global__&limit=20
GET  /api/dsh-memory/entry?id=3&table=rules   按 id 取单条全文（table 必填）
GET  /api/dsh-memory/search?q=沙箱       FTS 检索（中文按字；只查四张业务表）
GET  /api/dsh-memory/archive?scope=<项目>&q=<词>   原文层回溯（role/from/to/limit/offset）
GET  /api/dsh-memory/persona-check       人称规范扫描
GET  /api/dsh-memory/heartbeat           读收尾语
POST /api/dsh-memory/entry/create        {"text":"...","scope":"__global__","kind":"pref"}
POST /api/dsh-memory/entry/update        {"id":1,"table":"rules","text":"..."}
POST /api/dsh-memory/entry/status        {"id":1,"table":"rules","status":"stale"}
POST /api/dsh-memory/entry/delete        {"id":1,"table":"rules"}
POST /api/dsh-memory/entry/upgrade-global {"id":1}
POST /api/dsh-memory/heartbeat           {"text":"..."}
GET  /api/dsh-memory/client-report?state=..&stripped=..   客户端擦除器回传（见 §7.5）
```

> 除 `heartbeat` 外路由**不校验 `req.method`**（`kind: 'exact'` 注册），
> 所以方法写错也能通 —— 接口出错时先查参数名，再查方法。

**路径防护**（应当被拒绝）：

```powershell
# 拒绝：目标目录非空
POST /api/dsh-memory/project/move  {"project":"FatFishDream","dir":"C:\\Windows"}

# 拒绝：迁移到当前目录
POST /api/dsh-memory/root/move     {"root":"D:\\dsh-fatfishdream-memory"}
```

## 7. GUI 面板

**入口在左侧栏**（`sidebar.panellist` 的「大肥鱼的梦」图标），不是设置页。
点击后主区域切换到记忆面板，应看到**七个页签**：

```
用户画像 / 规则与偏好 / 情绪记录 / 记忆流水 / 工作区改名 / 收尾语 / 存储设置
```

各页签确认：

- **用户画像 / 规则与偏好**：能列出条目、能改字、能停用、能删除；「＋ 新增」表单能落库
- **情绪记录**：插件自动录入的条目在，可纠正误判
- **记忆流水**：按时间范围能筛；**列表默认显示 `summary`**（v3），点「展开全文」才看正文
- **工作区**（2026-11-15 新增）：下拉列出**有数据**的工作区（**不含 `__global__`**，
  且必须包含「rules 全是停用条目」的 `design`）；选源 + 填新名 → 「预览影响」显示三表行数 →
  「开始迁移」弹确认 → 「确认迁移」后显示迁前/迁后对照与 9 项校验
- **收尾语**：输入框里只有那句话本身（不含「这是会话的心跳…」那段执行说明）
- **存储设置**：显示记忆根目录、是否在系统盘、库体积/条数；有迁移按钮
- **不应有**「打开文件夹」（已移除）

> 页签不对/面板不出现，先查 `client.js` 的 slot 是否注册成功（见 §1 的 `[route-registered]` 同级日志），
> 再查 `locale/*.json` 的 `meta.title`。这两处文字来源不同（见 AGENTS.md 硬约束 7）。

## 7.5 记忆标记在界面上不可见（DOM 擦除）

**这是 2026-11-13 新增的一层，也是最容易被误判为「没生效」的一项。**

### 原理先看懂，否则会白测

记忆写入靠模型在**回复正文里**写 `<!--mem-log ... -->`（零工具架构的唯一通道）。
而 DSH 的对话渲染器把 HTML 注释当**纯文本**吐出来 —— 渲染器里那行是：

```js
case "html": return r.omitHtml ? null : e.value;   // omitHtml 默认 false
```

对话消息（ui-chat 的 `AssistantMarkdown`）调 `MarkdownText` 时**没传 `omitHtml`**，
所以标记会原样显示。`client.js` 里装了一个 MutationObserver 把它从 DOM 里擦掉。

**关键点：插件读的是 session 事件原文，与 DOM 显示完全解耦。**
擦掉的只是那层「显示壳」，入库照常。所以：

> **看到标记 = 显示层没擦掉，不等于记忆没写进去。**

### 怎么测（三档，从弱到强）

**① 静态逻辑（不需要 DSH，改正则后必跑）**

```powershell
# 本机 node 不在 PATH，用 DSH 自带运行时（路径按你的安装位置替换）
$node = "<DSH 安装目录>\dsh\node_modules\@deepseek-ai\dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node _dbpreview\selfcheck-dom-strip.mjs        # 17 项
& $node _dbpreview\selfcheck-scrubber-loop.mjs    # 23 项
```

两条都要 **0 失败**。它们覆盖了实测踩过的两个坑，改正则前先看这两条：

| 坑 | 断言内容 |
|---|---|
| 正则跨段匹配吞掉说明文字 | 正文里 `` `<!--mem-log` `` + `` `-->` `` 这种行内代码组合**一个字都不能删** |
| 布尔标志在异步回调下失效 | 自激循环必须用**时间戳 + 100ms 窗口**，不能用布尔标志 |

**② 入库是否照常（证明没伤到数据层）**

```powershell
Select-String -Path 'D:\dsh-fatfishdream-memory\logs\2026-11-13.log' -Pattern 'mem-写流水' | Select-Object -Last 3
```

应看到 `{"project":"...","topic":"...","db":true}`。
同时查库条数在涨：

```powershell
Invoke-WebRequest 'http://127.0.0.1:<port>/api/dsh-memory/state' -UseBasicParsing |
  Select-Object -ExpandProperty Content   # db.byTable.logs 应持续增长
```

**③ 界面是否真的擦掉（最终验收）**

看**最新一条** assistant 回复的末尾 —— 正文之后应**直接**是心跳句，
不应该出现 `<!--mem-log ... -->` 区块。

> ⚠️ **一定要看最新那条。** 往上翻历史消息可能还带着标记 ——
> 那是旧版 `client.js` 时期渲染的，擦除器只处理装载之后的 DOM。
> 2026-11-13 因为这个来回排查了三轮。

### 三个必须知道的边界（设计取舍，不是 bug）

| 情况 | 行为 | 为什么 |
|---|---|---|
| 只敲到 `<!--mem`（kind 还没出） | **不擦**，会闪一下 | 无法判断是标记还是正文，宁可闪也不误伤 |
| `code` / `pre` 里的标记示例 | **不擦** | 那是讲解格式的行内代码，本来就该显示 |
| 装载时 body 还没渲染（只有 5 个文本节点） | 靠 MutationObserver 补 | 正常，不是失效 |

### 改动后必须重启客户端，不是只重载插件

`client.js` 是**浏览器模块**（首行 `window.__ModuleLoader__.load({...})`），
DSH 运行时直接喂给浏览器。**禁用→启用插件不会刷新浏览器里的那份代码。**

- 改 `index.js`（host 侧）→ 重载插件即可
- 改 `client.js`（浏览器侧）→ **必须完整重启客户端**

搞错这一点的表现是「代码明明改了，行为一点没变」，非常容易误判成逻辑写错。

### 出问题时怎么定位

擦除器跑在浏览器里，模型看不见控制台。**别让用户开 DevTools 贴代码** ——
`index.js` 里有现成的回传通道：

```
GET /api/dsh-memory/client-report?state=<任意>&stripped=<数字>
```

`client.js` 的 `report()` 就是往这里打，`diag('client-scrubber', ...)` 会写进
`D:\dsh-fatfishdream-memory\logs\YYYY-MM-DD.log`。排查时临时加几行回报，
读完日志再把诊断代码删掉。

> 2026-11-13 的教训：一开始反复让用户开 DevTools、手打 `allow pasting`、贴日志，
> 折腾了四五轮。**正确做法是自己建回传通道。** 而且 `console.log` 在页面加载时
> 只打一次，用户开 DevTools 时日志早没了 —— "控制台没输出"根本不能证明代码没执行。

## 7.6 流水排序（看着像丢数据，其实是排序错）

**2026-11-13 实际发生**：用户报「记忆库只有凌晨 2 点多的记录了，5 点后到现在少了」。

查下来**一条没丢**：

```powershell
# id 是否连续（连续 = 没删过）
node -e "const{DatabaseSync}=require('node:sqlite');
const d=new DatabaseSync('D:/dsh-fatfishdream-memory/memory.db',{readOnly:true});
const ids=d.prepare('SELECT id FROM logs ORDER BY id').all().map(r=>r.id);
console.log('条数',ids.length,'范围',ids[0],'~',ids[ids.length-1],
            '连续',ids[ids.length-1]-ids[0]+1===ids.length);d.close()"
```

真因是**排序**，三层叠加：

1. **两种 ts 格式**：`#1~#234` 无时区后缀（`.md` 迁移来的本地时间），
   `#235` 起带 `Z`（UTC）。字符串比较时 `02:12` > `00:35Z`。
2. **`julianday` 救不了**：实测 SQLite 对无后缀字符串**一律按 UTC 解读**
   （`julianday('...T00:00:00')` 与 `...00:00:00Z` 完全相等）。
   这条已固化成断言：`_dbpreview/selfcheck-ts-sort.mjs` 第 1 节
   （用例名「julianday 也把 #2 排到后面」）。当初的一次性探查脚本
   `diag-julianday.mjs` 已随清理移走，结论留在断言里。
3. **老数据本身有 4 处时间逆序**，最大差 44.6 小时 ——
   `db-migrate.mjs` 当初按目录名逐项目导入，项目之间没有全局排序。

**结论：排序键用 `id`（插入顺序），不是 `ts`。**
id 连续无断号，才真正对应「谁更晚写」。见 `db-store.mjs` 的 `TS_ORDER`。

### 验证方法

```powershell
& $node _dbpreview\selfcheck-ts-sort.mjs        # 9 项，含「三种按时间排的写法全错」的断言
& $node _dbpreview\selfcheck-migrate-order.mjs  # 9 项，迁移时的全局排序
```

再直接打接口看首行是不是 id 最大的那条：

```powershell
$j = (Invoke-WebRequest 'http://127.0.0.1:<port>/api/dsh-memory/entries?table=logs&limit=5' -UseBasicParsing).Content | ConvertFrom-Json
$j.entries | Select-Object id, ts
# 第一条的 id 应该等于全表 MAX(id)
```

### 如果将来要动 ts 格式

**先想清楚这三件事，否则会重蹈覆辙**：

- 新增写入必须统一用 `new Date().toISOString()`（带 Z），不要再用无后缀格式
- 历史那 234 条**不要动** —— 无后缀数据无法判定当初写的是本地还是 UTC，
  归一化猜错会让全部时间偏 8 小时，比现在的错位严重得多
- 真要归一化，先备份 + 全量比对，并同步改 `selfcheck-ts-sort.mjs` 的断言

## 8. 资源占用

插件对资源应无可测量影响。实测对照（各 10 秒空闲采样）：

| 指标 | 启用 | 禁用 |
|---|---|---|
| 内存 | 1629 MB | 1742 MB |
| 线程 | 165 | 165 |
| 句柄 | 4262 | 4265 |
| 空闲 CPU | 30.8% | 31.7% |

空闲 30% 是 DSH 自身（GUI 渲染 + 会话），不是插件。

## 9. 数据完整性

改动涉及存储路径或格式时额外检查：

```powershell
# 所有记忆文件不应有 BOM
# 所有 JSON 应能正常解析
node -e "const fs=require('fs');const b=fs.readFileSync('D:/dsh-fatfishdream-memory/state.json');console.log('BOM:', b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF)"
```

## 10. 三层记忆（schema v3，2026-11-14）

设计见 [`三层记忆设计决议-2026-11-14.md`](三层记忆设计决议-2026-11-14.md)。

```powershell
# ① 静态双路径（迁移 + 空库），不碰真实库
& $node _dbpreview\verify-v3-schema.mjs        # 55 项（含 v4 archive）
# ② 标记语法（5 个捕获组）
& $node _dbpreview\test-marker-forms.mjs       # 30 项
```

**真实库迁移只发生在插件重载时**（`MIGRATIONS` v3/v4 自动跑）。验证点：

```powershell
$j = (Invoke-WebRequest "$env:DSH_WEB_URL/api/dsh-memory/state" -UseBasicParsing).Content | ConvertFrom-Json
$j.db.schemaVersion          # 必须是 5
$j.db.archive                # 原文条数（v4 单独字段，不进 byTable）
# 摘要模式：excerpt 应是真摘要（≤35 字），不是正文前 80 字截断；带 keywords 数组
Invoke-WebRequest "$env:DSH_WEB_URL/api/dsh-memory/search?q=沙箱&scope=dsh-fatfishdream-memory&summary=1&limit=3" -UseBasicParsing | Select -Expand Content
```

**新写一条流水**（回复正文里写标记）后查日志：

```
[mem-写流水] {"project":"...","topic":"...","summary":"...","keywords":"...","db":true}
```

缺 summary 的流水会打 `[summary-missing]`；超 35 字会打 `[summary-truncated]`。
**这两个诊断跑一段时间后要统计比例**（设计决议 #4：>20% 说明注入约束不够）。

> ⚠️ `logs_fts` 改过结构（5 列）：`bm25()` 的权重个数必须 = 列数（5 个），
> 少写会直接报错或错位加权。见 `db-store.mjs` 的 `LOGS_BM25`。

### 10.1 端到端：写入 → 落库 → 检索 → 条件查询

**写入那一步必须由模型完成**（脚本无法伪造 `assistant/message` 事件）：

1. 模型在回复正文写一条带唯一关键词的流水，例如 `E2E5A1`；
2. 跑：

```powershell
& $node _dbpreview\selfcheck-e2e-memory.mjs E2E5A1 E2E5A1-BODY   # 25 项
```

覆盖：entries 落库、topic/summary/keywords 齐全、摘要检索返回 keywords、
摘要不返回正文、全文检索可读正文、scope 隔离、`all=1` 跨项目、缺 scope 返回 400、
今天时间范围包含 / 未来范围排除、`limit=1` 分页、软删不在 active 列表、
中文 2 字词可检索、schema=v5、健康自检 9 项。

> ⚠️ **测试脚本取日期必须用本地时间**：库里 `ts` 是无时区的本地时间，
> `new Date().toISOString()` 在东八区凌晨会给出前一天，时间范围断言会假失败
> （2026-11-14 实测踩到）。用 `getFullYear/getMonth/getDate` 手工拼。

> 跑完记得把测试流水软删（`POST /api/dsh-memory/entry/delete`），别让测试数据留在记忆里。

### 10.1.1 原文归档（archive，schema v4 起）

**这是 v4 最容易「静默失效」的一层**：写不进去时模型照常回复、流水照常落库，
只是原文层空了 —— 等用户想回溯原话才发现找不回来。

```powershell
# 存储层 + HTTP 两层，49 项（需要 DSH 在跑；--no-http 只跑存储层 36 项）
& $node _dbpreview\selfcheck-archive.mjs
```

**真实写入路径的验证**（脚本伪造不了 session 事件）：

1. 发一条消息、收一条回复；
2. 查原文条数涨了 2 条（user 1 + assistant 1）：

```powershell
$j = (Invoke-WebRequest "$env:DSH_WEB_URL/api/dsh-memory/archive?scope=dsh-fatfishdream-memory&limit=5" -UseBasicParsing).Content | ConvertFrom-Json
$j.total
$j.rows | Select-Object id, ts, role, @{n='head';e={$_.text.Substring(0, [Math]::Min(40, $_.text.Length))}}
# 至少能看到 1 条 role=user、1 条 role=assistant
```

3. 日志里应有对应的两行：`[archive-user]` / `[archive-assistant]`；
   写入失败是 `[archive-write-failed] {"role":"..."}`。

**边界要一起测**（都在 `selfcheck-archive.mjs` 里）：

| 断言 | 为什么 |
|---|---|
| `role=x` → 400 | 别把任意字段当开放过滤条件 |
| 空文本 / 纯空白不写 | 空归档只有噪音，没有回溯价值 |
| 没有 `mem-log` 的回复也归档 | **v4 的核心**：模型没记的对话也要留 |
| 超长原文（2 万字）不截断 | 注入型提示词本来就长，截了就丢了现场 |
| 默认 `/search` 不返回 archive | 原文淹掉结论层 = 检索退化成关键词糊墙 |
| `stats().byTable` 仍是四张表 | GUI / 健康检查的「四表」口径不能变 |

> `archive` **没有清理策略**（保留期 / 体积上限都还没做，见 `docs/TODO.md`）。跑一段后看库体积：
> `$j.db.dbSize`。明显膨胀再讨论策略 —— 不要在没数据的时候就上限制。

> ⚠️ **重载插件（禁用→启用）后，`session/event` 监听可能不工作** ——
> 表现是日志里既没有 `[user-message]` 也没有 `[archive-assistant]`，
> 于是 `archive` 一直是 0 条。这不是归档功能坏了，是文档里的老问题
> 「热重载后 session/event 失效」（见文末「已知未解决」）。
> **验证真实写入前先完整重启 DSH**，否则会误判成 v4 写入路径有问题。
> （2026-11-14 实测：迁移成功、路由已注册、健康自检 9 项全过，但 archive=0，
> 原因就是监听没挂上。）

### 10.1.2 emotion 不在检索池（schema v5，2026-11-14）

**为什么**：情绪记录是「个人兴趣记录」，不是可检索的知识。而 `emotion.text` 存的是模板句
（分类名 + 证据 + 置信度 + 原话），这些都被写进了 FTS 索引，于是搜「爱意」「高置信」
「用户表达」命中的全是情绪模板，把结论层挤出结果位。实测 `q=爱意` 5 条里 4 条是 emotion。

```powershell
# 存储层：4 项断言（自建情绪种子后验证 search 不返回它）
& $node _dbpreview\selfcheck-isolation.mjs      # 18 项

# 下面是手工抽查（连真实库）
foreach ($q in '爱意','用户表达','高置信','喜欢') {
  $enc = [uri]::EscapeDataString($q)
  $r = (Invoke-WebRequest "$env:DSH_WEB_URL/api/dsh-memory/search?q=$enc&scope=dsh-fatfishdream-memory&limit=20" -UseBasicParsing).Content | ConvertFrom-Json
  "$q → $($r.hits.Count) 条，table: $(($r.hits | Group-Object table | ForEach-Object { $_.Name + '=' + $_.Count }) -join ' ')"
}
# 期望：结果里**不出现 **table=emotion
```

**边界（别改回去）**：

| 通道 | v5 后的行为 |
|---|---|
| `/search`（模型用） | ❌ 不返回 emotion |
| `/memory search`（用户斜杠命令） | ❌ 不返回 emotion |
| `/entries?table=emotion`（GUI 页签） | ✅ 照常，还能按 `q` 搜 |
| `emotion_fts` | ✅ 保留，供上面那条用 |
| 注入 | ❌ 从来不注入 emotion |

> **注入里必须提到这件事**：模型搜「喜欢」得到 0 条时不能判定「没记住」，
> 因为情绪确实在库里、只是不参与检索。
> `verify-injection-consistency.mjs` 断言了「情绪记录不在检索里」这句话必须存在。

### 10.1.3 v5 迁移与 confidence 归一化

`MIGRATIONS` v5 做三件事：`confidence` 归一化、删 v1 `entries` 冷存档、迁移后 `VACUUM`
（条目带 `drops: true` 才触发）。

```powershell
# 迁移后自动校验（selfcheck-full 的 B 段）
& $node _dbpreview\selfcheck-full.mjs    # 38 项，含：
#   ✅ v1 entries 冷存档已彻底移除（v5）
#   ✅ emotion.confidence 已归一化（无中文/无 NULL）
```

**confidence 的合法值只有三种**：`high` / `low` / `legacy`。

| 值 | 含义 |
|---|---|
| `high` | v4 起：分数 ≥ 0.62（含历史『高置信』归一化而来） |
| `low` | v4 起：分数 < 0.62，仍入库（不再丢弃） |
| `legacy` | v4 之前的记录，没有置信度字段 |

> ⚠️ **三种值并存是历史债**：v4 之前写中文『高置信』、之后写 `high`、远古行是 `NULL`。
> 想统计「low 的比例」时用 `confidence='low'` 会因为中文值和 NULL 静默少算 ——
> v5 已统一，不要再引入新写法。

**删 entries 的前置知识**（2026-11-14 干跑踩到）：

```
❌ DROP TABLE entries_fts_data   → 抛 table entries_fts_data may not be dropped
✅ DROP TABLE entries_fts        → 虚拟表本体，影子表由 SQLite 连带清理
✅ 再 DROP TABLE entries
✅ 迁移后 VACUUM                 → 否则体积一分不省（实测反而 +36 KB）
```

### 10.2 清空全部流水（彻底删除，2026-11-14 执行过）

**这不是软删除**：`DELETE FROM logs` + 重建 `logs_fts`。步骤（缺一不可）：

1. 备份：`node _dbpreview\backup-db.mjs`，产物改名为 `memory.db.before-purge-logs-<时间>`；
2. **禁用插件**（让数据库连接干净关闭，避免并发写）；
3. 执行清空（一次性脚本用后即删，照下面重建）：
   - `BEGIN IMMEDIATE` → `DELETE FROM logs` → `DROP TABLE logs_fts`
   - `CREATE VIRTUAL TABLE logs_fts USING fts5(summary, keywords, text, topic, seg, content='', tokenize='unicode61')`
   - `COMMIT` → `VACUUM`
4. 校验：`logs=0`、`logs_fts=0`、profile / rules / emotion 条数不变、`integrity_check=ok`；
5. 重新启用插件，确认日志 `health-check-verdict 通过：9 项全部就位`，
   注入里的「记忆索引」仍在（只剩 rules 的 topic 计数）。

> **不要逐行 `DELETE` + FTS `'delete'`**：整表清空时 DROP 重建更简单，也不会留残索引。
> **更不要用 `UPDATE ... SET status='deleted'` 冒充清空** —— 那是软删，行还在、FTS 还在。
>
> 这是硬约束 5「不要直写 `memory.db`」的**唯一例外**：目前没有对应的 HTTP 路由。
> 必须严格按上面 5 步（备份 → 停插件 → 事务内删表重建 → 校验 → 启插件），
> 少任何一步都可能留下「表空了但 FTS 还有残索引」的错位。
>
> **不需要把它做成功能**（2026-11-14 用户决定）：这次清空是因为架构大改的一次性操作，
> 不是日常需求。以后若真要频繁清空，再讨论 GUI 按钮 / 受保护路由。

---



## 已知未解决

**热重载后 `session/event` 监听可能失效。**

表现：日志里不再出现 `[user-message]`，情绪捕获停止工作。

实测有时正常恢复，所以不是必然失效 —— 更像时序/竞态。

**处理**：完整重启 DSH。这不是代码 bug，重启即可恢复。
