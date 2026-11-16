/**
 * 回归测试：注入文案不得自相矛盾，且不得把用户侧命令教给模型。
 *
 * 历史：
 *   2026-11-13 早：另一个工作区的模型被注入里两条冲突指路逼去翻数据库
 *     （「或直接 grep 记忆库」vs「任何情况下都不要碰 memory.db」），
 *     当时修法是「明确告诉模型 /memory search 是斜杠命令、不是它的工具」。
 *
 *   2026-11-13 晚（用户口径变更）：**`/memory search` 本来就只该由用户敲，
 *     写进模型注入等于教模型把检索甩回给用户。** 因此现在断言反向：
 *     注入里**不得出现** `/memory search`，只能写「查不到就说没记住」。
 *
 * 本测试从源码静态抽取注入文案（不 import index.js，它在 apply 闭包里）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IDX = fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory/index.js'), 'utf8')
const POLICY_PATH = 'D:/dsh-fatfishdream-memory/policy.md'
const POLICY = fs.existsSync(POLICY_PATH) ? fs.readFileSync(POLICY_PATH, 'utf8') : ''

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

// ── 抽取注入里的两个「模型会读到」的片段 ──────────────────────────
// ⚠️ 只取**字符串字面量**，不能把代码注释算进来 ——
//    源码里有「删掉所有 /memory search 字样」这类说明性注释，
//    它不进注入，但会被朴素切片误判成注入内容（踩过一次）。
const stripComments = (txt) =>
  txt
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      // 去掉整行注释与行尾注释（本文件里没有字符串内含 "//" 的情况）
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

const usageStart = IDX.indexOf('const usageLines = dbMode')
const usageEnd = IDX.indexOf('      : [', usageStart)
const DB_USAGE = usageStart >= 0 ? stripComments(IDX.slice(usageStart, usageEnd)) : ''

const idxStart = IDX.indexOf('## 记忆索引<!--')
const idxEnd = IDX.indexOf('    }\n  }', idxStart)
const IDX_SECTION = idxStart >= 0 ? stripComments(IDX.slice(idxStart, idxEnd > idxStart ? idxEnd : idxStart + 1200)) : ''

// 项目段头部（含用量百分比警告的那段）
const projStart = IDX.indexOf('// 项目段')
const projEnd = IDX.indexOf('// 路由表', projStart)
const PROJ_SECTION = projStart >= 0 ? stripComments(IDX.slice(projStart, projEnd > projStart ? projEnd : projStart + 2000)) : ''

const INJECT_TEXT = DB_USAGE + '\n' + IDX_SECTION + '\n' + PROJ_SECTION

console.log('=== 1. 旧的自相矛盾文案必须消失 ===\n')
check('无「或直接 grep 记忆库」', !IDX.includes('或直接 grep 记忆库'))
check('无「检索请用 /memory search」', !IDX.includes('检索请用 /memory search'))
check('无「grep 查」/「grep 搜记忆根目录」', !IDX.includes('grep 查') && !IDX.includes('grep 搜记忆根目录'))

console.log('\n=== 2. 注入里不得出现用户侧命令 /memory search ===\n')
// 这是本轮的核心断言：用户敲的斜杠命令不该出现在模型注入里
const usageHasSlash = DB_USAGE.includes('/memory search')
const indexHasSlash = IDX_SECTION.includes('/memory search')
check('usageLines(dbMode) 不含 /memory search', !usageHasSlash,
  usageHasSlash ? 'usageLines 里仍在教模型让用户去敲命令' : '')
check('记忆索引段不含 /memory search', !indexHasSlash,
  indexHasSlash ? '索引段里仍在教模型让用户去敲命令' : '')
check('项目段警告不含 /memory search', !PROJ_SECTION.includes('/memory search'))

console.log('\n=== 3. 必须保留的「诚实边界」文案 ===\n')
// ⚠️ 2026-11-17 修（审计 P0 #6）：原来是一行
//   ['只说没记住，不猜不编', /没记住|不要猜|不要编/]
//   名字声称要三件事，正则的 `|` 让**任一件**单独成立就绿 ——
//   注入里只剩「没记住」、两句话被删了，它照样通过。
//
//   ⚠️ 第一版修法（同样是错的，被故障注入抓出来）：我把它拆成三条独立断言
//   `/没记住/` `/不要猜/` `/不要编/`，全在 INJECT_TEXT 上测 ——
//   但 INJECT_TEXT 是**多段拼接**的，删掉「底线那句」里的「不要猜」之后，
//   另一段（跨项目那段 L3161「项目名不确定就先问用户，不要猜。」）照样命中。
//   **断言还在，被测的那个差异不在** —— 又是假覆盖换了张脸。
//
//   现在锁到**具体那一句**：只在「查不到就说…」这条命令所在行上判断。
//   判据：把这行里的「不要猜」改掉，它必须红。
const HONEST_LINE = INJECT_TEXT.split('\n').find((l) => l.includes('查不到就说') && l.includes('这段我没记住'))
check('能定位到「查不到就说…」那一行', typeof HONEST_LINE === 'string' && HONEST_LINE.length > 0,
  '定位不到就说明注入文案被改了结构，后面三条会失效')
const honest = HONEST_LINE ?? ''
check('该行含「没记住」', /没记住/.test(honest))
check('该行含「不要猜」', /不要猜/.test(honest))
check('该行含「不要编」', /不要编/.test(honest))
check('该行含「不要扩大到全库」', /不要扩大到全库/.test(honest))

// 以下三条与上面那行无关，仍按全文断言（它们没有同名替身）
const required = [
  ['不许自己读库', /不要 grep|不要自己读库/],
  ['标记语法', /mem-log/],
  ['不许碰库', /损坏数据库/],
]
for (const [name, re] of required) {
  check(name, re.test(INJECT_TEXT))
}

console.log('\n=== 4. 注入里不得出现「让用户去操作」的措辞 ===\n')
// 这类措辞把动作推给用户，与「模型自己负责」的设计冲突
const pushToUser = ['请用户敲', '请用户输入', '让用户敲', '告诉用户去敲', '交给用户去查']
for (const s of pushToUser) {
  check(`不含「${s}」`, !INJECT_TEXT.includes(s))
}

console.log('\n=== 5. POLICY_TEMPLATE 同步（硬约束 13）===\n')
const tmplStart = IDX.indexOf('const POLICY_TEMPLATE = `')
/**
 * ⚠️ 2026-11-16 修：原来用 `IDX.indexOf('`\n', tmplStart)` 找结束位置。
 *
 * 那个写法假设「模板结尾是反引号紧跟换行」。模板换成新版（与 policy.md 一致）后，
 * 里面出现了**大量转义反引号 `\``**（代码块、行内代码），
 * 于是 `indexOf('`\n')` 会命中模板内部第一个「反引号+换行」→ TMPL 被截得很短，
 * 后面所有「模板里有没有 X」的断言全部误判成缺内容。
 *
 * 现在改成**逐字符扫描**：跳过 `\`` 转义，找到真正的结束反引号。
 * 这是唯一能正确处理转义的方式 —— 纯 indexOf 做不到。
 */
