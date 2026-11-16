/**
 * 项目地图行号通用校验（P1）
 *
 * ## 为什么需要这个脚本
 *
 * 2026-11-17 的审计发现：地图里 108 处 `L####`，三个既有脚本只覆盖 26 处，
 * 其余 82 处**没有任何内容校验**。抽查其中可现算的 45 处，**全部对不上**。
 *
 * 既有脚本各自的盲区：
 *   - `verify-map`         只判「该行非空」→ 错位后的行全都是非空的
 *   - `verify-map-content` 只认 「`符号`（L####）」紧贴形态 → 28/108
 *   - `verify-symbol-lines` 只守 §3.1 那张裸数字表
 *
 * 本脚本补的是**其余三种形态**：
 *   A. | `符号` | L#### |          表格列
 *   B. L####  符号名               行首锚点
 *   C. | 数字 | `符号` |           裸数字表（§5 那种）
 *
 * ## 判据（必须严格，否则又是恒真）
 *
 * 1. 能从符号名在源码里**唯一定位**到定义行 → 比对
 * 2. 定位不到 → **不判红**，只记「无法自动核对」（手写描述性文字属于此类）
 * 3. 能定位但行号不符 → **判红**
 *
 * ⚠️ 第 2 条是刻意的：地图里有些行首条目写的是描述（「注入层」「标记写入监听」），
 *    不是符号名，自动核对不了。把它们判红会制造大量噪音，人就开始忽略整个脚本
 *    —— 那正是 AGENTS.md 里「会随时间自然变红的断言等于没有断言」的同一个病。
 */
import { readFileSync, existsSync } from 'node:fs'

const FILES = {
  index: 'dsh-fatfishdream-memory/index.js',
  client: 'dsh-fatfishdream-memory/client.js',
  store: 'dsh-fatfishdream-memory/db-store.mjs',
  schema: 'dsh-fatfishdream-memory/db-schema.mjs',
}

const sources = {}
for (const [k, p] of Object.entries(FILES)) {
  sources[k] = existsSync(p) ? readFileSync(p, 'utf8').split('\n') : []
}

/**
 * 按符号名找定义行（1-based）。返回 { file, line, count } 或 null。
 *
 * ⚠️ 2026-11-17 修（第一版漏了三种形态，导致 24 处「无法核对」）：
 *   ① **函数有缩进**：`function readHeartbeat()` 在 apply 内部，前面有 2 空格，
 *      而第一版用 `^function` 锚死了行首 → 一律定位不到。
 *      改成允许行首缩进 `^\s*`。
 *   ② **React 组件是 `const X = (`**：`client.js` 里
 *      `const MemoryPanel = (` 后面直接换行，第一版要求 `= $` 结尾 → 漏。
 *      改成 `=` 后面允许空白/换行（用 `=\s*$` 或 `=\s*\(`）。
 *   ③ **事件名不是符号**：`tools/result`、`agent/turn-stopping` 是事件名，
 *      根本没有「定义行」。这类应当在调用前就排除（含 `/` 且像 `a/b` 形态的
 *      交给另一套判断），不要在这里硬找。
 */
