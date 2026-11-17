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
  'verify-v3-schema',
  'test-marker-forms',
  'selfcheck-search-tier',
  'selfcheck-scope-rename',
  // ★ 2026-11-16 新增：policy.md 一次性覆盖的真实行为回归。
  //   这是唯一真正 import 并执行 createStore.ensureLayout 的脚本 ——
  //   之前的测试只查「源码里有没有那几行字」，从不执行覆盖逻辑，
  //   于是漏掉了「升级时收尾语随覆盖丢失」这个真 bug。详见脚本头部注释。
  'selfcheck-policy-sync',
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
  //   守的是硬约束 11b —— 记忆目录必须留在工作区之外。
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
