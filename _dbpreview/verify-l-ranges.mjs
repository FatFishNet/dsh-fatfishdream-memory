/**
 * 核对文档里 `L####–####` 这种**区间写法**（2026-11-28）。
 *
 * ## 为什么要单独一个脚本
 *
 * 维护手册 §4.9 的盲区表里写着：
 *
 *   > ⑤ `L####–####` 区间只校验起点，终点无人管（把终点改成 9999，四个脚本全绿）
 *
 * 这条自 2026-11-21 记下后就一直没人补。`verify-map.mjs` 只把每个 `L####`
 * 当成「该行非空」来判 —— 它**根本不当区间看**：起点和终点各判各的，
 * 于是「终点 > 文件行数」它会报，但「终点指向完全不相干的内容」它不管，
 * 「起点 > 终点」它也照样全绿。
 *
 * ## 这次实测出的真实情况（2026-11-28）
 *
 * 全仓 35 处区间，逐个核过之后发现的问题：
 *
 * | 处 | 写的是 | 实际应是 | 错法 |
 * |---|---|---|---|
 * | 项目地图 §3.5 请求参数 | `L702–696` | `L796–798` | **倒序**，且指向 client.js |
 * | 项目地图 数据库初始化 | `L3283–L3345` | `L3958–L4113` | 区间没挪，行内三个点也全错 |
 * | 项目地图 面板七页签 | `MemoryPanel` L645 / 按钮 L1360–1366 | L705 / L1021–L1029 | 三个数字全错 |
 *
 * ## 判据分层：只做能可靠做的（这是本脚本最重要的设计）
 *
 * 区间**无法**完全自动校验，因为文档里普遍不写「这是哪个文件」——
 * 同一个 `L1360–1366` 可能指 `index.js` 也可能指 `client.js`，
 * 两者都能「不越界」。所以分三层，**每层都明确写清它能抓什么、不能抓什么**：
 *
 *   ① **倒序**（下界 > 上界）—— 100% 可靠，任何文件都不该出现。
 *   ② **越界**（上界 > 最大的源码文件行数）—— 可靠，无论指哪个文件都超了。
 *   ③ **内容一致性**（可选的强判据，只在「同一行有明确标识符」时启用）：
 *      若这一行同时出现反引号包着的**具体符号名**（如 `rebindDbStore`），
 *      且该符号在某个源码文件里唯一存在，那么区间**必须包含**它的行号。
 *      —— 这条能抓住「指向完全不相干内容」，是 ③ 唯一的价值；
 *      抓不住「区间两端都错但恰好框住该符号」的情况。
 *
 * ⚠️ 局限性必须写出来，否则下一个人会以为它全知
 *   （本项目反复吃「检测器有盲区，而且它不会告诉你」的亏）：
 *   · 不校验「区间是否恰好是某个函数的完整起止」—— 文档里的区间本来就
 *     常是「大致一段」（实测 `createStore` 写 `L2679–3496`，而 3496 是空行）；
 *   · ③ 只在标识符唯一、且能定位时才生效；识别不了的直接跳过并计数。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SOURCES = {
  index: 'dsh-fatfishdream-memory/index.js',
  client: 'dsh-fatfishdream-memory/client.js',
  store: 'dsh-fatfishdream-memory/db-store.mjs',
  schema: 'dsh-fatfishdream-memory/db-schema.mjs',
}

const DOCS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'docs/项目地图.md',
  'docs/维护手册.md',
  'docs/TESTING.md',
  'docs/DECISIONS.md',
  'docs/TODO.md',
  'docs/踩坑清单.md',
  'dsh-fatfishdream-memory/README.md',
  'dsh-fatfishdream-memory/STORAGE.md',
]

const BUF = {}
for (const [k, rel] of Object.entries(SOURCES)) {
  const p = path.join(ROOT, rel)
  BUF[k] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n') : []
}
const MAX_LINES = Math.max(...Object.values(BUF).map((a) => a.length))

/** 区间写法：`L123–456` / `L123-456` / `L123–L456`。分隔符三种都见过。 */
const RANGE_RE = /L(\d{2,5})\s*([-–—])\s*L?(\d{2,5})/g

/** 反引号里的「像符号名」的标识串（用于第 ③ 层） */
const IDENT_RE = /`([A-Za-z_$][\w$]{2,})`/g

/** 这些是泛词，不当作「指向某个具体函数」的证据 */
const GENERIC = new Set([
  'index', 'client', 'store', 'schema', 'apply', 'grep', 'read', 'write',
  'file', 'true', 'false', 'null', 'undefined', 'string', 'number', 'object',
  'PAGE_SIZE', 'MAX_VIEWABLE',
])

