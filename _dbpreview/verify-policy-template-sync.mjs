/**
 * 校验：`POLICY_TEMPLATE`（index.js 里的模板）与当前 `policy.md` 的关系（2026-11-18，2026-11-21 重写）。
 *
 * ## 用途
 *
 * `policy.md` 是**用户数据**（GUI 维护）；`POLICY_TEMPLATE` 是**新装用户的默认值**。
 * 两者**本来就可以不同** —— 本脚本守的不是「完全相同」，而是：
 *
 *   1. 模板里**不许**夹带本机私人内容（收尾语、昵称）—— 那是所有新用户的开箱默认值；
 *   2. `policy.md` 里比模板**多出来的**，必须能被逐条解释（目前只有那条私人收尾语）；
 *   3. 模板自身的结构约束（标记语法、禁令、topic 分类……）仍然成立。
 *
 * ## 2026-11-21 重写，修掉两个假红 + 一处误导
 *
 * ### ① 行尾参与了内容比较（假红，最严重）
 *
 * 原实现：`tpl.trim() === policyNoMark.trim()` —— **逐字符**比。
 * 而 `policy.md` 在本机是 **CRLF**（266 行全是 `\r\n`），模板来自 `index.js` 是 **LF**。
 * 于是两者必然不等，报出「模板 7593 字符 vs 政策 7943 字符」。
 *
 * 实测拆解：**7943 − 7593 = 350，其中 263 个是 `\r`**。
 * 也就是说它声称「差 350 字符」，真实内容只差 **87 字符 / 1 行**。
 * 这正是 AGENTS.md 记的那类病：**判据量错了东西** —— 拿行尾参与了内容判断。
 *
 * 现在两边都先 `\r\n → \n` 归一，再比。
 *
 * ### ② 哨兵标记没被真正剥掉（假红）
 *
 * 原实现的正则 `/\n?<!-- policy-sync:\d+ -->\n?/g` 要求**开头是可选的 `\n`**，
 * 而本机的哨兵在**文件末尾**（`...写操作。\r\n\r\n<!-- policy-sync:2 -->\r\n`），
 * 前面是 `\r\n` —— 于是 `\n?` 匹配失败，整条标记留在 `policy` 里参与比对。
 *
 * 现在改成不依赖前后换行的 `\s*<!-- policy-sync:\d+ -->\s*`。
 *
 * ### ③ 硬编码了本机绝对路径（换机器直接 ENOENT，不是断言失败）
 *
 * 原实现：`'D:/workspace/dsh-fatfishdream-memory/dsh-fatfishdream-memory/index.js'`、
 * `'D:/dsh-fatfishdream-memory/policy.md'`。
 * 现在一律从 `import.meta.url` 推仓库根；`policy.md` 的位置支持环境变量覆盖。
 *
 * ## 为什么这个脚本**不进** `run-all.mjs` 的 `SCRIPTS`（本机优先，刻意为之）
 *
 * 它读的是**本机的 `policy.md`**（`D:\dsh-fatfishdream-memory\policy.md`），
 * 那个文件不在仓库里、也不随 clone 分发。
 * 一旦放进 SCRIPTS，**任何人 clone 下来跑全量回归都会因为找不到它而红** ——
 * 那是把「环境缺件」误报成「代码坏了」，与 `verify-v3-schema` 当年踩过的坑同源。
 *
 * 所以它留在**手动工具位**：本机开发时按需跑，用于确认「模板没被私人内容污染」。
 * ⚠️ 别因为它在 `_dbpreview/` 里就以为全量回归覆盖了它 —— 没有。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const IDX = path.join(ROOT, 'dsh-fatfishdream-memory', 'index.js')

// `policy.md` 与 `memory.db` 同级，**在工作区之外**（AGENTS.md 硬约束 14：那是安全边界）。
// 优先级：环境变量 > 本机默认位置。
// ⚠️ 默认值只是本机约定，别的机器/别的记忆根请用 DSH_POLICY_MD 覆盖。
const POL =
  process.env.DSH_POLICY_MD ||
  'D:/dsh-fatfishdream-memory/policy.md'

let pass = 0
let fail = 0
const failures = []

function check(name, ok, note = '') {
  ok ? pass++ : (fail++, failures.push(`${name}${note ? ` — ${note}` : ''}`))
  console.log(`  ${ok ? '✅' : '❌'} ${name}${!ok && note ? ` — ${note}` : ''}`)
}

/** 行尾归一：把 CRLF 变成 LF。**比对前必须做**，否则 \r 会冒充内容差异。 */
function norm(s) {
  return s.replace(/\r\n/g, '\n')
}

