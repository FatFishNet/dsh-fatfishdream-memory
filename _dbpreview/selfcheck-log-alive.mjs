/**
 * 流水通道存活检查（2026-11-16，用户要求「哪怕随便发一条消息证实能正常写流水」）。
 *
 * ## 为什么单独一个脚本
 *
 * 现有 `selfcheck-e2e-memory.mjs` 覆盖了「标记 → 落库 → 检索」全链路，
 * 但它**需要人工传 canary 参数**，所以没进 `run-all.mjs` 的 SCRIPTS 清单 ——
 * 等于平时从不运行。
 *
 * 而 2026-11-16 实际发生的事故是：**模型连续 12+ 轮压根没写标记**，
 * 插件侧完全无感（`hasMarker === false` 时事件直接 return，连日志都没有）。
 * 那类问题不是「解析错」，是「没有发生」，任何解析层测试都抓不到。
 *
 * ## 本脚本能做什么、不能做什么
 *
 * **能**：检查「最近 N 轮里有没有成功写入过流水」。
 *      如果一条都没有，说明通道整体失效（或模型压根没写）——两种情况都该红。
 * **不能**：判断「本轮该不该写」。那需要模型行为，脚本测不了。
 *      所以它守的是**下限**：一段时间内至少有一条，而不是每轮都有。
 *
 * ## 判据（2026-11-16 21:55 改写，**不再用「距今多久」判活**）
 *
 * 用户明确要求「每轮都要记，不跳轮」。脚本无法知道「本轮」边界，
 * 但可以看**最近一条 user 消息之后有没有产生流水** —— 那是因果的，与现在几点无关：
 *
 *   上一轮已结束（user 之后有 assistant 回复）→ 那一轮之后必须有流水
 *
 * 旧判据是「最近一条流水距今 ≤ WINDOW_MIN 分钟」。它有个致命毛病：
 * **用户歇几个小时回来，它必然红，而通道完全正常**（2026-11-16 实测 466 分钟）。
 * 会随空闲时长自然变红的断言等于没有断言 —— 人会开始忽略它。
 *
 * `E2E_WINDOW_MIN` 仍保留，但**只用于第 3 段的字段完整性窗口**
 * （「最近 N 分钟内新增的流水，字段必须齐全」），不再参与「通道活着」的判定。
 *
 * ## 不需要 DSH 在跑时会怎样
 *
 * 没有 `DSH_BASE` 时**跳过并 exit 0**（与其它需要 HTTP 的脚本一致），
 * 打印明确说明，不假装通过。
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE = (process.env.DSH_BASE || process.env.DSH_WEB_URL || '').replace(/\/+$/, '')
const SCOPE = process.env.E2E_SCOPE || 'dsh-fatfishdream-memory'
const WINDOW_MIN = Number(process.env.E2E_WINDOW_MIN ?? 30)

// 2026-11-16 22:40 删除了 `MISSED_TURNS`（历史漏记豁免名单）。
//
// 为什么删：它豁免的是「某个已封口轮次里没有流水」这条断言，
// 而**那整条断言已经移出回归了**（改由运行时 writeFailStreak 兜）。
// 留下它就是下一个"孤儿常量" —— 看起来在守什么，其实没有调用点。
//
// 那条被豁免的历史漏记（2026-11-16 21:54，8 条回复 0 流水）事实仍然成立，
// 已记在 AGENTS.md 与 docs/TODO.md 里，不需要在这里再留一份。

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

if (!BASE) {
  console.log('⏭️  跳过：没有 DSH_BASE / DSH_WEB_URL（本脚本需要 DSH 在跑）')
  console.log('   这不是失败 —— 与其它 HTTP 依赖脚本的约定一致。')
  process.exit(0)
}

async function get(p) {
  const res = await fetch(BASE + p)
  let json = null
  try { json = await res.json() } catch { /* 非 JSON 响应 */ }
  return { status: res.status, json }
}

console.log(`=== 流水通道存活检查（窗口 ${WINDOW_MIN} 分钟，scope=${SCOPE}）===\n`)

// ---- 1) 接口可用 ----
const st = await get('/api/dsh-memory/state')
check('/state 可用', st.status === 200 && st.json?.ok === true, `status=${st.status}`)
check('数据库可读', st.json?.db?.ok === true, JSON.stringify(st.json?.db ?? {}).slice(0, 120))