function findSymbol(name) {
  // 含 `/` 的通常是事件名（tools/result）或路径，不是可定义符号 —— 直接放弃
  if (name.includes('/') || name === 'ctx.effect' || name === 'let' || name === 'HTTP') return null
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    // function / async function，允许缩进（apply 内部全是缩进的）
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${esc}\\s*\\(`),
    // const/let/var，允许 `=` 后换行（React 组件 `const X = (`）
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*=\\s*(?:$|\\()`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${esc}\\s*=`),
  ]
  const hits = []
  for (const [fk, lines] of Object.entries(sources)) {
    lines.forEach((l, i) => {
      if (patterns.some((re) => re.test(l))) hits.push({ file: fk, line: i + 1 })
    })
  }
  if (hits.length === 0) return null
  return { ...hits[0], count: hits.length }
}

/**
 * 按**事件名**找注册行（1-based）。返回 { file, line } 或 null。
 *
 * ⚠️ 2026-11-17 加（补 3 处真错位）：
 *   地图里有三行写的是事件名：
 *     | `tools/result`        | L3198 |
 *     | `agent/turn-stopping` | L3119 |
 *     | `agent/created`       | L3500 |
 *   它们的「定义」不是 const/function，而是 `safeOn('事件名', ...)` 这一行。
 *   第一版用 findSymbol 找不到，于是把这 3 条记成「无法核对」——
 *   **那是我判据错了，它们其实是错了 700~900 行的真错误**。
 *
 *   实际正确位置：tools/result L4040、turn-stopping L4101、agent/created L4252。
 */
function findEvent(name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`safeOn\\('${esc}'`)
  const hits = []
  for (const [fk, lines] of Object.entries(sources)) {
    lines.forEach((l, i) => {
      if (re.test(l)) hits.push({ file: fk, line: i + 1 })
    })
  }
  if (hits.length === 0) return null
  return { ...hits[0], count: hits.length }
}

/**
 * `ctx.effect`、`ctx.inject` 这类**对象方法调用**不是定义符号，
 * 判据只能是「该行确实包含这个调用」。
 *
 * ⚠️⚠️ 2026-11-17 踩过的坑（**这里差点误判文档**）：
 *   第一版只返回「第一个命中的行」，而 `ctx.effect` 在 **index.js 有 2 处
 *   （L2814 / L5842）、client.js 有 3 处（L2474 / L2479 / L2490）**。
 *   按文件字典序 index 在前，于是返回 index.js:2814，
 *   报「地图 L2474 错，实际 2814」——**但地图是对的**：
 *   那一行讲的是 client.js 里「擦除器挂载在 ctx.effect」，L2474 后面紧跟
 *   `() => installMarkerScrubber()`，完全正确。
 *
 *   修法：**多文件都可能有同名调用**，不能只返回第一个。
 *   返回全部命中，核对时只要**任一命中**等于 claimed 就算对。
 */
function findCall(name) {
  const hits = []
  for (const [fk, lines] of Object.entries(sources)) {
    lines.forEach((l, i) => {
      if (l.includes(name)) hits.push({ file: fk, line: i + 1 })
    })
  }
  return hits.length ? { hits, first: hits[0] } : null
}

const MAP = 'docs/项目地图.md'
const lines = readFileSync(MAP, 'utf8').split('\n')

const results = []

// ── 形态 A：| `符号` | L#### | ──
const RE_TABLE_L = /^\|\s*`([^`]+)`\s*\|\s*L(\d{3,4})\s*\|/
// ── 形态 B：行首 L####  符号名 ──
const RE_LEAD_L = /^L(\d{3,4})\s{2,}([^\s（(←]+)/
// ── 形态 C：| 数字 | `符号` | ──
const RE_BARE_NUM = /^\|\s*(\d{2,4})\s*\|\s*`([^`]+)`\s*\|/
// ── 形态 D：任意位置 `符号`（L####）—— 覆盖正文里的自由引用 ──
//    注意：分隔符既可能是全角括号也可能是半角，还可能是「（L1643–2063）」这种区间
//    （只取起点）。
//    ⚠️ 2026-11-17 修：原来的字符类 `[\w$/.-]` 不含 `()`，
//    于是 `\`overview()\`（L1640）` 这种**带空调用括号**的写法整条漏掉。
//    现在把 `()` 纳入，并在取到后**去掉尾部的 `()`** 再当符号名查找。
const RE_INLINE_SYM_L = /`([A-Za-z_$][\w$/.-]*(?:\(\))?)`\s*[（(]\s*L(\d{3,4})/g
// ── 形态 F：正文里「`符号` 声明 L####」这种**符号在前、行号在后但中间有字** ──
//    例如：「`dbPath` 声明 L2074」。跨距限定 20 字符，避免跨到别的句子。
//
//    ⚠️ 2026-11-17 修：`L290` 那行写的是**行号在前、符号在后**：
//      「L3303 \`sanitizeTopic\` / L3333 \`sanitizeSummary\`」
//    而本正则要求「符号…行号」，于是把 L290 的 `sanitizeTopic` 和**下一个**行号
//    （L3333，属于 sanitizeSummary）错误配对，报出两条假失败。
//
//    这是一个**真规则的缺陷**，不是文档错。修法：**只配对同一对反引号+紧邻行号**，
//    跨距压到 12 字符，并且**要求行号紧跟在符号之后**（中间只能是
//    「声明/定义/常量在/在」这类短词），不允许跨过另一个符号或斜杠分隔。
const RE_INLINE_SYM_SPACED = /`([A-Za-z_$][\w$.]*)`\s*(?:声明|定义|常量在|在|是)?\s*L(\d{3,4})\b/g
// ── 形态 G：「L#### `符号`」—— 行号在前、符号在后（L290 那种）──
//    ⚠️ 关键：这里也要**按顺序配对**，不能复用上面的捕获组顺序。
const RE_L_THEN_SYM = /L(\d{3,4})\s*`([A-Za-z_$][\w$.]*)`/g
// ── 形态 E：**L####**（加粗行号，前面有描述性文字）──
//    这类无法从行号反推符号名（描述是中文），只做「该行非空」的弱检查，
//    单独统计，不计入失败 —— 但要把数量如实报出来，避免制造「全都覆盖了」的错觉。
const RE_BOLD_L = /\*\*L(\d{3,4})\*\*/g

// ── 形态 H：§11 HTTP 路由表 —— `| 方法 | `/api/dsh-memory/xxx` | 行号 | ...` ──
//    ⚠️ 2026-11-17 加：这张表原来 **20 行全部错位**（偏差 +762 ~ +941），
//    而三个既有脚本都看不见它（表格列形态、且 `path:` 行不在符号定义里）。
//    判据很直接：按路径字符串在 index.js 里找 `path: '<路径>'` 的真实行号。
const RE_ROUTE_ROW = /^\|\s*[A-Z/]+\s*\|\s*\*{0,2}`(\/api\/dsh-memory\/[^`]+)`\*{0,2}\s*\|\s*\*{0,2}(\d{3,4})\*{0,2}\s*\|/

// ── 形态 I：| `符号(参数)` | 裸数字 | —— §5 db-store.mjs 表 ──
//    符号可能带参数列表（如 `appendLog(project, content, {...})`）或为空（`routeTable`）。
const RE_SYM_CALL_BARE =
  /^\|\s*\*{0,2}`([A-Za-z_$][\w$]*)\s*(?:\([^`]*\))?`\*{0,2}\s*\|\s*\*{0,2}(\d{3,4})\*{0,2}\s*\|/

lines.forEach((text, idx) => {
  const mapLine = idx + 1

  let m = text.match(RE_TABLE_L)
  if (m) {
    results.push({ form: 'A', mapLine, sym: m[1], claimed: Number(m[2]), raw: text.trim() })
    return
  }

  m = text.match(RE_LEAD_L)
  if (m) {
    const sym = m[2]
    // ⚠️ 2026-11-17 修：行首形态抓到的「第二个词」不一定是符号名。
    //   实测被误抓的：`let`（"L2655  let dbPath / ..."）、`HTTP`（"L4541  HTTP 路由…"）
    //   —— 它们是英文单词，不是符号。
    //   判据加强：必须是标识符形态，**且不能是 JS 关键字或常见描述词**。
    const NOT_SYMBOLS = new Set([
      'let', 'const', 'var', 'function', 'class', 'return', 'if', 'else',
      'HTTP', 'GET', 'POST', 'SQLite', 'JSON', 'API', 'GUI', 'CSS', 'DOM',
    ])
    if (/^[A-Za-z_$][\w$]*$/.test(sym) && !NOT_SYMBOLS.has(sym)) {
      results.push({ form: 'B', mapLine, sym, claimed: Number(m[1]), raw: text.trim() })
    } else {
      results.push({ form: 'B?', mapLine, sym, claimed: Number(m[1]), raw: text.trim(), skip: true })
    }
    return
  }

  m = text.match(RE_BARE_NUM)
  if (m) {
    results.push({ form: 'C', mapLine, sym: m[2], claimed: Number(m[1]), raw: text.trim() })
    return
  }

  // 形态 D：一条行里可能有多个 `符号`（L####）
  RE_INLINE_SYM_L.lastIndex = 0
  let found = false
  let mm
  while ((mm = RE_INLINE_SYM_L.exec(text)) !== null) {
    // 去掉尾部空括号：`overview()` → `overview`
    const sym = mm[1].replace(/\(\)$/, '')
    results.push({ form: 'D', mapLine, sym, claimed: Number(mm[2]), raw: text.trim() })
    found = true
  }
  if (found) return

  // 形态 F：`符号` 声明 L####（中间只允许短词，不允许跨符号）
  RE_INLINE_SYM_SPACED.lastIndex = 0
  let sf = false
  while ((mm = RE_INLINE_SYM_SPACED.exec(text)) !== null) {
    results.push({ form: 'F', mapLine, sym: mm[1], claimed: Number(mm[2]), raw: text.trim() })
    sf = true
  }
  if (sf) return

  // 形态 G：L#### `符号`（行号在前）
  RE_L_THEN_SYM.lastIndex = 0
  let gl = false
  while ((mm = RE_L_THEN_SYM.exec(text)) !== null) {
    results.push({ form: 'G', mapLine, sym: mm[2], claimed: Number(mm[1]), raw: text.trim() })
    gl = true
  }
  if (gl) return

  // 形态 H：路由表行（必须在其他形态之前判断 —— 它的路径在反引号里，
  // 会被形态 D 误当成符号名去 findSymbol）
  m = text.match(RE_ROUTE_ROW)
  if (m) {
    results.push({ form: 'H', mapLine, sym: m[1], claimed: Number(m[2]), raw: text.trim() })
    return
  }

  // 形态 I：| `符号(参数)` | 裸数字 |  —— §5 db-store 表就是这种
  //    ⚠️ 2026-11-17 加：这张表 30 行**全部错位**（差 59~315 行），
  //    而既有脚本一个都看不见它（符号在反引号里、行号是裸数字列）。
  m = text.match(RE_SYM_CALL_BARE)
  if (m) {
    // ⚠️ 2026-11-17 再加排除：这张「裸数字表」的形态**和字节预算表长得一样**：
    //    | `factsBytes` | 8000 | `cordis.patch.yml` |     ← 8000 是**字节**，不是行号
    //    | `routeTable(name)` | 354 |                     ← 354 是行号
    //  判据：**同一张表里靠前的表头**出现「预算 / bytes / 默认值」等词，
    //  或该数字明显超出源码行数上界（5843），就判定为「非行号」，不进核对。
    //  这里用**两条互补的判据**（任一命中即排除），避免依赖表头位置。
    const n = Number(m[2])
    const MAX_SOURCE_LINES = Math.max(...Object.values(sources).map((ls) => ls.length))
    const looksLikeBudget = n > MAX_SOURCE_LINES
    const rowMentionsBytes = /bytes|预算|patch\.yml/i.test(text)
    if (looksLikeBudget || rowMentionsBytes) {
      results.push({ form: 'I?', mapLine, sym: m[1], claimed: n, raw: text.trim(), skip: true })
      return
    }
    results.push({ form: 'I', mapLine, sym: m[1], claimed: n, raw: text.trim() })
    return
  }

  // 形态 E：只有加粗行号，无符号名 → 记录但不核对
  RE_BOLD_L.lastIndex = 0
  let eb
  while ((eb = RE_BOLD_L.exec(text)) !== null) {
    results.push({ form: 'E', mapLine, claimed: Number(eb[1]), raw: text.trim(), skip: true })
  }
})

// ── 形态 H：§11 HTTP 路由表 —— `| 方法 | `/api/dsh-memory/xxx` | 行号 | ...` ──
//    ⚠️ 2026-11-17 加：这张表原来 **20 行全部错位**（偏差 +762 ~ +941），
//    而三个既有脚本都看不见它（表格列形态、且 `path:` 行不在符号定义里）。
//    判据很直接：按路径字符串在 index.js 里找 `path: '<路径>'` 的真实行号。
//    同时核对**条数**：表里出现多少条路径，源码里就该有多少条 `path:` 声明。
//    （正则 `RE_ROUTE_ROW` 定义在上面，与形态判断放在一起，别在这里重复声明。）

// ── 形态 H 的源码侧数据：所有 `path: '/api/...'` 声明 ──
const ROUTE_DECLS = []
for (const [fk, ls] of Object.entries(sources)) {
  ls.forEach((l, i) => {
    const m = l.match(/path:\s*'(\/api\/dsh-memory\/[^']+)'/)
    if (m) ROUTE_DECLS.push({ file: fk, line: i + 1, path: m[1] })
  })
}

// ── 核对 ──
let pass = 0
let fail = 0
let unknown = 0
let skipped = 0
const failures = []

for (const r of results) {
  if (r.skip) {
    skipped++
    continue
  }

  // 形态 H（路由）：按路径字符串找真实 `path:` 行，不走 findSymbol
  if (r.form === 'H') {
    const decl = ROUTE_DECLS.find((d) => d.path === r.sym)
    if (!decl) {
      unknown++
      continue
    }
    if (decl.line === r.claimed) {
      pass++
    } else {
      fail++
      failures.push({ ...r, actual: { file: decl.file, line: decl.line } })
    }
    continue
  }

  // ⚠️ 2026-11-17 修：有两类「符号」不能用 findSymbol 查，要按各自形态另找。
  //   ① **事件名**（含 `/`）：定义行是 `safeOn('事件名', ...)`。
  //      第一版把 `tools/result` 等 3 条记成「无法核对」——
  //      实际它们错了 700~900 行（3198→4040、3119→4101、3500→4252）。
  //   ② **对象方法调用**（`ctx.effect`）：不是定义符号，只判「该行包含它」。
  const isEventName = r.sym.includes('/')
  const isCallLike = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/.test(r.sym)

  if (isEventName || isCallLike) {
    // 事件名：safeOn 注册行唯一，可直接比。
    // 对象方法调用：**多文件都有同名调用**（见 findCall 的长注释），
    // 只要任一命中等于 claimed 就算对 —— 不能只认第一个。
    if (isEventName) {
      const found = findEvent(r.sym)
      if (found === null) {
        unknown++
        continue
      }
      if (found.line === r.claimed) {
        pass++
      } else {
        fail++
        failures.push({ ...r, actual: found })
      }
      continue
    }
    const call = findCall(r.sym)
    if (call === null) {
      unknown++
      continue
    }
    if (call.hits.some((h) => h.line === r.claimed)) {
      pass++
    } else {
      fail++
      failures.push({ ...r, actual: call.first })
    }
    continue
  }

  const hit = findSymbol(r.sym)
  if (hit === null) {
    unknown++
    continue
  }
  // 地图里也有对 client.js / db-store.mjs 的引用：只要**任一文件**在 claimed 行
  // 出现该符号名，就认为对得上（不强制与 findSymbol 的文件一致）。
  const atClaimed = Object.values(sources).some(
    (ls) => ls[r.claimed - 1] !== undefined && ls[r.claimed - 1].includes(r.sym),
  )
  if (atClaimed) {
    pass++
  } else {
    fail++
    failures.push({ ...r, actual: hit })
  }
}

// ── 输出 ──
console.log('=== 项目地图行号校验（形态 A/B/C）===\n')
console.log(`共扫描到 ${results.length} 处可结构化引用：`)
for (const form of ['A', 'B', 'C', 'D', 'F', 'G', 'H', 'I', 'E']) {
  const n = results.filter((r) => r.form === form).length
  if (n > 0) {
    const label = {
      A: '| `符号` | L#### |',
      B: '行首 L#### 符号',
      C: '| 数字 | `符号` |',
      D: '正文 `符号`（L####）',
      F: '正文 `符号` 声明 L####',
      G: '正文 L#### `符号`',
      H: '§11 HTTP 路由表',
      I: '| `符号(参数)` | 裸数字 |（§5）',
      E: '**L####**（无符号名，仅记录）',
    }[form]
    console.log(`  形态${form}（${label}）：${n}`)
  }
}

// 路由条数核对：表里出现的路径条数必须等于源码里的 `path:` 声明条数
const mapRouteCount = results.filter((r) => r.form === 'H').length
console.log(`\n  §11 路由：表里 ${mapRouteCount} 条 / 源码 ${ROUTE_DECLS.length} 条`)
if (mapRouteCount !== ROUTE_DECLS.length) {
  console.log(`  ⚠️ 条数不一致 —— 表里可能漏列或多列了路由`)
}
console.log(`  跳过（行首是中文描述 / 加粗行号无符号名）：${skipped}`)
console.log(`  无法自动核对（符号定位不到）：${unknown}`)
console.log('')

if (failures.length > 0) {
  console.log(`❌ 对不上 ${failures.length} 处：\n`)
  for (const f of failures) {
    console.log(`  地图 L${f.mapLine} [形态${f.form}] \`${f.sym}\` 声称 L${f.claimed} → 实际 L${f.actual.line}（${f.actual.file}.mjs/js）`)
    console.log(`     原文: ${f.raw.slice(0, 100)}`)
  }
  console.log('')
}

console.log(`${failures.length === 0 ? '✅' : '❌'} 结果：PASS=${pass} FAIL=${fail} 跳过=${skipped} 无法核对=${unknown}`)
// 路由条数不一致也算失败 —— 否则「表里少列一条」永远不会被发现
const routeMismatch = mapRouteCount !== ROUTE_DECLS.length
if (routeMismatch) console.log('❌ 路由条数与源码不一致')
process.exit(fail === 0 && !routeMismatch ? 0 : 1)