// ============================================================
console.log('=== 〇 前提：两个文件都得读得到 ===\n')

if (!existsSync(IDX)) {
  console.log(`❌ 找不到 index.js：${IDX}`)
  process.exit(1)
}
if (!existsSync(POL)) {
  // 这不是「代码坏了」，是环境缺件。**不要**用断言失败来表达它。
  console.log(`⚠️ 本段不适用：找不到 policy.md（${POL}）`)
  console.log('   这是**环境缺件**，不是代码问题 —— 换机器/clone 后本来就没有它。')
  console.log('   如需指定，用环境变量：DSH_POLICY_MD=<path>')
  process.exit(0)
}

const src = readFileSync(IDX, 'utf8')
const policyRaw = readFileSync(POL, 'utf8')

// ============================================================
console.log('\n=== ① 从 index.js 抽出 POLICY_TEMPLATE 并求值 ===\n')

const marker = 'const POLICY_TEMPLATE = '
const at = src.indexOf(marker)
check('源码里能找到 POLICY_TEMPLATE 定义', at >= 0)

if (at < 0) {
  console.log('\n无法继续：模板定义都没找到。')
  process.exit(1)
}

const bodyStart = at + marker.length
// ⚠️ marker 不带反引号，所以 bodyStart 指向的**正是模板的开引号**。
//    从 bodyStart + 1 开始扫，否则第一轮就匹配到开引号、close === bodyStart，
//    模板体会被读成空字符串 —— 那是本脚本第一版的真实 bug
//    （误报「模板写坏了」，而源码其实是好的）。
let i = bodyStart + 1
let close = -1
while (i < src.length) {
  if (src[i] === '\\') {
    i += 2 // 跳过 `\` 和它后面的一个字符（\` 或是 \\）
    continue
  }
  if (src[i] === '`') {
    close = i
    break
  }
  i += 1
}
check('能找到模板的收尾反引号', close > bodyStart, `bodyStart=${bodyStart} close=${close}`)

// 用 eval 求值（只读，模板体里只有字符串字面量）
const expr = src.slice(bodyStart, close + 1)
let tpl = ''
try {
  tpl = eval(expr)
} catch (e) {
  check('模板能被求值（转义正确）', false, String(e?.message ?? e))
}

// ---- 行尾归一（2026-11-21 修：不归一就会拿 \r 冒充内容差异）----
const tplN = norm(tpl).trim()
// 哨兵标记：不再依赖前后是否紧跟换行（旧正则漏掉了「文件末尾」这一种）
const policyNoMark = norm(policyRaw)
  .replace(/\s*<!--\s*policy-sync:\d+\s*-->\s*/g, '\n')
  .trim()

console.log(`\n模板      : ${tplN.length} 字符 / ${tplN.split('\n').length} 行（已归一行尾）`)
console.log(`policy.md : ${policyNoMark.length} 字符 / ${policyNoMark.split('\n').length} 行（已归一行尾、已剥哨兵）\n`)

// ============================================================
console.log('=== ② 模板里不许有本机私人内容（这些会发给所有新用户）===\n')

check('不含私人收尾语「大肥鱼」', !tplN.includes('大肥鱼'), '模板是新装用户的开箱默认值')
check('不含默认收尾语句式', !tplN.includes('每轮回复的结尾，加固定一句'), '收尾语只能由用户自己定')
check('不含「执行回执」这类本机专用约定', !tplN.includes('执行回执'), '那是本机 policy.md 的私人约定')