function sliceTemplate(src, from) {
  let i = from + 'const POLICY_TEMPLATE = `'.length
  let out = ''
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\' && src[i + 1] === '`') {
      out += '`' // 反转义，让断言看到运行时真正的内容
      i += 2
      continue
    }
    if (ch === '`') break // 真正的结束
    out += ch
    i += 1
  }
  return out
}
const TMPL = sliceTemplate(IDX, tmplStart)
check('模板不再写「grep 查」', !TMPL.includes('grep 查'))
check('模板不再写「用 grep 搜记忆根目录」', !TMPL.includes('用 grep 搜记忆根目录'))
check('模板不含 /memory search', !TMPL.includes('/memory search'),
  TMPL.includes('/memory search') ? '模板仍会教新用户让模型去敲命令' : '')
check('模板含「SQLite 二进制」', TMPL.includes('SQLite 二进制'))

console.log('\n=== 6. 运行时 policy.md 与模板口径一致 ===\n')
if (POLICY === '') {
  console.log('  （policy.md 不可读，跳过）')
} else {
  check('policy.md 不含 /memory search', !POLICY.includes('/memory search'),
    POLICY.includes('/memory search') ? '运行时规则里仍有用户侧命令' : '')
  check('policy.md 不再写「任何情况下都不要用」', !POLICY.includes('任何情况下都不要用'))
  check('policy.md 含「grep 只会得到乱码」', POLICY.includes('grep 只会得到乱码'))
  check('policy.md 含标记语法说明', POLICY.includes('mem-log'))
}

console.log('\n=== 7. dbMode 注入里不得「正面推荐 grep」===\n')
const grepLines = INJECT_TEXT.split('\n').filter((l) => l.includes('grep'))
const badAdvice = grepLines.filter((l) => {
  const t = l.toLowerCase()
  return !(
    l.includes('不要') || l.includes('别') || l.includes('只会得到乱码') ||
    l.includes('二进制') || l.includes('读出来是乱码') || l.includes('不是')
  )
})
check('没有「正面推荐 grep」的注入行', badAdvice.length === 0,
  badAdvice.length ? `${badAdvice.length} 行: ` + badAdvice.join(' / ').slice(0, 120) : '')

console.log('\n=== 8. 全仓扫描：docs 里还有没有 grep 记忆库 ===\n')
const docs = ['dsh-fatfishdream-memory/README.md', 'dsh-fatfishdream-memory/STORAGE.md', 'README.md', 'AGENTS.md', 'docs/TESTING.md']
let stale = 0
for (const d of docs) {
  const p = path.join(REPO, d)
  if (!fs.existsSync(p)) continue
  const t = fs.readFileSync(p, 'utf8')
  if (t.includes('或直接 grep 记忆库') || t.includes('grep 记忆库')) {
    stale++
    console.log(`  ⚠️ ${d} 仍有「grep 记忆库」的提法`)
  }
}
check('文档无残留', stale === 0)

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
