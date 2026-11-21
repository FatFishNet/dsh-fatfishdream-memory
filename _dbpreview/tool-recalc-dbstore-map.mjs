/**
 * 重算 `docs/项目地图.md` 里**指向 db-store.mjs** 的裸数字行号。
 *
 * 为什么需要单独一个工具：
 *   `tool-recalc-map.mjs` 解析的是 `verify-map-forms` 的输出，而那个脚本
 *   只核对 `index.js`（它在判据里写死了 `index.mjs/js`）。
 *   地图 §5 有一整张表是 `db-store.mjs` 的函数行号（裸数字，无 L 前缀），
 *   那些**没有任何脚本管**——正是 AGENTS.md 说的「校验脚本也有看不见的地方」。
 *
 * 做法：对地图里 N 列是纯数字、且描述里出现 `db-store` 上下文的行，
 * 按「该行第一个反引号里的函数名」去 db-store.mjs 里现算真实行号。
 *
 * 用法：node _dbpreview/tool-recalc-dbstore-map.mjs [--write]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const MAP = path.join(REPO, 'docs/项目地图.md')
const STORE = path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs')
const WRITE = process.argv.includes('--write')

const storeSrc = fs.readFileSync(STORE, 'utf8').split('\n')
const mapLines = fs.readFileSync(MAP, 'utf8').split('\n')

/** 在 db-store.mjs 里找某个符号的定义行（1-based）。 */
function findLine(sym) {
  const esc = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // 函数声明、const 定义、对象属性简写（`appendLog,`）都算
  const patterns = [
    new RegExp(`^\\s*function\\s+${esc}\\s*\\(`),
    new RegExp(`^\\s*(?:const|let)\\s+${esc}\\s*=`),
    new RegExp(`^\\s*${esc}\\s*,\\s*$`),
  ]
  for (let i = 0; i < storeSrc.length; i++) {
    if (patterns.some((re) => re.test(storeSrc[i]))) return i + 1
  }
  return null
}

// 只处理 §5 的 db-store 表：行形如 `| \`name(...)\` | 471 | ... |`
// 或者 `| **\`appendArchive(...)\`** | **1630** | ... |`
const ROW_RE = /^\|\s*(\*\*)?`([A-Za-z_$][\w$]*)\s*(?:\([^)]*\))?`(\*\*)?\s*\|\s*(\*\*)?(\d+)(\*\*)?\s*\|/

let changed = 0
let checked = 0
const skipped = []

for (let i = 0; i < mapLines.length; i++) {
  const line = mapLines[i]
  const m = line.match(ROW_RE)
  if (!m) continue

  const sym = m[2]
  const claimed = Number(m[5])
  const bold = m[1] === '**'

  const actual = findLine(sym)
  if (actual === null) {
    // ⚠️ 字节预算常量（factsBytes / policyBytes / projectBytes）不是函数，
    //    它们在地图里是「默认值」不是「行号」，找不到定义是**正常的**，
    //    不该算跳过失败。用 IS_BUDGET 精确排除，不要把「真的找不到」也放过。
    if (/Bytes$/.test(sym)) continue
    skipped.push(`L${i + 1} ${sym} —— db-store.mjs 里找不到`)
    continue
  }
  checked++
  if (actual === claimed) continue

  // 只替换那个具体的数字（保留加粗）
  const oldCell = bold ? `| **${claimed}** |` : `| ${claimed} |`
  const newCell = bold ? `| **${actual}** |` : `| ${actual} |`
  if (!line.includes(oldCell)) {
    skipped.push(`L${i + 1} ${sym} —— 单元格 ${oldCell} 未命中`)
    continue
  }
  mapLines[i] = line.replace(oldCell, newCell)
  changed++
  console.log(`  ${sym.padEnd(22)} ${claimed} → ${actual}`)
}

console.log(`\n核对 ${checked} 个符号，需改 ${changed} 处，跳过 ${skipped.length} 处。`)
for (const s of skipped) console.log(`  ⚠️ ${s}`)

if (!WRITE) {
  console.log('（未加 --write，未写入）')
  process.exit(0)
}
if (skipped.length > 0) {
  console.log('有跳过项，为安全起见不写入。')
  process.exit(1)
}
fs.writeFileSync(MAP, mapLines.join('\n'), 'utf8')
console.log(`已写入 ${MAP}`)