let pass = 0
let fail = 0
const bad = []
function check(label, ok, detail = '') {
  if (ok) pass++
  else { fail++; bad.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${label}  ← ${detail}`) }
}

/** 找出符号在哪个源码文件里（要求唯一，否则不判） */
function locateUnique(sym) {
  const re = new RegExp(`^(export )?(const|function|let|async function|class|var) ${sym}\\b|\\b${sym}\\s*[=:]\\s*`)
  const found = []
  for (const [key, lines] of Object.entries(BUF)) {
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { found.push({ file: key, line: i + 1 }); break }
    }
  }
  return found.length === 1 ? found[0] : null
}

const ranges = []
for (const doc of DOCS) {
  const p = path.join(ROOT, doc)
  if (!fs.existsSync(p)) continue
  const lines = fs.readFileSync(p, 'utf8').split('\n')

  // ★ 2026-11-28：`项目地图.md` 按章节**隐含**了目标文件 ——
  //   §3=index、§4=schema、§5=store、§6=client。这个约定早已存在：
  //   `verify-map-content.mjs` 的 `secFile()` 就是按它分的（见该脚本 L106-110）。
  //   所以地图里那 7 处**不必**逐条补文件名，继承章节即可 ——
  //   验证过：7 处区间全部落在所推断文件的真实行数之内，且
  //   「面板七页签」「请求参数」两处已由实证确认属于 client.js。
  //   其它文档没有这个约定，仍然只能靠「区间紧邻文件名」或跳过。
  let chapFile = null
  const chapFileOf = (heading) => {
    const m = heading.match(/^##\s+(\d+)/)
    if (!m) return null
    return { 3: 'index', 4: 'schema', 5: 'store', 6: 'client' }[Number(m[1])] ?? null
  }

  lines.forEach((line, i) => {
    if (/^##\s+/.test(line)) chapFile = chapFileOf(line)
    RANGE_RE.lastIndex = 0
    let m
    while ((m = RANGE_RE.exec(line)) !== null) {
      // ★ 2026-11-28：除了章节推断，还要认**显式标注的文件名**。
      //   文档里已经普遍有这种写法（实测 12 处）：
      //     `index.js` **L2620-2624** / `db-schema.mjs` **[L400-408]**
      //     `pointerPath()`（`index.js` L382-388）
      //   判据：取区间**前面最近的那个文件名**，且中间不能跨越句号/分号
      //   （避免把「上一句说的 client.js」错配给这一句的区间）。
      const before = line.slice(0, m.index)
      const fm = before.match(/(index\.js|client\.js|db-store\.mjs|db-schema\.mjs)[^。；;]*$/)
      const explicitFile = fm
        ? { 'index.js': 'index', 'client.js': 'client', 'db-store.mjs': 'store', 'db-schema.mjs': 'schema' }[fm[1]]
        : null

      ranges.push({
        doc,
        docLine: i + 1,
        raw: m[0],
        lo: Number(m[1]),
        hi: Number(m[3]),
        text: line,
        // 显式标注优先于章节推断（前者更具体，且能跨文档生效）
        impliedFile: explicitFile ?? (doc === 'docs/项目地图.md' ? chapFile : null),
        fileSource: explicitFile ? 'explicit' : (doc === 'docs/项目地图.md' && chapFile ? 'chapter' : null),
      })
    }
  })
}

const attrCount = { explicit: 0, chapter: 0, none: 0 }
for (const r of ranges) {
  if (r.fileSource === 'explicit') attrCount.explicit++
  else if (r.fileSource === 'chapter') attrCount.chapter++
  else attrCount.none++
}

console.log(`\n=== 扫到 ${ranges.length} 处 L####–#### 区间引用 ===`)
console.log(`    能确定归属文件的：显式标注 ${attrCount.explicit} 处 + 章节推断 ${attrCount.chapter} 处`)
console.log(`    确定不了的：${attrCount.none} 处（只能做「不超最大文件」的宽松判据）\n`)

// ---- ① 倒序：100% 可靠 ----
console.log('--- ① 倒序（下界 > 上界）---')
for (const r of ranges) {
  check(
    `${r.doc}:${r.docLine} ${r.raw} 不得倒序`,
    r.lo <= r.hi,
    r.lo > r.hi ? `下界 ${r.lo} 大于上界 ${r.hi}` : '',
  )
}

// ---- ② 越界 ----
//
// 分两种口径：
//   · 有章节归属（项目地图 §3–§6）→ 必须落在**那个文件**的行数内（更严）；
//   · 无归属 → 只能判「不得超过最大的源码文件行数」（宽松，但聊胜于无）。
console.log('\n--- ② 越界 ---')
for (const r of ranges) {
  if (r.impliedFile) {
    const limit = BUF[r.impliedFile].length
    check(
      `${r.doc}:${r.docLine} ${r.raw} 必须落在 ${r.impliedFile} 的行数内（该文件 ${limit} 行）`,
      r.hi <= limit,
      r.hi > limit ? `上界 ${r.hi} 超过 ${r.impliedFile} 的 ${limit} 行` : '',
    )
  } else {
    check(
      `${r.doc}:${r.docLine} ${r.raw} 上界不得超过最大源码文件行数（${MAX_LINES}）`,
      r.hi <= MAX_LINES,
      r.hi > MAX_LINES ? `上界 ${r.hi} 超过 ${MAX_LINES}` : '',
    )
  }
}

// ---- ③ 内容一致性：仅当区间**紧邻**一个唯一可定位的符号 ----
//
// ⚠️ 这一层的第一版设计是「同行出现唯一符号 → 区间必须包含它」，实测**4 处全误报**：
//
//   · `\`POINTER_FILE\` 已确认是死常量 | index.js L380 | … \`pointerPath()\`（L382-388）`
//     —— 区间指的是 `pointerPath`，`POINTER_FILE` 只是文中被提到的名字；
//   · `pre-step 监听器范围是 L6106–L6175（下一个 \`safeOn\` 在 L6176）`
//     —— `safeOn` 是「下一个」的措辞，根本不是区间指的东西；
//   · `L2216→2963`、`L1150-1766→1643-2475`
//     —— 这是**历史迁移对照表**，箭头两边是「当年从哪改到哪」，不是当前行号。
//
// 教训：**「同一行出现过」不等于「这个区间指的是它」**。
// 判据必须认**紧邻关系**（区间前面或后面紧跟的那个标识符），而不是「同行出现」。
//
// 因此改成：只取「紧贴在区间前 / 后」的标识符（允许中间隔 ≤3 个字符，
// 如 `（`、`：`、空格），且该符号必须在源码里唯一可定位。
// 判不了就跳过并计数 —— **宁可少判，不要错判**（错判会把人引去改对的东西）。
console.log('\n--- ③ 内容一致性（区间紧邻一个唯一可定位符号时）---')
let judged = 0
let skipped = 0
for (const r of ranges) {
  // 在原文里找这个区间的出现位置，只看它**紧邻**的标识符
  const at = r.text.indexOf(r.raw)
  if (at < 0) { skipped++; continue }
  const before = r.text.slice(0, at)
  const after = r.text.slice(at + r.raw.length)

  // 紧邻前：以 `符号`（ 或 `符号` 结尾，中间最多 3 个非字母字符
  const beforeM = before.match(/`([A-Za-z_$][\w$]{2,})`[^A-Za-z0-9]{0,3}$/)
  // 紧邻后：以 （`` `符号` `` 开头
  const afterM = after.match(/^[^A-Za-z0-9]{0,3}`([A-Za-z_$][\w$]{2,})`/)

  const candidates = [beforeM?.[1], afterM?.[1]].filter(Boolean).filter((s) => !GENERIC.has(s))
  if (candidates.length === 0) { skipped++; continue }

  // ⚠️ 排除「历史快照」写法：`L2216→2963`、`L1150-1766→1643-2475`
  //
  // 箭头左边是「当年从哪」，右边是「当年改到哪」—— **两边都是当时的行号**，
  // 与今天的源码无关。实测 TODO.md 的「2026-11-17 核对快照」一节整张表都是
  // 这种形态（且该节自己有 ⚠️ 声明「数字全部按当时的源码行数」）。
  //
  // 判据：区间**紧跟着一个箭头**→ 这是迁移对照，跳过。
  // （只认 → / -> 两种写法；`L123–456` 后面跟普通文字不受影响）
  if (/^\s*[（(]?\s*(→|->)/.test(after)) { skipped++; continue }

  const located = candidates
    .map((s) => ({ sym: s, at: locateUnique(s) }))
    .filter((x) => x.at !== null)
  if (located.length === 0) { skipped++; continue }
  judged++

  for (const { sym, at: loc } of located) {
    check(
      `${r.doc}:${r.docLine} ${r.raw} 必须包含紧邻的 \`${sym}\`（在 ${loc.file} L${loc.line}）`,
      r.lo <= loc.line && r.hi >= loc.line,
      `区间 ${r.lo}–${r.hi} 不含 L${loc.line}`,
    )
  }
}
console.log(`    （判定了 ${judged} 处，跳过 ${skipped} 处 —— 跳过的是「区间旁边没有可唯一定位的符号」）`)

// 防空转：区间本来就该有若干处；一处都没有说明解析坏了
check('至少解析出 10 处区间引用（防止解析失效后静默零覆盖）', ranges.length >= 10, `实际 ${ranges.length}`)

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