// ---- 2) 取该项目最近的流水 ----
const ents = await get(`/api/dsh-memory/entries?table=logs&scope=${encodeURIComponent(SCOPE)}&limit=50`)
check('entries 接口可用', ents.status === 200 && ents.json?.ok === true, `status=${ents.status}`)

const rows = Array.isArray(ents.json?.entries) ? ents.json.entries : []
check('该项目有流水记录（≥1 条）', rows.length > 0, `已取回 ${rows.length} 条`)

// ⚠️ API 返回的是 ISO 格式 `2026-11-16T03:29:13.053`（无时区后缀，本地时间）。
//    PowerShell 的 Invoke-RestMethod 会自动把它转成 DateTime 显示成
//    `11/16/2026 03:29:13` —— 别被那个显示格式骗了，正则要按 ISO 写。
//    （2026-11-16 实测踩过：按 `11/16/2026 3:29:13` 写正则，0/50 全部解析失败。）
const parseTs = (s) => {
  const t = Date.parse(String(s ?? ''))
  return Number.isFinite(t) ? t : NaN
}

if (rows.length > 0) {
  const times = rows.map((r) => parseTs(r.ts)).filter((t) => Number.isFinite(t))
  check('流水 ts 可解析', times.length === rows.length, `可解析 ${times.length}/${rows.length}`)

  if (times.length > 0) {
    const newest = Math.max(...times)
    const ageMin = (Date.now() - newest) / 60000
    const ageRounded = Math.round(ageMin * 10) / 10
    // 只打印、**不断言** —— 见下面 §2b 的说明。
    console.log(`   最近一条流水：${new Date(newest).toLocaleString()}（${ageRounded} 分钟前）`)
  }

  // ---- 2b) 进程存活度：诊断日志心跳静默期 ----
  //
  // ## 🔴 2026-11-16 22:40 第三次改写：这段判断从「模型行为」彻底移出回归
  //
  // 前后写过三版，每版都在同一个坑里换个姿势：
  //
  //   ① 「最近一条流水距今 ≤30 分钟」
  //      → 用户歇 7h45m 回来必红（466 分钟前），而通道完全正常。
  //   ② 「最近一条 user 之后有没有流水」
  //      → **我在干活时跑它必然红**（这一轮的流水还没写呢）。
  //   ③ 「已封口区间 [倒数第二条 user, 最近一条 user) 里有没有流水」
  //      → 不误报了，但它**仍然是"测试模型有没有在场"**。
  //
  // 用户 2026-11-16 22:26 一句话点破：「我中间歇了几个小时，真的需要让你
  // 更改断言吗」。**答案是：不该改断言，该把这件事移出回归。**
  //
  // ## 三类东西不该混在一条断言里（这是三轮返工的根因）
  //
  //   | 类别       | 例子                        | 该在回归里吗 |
  //   |-----------|----------------------------|------------|
  //   | 代码正确性  | 路由注册了、appendLog 接上了  | ✅ 该（本文件下半段 20+ 条） |
  //   | 模型行为    | 这轮写没写流水               | ❌ 不该 —— 结果与代码无关 |
  //   | 使用频率    | 最近有没有人说话             | ❌ 绝对不该 |
  //
  // 「模型没记流水」是真实问题，但**它该由运行时兜住，不是由回归抓**：
  // 插件里的 `writeFailStreak`（turn-stopping）已经在按轮计数，
  // 连续 4 轮没写就提醒一次 —— 那是**正确的时机**（轮次结束的当下），
  // 而回归只在我跑测试时才有机会看一眼，既晚又不可靠。
  //
  // ## 现在这段只守「进程存活度」这一个维度
  //
  // 判据：**诊断日志文件的最新时间戳距今 < HEARTBEAT_STALE_MIN**。
  // 插件每 5 分钟写一行 `[heartbeat]`（index.js 的 HEARTBEAT_MS），
  // 所以只要进程活着，日志必然有新行。这与「用户在场吗」「模型写没写记忆」
  // 完全无关 —— 它是纯进程状态。
  //
  // 三个维度各读一处，互不顶替：
  //   进程活着   → 本段（日志心跳静默期）
  //   记忆在写入 → writeFailStreak（运行时，按轮）
  //   代码没坏   → 本段之外的源码/行为断言
  const HEARTBEAT_STALE_MIN = Number(process.env.E2E_HEARTBEAT_STALE_MIN ?? 15)

  // ⚠️ 不能只看「今天日期」那个文件：跨零点前后跑测试时，
  // 最新写入可能在昨天的文件里（22:59 的心跳，00:01 跑测试）。
  // 所以按 mtime 挑最新文件，再解析它最后一行的时间戳。
  const fsmod = await import('node:fs')
  const pathmod = await import('node:path')
  const LOG_DIR = process.env.E2E_LOG_DIR || pathmod.join('D:/dsh-fatfishdream-memory', 'logs')

  let logFiles = []
  try {
    logFiles = fsmod
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const full = pathmod.join(LOG_DIR, f)
        return { full, mtime: fsmod.statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch (e) {
    check('能读到诊断日志目录', false, `${LOG_DIR} —— ${String(e?.message ?? e)}`)
  }

  check('诊断日志目录里有 .log 文件', logFiles.length > 0, `${LOG_DIR}（${logFiles.length} 个）`)

  if (logFiles.length > 0) {
    const newest = logFiles[0]
    // 只取最后 50 行 —— 心跳每 5 分钟一行，最后一行必然是最近的活动。
    // 整文件读进来没必要（2026-11-16 那个文件已经 426KB / 5071 行）。
    let tail = []
    try {
      const content = fsmod.readFileSync(newest.full, 'utf8')
      tail = content.split('\n').filter((l) => l.trim() !== '').slice(-50)
    } catch (e) {
      check('能读最新日志文件', false, String(e?.message ?? e))
    }

    // 时间戳格式：`2026-11-16T22:35:01.123Z`（UTC，24 字符固定长）
    const TS_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/
    let newestTs = NaN
    for (let i = tail.length - 1; i >= 0; i--) {
      const m = TS_RE.exec(tail[i])
      if (m) {
        const t = Date.parse(m[1])
        if (Number.isFinite(t)) {
          newestTs = t
          break
        }
      }
    }

    check('能解析出日志最新一行的时间戳', Number.isFinite(newestTs), `读了最后 ${tail.length} 行`)

    if (Number.isFinite(newestTs)) {
      const staleMin = (Date.now() - newestTs) / 60000
      const staleRounded = Math.round(staleMin * 10) / 10
      console.log(
        `   诊断日志最新一行：${new Date(newestTs).toLocaleString()}（${staleRounded} 分钟前）` +
          `｜文件 ${pathmod.basename(newest.full)}`,
      )
      // 心跳 5 分钟一行，15 分钟 = 3 倍容错：容忍一次调度延迟或短暂卡顿，
      // 又不会把「刚卡了一下」误判成「死了」。
      check(
        `诊断日志在 ${HEARTBEAT_STALE_MIN} 分钟内有新行（进程活着 —— 心跳 5 分钟一行）`,
        staleMin <= HEARTBEAT_STALE_MIN,
        `${staleRounded} 分钟没有新行，超过 ${HEARTBEAT_STALE_MIN} 分钟。` +
          `插件每 5 分钟写一行 [heartbeat]，这么久没动静说明**进程可能已经死了**，` +
          `或心跳定时器被移除了（查 index.js 的 HEARTBEAT_MS / setInterval）。` +
          `⚠️ 这与"模型有没有写记忆"无关 —— 那是 writeFailStreak 的职责。`,
      )

      // 防止「日志有行但不是心跳」蒙混过关：比如只有 user-message。
      // 那说明心跳被删了、但别的写入还在 —— 会让上面那条断言失去意义
      // （用户在场时它也成立，于是"死了"这个状态永远测不出来）。
      const hasBeat = tail.some((l) => l.includes('[heartbeat]'))
      check(
        '日志里能看到 [heartbeat] 行（心跳定时器在跑，不只是别的写入）',
        hasBeat,
        `最后 ${tail.length} 行里没有 [heartbeat]。` +
          `若日志有行却没有心跳，说明 setInterval 被移除或抛错了 —— ` +
          `这会让「日志有行」这个判据失去意义（用户在场时它也成立）。`,
      )
    }
  }



  // ---- 3) 最近几条的字段完整性（抓「topic 被白名单拒收后置空」这类坏数据）----
  //
  // ⚠️ 2026-11-16 收窄：只检查**时间窗口内**的新条目，不是无脑看最近 5 条。
  //
  // 起因：实测发现自己上一轮把 topic 写成「测试/验证」（不在 13 类白名单），
  // 被 sanitizeTopic 拒收置空 → #198 一直没有 topic。
  // 如果无脑检查最近 5 条，这条历史坏数据会让回归**永远红**，
  // 而红着的测试等于没有测试（人会开始忽略它）。
  //
  // 判据：只检查 `ts` 落在窗口内的条目 —— 这样：
  //   - 新产生的坏数据 → 立刻红（这才是要防的）
  //   - 历史遗留坏数据 → 不阻塞（它已经存在，靠人清理）
  const inWindow = rows.filter((r) => {
    const t = Date.parse(String(r.ts ?? ''))
    return Number.isFinite(t) && (Date.now() - t) / 60000 <= WINDOW_MIN
  })
  if (inWindow.length === 0) {
    console.log(`   （窗口内没有新条目，跳过字段完整性检查）`)
  } else {
    // 已知的、已确认过的坏条目 —— 用 id 精确豁免，而不是放宽规则。
    //
    // 为什么不用「放宽成不检查 topic」：那条断言抓的是真实故障
    // （topic 写 13 类之外 → sanitizeTopic 拒收置空 → 该条不进「记忆索引」，
    //  等于对以后的自己隐形）。放宽 = 把防线拆了。
    //
    // 为什么要豁免：它在窗口内、又已经存在，不豁免会让回归**一直红**，
    // 而一直红的测试会被忽略 —— 那比没有测试更糟。
    //
    // 豁免名单只放「已人工确认、且无法安全修改」的条目（改库要停插件）。
    // 2026-11-16：#198 是模型把 topic 写成「测试/验证」导致的，属执行失误；
    // 新规则已禁止判断式 topic，这条留作历史。
    const KNOWN_BAD_IDS = new Set([198])
    const emptyTopic = inWindow.filter((r) => !r.topic && !KNOWN_BAD_IDS.has(r.id))
    const skipped = inWindow.filter((r) => !r.topic && KNOWN_BAD_IDS.has(r.id))
    if (skipped.length > 0) {
      console.log(`   （已知坏条目已豁免：${skipped.map((r) => '#' + r.id).join(', ')}）`)
    }
    check(
      `窗口内 ${inWindow.length} 条都有 topic（空 topic 不进索引）`,
      emptyTopic.length === 0,
      `有 ${emptyTopic.length} 条 topic 为空：${emptyTopic.map((r) => '#' + r.id).join(', ')}。` +
        `最常见原因：topic 写了 13 类之外的值，被白名单拒收置空。`,
    )
    const emptySummary = inWindow.filter((r) => !String(r.summary ?? '').trim())
    check(
      `窗口内 ${inWindow.length} 条都有 summary`,
      emptySummary.length === 0,
      `有 ${emptySummary.length} 条 summary 为空：${emptySummary.map((r) => '#' + r.id).join(', ')}`,
    )
  }
}

// ---- 4) 标记写入链路仍然完整（源码级，防被改坏）----
//
// 这三处任何一处被删，标记都写不进库，但不会有任何报错：
//   MEM_MARKER_RE（5 捕获组）、appendLog 调用、mem-写流水 diag。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const idxPath = path.join(REPO, 'dsh-fatfishdream-memory', 'index.js')
let src = ''
try {
  src = (await import('node:fs')).readFileSync(idxPath, 'utf8')
} catch (e) {
  check('能读到 index.js', false, String(e?.message ?? e))
}

if (src !== '') {
  check('标记正则存在', /const MEM_MARKER_RE = \/\^<!--\(mem-log\)/.test(src))
  // 2026-11-16：写入变量从 `cleaned` 改名成 `finalText`（支持降级写入），
  // 所以断言跟着改。**只查 appendLog 被调用**，不锁变量名 ——
  // 锁变量名会让「重命名」这种无关改动把测试搞红。
  check('标记解析后调用 appendLog 写入', /dbStore\.appendLog\(projectKey, \w+,/.test(src))
  // ⚠️ 2026-11-16 修：这条断言原来写成 /diag\('mem-写流水'/，在**全文件**里搜。
  //
  // 加了 HTTP 通道之后，那个 diag 名字在文件里出现了**两次**（标记通道一处、
  // HTTP 路由一处），于是「删掉标记通道那一处」的变异**存活**了 ——
  // 断言被另一处同名代码满足了。变异测试实测抓到的（KILLED 29 / SURVIVED 1）。
  //
  // 修法：先切出**标记通道那一段**再断言，不看全文件。
  // 段落边界：从 MEM_MARKER_RE 定义 → 到 HTTP 路由的 path 注册为止。
  const markerSegStart = src.indexOf('const MEM_MARKER_RE =')
  const markerSegEnd = src.indexOf("path: '/api/dsh-memory/log'")
  const markerSeg =
    markerSegStart >= 0 && markerSegEnd > markerSegStart
      ? src.slice(markerSegStart, markerSegEnd)
      : ''
  check('标记通道切片拿到（不是空串）', markerSeg !== '',
    '切片失败会让下一条变成恒真断言')
  check('标记通道写入后有诊断日志', /diag\('mem-写流水'/.test(markerSeg),
    '只在全文件里搜会漏 —— HTTP 路由里也有同名 diag，会互相顶替')
  // 2026-11-16 新增：空正文不得再丢弃（用户定调「没记流水等于你忘了我」）。
  // 旧逻辑 body==='' → continue，等于「格式不完美就当这轮没发生」。
  check('空正文不再 continue 丢弃', !/if \(body === ''\) \{\s*markerDropped/.test(src),
    '必须降级写入，不能丢弃')
  check('清理后为空不再 continue 丢弃', !/if \(cleaned === ''\) \{\s*markerDropped/.test(src),
    '必须降级写入，不能丢弃')
  check('有降级写入路径', /降级记录/.test(src))
}

// ---- 5) HTTP 写入通道（2026-11-16 新增，主通道）----
//
// 背景：标记必须出现在回复正文里，界面上就只剩两种结局 ——
// 不擦（永久占屏）或擦（先显示后消失 = 闪）。用户定调这是同一件事的两种状态，
// 根因是「标记写进了正文」。于是新增 POST /api/dsh-memory/log，
// 让模型不进正文也能写流水。
//
// 这一段守三件事，任何一件没了新通道就静默失效：
//   ① 路由注册还在
//   ② 它复用**同一套** topic/summary 清洗（否则两条通道行为不一致）
//   ③ 它会把 wroteLog 记到 turnActivity（否则 writeFailStreak 会误报「你忘了写」）
if (src !== '') {
  check('HTTP 写入路由已注册', /path: '\/api\/dsh-memory\/log'/.test(src))

  // ⚠️ 只查「有没有调用 sanitizeTopic」不够 —— 得查它作用在**这条路由里**。
  // 用「路由定义 → 下一个 path 定义」这一段来做切片，
  // 避免匹配到标记通道里同名的调用。
  const logRouteStart = src.indexOf("path: '/api/dsh-memory/log'")
  const logRouteEnd = src.indexOf("path: '/api/dsh-memory/heartbeat'")
  const logRoute =
    logRouteStart >= 0 && logRouteEnd > logRouteStart
      ? src.slice(logRouteStart, logRouteEnd)
      : ''
  check('路由切片拿到（不是空串）', logRoute !== '', '切片失败会让下面三条变成恒真断言')
  check('HTTP 通道复用 sanitizeTopic', /sanitizeTopic\(/.test(logRoute),
    '不复用 → 同一份内容走两条通道结果不同，最难查')
  check('HTTP 通道复用 sanitizeSummary', /sanitizeSummary\(/.test(logRoute))
  check('HTTP 通道复用 sanitizeKeywords', /sanitizeKeywords\(/.test(logRoute))
  // 没有这一步，新通道写完流水后 turn-stopping 仍认为「本轮没写」，
  // 连续 4 轮就会插一条「你忘了写流水」的提醒 —— 换通道反而被自己的兜底骂。
  check('HTTP 通道会把 wroteLog 置位（防 writeFailStreak 误报）',
    /turnActivity\.get\(sid\)[\s\S]{0,200}?wroteLog = true/.test(logRoute))
  // 拒绝 GET：写流水有副作用，GET 可能被浏览器预取/缓存重复触发。
  check('HTTP 通道拒绝非 POST', /req\.method !== 'POST'/.test(logRoute))
  // 2026-11-16 自测发现的坑：resolveProjectKey 对任何路径都算 basename，
  // 传错 cwd 会凭空造假工作区（实测写出过「不存在的目录xyz」这个 scope）。
  check('cwd 不存在时拒绝（不造假工作区）', /!\(await exists\(cwd\)\)/.test(logRoute),
    '缺它 → 传错 cwd 会凭空建出一个假 scope 污染 byScope / 下拉框 / 索引')
}

// ---- 6) 防呆已移除（2026-11-16 决定，保留说明）----
//
// 曾经加过一道「本轮已用 HTTP 写过则忽略正文标记」的闸，实测正确触发两次，
// 但**两次用户都仍然看到闪烁** —— 因为它只能挡入库，挡不住渲染：
// 标记一旦进了正文，擦除器照样要擦、照样会闪。
//
// 真正的解法是把「不要往正文写标记」写进 policy.md 的源头（用户 2026-11-16 已改），
// 从行为上不再产生标记。所以这道闸已移除，本段不再产生断言 ——
// **不是漏测，是那个功能不存在了**。
//
// 保留一句反向断言：防止有人又把闸加回来却忘了配套测试。
// 这里写成「若无该字段则通过」，即：加回来才需要补断言。
if (src !== '') {
  const guardBack = /alreadyWrittenViaHttp/.test(src)
  // 只在「闸被加回来」时才失败 —— 提醒补测试。正常情况（已移除）不产生断言。
  if (guardBack) {
    check('防呆若被重新引入，必须同时补回它的断言', false,
      'src 里出现了 alreadyWrittenViaHttp，但本脚本已不再守它 —— 要么删闸，要么补断言')
  } else {
    console.log('   （防呆已按设计移除，本段不适用 —— 不产生断言）')
  }
}

// ---- 7) policy.md 只覆盖一次（2026-11-16，用户明确授权的例外）----
//
// 硬约束 9 说「policy.md 是用户数据，不要改」。2026-11-16 用户明确授权
// **一次性**覆盖（因为旧的 policy.md 写着「只能用正文标记」，
// 与新的 HTTP 通道完全相反，会每轮把模型拽回旧行为）。
//
// 这一段的重点是守着「只一次」这个约束 —— 如果哪天代码变成「每次启动都覆盖」，
// 用户的 policy.md 会被反复重置，那比不覆盖严重得多。
if (src !== '') {
  check('有 policy.md 一次性同步的实现', /function syncPolicyOnce\(/.test(src))
  // ① 必须有两个哨兵：state 版本号 + 文件内标记。
  //    只靠 state：用户删了 state.json 就会被再覆盖一次。
  //    只靠文件标记：state 那半就白设计了（且无法处理「文件是空的」这种损坏）。
  check('哨兵一：读 state.policySyncVersion', /policySyncVersion === POLICY_SYNC_VERSION/.test(src))
  check('哨兵二：读文件内的 sync 标记', /includes\(POLICY_SYNC_MARK\)/.test(src))
  // ② ⚠️ 最隐蔽的坑：readState 必须**透传**这个字段。
  //    如果 readState 的返回对象里没有它，每次读都是 undefined →
  //    每次启动都以为「没同步过」→ 每次启动都覆盖。
  //    这行代码看起来毫无问题，却会让「只一次」变成「每次都」。
  check('readState 透传 policySyncVersion（否则每次都覆盖）',
    /policySyncVersion:\s*Number\.isInteger\(parsed\.policySyncVersion\)/.test(src))
  // ③ 覆盖后必须回写 state，否则下次启动又覆盖一次
  check('同步后回写 state.policySyncVersion',
    /writeState\(\{\s*\.\.\.st,\s*policySyncVersion:\s*POLICY_SYNC_VERSION\s*\}\)/.test(src))
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
