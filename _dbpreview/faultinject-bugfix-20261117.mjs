/**
 * 故障注入：确认 `selfcheck-bugfix-20261117.mjs` 的 39 条断言**真的会变红**。
 *
 * 为什么必须做（今晚的核心教训）：
 *   「测试全绿」不证明测试有效。`appendArchive` 缺事务那个 bug 就是
 *   在 46/46 全绿的情况下活着的。只有**把修复撤掉看它红不红**才算数。
 *
 * 做法与 meta-mutation-test 同款：临时改 index.js / db-store.mjs，
 * 跑被测脚本，恢复，sha256 校验。
 *
 * ⚠️ 跑的时候不要并行改代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory/index.js')
const STORE = path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs')
const TEST = 'selfcheck-bugfix-20261117.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const origIndex = fs.readFileSync(INDEX, 'utf8')
const origStore = fs.readFileSync(STORE, 'utf8')
const hashIndex = sha(origIndex)
const hashStore = sha(origStore)

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    bad.push(name)
    console.log(`  ❌ ${name}${detail ? '  ← ' + detail : ''}`)
  }
}

/**
 * @param {string} label
 * @param {string} file INDEX | STORE
 * @param {string} from 必须是**唯一**匹配
 * @param {string} to
 * @param {boolean} expectRed
 */
function trial(label, file, from, to, expectRed) {
  const src = file === INDEX ? origIndex : origStore
  const n = src.split(from).length - 1
  if (n !== 1) {
    check(`${label} 锚点唯一`, false, `实际匹配 ${n} 处`)
    return
  }
  const target = file === INDEX ? INDEX : STORE
  try {
    fs.writeFileSync(target, src.replace(from, to), 'utf8')
    const r = runCaptured([path.join(HERE, TEST)], { cwd: REPO, timeout: 120000 })
    const red = r.status !== 0 && r.status !== null
    check(
      `${label} → 期望${expectRed ? '红' : '绿'}，实际 exit=${r.status}`,
      r.status !== null && red === expectRed,
      r.status === null ? '子进程没跑起来' : '',
    )
  } finally {
    fs.writeFileSync(target, src, 'utf8')
  }
}

console.log('=== 逐个撤掉修复，测试必须变红 ===\n')

// ① `$` 展开：把函数形式改回字符串形式
//
// ⚠️ 两处 replace 的文字**完全一样**，只有缩进不同：
//    restoreHeartbeat 里是 6 空格、writeHeartbeat 里是 8 空格。
// 但**只加缩进还不够** —— 6 空格那串是 8 空格那串的**子串**，
// 所以 '      updated = ...' 会同时匹配到两行。
// 必须带**前导换行**才真正唯一。这是今晚第三次踩「锚点不唯一」。
trial(
  '① 撤掉 replace 函数形式（restoreHeartbeat）',
  INDEX,
  '\n      updated = current.replace(blockRe, () => `${newLine}\\n`)',
  '\n      updated = current.replace(blockRe, `${newLine}\\n`)',
  true,
)
trial(
  '①b 撤掉 replace 函数形式（writeHeartbeat）',
  INDEX,
  '\n        updated = current.replace(blockRe, () => `${newLine}\\n`)',
  '\n        updated = current.replace(blockRe, `${newLine}\\n`)',
  true,
)

// ② appendArchive 事务：去掉 withFtsTransaction 包裹
trial(
  '② 撤掉 appendArchive 的事务',
  STORE,
  "    return withFtsTransaction((d) => {\n      const r = d\n        .prepare(`INSERT INTO archive",
  '    return ((d) => {\n      const r = d\n        .prepare(`INSERT INTO archive',
  true,
)

// ③ isInside 参数：改回反序
trial(
  '③ 把 isInside 参数改回反序',
  INDEX,
  'if (isInside(root, nextRoot)) throw',
  'if (isInside(nextRoot, root)) throw',
  true,
)

// ④ POSIX 正向判据：改回恒真（= 永不拒绝）
trial(
  '④ 撤掉 POSIX 正向判据（恒真）',
  INDEX,
  "  const isPosixAcceptable =\n    process.platform !== 'win32'\n      ? isAbsolute(explicit) || explicit.startsWith('~')",
  '  const isPosixAcceptable = true\n  const _dead =\n    process.platform !== \'win32\'\n      ? isAbsolute(explicit) || explicit.startsWith(\'~\')',
  true,
)

// ⑤ joinWithBudget：删掉「全军覆没」兜底分支
trial(
  '⑤ 撤掉 joinWithBudget 的单条兜底',
  STORE,
  '    // ② 全军覆没：说明每条都超过预算。取最长的一条，硬截到 tailBudget。',
  '    // ② 全军覆没（已撤掉，用于验证测试有效性）\n    if (false) {',
  true,
)

// ⑥ cwd 判目录：改回 exists
trial(
  '⑥ 把 isDirectoryPath 改回 exists',
  INDEX,
  '!((await isDirectoryPath(cwd)))'.replace('((', '('),
  '!((await exists(cwd)))'.replace('((', '('),
  true,
)

// ⑦ topic/summary 拒绝：把 topic 的 return 400 去掉
trial(
  '⑦ 撤掉 topic 的 400 拒绝',
  INDEX,
  "            if (topicRaw !== '' && topic === null) {\n              diag('topic-rejected', { raw: topicRaw.slice(0, 40), via: 'http' })",
  "            if (false) {\n              diag('topic-rejected', { raw: topicRaw.slice(0, 40), via: 'http' })",
  true,
)

// 对照组：什么都不改，必须仍然绿
trial(
  '对照组：撤掉后原样恢复（应仍绿）',
  INDEX,
  "const IS_WINDOWS = process.platform === 'win32'",
  "const IS_WINDOWS = process.platform === 'win32'",
  false,
)

const afterIndex = sha(fs.readFileSync(INDEX, 'utf8'))
const afterStore = sha(fs.readFileSync(STORE, 'utf8'))
check('index.js 已逐字节还原', afterIndex === hashIndex, `${hashIndex.slice(0, 12)} vs ${afterIndex.slice(0, 12)}`)
check('db-store.mjs 已逐字节还原', afterStore === hashStore, `${hashStore.slice(0, 12)} vs ${afterStore.slice(0, 12)}`)

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
