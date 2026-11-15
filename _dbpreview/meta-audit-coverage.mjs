/**
 * 一次性审计：测试覆盖度 —— 每个生产函数是否被任何测试「实际执行」过。
 *
 * 关键区分（2026-11-15 死代码检测踩过的教训）：
 *   「测试里出现这个函数名」 ≠ 「测试调用了这个函数」。
 *   verify-functions 是在**按名字正则定位**，不是在调用。
 *   所以这里要分清三种情况：
 *     CALLED   测试代码里真的调用了它（functionName( 或 .functionName(）
 *     NAMED    只在按名字定位的断言里出现（等于没测）
 *     NONE     测试里完全没出现
 *
 * 跑完即删。
 */
import fs from 'node:fs'
import path from 'node:path'

const PROD = {
  'index.js': 'dsh-fatfishdream-memory/index.js',
  'client.js': 'dsh-fatfishdream-memory/client.js',
  'db-store.mjs': 'dsh-fatfishdream-memory/db-store.mjs',
  'db-schema.mjs': 'dsh-fatfishdream-memory/db-schema.mjs',
}

const testDir = '_dbpreview'
const testFiles = fs.readdirSync(testDir).filter((f) => f.endsWith('.mjs'))
const testSrc = testFiles.map((f) => fs.readFileSync(path.join(testDir, f), 'utf8')).join('\n')

// 去掉测试文件里的注释，避免「注释里提到函数名」被算成覆盖
const testCode = testSrc
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

/** 从生产文件里抽取函数声明 */
function discoverFns(src) {
  const out = []
  const lines = src.split('\n')
  for (const line of lines) {
    const indent = line.length - line.trimStart().length
    if (indent > 4) continue // 太深的嵌套不算公共 API
    if (/^\s*export\s+/.test(line) && !/export function/.test(line)) continue
    let m = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
    if (m) { out.push(m[1]); continue }
    m = line.match(/^\s*const\s+([a-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/)
    if (m) out.push(m[1])
  }
  return [...new Set(out)]
}

const report = {}
for (const [label, file] of Object.entries(PROD)) {
  const src = fs.readFileSync(file, 'utf8')
  const fns = discoverFns(src)
  const rows = []
  for (const fn of fns) {
    // CALLED：作为函数被调用。
    //
    // ⚠️ 第一版写的是 `(?:[^\\w$.]|^)fn\\s*\\(`，把 `store.appendLog(...)`
    //    这种**方法调用**全排除了（`.` 被排除在外）—— 于是 appendLog 被误判成
    //    「仅按名提到」。所以这里允许 `.`：对象方法调用也是真调用。
    //    唯一要排除的是「定义本身」，但测试里没有定义，不必管。
    const callRe = new RegExp(`(?:^|[^\\w$])${fn.replace(/[$]/g, '\\$')}\\s*\\(`, 'm')
    const called = callRe.test(testCode)
    // NAMED：出现在测试里但不像调用（多半是按名字定位的断言）
    const named = !called && new RegExp(`\\b${fn.replace(/[$]/g, '\\$')}\\b`).test(testCode)
    rows.push({ fn, status: called ? 'CALLED' : named ? 'NAMED' : 'NONE' })
  }
  report[label] = rows
}

// ---- 输出 ----
let total = 0, called = 0, named = 0, none = 0
for (const [file, rows] of Object.entries(report)) {
  const c = rows.filter((r) => r.status === 'CALLED')
  const n = rows.filter((r) => r.status === 'NAMED')
  const x = rows.filter((r) => r.status === 'NONE')
  total += rows.length
  called += c.length
  named += n.length
  none += x.length
  console.log(`\n=== ${file}  (${rows.length} 个函数) ===`)
  console.log(`  实际被调用 ${c.length} / 仅按名提到 ${n.length} / 完全没有 ${x.length}`)
  if (n.length) console.log(`  仅按名提到（等于没测）：${n.map((r) => r.fn).join(', ')}`)
  if (x.length) console.log(`  完全没有覆盖：${x.map((r) => r.fn).join(', ')}`)
}

console.log(`\n${'='.repeat(50)}`)
console.log(`总计 ${total} 个函数`)
console.log(`  CALLED  ${called}  (${Math.round(called / total * 100)}%)`)
console.log(`  NAMED   ${named}  (${Math.round(named / total * 100)}%)  ← 只被按名定位，实际没执行`)
console.log(`  NONE    ${none}  (${Math.round(none / total * 100)}%)  ← 零覆盖`)