// ============================================================
console.log('\n=== ③ policy.md 比模板多出来的行，必须能被逐条解释 ===\n')

// 为什么要这一节：两边**本来就可以不同**（用户会把私人约定写在 policy.md 里）。
// 但「不同」必须**可解释**，否则就是漂移 —— 有人偷偷改了其中一边而忘了另一边。
//
// 目前唯一合法的差异是**那条私人收尾语**（含「大肥鱼」）。
// 它同时满足了前一条断言（模板里不许有它），所以这里把它单列为预期差异。
const tplLines = new Set(tplN.split('\n').map((l) => l.trimEnd()))
const policyExtra = policyNoMark
  .split('\n')
  .filter((l) => l.trim() !== '' && !tplLines.has(l.trimEnd()))

// 合法差异的判据：含私人称呼的行，且是「收尾语」语境
const PRIVATE_RE = /大肥鱼|执行回执/
const privateExtras = policyExtra.filter((l) => PRIVATE_RE.test(l))
const unexplainedExtras = policyExtra.filter((l) => !PRIVATE_RE.test(l))

check(
  'policy.md 比模板多出的非空行，全部是私人约定',
  unexplainedExtras.length === 0,
  unexplainedExtras.length === 0
    ? ''
    : `${unexplainedExtras.length} 行无法解释：` +
      unexplainedExtras.map((l) => JSON.stringify(l.slice(0, 60))).join(' | ') +
      '。要么补进模板，要么确认它该留在 policy.md（然后加进本条的白名单）',
)

if (privateExtras.length > 0) {
  console.log(`  ℹ️ 预期差异 ${privateExtras.length} 行（私人约定，模板刻意不含）：`)
  for (const l of privateExtras) console.log(`     · ${l.slice(0, 90)}${l.length > 90 ? '…' : ''}`)
} else {
  console.log('  ℹ️ 没有私人差异行（policy.md 与模板在这一维度一致）')
}

// 反向：模板里不许有 policy.md 完全没有的行 —— 那说明模板里塞了没人用的东西，
// 或者 policy.md 被删掉了一段而模板没跟着改。
const policyLines = new Set(policyNoMark.split('\n').map((l) => l.trimEnd()))
const tplOnly = tplN
  .split('\n')
  .filter((l) => l.trim() !== '' && !policyLines.has(l.trimEnd()))
check(
  '模板没有 policy.md 里不存在的非空行（模板与用户文件同源）',
  tplOnly.length === 0,
  tplOnly.length === 0
    ? ''
    : `${tplOnly.length} 行只在模板里：` + tplOnly.map((l) => JSON.stringify(l.slice(0, 60))).join(' | '),
)

// ============================================================
console.log('\n=== ④ 模板自身的结构约束 ===\n')

check('含空行规则「擦掉后每个空行会留一个空段」', tplN.includes('擦掉后每个空行会留一个空段'))
check('说明了空行后果 /空行..空段/', /空行[^\n]{0,60}空段/.test(tplN))
check('含「一律记流水」', tplN.includes('一律记流水'))
check('说明了两个通道独立 /独立的通道/', /独立的通道/.test(tplN))
check('含 mem-log 标记语法', tplN.includes('mem-log'))
check('含 memory.db 禁令', tplN.includes('memory.db'))
check('含 topic 分类', tplN.includes('开发日志 / 技术讨论'))
check('含 scope 必带', tplN.includes('scope'))
check('含 log.ps1 命令', tplN.includes('log.ps1'))
// 标记语法的三条禁令都在（2026-11-19 教训：闭合标签会永久写进库）
check('说明了「不要写闭合标签」', /不要\*\*写闭合标签|不写闭合标签|闭合标签/.test(tplN))
check('说明了「正文不要写空行」', tplN.includes('正文不要写空行'))

// ============================================================
console.log('\n' + '─'.repeat(70))
console.log(`结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
