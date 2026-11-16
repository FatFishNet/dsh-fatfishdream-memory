/**
 * 核对 `docs/项目地图.md` §3.1 的**裸数字行号表**。
 *
 * ## 为什么需要它（2026-11-16）
 *
 * `verify-map.mjs` 只认带 `L` 前缀的引用（`L1234`）；而 §3.1 那张表写的是
 * **裸数字**（`| 45 | \`name\` |`）。于是这张表**完全不受任何校验**——
 * 2026-11-16 实测：表里 15 行**全部指向错位置**
 * （`name` 表说 45、实际 83；`POLICY_TEMPLATE` 说 610、实际 790），
 * 而 `verify-map` 一直报「111 处引用，0 处落空」。
 *
 * 更糟的是 `verify-map-content.mjs` 也不看它（它只匹配
 * `` `符号`（L####） `` 那种形态），所以两个校验脚本都没有覆盖。
 *
 * 这正是 AGENTS.md 里那条：「回归全绿 ≠ 没问题，绿只能证明被覆盖的部分没坏」。
 *
 * ## 判据
 *
 * 对表里每一行 `| 行号 | \`符号\` |`，在 index.js 里按
 * `^(export )?(const|function|let|async function) <符号>` 现算真实行号，
 * 必须与表里的数字一致。**行号由源码现算，不写死期望值** ——
 * 写死期望值就是下一个漂移源（verify-map-content 踩过这个坑）。
 */
import fs from 'node:fs'

const SRC_PATH = 'dsh-fatfishdream-memory/index.js'
const MAP_PATH = 'docs/项目地图.md'

const src = fs.readFileSync(SRC_PATH, 'utf8').split('\n')
const mapLines = fs.readFileSync(MAP_PATH, 'utf8').split('\n')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) { pass++ }
  else { fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${name}  ← ${detail}`) }
}

/** 按声明形态定位符号的真实行号；找不到返回 -1 */
function locate(sym) {
  const re = new RegExp(`^(export )?(const|function|let|async function|class) ${sym}\\b`)
  for (let i = 0; i < src.length; i++) {
    if (re.test(src[i])) return i + 1
  }
  return -1
}

// ---- 找出 §3.1 表格的起止 ----
const startIdx = mapLines.findIndex((l) => /^###\s*3\.1\b/.test(l))
check('地图里能找到 §3.1 小节', startIdx >= 0)
if (startIdx < 0) {
  console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
  process.exit(1)
}

let endIdx = mapLines.length
for (let i = startIdx + 1; i < mapLines.length; i++) {
  if (/^#{2,3}\s/.test(mapLines[i])) { endIdx = i; break }
}

// ---- 解析表格行 ----
//
// 支持三种写法：
//   | 45 | `name` | …                      单行号
//   | 372–395 | `a`(372) / `b`(376) | …    区间 + 行内括号行号
//   | 243 / 253–283 | `a`(243) / … | …     混合
//
// 对「行内括号行号」逐个核对；行首的区间数字只核对下界是否存在声明，
// 避免与行内括号行号重复计数。
const rows = []
for (let i = startIdx; i < endIdx; i++) {
  const line = mapLines[i]
  const rowMatch = line.match(/^\|\s*(\d{2,4})(?:[–-](\d{2,4}))?(?:\s*\/\s*(\d{2,4})(?:[–-](\d{2,4}))?)?\s*\|\s*`([A-Za-z_$][\w$]*)`/)
  if (!rowMatch) continue

  const headNo = Number(rowMatch[1])
  const headSym = rowMatch[5]
  rows.push({ mapLine: i + 1, no: headNo, sym: headSym, kind: 'head' })

  // 行内所有 `符号`(行号)
  for (const m of line.matchAll(/`([A-Za-z_$][\w$]*)`\s*[（(]\s*(\d{2,4})\s*[）)]/g)) {
    rows.push({ mapLine: i + 1, no: Number(m[2]), sym: m[1], kind: 'inline' })
  }
}

check('§3.1 表格里解析出符号行号', rows.length > 0, `${rows.length} 条`)

// ---- 逐条核对 ----
let checked = 0
for (const r of rows) {
  const real = locate(r.sym)
  if (real < 0) {
    // 符号不存在（可能已删除）—— 这不是「行号错」，单独报
    fail++
    bad.push(`map#${r.mapLine} \`${r.sym}\`：源码里找不到该声明（可能已删除，地图需更新）`)
    console.log(`❌ map#${r.mapLine} \`${r.sym}\`：源码里找不到该声明`)
    continue
  }
  checked++
  check(
    `map#${r.mapLine} \`${r.sym}\` 写 L${r.no}，实际 L${real}`,
    r.no === real,
    r.no === real ? '' : `差 ${real - r.no} 行`,
  )
}

check('至少核对了 10 个符号（防止表格被改坏后静默零覆盖）', checked >= 10, `实际 ${checked}`)

console.log(`\n结果：PASS=${pass} FAIL=${fail}（共核对 ${checked} 个符号行号）`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
