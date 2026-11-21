/**
 * 全量回归 runner —— 一条命令跑完所有脚本，输出 FAIL=N 汇总行。
 *
 * ## 为什么单独抽出来（2026-11-15）
 *
 * 以前是每次手写一个 foreach 循环贴进 pwsh。问题：
 *   1. 变异测试需要用代码调用（execSync），不能依赖 PowerShell
 *   2. 手写循环容易漏脚本（我从 30 数到 31 时手动加过好几次）
 *   3. 汇总格式不一致，没法用正则稳定解析
 *
 * 现在脚本清单只有这一处定义。新增脚本加进 SCRIPTS 即可，
 * 文档里的清单也引用它（`docs/TESTING.md` 别再手抄一份）。
 *
 * ## 捕获输出必须走 runCaptured（2026-11-15 修）
 *
 * 受限沙箱（`workspace-write` / `read-only`）不允许程序开命名管道，
 * 而 `spawnSync(..., { encoding: 'utf8' })` 默认 `stdio: 'pipe'` →
 * 每个子进程都拿回 `EPERM`、`status = null`。
 *
 * 旧代码写的是 `const code = r.status ?? -1`，于是
 * **「一个都没跑起来」被算成「32 个全部失败」**，报出
 * `TOTAL=32 FAIL=32` —— 而同一时刻用 pwsh 循环跑是 32/32 全绿。
 * 那条假红会让下一个会话误判「插件全崩」，然后去修一个不存在的问题。
 *
 * 现在改用 `lib-spawn-capture.mjs`：先试管道，被拒就退回临时文件捕获。
 *
 * ## 三种结果必须分开，不能混
 *
 *   PASS    exit=0
 *   FAIL    真的跑了，且 exit≠0          ← 计入 `FAIL=`
 *   ERROR   压根没跑起来（status=null）  ← **不计入 FAIL**，但整体 exit≠0
 *
 * ERROR 不进 FAIL 计数是有意的：否则变异测试会把
 * 「runner 自己崩了」误读成「测试抓到了 bug」（假绿）。
 * exit≠0 且 FAIL=0 时，`meta-mutation-test.mjs` 会判 ERROR —— 那正是我们要的。
 *
 * 用法：
 *   node _dbpreview/run-all.mjs            # 跑全部
 *   node _dbpreview/run-all.mjs --verbose  # 打印每个脚本的 exit
 *   node _dbpreview/run-all.mjs --only a,b # 只跑指定
 *
 * 输出最后一行固定为：
 *   TOTAL=32 FAIL=2 scriptA,scriptB
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

// ---- 脚本清单（唯一真相）----
//
// ⚠️ 这里**刻意不含** `audit-full.mjs` / `audit-rules.mjs` / `audit-baseline.mjs`。
//
// 它们是「完整自检」（阶段性全面体检），不是日常回归的一部分：
//   - audit-full 自己会调用 run-all（D 段），放进来会无限递归
//   - 它的成本远高于其它脚本，混进来会让日常回归变慢，然后大家都去跳过
//
// 完整自检只手动跑：`node _dbpreview/audit-full.mjs`（见 docs/TESTING.md §0.01）
export const SCRIPTS = [
  // 2026-11-21 新增，**必须是第 1 个**。
  // 为什么放最前：后面 76 个脚本全靠「字符串锚点去 index.js 里找代码」，
  // 而锚点里写死的是 \n。一旦工作区是 CRLF（core.autocrlf=true 的默认后果），
  // 锚点永远匹配不上 —— 实测同一棵树 CRLF 下 FAIL=12、归一 LF 后 FAIL=0，
  // 那 12 个红全是环境噪音，会把人引去改没坏的东西。
  // 这是**前置条件检查**，不是并列的第 78 项。
  'verify-eol',
  'verify-functions',
  'verify-map',
  'verify-map-content',
  // 2026-11-17 新增：补齐另外四种行号形态（表格列 / 行首 / 正文内联 / 行号在前）。
  // 为什么必须加：上面两个脚本只覆盖 108 处里的 26 处，其余 82 处
  // 「该行非空就算过」—— 实测抽查 45 处全部错位，而它们自报 0 落空。
  'verify-map-forms',
  'selfcheck-full',
  'selfcheck-cap',
  'selfcheck-isolation',
  'selfcheck-paging',
  'selfcheck-marker-hardened',
  'selfcheck-dom-strip',
  'selfcheck-scrubber-loop',
  'selfcheck-collapse-guard',
  'selfcheck-ts-sort',
  'selfcheck-migrate-order',
  'selfcheck-migrate-db',
  'selfcheck-copytree-empty',
  'selfcheck-topic-clean',
  'selfcheck-injection-wording',
  'verify-injection-consistency',
  'selfcheck-pure-utils',
  'selfcheck-emotion-guard',
  'selfcheck-emotion-lexicon',
  'selfcheck-emotion-limiter',
  'selfcheck-entry-by-id',
  // ★ 2026-11-16 新增：流水通道存活检查。
  //   守的是「最近 N 分钟有没有成功写入过流水」—— 抓「模型压根没写」这类
  //   解析层测试看不见的失效。详见脚本头部注释。
  'selfcheck-log-alive',
  'selfcheck-archive',
  'selfcheck-breakdown',
  'selfcheck-dir-name',
  'verify-no-self-trigger',
  'verify-final',
  'verify-doc-links',
  // ★ 2026-11-18 新增：AGENTS.md 里的「代码事实」引用守卫。
  //
  // 为什么需要它：`AGENTS.md` 长期有一处引用写着 `index.js` L2086，
  // 而真正的代码在 L2145（L2086 是 `.map((line) => line.trim())`）。
  //
  // 更关键的是**没有任何脚本守这一块**：
  //   · verify-map 系只读 docs/项目地图.md
  //   · verify-doc-links 读 AGENTS.md，但只查链接目标是否存在
  // 实测把引用改成**不存在的函数名** `noSuchFunctionXYZ()`、
  // 或**真实但无关的** `analyzeEmotion()`，五个脚本全部报绿。
  //
  // 本脚本核四件事：文件存在、符号有唯一定义、代码片段存在、片段在符号体内。
  // 自带 `--self-test` 做三次故障注入，证明这些断言**确实会红**。
  'verify-agents-codefacts',
  'verify-v3-schema',
  'test-marker-forms',
  'selfcheck-search-tier',
  'selfcheck-scope-rename',
  // ★ 2026-11-16 新增：policy.md 一次性覆盖的真实行为回归。
  //   这是唯一真正 import 并执行 createStore.ensureLayout 的脚本 ——
  //   之前的测试只查「源码里有没有那几行字」，从不执行覆盖逻辑，
  //   于是漏掉了「升级时收尾语随覆盖丢失」这个真 bug。详见脚本头部注释。
  'selfcheck-policy-sync',
  // ★ 2026-11-18 新增：pre-step 提醒通道（v1）已删除的守卫。
  //
  // 那条通道**一次都没执行过** —— 闸门在每轮开始被设成当前轮，判据
  // `remindedFor.turn === turn` 恒为真，分支结构上不可达。日志侧
  // `[pre-step-hit]` 235 次 vs `[pre-step-write-nudge]` 0 次完全吻合。
  //
  // 这个脚本守三件事，缺一都会退化成「看起来删干净了」：
  //   ① 死代码确实不在了（判据只看可执行代码，注释里应保留推导记录）
  //   ② pre-step 的**轮次记账还在** —— 删多了会让 `/log` 的重记检测静默失效
  //   ③ 活的 v3 通道仍完整 —— 它被顺手删掉的话，漏记就彻底没人管
  'selfcheck-prestep-single-channel',
  // ★ 2026-11-18 新增：待判情绪队列已彻底删除的守卫。
  //
  // 那条队列死在两处：生产者 enqueueAmbiguous **全项目 0 个调用点**
  // （2026-11-14 起弱信号改为直接入库），而仅剩一条的 sessionId 是
  // "session-1"（不是真实会话 id），永远被过滤、永远出不了队。
  // 它还在 `/memory status` 报「待判 1 条」，让用户以为功能还在。
  //
  // 守三件事：
  //   ① 队列删干净了（代码 + state.json 字段 + 导出 + 诊断）
  //   ② **情绪录入没被误伤** —— 弱信号走 recordEmotion 直接入库才是现状
  //   ③ state.json 结构变更后仍能读写（老用户带 BOM + 旧键不能启动失败）
  'selfcheck-ambiguous-queue-removed',
  // ★ 2026-11-18 新增：C1-A「收尾语打嗝」判据的守卫。
  //
  // 实测 97 个 turn（9.2%）里 ≥2 条 assistant 消息各带一次收尾语，
  // 其中 95 个是「第 1 条真回答（位置正确）+ 最后 1 条补记（多嗝一次）」。
  //
  // ⚠️ 这条判据的方向极易搞反：直觉是「收尾语要在最后，所以保留最后一条」，
  //    但实测形态是反的 —— 那样会把**正确的那条**删掉、保留补记上那次，
  //    而补记消息（「已补记 id=xxx」）本来就是历史上一直想消灭的东西。
  //    脚本里对此有专门断言。
  //
  // 只测判据（纯函数），不测 surface replace 的调用 ——
  // 那部分需要真实 session 对象，改由运行时探针 `[c1-probe]` 与日志验证。
  'selfcheck-c1-hiccup-plan',
  // ★ 2026-11-18 新增：C1-A 的**集成**验证（判据之外的那一半）。
  //
  // 上一个脚本只测纯函数判据。但判据对了、**调用链还可能没接上** ——
  // 这正是 AGENTS.md 记过的「reportBudget 静默失效」（函数在、调用点没了）。
  //
  // 本脚本三件事：
  //   ① 源码事实核对：turn-stopping 里确实调了 planHiccupFix 与 session.append
  //   ② 用假 session 跑集成逻辑，断言 surfaceOp 形状与替换范围正确
  //   ③ **非文本块（图片/工具调用）必须原样保留** —— 只替换 text 块
  'selfcheck-c1-hiccup-integration',
  // ★ 2026-11-18 新增：C1-A（修正版）—— **补记消息不该带收尾语**。
  //
  // 用户观察点破了真正的主症：
  //   「收尾语先出来，但下面还在执行指令，指令结束后打嗝并发出第二条收尾语」
  //
  // 实盘三轮（本会话）：turn 13/15 是「真回答 + 补记」各带一次 → 打嗝；
  // turn 14 只有补记带。**共同点是补记那条每次都带** ——
  // 它是插件 steer 出来的工具步骤，本来就不是「一轮回复」。
  //
  // v3 文案**已经写明**「不要加收尾语」，模型仍然加。
  // 三个版本的文案全部失败过（详见脚本头与 index.js 里那段注释），
  // 所以必须由**归档闸门**兜底 —— 与 filler-guard 拦住「。」同一个思路。
  //
  // ⚠️ 它只改 archive 里存的那一份，不改界面已显示的消息
  //    （后者需要 surface replace，已证实结构上不可能）。
  'selfcheck-c1-toolstep-heartbeat',
  // ★ 2026-11-18 新增：C4 的「跨轮状态必须按 sessionId 分键」守卫。
  //
  // 交接单记的是「3 个模块级变量未分键」，实测是 **5 个**。逐个体检后
  // 只有两个真影响正确性，本次改它们：
  //
  //   `turnStartedAt`  A 先打点，B 结算时算出的是 A 的时长（实测会翻倍）
  //   `logRouteHits`   A 调 /log 会记进 B 的计数，而这是「区分没写 vs 写了被拒」
  //                    的核心判据，串了这个区分就失效
  //
  // 另外三个（lastInjectionBytes / lastInjectionHasWriteRule / c1ProbeDone）
  // 已论证只影响诊断、且每次都会重写（分键等于造永不清理的 Map），不改，脚本里有白名单。
  //
  // ⚠️ 脚本里那条「行为隔离」断言不是查源码文本，而是用两个会话**交错跑**
  //    同一段算法并断言数字互不污染 —— 只断言「源码里有 Map」是恒真断言的近亲。
  'selfcheck-c4-session-scoped-state',
  // ★ 2026-11-16 新增：消息去重键的真实行为回归。
  //   守的是「不同 session 的同一 turn:step 不能撞键」—— 撞了那条原文永久丢失。
  //   抽成顶层纯函数 makeMessageKey 之前它**无法黑盒验证**：需要伪造两个会话
  //   消费相同 turn:step，而单会话测试里 sid 恒定，加不加前缀行为一样 →
  //   那种测试会绿却证明不了任何事。详见脚本头部注释。
  'selfcheck-message-key',
  // ★ 2026-11-17 新增：并发写入完整性（多进程）。
  //   守的是「并发写会不会丢」—— 记忆里唯一一次「丢到只剩 1 条」的实测记录
  //   是 D13（.md 时代的读-改-写），改 SQLite 之后从未实测过。
  //   这个脚本 fork 4 个真实进程同时写同一个临时库，断言成功次数 == 库里条数。
  'selfcheck-concurrency',
  'selfcheck-concurrency-multiproc',
  // ★ 2026-11-17 新增：serialize() 串行队列的行为回归。
  //   守的是「state.json 的读-改-写不会互相覆盖」。此前 serialize 只用在 2 处，
  //   registerProject / moveProject / /scope/rename 三条**没走锁** ——
  //   实测故障注入：去掉锁后并发注册 12 个项目，**12 个全丢**。
  'selfcheck-serialize',
  // ★ 2026-11-16 新增：§3.1 裸数字行号表的核对。
  //   verify-map 只认带 L 前缀的引用，§3.1 那张表写的是裸数字 →
  //   它**完全不受校验**。实测表里 15 行全部指错位置而 verify-map 报 0 处落空。
  'verify-symbol-lines',
  // ★ 2026-11-17 新增：P0 #5 / #6 两处「假绿断言」的故障注入守卫。
  //   为什么需要它：这两条断言被反复改错过三次 ——
  //   ① 原始版 `/A|B/` 任一成立；
  //   ② 改成「两词都出现」后，另一个**同名句子**在替它通过；
  //   ③ 再改成「都出现」后，INJECT_TEXT 是多段拼接，仍被别段满足。
  //   三次都是绿的，通读源码看不出来 —— 只有「改坏对应代码看它红不红」
  //   才能发现。所以把它固化成回归，而不是一次性排查。
  //   ⚠️ 它会临时改写 index.js（跑完逐字节还原 sha256），
  //      与 meta-mutation-test 一样：跑的时候不要并行改代码。
  'faultinject-p0-assertions',
  // ★ 2026-11-17 新增：macOS / POSIX 路径行为。
  //   守的是硬约束 14 —— 记忆目录必须留在工作区之外。
  //   在 POSIX 下 `expandRoot('')` 曾产出 `D:\<名称>`，被 resolve() 当相对路径 →
  //   记忆会**建进当前工作区**（那里是 LLM 可以随意操作的地方）。
  //   本脚本用假 platform + path.posix 在 Windows 上精确复现 POSIX 语义。
  'selfcheck-posix-paths',
  //   配套故障注入：确认上面那 23 条断言真的会红（含「Windows 分支不许变」）。
  'faultinject-posix-paths',
  // ★ 2026-11-17 新增：双会话撞键的**逻辑链端到端**验证。
  //   TODO.md 曾记「真实双会话同 (turn,step) 撞车时原文不丢」未验，
  //   当时的判断是「宿主 session/event 驱动不了，只能靠碰巧」。
  //   对了一半：事件源确实驱动不了，但**去重的四步都在插件自己代码里**
  //   （取键 → Set 判重 → appendArchive → 读回），所以用两个真实 store 实例
  //   喂完全相同的 (turn, step) 就能忠实复现撞车条件。
  //   ⚠️ 它证明的是「逻辑链端到端」，**不是**「宿主真实并发时序」——
  //      后者仍需两个真会话，别据此宣称全验完。
  'selfcheck-archive-collision',
  //   配套故障注入：去掉 sid 后必须红（守住 2026-11-16 那个「丢整轮原文」的修复）。
  'faultinject-archive-collision',
  // ★ 2026-11-17 新增：一次完整代码审查修掉的 7 个 bug 的回归。
  //   为什么要独立一个文件：这 7 个 bug 有共同点 ——
  //   **正常路径下行为完全不变，只有故障路径才暴露**。
  //   所以 46 个既有脚本全绿的情况下它们还活着。
  //   每条断言都标了 [回退验证]（把修复撤掉该怎么让它红）。
  'selfcheck-bugfix-20261117',
  //   配套故障注入：逐个撤掉修复，确认上面 42 条断言真的会红。
  //   2026-11-17 实测：8 个变异全部 KILLED。
  //   ⚠️ 它会临时改写 index.js / db-store.mjs（跑完 sha256 逐字节还原），
  //      跑的时候不要并行改代码。
  'faultinject-bugfix-20261117',
  // ★ 2026-11-17 新增：第二批修复（TODO 待办 L / A / C / P / O）的回归。
  //   L  search() 不过滤 review='retracted' —— 用户撤销的规则仍被当结论检索
  //   A  迁移失败不 close 连接 —— Windows 上锁库，备份/再迁移全失败
  //   C  copyTree 读目录失败静默 return 0 —— 迁移报「成功」但少文件且零日志
  //   P  Number(body.id) 接受 true(=1) / [7](=7) —— 传错类型会误删 id=1
  //   O  limit/offset 无校验 —— -1 静默返 0 条，2.5/1e21 直接 500
  //   收口方式：P 抽 parseId()、O 抽 clampInt()，各把 5-6 处变 1 处。
  'selfcheck-batch5-20261117',
  //   配套故障注入：逐个撤掉修复，确认上面 42 条断言真的会红。
  //   2026-11-17 实测：6 个变异全部 KILLED。
  //   ⚠️ 同 faultinject-bugfix：临时改写 3 个源文件，跑时别动代码。
  'faultinject-batch5-20261117',
  // ★ 2026-11-17 新增：batch5 里两条「故障路径」修复的行为验证。
  //   为什么需要单独两个脚本：
  //   修复 A（迁移失败要 close）和 C（copyTree 读失败要记账）都只发生在
  //   **故障路径**上 —— 正常跑一百次也不会走到。而构造真实故障要动真实库/真实目录，
  //   风险太高（2026-11-16 的 /root/move 事故就是「想测失败路径结果真的执行了」）。
  //   这两个脚本改用**临时目录 + 临时库**构造同样的故障，不碰用户数据。
  //
  //   verify-openmemdb-close：建一个「版本落后但结构是新的」临时库，
  //     让 ALTER 撞 duplicate column → 迁移必然失败 →
  //     **判据是抛错后能否立刻可写重开**（不能重开 = 连接没释放）。
  //     实测：撤掉修复后连临时目录都删不掉（EPERM），正是它要防的场景。
  //
  //   verify-copytree-failure：在临时目录里用一个**文件**冒充目录，
  //     `readdir` 抛 ENOTDIR（非 ENOENT）→ 必须记进 skipped。
  //     实测：撤掉修复后 skipped 从 1 条变 0 条，迁移会「报成功但少文件」。
  'verify-openmemdb-close',
  'verify-copytree-failure',
  // ★ 2026-11-17 新增：§3.3「apply 内部」行号表的故障注入。
  //   为什么需要它：§3.3 那个代码块原来是「裸 L#### + 中文描述」，
  //   **三个校验脚本全都不看它** —— 实测 13 处里 10 处指向无关代码，
  //   而当时三脚本同时报 0 失败。现已改成「L#### 类型:锚点 描述」，
  //   由 verify-map-forms 的**形态 J** 逐个核对。
  //   本脚本篡改**地图本身**（不改源码），确认：
  //     行号改错 / 锚点写错 / 类型写错 / 删掉锚点 —— 四种都必须变红。
  //   2026-11-17 实测：13 项全绿，地图按 sha256 逐字节还原。
  //   ⚠️ 它临时改写 docs/项目地图.md，跑时别并行改文档。
  'faultinject-form-j',
  // ★ 2026-11-17 新增：断点④ —— 归档时记录「这条消息带不带收尾语」。
  //
  // 为什么需要：双收尾语的主症是「补写那条消息又加了一条」，而原先只能
  // 事后查 archive 表判断 —— 那样会**数错对象**（把同一轮其它正常回复的
  // 收尾语也算进去），2026-11-17 实测因此得出过错误结论。
  //
  // 它守的是两个纯函数 `countHeartbeat` / `isHeartbeatLast`，
  // 用 `extract()` 从源码抽出来直接喂四种形态，不依赖任何 I/O。
  'selfcheck-heartbeat-breakpoint',
  // ★ 2026-11-18 新增：归档前的「纯标点填充物」闸门。
  //
  // 起因：补记那一步文案改到「不要输出任何文字」后，模型仍每轮发一个
  // 中文句号「。」，界面上孤零零挂一个「。」。三个文案版本全部失败。
  // 真正的放行点是代码里那一行：`'。'.trim()` 仍非空 → 照常归档、照常显示。
  //
  // 判据用 \p{P}（Unicode 标点），不写死「。」；刻意不拦 \p{S}（emoji），
  // 因为用户真的会发纯 emoji 的回复，那是有效内容。
  'selfcheck-filler-guard',
  // ★ 2026-11-19 新增：注入渲染的分段字节账 + 300 次确定性验证。
  //
  // 为什么需要它：生产端每轮只记**一个数** `lastInjectionBytes`（总字节）。
  // 总字节对得上，仍可能是「全局规则被挤掉了、而记忆索引刚好长了同样多」——
  // 静默失效。而 `## 全局规则` 是唯一来自 policy.md 的一段，它缺了以后
  // 每轮注入里的「心跳收尾语」就没了，模型不会报错，只是不再照做。
  //
  // 做法（与其它脚本不同的两处）：
  //   ① 它在**临时目录里自建虚拟库**，数据量按真实库只读统计的「等量蓝图」
  //      灌入（连每条文本的字节数都对齐），所以能复现出与生产**逐段相同**
  //      的字节账（实测总字节 6429，与生产差 0）；
  //   ② 渲染走**真实源码**：从 index.js 抽 renderFromDb / finishInjection /
  //      policyTextSync / activeLines 等 12 个函数，`new Function` 执行。
  //      不 import 是因为它们是 apply/createStore 的内部函数。
  //
  // 真实库只以 readOnly 打开做 SELECT，policy.md 只读复制，临时目录跑完即删。
  // ⚠️ 结论边界：它只证明「库与 policy.md 不变时渲染确定」，
  //    **不**证明「生产每轮注入成功」—— 后者看运行日志。
  'test-injection-sandbox',
  // ★ 2026-11-19 新增：检索词里的控制字符（实测复现的 500）。
  //
  // 起因：`GET /api/dsh-memory/search?q=a%00b` 直接 500
  // `{"ok":false,"error":"unterminated string"}`。
  // 根因是 FTS5 的 MATCH 用 C 字符串解析，`\u0000` 被当成字符串终止符。
  //
  // 为什么值得单列一个脚本，而不是塞进 selfcheck-pure-utils：
  //   ① 它有三层，pure-utils 只有纯函数那一层 —— 没有真实 FTS5 就证明不了
  //      「这条表达式拿去 MATCH 不会炸」；
  //   ② 它还带 `--self-test` 式的自证（内存里撤掉清洗行，断言必须变红），
  //      这套机制和 pure-utils 的抽取方式不同，混在一起会让两边都难读。
  //
  // 另一类危害比 500 更隐蔽：`\u0001` 不报错，却会被当成真实 token，
  // 导致「本该有结果的查询静默返回 0 条」。修复前没有任何断言守它。
  //
  // ⚠️ 它只改内存里的函数体，**不碰磁盘上的源文件** ——
  //   所以可以和别的脚本并发跑，不需要 sha256 还原。
  'selfcheck-query-nul',
  // ★ 2026-11-20 新增：流水**漏记判据本身**的行为回归。
  //
  // 为什么必须单独一个，而不是塞进现有的几个漏记相关脚本：
  //   · selfcheck-marker-hardened 只做**源码文本核对**（那句在不在），
  //     测不出判据算得对不对；
  //   · selfcheck-log-alive 守的是「写流水的通道还活着」；
  //   · meta-mutation-test 有 streak 变异，但要跑全套回归才生效，
  //     日常单跑看不见。
  //
  // 而 2026-11-20 实盘查出的三个问题**全在「判据算得对不对」这一层**：
  //   ① `turn-未记流水` 用 `wroteMemory`，而它只在「写进记忆根目录」时置位。
  //      log.ps1 在工作区、store.root 在 D 盘 → 判据恒真。当天 6 条全假阳性，
  //      其中 02:08 那条，7 秒前刚成功写入 id=1078。
  //   ② `write-streak-check` 的 diag 没有 sessionId，而 turn 是每会话各自
  //      从 1 数起的 → 按 turn 聚合必然串账。
  //   ③ record 不存在（纯思考轮）与真的没写被算成同一结果 →
  //      「漏记集中在纯分析轮」这个真实现象无法从数据里区分。
  //
  // ⚠️ 它用 extract 抽**真实源码里的判据**求值，不抄一份。
  //    自带反向自证：把三处临时修好 → 24/0 全绿；还原 → sha256 逐字节一致。
  //    磁盘上只读，不改任何生产文件。
  'selfcheck-write-miss-crosscheck',
  // ★ 2026-11-20 新增：工作区脚本 log.ps1 的自愈与版本同步。
  //
  // 为什么必须有：2026-11-19 夜里 log.ps1 的新版本（带 turnWrites 输出）
  // **一次都没跑起来** —— 三个工作区全停在 11-18 那版（718 vs 模板 1599 字节）。
  // 根因是判据 `if (await exists(scriptPath)) return false`：只看文件在不在，
  // 模板改了什么都不会同步，而且**静默**（返回 false 兼作「没新建」，
  // 上层只在该值为 true 时打 workspace-script-installed）。
  //
  // 这是「改了代码，但跑的不是这版」在**派生文件**上的形态。
  //
  // ⚠️ 当晚我是用临时脚本验的，跑完就删了 → 回归里这个函数零覆盖
  //    （grep ensureWorkspaceScripts _dbpreview/ 是 0 命中）。
  //    只要有人「顺手简化」改回 exists()，版本漂流立刻复发而回归全绿。
  //
  // 它从源码抽**真实函数体**求值（连同模板常量，用 new Function 拿到
  // 运行时真值 —— 源码里的 `\`` 是转义，直接截文本会写出坏文件）。
  // 全程在系统临时目录，不碰用户的 .dsh-fatfishdream-memory/。
  // 自带反向自证：把内容比对换成恒等 → 旧内容不再被覆盖 → 断言变红。
  'selfcheck-workspace-script-sync',
  // ★ 2026-11-20 新增：收尾语解析器 + 文件替换的**行为**回归（两段）。
  //
  // 为什么补（2026-11-20 用覆盖扫描查出来的两个真空白）：
  //
  //   段 A `parseHeartbeatFromPolicy`：2026-11-19 刚重构成「单一来源」，
  //     而它**从没被任何回归脚本执行过** —— 只有 selfcheck-policy-sync
  //     按符号名抓源码文本，抓不到「解出来的句子对不对」。
  //     它的失效形态极其隐蔽：解析失败返回 ''→ countHeartbeat 得 null →
  //     heartbeat-turn-verdict 恒报 missing，看起来像模型没加收尾语。
  //     当晚就因此排查了整整一轮。
  //
  //   段 B `replaceFile`：同样零覆盖。它是 atomicWrite 的底座，
  //     正常路径只有一步 rename，Windows 目标被占用时才走
  //     「挪到 .bak → 写新的 → 失败就回滚」那条复杂路径。
  //     **这条路径正常跑一万次都不会执行**，但写错就会让用户的
  //     policy.md 凭空消失。
  //
  // 断言重点：A 段钉四种句式（新/旧/行在但截不出/没有行）+ 读写互为逆运算；
  //          B 段钉「任何失败分支都不许让目标文件消失」，含双重失败时的报错内容。
  // 两段都带反向自证（改坏对应实现 → 断言变红）。
  // 全程用系统临时目录，不碰用户的 policy.md 与记忆目录。
  'selfcheck-heartbeat-parse-replace',
  // ★ 2026-11-20 新增：`assertSupportedSchema` 与 `pointerPath`（最后两个覆盖空白）。
  //
  // 补之前 `grep <函数名> _dbpreview/` 是 0 命中。两者性质完全不同：
  //
  //   A `assertSupportedSchema` —— **死代码**（已登记 knownDead 白名单）。
  //     它是「注册工具前的 schema 自检」，而硬约束 1 让本插件永久不注册工具。
  //     怎么躲过死代码检测的：`usageOf` 原来只跳过定义行，而它在函数体内
  //     **递归调用自己两次** → 被算成「有引用」。2026-11-20 修了 usageOf
  //     （排除自递归）后才暴露。测它是为了证明「留着的那段死代码是对的」。
  //
  //   B `pointerPath` —— 有真实调用点（readPointer / writePointer），但从未单独验证。
  //     它错位的后果：指针读不到 → 每次启动回退盘符探测 → 用户自定义记忆根静默丢失。
  //     依赖 homedir()，所以只能靠**注入假 homedir** 测，绝不碰真实 home。
  //
  // 附带记录一个事实（不断言正确性）：`POINTER_FILE = '_root.json'` 与实际使用的
  // `memory-root.json` **不一致**，且全文件零引用 —— 工具路线遗留，不影响行为。
  'selfcheck-schema-assert-pointer',
  // ★ 2026-11-20 新增：用户实报的「显示已停用」开关失效。
  //
  // 现象：停用了一条全局规则，勾选「显示已停用的」看不到它。
  // 实测（本机）：不带 status → 8 条全 active；status=all → 9 条（多 1 条 stale）。
  //
  // **后端是对的**（index.js 那段 2026-11-16 的注释专门讲了为什么不能传 undefined）。
  // **前端漏了**：`if (!showInactive) params.set('status', 'active')` ——
  // 勾选时什么都不传 → 后端回落 active → 停用条目永远列不出来。
  //
  // ## 为什么之前没有任何脚本抓到（这是本条最值得记的部分）
  //
  //   · `audit-rules.mjs` 那条规则守的是**后端**（`|| 'active'` 附近有没有
  //     `includeAll`），后端确实改好了 → 一直绿；
  //   · `selfcheck-full.mjs` 只核对依赖数组里**有没有** `showInactive`，
  //     不核对**它的值有没有真的被用上**。
  //
  // 于是**两端各自的测试都绿，接缝是断的**。这类 bug 的判据：
  // 「一个跨两端的约定，有没有一端在测试里被验证过它真的传了？」
  //
  // ⚠️ 本脚本是**静态**的：证明接线对，证明不了真实数据出现 ——
  //    那要靠带/不带 status 的 total 对比（见脚本 E 段打印的基线）。
  // ⚠️ 写它时踩过一次「断言命中注释」：修复时我把旧写法留在注释里作对照，
  //    第一版断言直接匹配原文 → 假红两条。现在统一 `stripLineComments()` 后再生效。
  'selfcheck-show-inactive-wire',
  // ★ 2026-11-20 新增：`log.ps1` 的**输出信息量**（不是「能不能写进去」）。
  //
  // 守的是同一个病的三次复发：
  //   ① 2026-11-19 `turnWrites` —— 脚本只打 `ok id=N turn=M`，同一轮连写 5 条
  //      我看不出那是 5 条还是 5 轮；
  //   ② 2026-11-20 `topic` —— 我调用时只传一个参数，`$Topic` 是 null →
  //      请求体没 topic → 服务端补「开发日志」。正文写着「判为闲聊」，
  //      **实际归进开发日志**，而输出一个字都没提 topic。
  //
  // 病根一句话：**脚本把服务端的响应剪裁成一行，剪掉了判断对错所需的信息。**
  //
  // 之前没有任何测试守这个 —— 它们全在测「能不能成功写进去」。
  //
  // 本脚本三层：
  //   ① 模板文本层（topic / turnWrites / 未传提示 必须在 Write-Output 里）
  //   ② **真实执行层**：临时目录放脚本 + 独立进程 mock server + 真跑 pwsh，
  //      断言 stdout 的实际文字（传 topic / 不传 topic 两组）
  //   ③ 自证（删掉 topic 输出 → ① 和 ② 都必须红）
  //
  // ⚠️ 两个实测过的坑，写在脚本注释里：
  //   · mock server **不能跑在同一进程**（spawnSync 会阻塞事件循环，
  //     server 永远 accept 不到连接 → status=null，8 条假红）；
  //   · 自证不能对整模板匹配 `$r.topic`（「未指定 topic」那行也含它，
  //     删掉成功输出后仍命中 → 自证假红）。
  'selfcheck-logps1-output',
  // ★ 2026-11-20 新增：真实漏记数据的**统计口径**回归。
  //
  // 背景：「04:00 后 24 轮里 18 轮漏记」这个数字，当天是**临时脚本算的、跑完就删**，
  // 于是它**无法复现** —— 下次谁觉得可疑，都得重新手写统计，而重写出来的数字
  // 一旦不同，谁也说不清是「数据变了」还是「口径变了」。
  //
  // 现有夹具：`fixtures/turns-2026-11-20.txt`（181 行，逐字节冻结的日志切片，
  // 带 sha256）+ `fixtures/turns-2026-11-20.expected.json`（已知答案）。
  //
  // 它守的是**四个实测过的串账陷阱**，每一个都对应一个真会算错的错法：
  //   ① 只按 turn 号聚合（turn 每会话各自从 1 数起）→ 27 行 / 漏 19（正确 25 / 18）
  //   ② 配对键用 ts 而不是 (sessionId, turn) → 配对只剩 8/62（正确 36）
  //   ③ 把无 sessionId 的老行并进会话口径 → 20 行老行混入
  //   ④ 拿 turn-end 当分母 → 26 轮「没有结算」被当成「漏记」
  //
  // ⚠️ 它守的是**统计口径**，不是「模型该不该写流水」（那是模型行为，回归测不了）。
  // ⚠️ 自带 5 个故障注入（M1–M5），每个都先断言锚点唯一再注入。
  //    写这个脚本时我自己踩了三处：注入打到守卫行之前、锚点打在窗口内（那里只有一个
  //    会话，变异天然无效）、streakTs 的 TDZ —— 都已写进脚本注释。
  'selfcheck-miss-audit',
  // ★ 2026-11-20 新增：`client.js` 的日期筛选必须用**本地日期**。
  //
  // 用户实报：「你还是把服务器时间和本地时间算成两天」。
  // 实测（本地 05:23，UTC 还是前一天）：点「今天」→ 筛出 2026-11-19，
  // 当天流水一条都看不见，反而显示昨天的 520 条。
  //
  // **根因**：`client.js` 三处用 `toISOString().slice(0,10)` 取日期，
  // 而 `toISOString()` **永远输出 UTC**。本机 UTC+8，每天本地 00:00–08:00
  // 这 8 小时 UTC 还停在前一天 → 整差一天。
  //
  // **为什么躲过了所有既有测试**：那个 bug 在 `client.js`，而回归里
  // **没有任何东西执行 `client.js`**（浏览器模块，Node 里跑不了 __ModuleLoader__）。
  // 既有测试全在测后端，而后端早就是本地时间了 —— **后端一直对，断在前端**。
  // 与 `selfcheck-show-inactive-wire` 同型（两端各自绿、接缝是断的）。
  //
  // ⚠️ 关键做法：**假造一个「本地与 UTC 不同日」的时刻**再断言。
  //    若拿现在的时间跑，且恰好在 08:00 之后，本地与 UTC 同一天，
  //    bug 与修复表现完全一样 —— 那种断言会绿，却什么都没证明。
  //
  // ⚠️ 另一处：所有「不许出现 toISOString」的断言都先 `stripComments()`。
  //    因为修复时**故意把旧写法留在注释里作对照**，直接匹配原文会假红
  //    （2026-11-20 已经在这个坑里栽过两次）。
  'selfcheck-client-local-date',
  // ★ 2026-11-20 新增：`policy.md` **前两行格式**是硬性的。
  //
  // 用户定：第 1 行 `## 给模型的规则`、第 2 行「- **每轮必须无条件执行** …log.ps1…」。
  // 无论发生什么（初始化覆盖 / 删收尾语重建 / GUI 反复改），这两行都不许动。
  //
  // **用户实报的 bug**：GUI 里删掉收尾语再重新填进去，
  // 「必须执行」会变成第三行 —— 因为 `writeHeartbeat` 的 `else` 分支
  // 用 `anchor = /^(#{1,2}.*给模型的规则.*\\n)/m` 把新行**插到标题正下方**。
  //
  // ⚠️ 这类 bug 尤其难测，因为**它依赖初始状态**：
  //    · 若收尾语本来就在第 2 行 → 插回第 2 行 → 看起来正常（我第一次就栽在这）
  //    · 若「必须执行」在第 2 行 → 收尾语插进去 → **把规则挤到第 3 行**
  //    所以本脚本用**四种文本形态**分别喂，其中三种是「必须执行在第 2 行」。
  //
  // ⚠️ 并且必须测 **CRLF** 输入 —— 第一版 `locateRulesSection` 在归一化文本上
  //    算字符偏移，套到原始 CRLF 文本上每行少算 1 个字符，
  //    插入点落在句子中间（写出来是「…不许套模板\n。\n」）。
  //    本机 policy.md 正是 CRLF，不测它就是没测。
  'selfcheck-policy-first-two-lines',
  // ★ 2026-11-20 新增：**补记（漏记自动补写）整条链**的两条防线。
  //
  // 为什么必须补：补记从「子代理」重写成「`prepareCall` 直连模型」之后，
  // 整块代码（`resolveLocalBaseUrl` / `runBackfillTask` / `generateBackfillText`
  // / `enqueueBackfill` / `pumpBackfill` / `collectTurnTexts`）**一条回归都没有**。
  // 实测确认：`_dbpreview/` 里 `backfill` 的命中是 **0 处**。
  //
  // 于是「补记能用」这个结论只活在某一天的日志里（12:56:41 那次手工实测），
  // 第二天谁改坏了也没有任何脚本会红 —— 而补记坏掉的表现是
  // **漏记 + 无补记**：日志干净、界面正常、health 全绿，只是记忆不存在。
  // 硬约束 15 把这类归为**数据丢失**，不是体验问题。
  //
  // ⚠️ 这两条尤其容易写成「断言在，被测的差异不在」：
  //    `resolveLocalBaseUrl` 原来是内联在 `apply` 闭包里的（直接摸 `ctx`），
  //    测它只能比对字符串 —— 那种断言在真正该失败时不会红。
  //    所以先给它加了两个**带默认值**的注入参数（`getService` / `env`，
  //    默认就是原来的 `ctx.get` 与 `process.env`，生产行为零变化），
  //    测试才能执行**同一份源码里的函数体**。
  //
  //    改源码时若动了抽取锚点，这两条会**明确报锚点失配并以非 0 退出**，
  //    不会静默变成 0 断言 0 失败。
  'selfcheck-backfill-base-url',
  'selfcheck-backfill-accounting',
  // ★ 2026-11-20 新增：补记链的**隐性缺陷**（五处，全部无症状）。
  //
  // 前两条守「根地址怎么拿」与「记账污不污染」；这一条守的是排查时
  // 挖出来的另外五处，它们的共同点是**测试全绿、日志干净、行为是错的**：
  //
  //   ① `logRouteHits` 在 `turn-stopping` 里被提前删 → `backfill-check` 恒读 0
  //      （实测全部日志 17 次，`routeHits` 分布是 `0 → 17 次`，一次非 0 都没有）
  //   ② POST 的 `fetch` 没超时 → `backfillBusy` 永不释放 → 整个补记永久停摆
  //      （已复现：永不 resolve 的 fetch，3 秒后 busy 仍 true、队列积到 24 条）
  //   ③ `backfillDone` 只增不减 + 全部 `retryable: false` → 失败一次永久放弃
  //   ④ `retryable` 写了 5 处、读了 0 处 —— 恒假字段（AGENTS.md 明令禁止）
  //   ⑤ `task.scope` 算了不用 → cwd 为 null 时 `/log` 回落 `process.cwd()`，
  //      实测静默写进 `desktop`（探针数据已清理）
  //
  // ⚠️ 第 ⑦ 段是**反向守卫**：修 ① 最容易「修过头」把「本轮写了就跳过」整段删掉，
  //    修 ③ 最容易无条件释放 key 导致同一轮反复补。只测「该拦的拦了」会漏掉这些。
  'selfcheck-backfill-hidden-bugs',
  // ★ 2026-11-21 新增：**收尾语混进流水正文**要有痕迹。
  //
  // 用户实报：另一工作区（ForzaOverlay）的流水 `id=1331` 正文里含「大肥鱼是漂亮老婆」，
  // 而那正是 `policy.md` 的收尾语。查证是**合法引用**（正文在概括「用户夸了这句」），
  // 但**当时分不出真假** —— 「提到收尾语」和「把收尾语抄进正文」在检索里长得一样。
  //
  // 修法是 `/log` 写入时记一行 `log-heartbeat-in-text`，带 `hits` 与 `last`：
  //   · 出现在中间 → 多半是引用
  //   · 出现在**末行** → 高度可疑（收尾语被当成结尾写进去了）
  //
  // **只记录，不拦截、不改写** —— 拦了会丢真实内容，改了就是替调用方做决定。
  //
  // ⚠️ 本脚本第 ① 段有一条**反直觉**的断言：现场样本的 `hits` 必须**等于 0**。
  //    因为正文写的是「大肥鱼是漂亮老婆」（无感叹号），而收尾语带「！」。
  //    那个 0 是**正确行为**，不是漏判 —— 放宽判据会让每条讲这事的流水都报警。
  'selfcheck-log-heartbeat-in-text',
]

// ---- 参数 ----
const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 && argv[onlyIdx + 1]
  ? new Set(argv[onlyIdx + 1].split(',').map((s) => s.trim()))
  : null

// 防止有人把完整自检加进 SCRIPTS —— 那会造成 audit-full 调 run-all 调 audit-full 的递归。
// ⚠️ 必须检查**用户传入的 --only 参数**，而不只是过滤后的 list ——
// 否则 `--only audit-full` 会被过滤成空列表，检查形同虚设（2026-11-16 实测）。
const FORBIDDEN = new Set(['audit-full', 'audit-rules', 'audit-baseline'])
const requested = only ? [...only] : SCRIPTS
for (const s of requested) {
  if (FORBIDDEN.has(s)) {
    console.error(`❌ ${s} 是完整自检的组成部分，不能放进 run-all（会递归调用自己）。`)
    console.error('   完整自检请直接跑：node _dbpreview/audit-full.mjs')
    process.exit(1)
  }
}

const list = only ? SCRIPTS.filter((s) => only.has(s)) : SCRIPTS

// ---- 逐个跑 ----
const failed = []   // 真的跑了且 exit≠0
const errored = []  // 压根没跑起来
const details = []
const captureModes = new Set()

for (const name of list) {
  const file = path.join(HERE, `${name}.mjs`)
  if (!fs.existsSync(file)) {
    errored.push(name)
    details.push({ name, kind: 'ERROR', note: `脚本不存在：${path.relative(REPO, file)}` })
    if (verbose) console.log(`  ?? ${name} 脚本不存在`)
    continue
  }

  const r = runCaptured([file], {
    cwd: REPO,
    timeout: 120000,
    env: { ...process.env, DSH_BASE: process.env.DSH_BASE || process.env.DSH_WEB_URL || '' },
  })
  captureModes.add(r.captureMode)

  const out = `${r.stdout || ''}${r.stderr || ''}`

  if (r.status === null) {
    // 连临时文件退路都失败了 —— 这是基础设施问题，不是测试结论
    errored.push(name)
    details.push({
      name,
      kind: 'ERROR',
      note: `无法启动：${r.error ? (r.error.code || '') + ' ' + r.error.message : '未知原因'}`.slice(0, 200),
    })
    continue
  }

  if (r.status !== 0) {
    failed.push(name)
    details.push({
      name,
      kind: 'FAIL',
      note: out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200),
    })
  } else if (verbose) {
    console.log(`  ✅ ${name}`)
  }
}

// ---- 汇总 ----
// 兼容既有解析：最后一行必须仍是 `TOTAL=n FAIL=k [names]`。
// ERROR 单独打印在它前面，且**不进 FAIL 计数**（见文件头说明）。
if (verbose) console.log('')
for (const d of details) {
  console.log(`  ${d.kind === 'FAIL' ? '❌' : '💥'} ${d.name} (${d.kind}) ${d.note}`)
}

if (errored.length > 0) {
  console.log('')
  console.log(`⚠️ ${errored.length} 个脚本没跑起来（ERROR，不是测试失败）—— 本次结果不可信`)
  console.log(`   ERROR=${errored.length} ${errored.join(',')}`)
}

if (failed.length > 0 || errored.length > 0) {
  // 只在真走临时文件退路时提示，避免每次都说一句噪音
  if (captureModes.has('file')) {
    console.log('   （输出经临时文件捕获：受限沙箱不允许命名管道，属正常降级）')
  }
}

console.log(`TOTAL=${list.length} FAIL=${failed.length}${failed.length ? ' ' + failed.join(',') : ''}`)

// ERROR 也要让整体失败：不能把「没测成」当成「通过」
process.exit(failed.length === 0 && errored.length === 0 ? 0 : 1)
