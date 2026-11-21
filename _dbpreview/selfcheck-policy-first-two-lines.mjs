/**
 * 回归：`policy.md` 的**前两行格式**是硬性的，任何写入操作都不许动。
 *
 * ## 硬性格式（用户 2026-11-20 定）
 *
 *   **第 1 行必须是 `## 给模型的规则`
 *     第 2 行必须是「- **每轮必须无条件执行** `& ...log.ps1 ...`」那条。**
 *
 *   无论发生什么（初始化覆盖、删收尾语重建、GUI 反复改），这两行都不许动。
 *
 * ## 为什么要有这个脚本（真实 bug，用户实报）
 *
 * 2026-11-20 用户报：
 *
 *   > 如果手动在 GUI 删除收尾语，然后又重新填进去，
 *   > 「- **每轮必须无条件执行**」就会变成第三行，
 *   > 导致执行逻辑的变更，流水写入失败并且收尾语消失。
 *
 * 根因：`writeHeartbeat` / `restoreHeartbeat` 在「文件里没有收尾语行」时，
 * 用 `anchor = /^(#{1,2}\s*.*给模型的规则[^\n]*\n)/m` 把新行**插到标题正下方**
 * = 第 2 行。于是「删掉 → 再填」不幂等：
 *
 *     初始（用户实例）          删除后              重新填入后
 *     1 ## 给模型的规则         1 ## 给模型的规则    1 ## 给模型的规则
 *     2 - 必须执行 log.ps1      2 - 必须执行         2 - 收尾语   ← 挤进来了
 *     3 - 收尾语                3 （空）            3 - 必须执行 ← 被挤到第 3 行
 *
 * ## 本脚本怎么测（不碰真实 policy.md）
 *
 * 从源码抽 `locateRulesSection` 的**真实函数体**执行（不抄一份 ——
 * 抄的话源码改坏了它照样绿）。喂四种文本形态，断言插入点永远**不落进前两行**。
 *
 * 另外断言模板 `POLICY_TEMPLATE` 的第 2 行就是那条规则（新装用户也合规）。
 *
 * ## 踩过的坑（写这个脚本时）
 *
 * **CRLF 偏移**：第一版 `locateRulesSection` 把文本 `.replace(/\r\n?/g,'\n')`
 * 归一化后再算字符偏移，而调用方拿它去切**原始 CRLF 文本** ——
 * 每个 `\r` 少算 1 个字符，越往后越偏。实测第 3 行起偏移应为 127、
 * 归一化算出 126，插入点落在句子中间，写出来是「…不许套模板\n。\n」。
 *
 * 所以本脚本**必须**测 CRLF 输入 —— 这正是它当初失效的形态。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory', 'index.js')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}  ← ${detail}`)
  }
}

const SRC = fs.readFileSync(INDEX, 'utf8')

/** 从源码抽出某个 `function NAME(` 的完整体（按大括号配对）。找不到就抛。 */
function extractFn(name) {
  const at = SRC.indexOf(`function ${name}(`)
  if (at < 0) throw new Error(`源码里找不到 function ${name}`)
  let d = 0
  let started = false
  for (let i = at; i < SRC.length; i++) {
    if (SRC[i] === '{') {
      d++
      started = true
    } else if (SRC[i] === '}') {
      d--
      if (started && d === 0) return SRC.slice(at, i + 1)
    }
  }
  throw new Error(`function ${name} 的大括号不配对`)
}

// eslint-disable-next-line no-new-func
const locateRulesSection = new Function(`${extractFn('locateRulesSection')}; return locateRulesSection;`)()

// ============================================================
console.log('=== ① locateRulesSection 存在且能被抽出执行 ===\n')

check('源码里有 locateRulesSection', SRC.includes('function locateRulesSection('))
check('抽出的函数可执行（typeof function）', typeof locateRulesSection === 'function')

// ============================================================
console.log('=== ② 四种文本形态：插入点都不得落进前两行 ===\n')

/** 把一段文本按插入点切开，看新行会落在第几行。 */
function insertAndReport(text, newLine) {
  const seg = locateRulesSection(text)
  if (!seg) return { at: null, lines: null }
  const sim = text.slice(0, seg.insertAt) + newLine + seg.eol + text.slice(seg.insertAt)
  return { seg, lines: sim.split(/\r?\n/) }
}

const MUST = '- **每轮必须无条件执行** `& .\\.dsh-fatfishdream-memory\\log.ps1 "<本轮一句话结论>"`：不跳轮'
const HB = '- 脚本执行成功**之后**，才允许在回复最后一行输出：大肥鱼是漂亮老婆！'
const NEW = '- 【新插入的收尾语】大肥鱼是漂亮老婆！'

const cases = [
  {
    label: 'CRLF · 必须执行在第2行（用户实例）',
    text: `## 给模型的规则\r\n${MUST}\r\n${HB}\r\n\r\n## 简单用法\r\n- 别的\r\n`,
  },
  {
    label: 'LF · 必须执行在第2行',
    text: `## 给模型的规则\n${MUST}\n${HB}\n\n## 简单用法\n- 别的\n`,
  },
  {
    label: 'CRLF · 只有必须执行一条',
    text: `## 给模型的规则\r\n${MUST}\r\n\r\n## 简单用法\r\n- 别的\r\n`,
  },
  {
    label: 'CRLF · 该段一条规则都没有（空段）',
    text: `## 给模型的规则\r\n\r\n## 简单用法\r\n- 别的\r\n`,
  },
]

for (const c of cases) {
  const { seg, lines } = insertAndReport(c.text, NEW)
  check(`[${c.label}] 能定位到插入点`, seg !== null && Number.isInteger(seg.insertAt))
  if (!lines) continue

  // ★ 核心：前两行不许被改动
  check(`[${c.label}] 第 1 行仍是 \`## 给模型的规则\``,
    lines[0] === '## 给模型的规则', `实际 ${JSON.stringify(lines[0])}`)

  const line2 = lines[1] ?? ''
  const line2Kept = line2.includes('每轮必须无条件执行')
  // 「空段」那种输入本来就没有第 2 行规则，此时新行插到第 2 行是允许的
  const isBlankSection = c.label.includes('空段')
  check(
    `[${c.label}] 第 2 行${isBlankSection ? '（空段，新行可占位）' : '仍是「必须执行」'} `,
    isBlankSection ? true : line2Kept,
    `实际 ${JSON.stringify(line2.slice(0, 50))}`,
  )

  // 新行必须出现在第 3 行或更后（空段例外：它可以占第 2 行）
  const newAt = lines.findIndex((l) => l.includes('新插入的收尾语'))
  check(`[${c.label}] 新行不在第 2 行（除非空段）`,
    isBlankSection ? newAt >= 1 : newAt >= 2,
    `新行在第 ${newAt + 1} 行`)
}

// ============================================================
console.log('\n=== ③ CRLF 偏移必须精确（这是第一版失效的形态）===\n')
{
  const text = `## 给模型的规则\r\n${MUST}\r\n${HB}\r\n\r\n## 简单用法\r\n`
  const seg = locateRulesSection(text)
  // 手工算期望偏移：前 3 行（标题 + 两条规则）连同换行符
  const lines = [ '## 给模型的规则', MUST, HB ]
  let want = 0
  for (const l of lines) want += l.length + 2 // +2 = CRLF
  check('CRLF 下插入偏移 = 前三行长度 + 各自的 \\r\\n',
    seg && seg.insertAt === want, `实际 ${seg?.insertAt}，期望 ${want}`)
  check('识别出的换行符是 CRLF',
    seg && seg.eol === '\r\n', `实际 ${JSON.stringify(seg?.eol)}`)
}

// ============================================================
console.log('\n=== ④ POLICY_TEMPLATE 的第 2 行就是那条规则（新装用户也合规）===\n')
{
  const at = SRC.indexOf('const POLICY_TEMPLATE = `')
  check('能找到 POLICY_TEMPLATE', at > 0)
  if (at > 0) {
    const end = SRC.indexOf('\n`\n', at)
    const body = SRC.slice(at + 'const POLICY_TEMPLATE = `'.length, end)
    const tplLines = body.split('\n')
    check('模板第 1 行是 `## 给模型的规则`',
      tplLines[0] === '## 给模型的规则', JSON.stringify(tplLines[0]))
    check('模板第 2 行以 `- **每轮必须无条件执行**` 开头',
      /^- \*\*每轮必须无条件执行\*\*/.test(tplLines[1] ?? ''),
      JSON.stringify((tplLines[1] ?? '').slice(0, 50)))
    check('模板第 2 行提到 log.ps1',
      (tplLines[1] ?? '').includes('log.ps1'))
  }
}

// ============================================================
console.log('\n=== ⑤ 两处写入点都走 locateRulesSection（不再用 anchor 插标题下）===\n')
{
  // 剥注释后再查，避免命中「已废弃」的历史说明
  const codeOnly = SRC
    .split('\n')
    .map((line) => {
      const t = line.trimStart()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
      const i = line.indexOf('//')
      return i >= 0 ? line.slice(0, i) : line
    })
    .join('\n')

  const uses = (codeOnly.match(/locateRulesSection\(current\)/g) ?? []).length
  check('可执行代码里有两处调用 locateRulesSection（writeHeartbeat + restoreHeartbeat）',
    uses === 2, `实际 ${uses} 处`)

  // 反向：可执行代码里不该再有「anchor 插标题下」的写法
  const anchorLive = /const anchor = \/\^\(#\{1,2\}/.test(codeOnly)
  check('可执行代码里已无 `const anchor = /^(#{1,2}...` 的插入写法',
    anchorLive === false, '旧的「插到标题下第一行」写法还在，会把第 2 行挤走')
}

// ============================================================
console.log('\n=== ⑥ 自证：把 locateRulesSection 换回「插标题下第一行」，断言必须变红 ===\n')
{
  // 用同样的输入，喂一个**故意错误**的定位器（插在标题正下方 = 第 2 行）
  const broken = (text) => {
    const lines = String(text).split(/\r?\n/)
    let head = lines.findIndex((l) => /^#{1,2}\s*.*给模型的规则/.test(l))
    if (head < 0) return null
    let offset = 0
    for (let i = 0; i <= head; i++) offset += lines[i].length + (i < lines.length - 1 ? 2 : 0)
    return { insertAt: offset, eol: '\r\n' }
  }
  const text = `## 给模型的规则\r\n${MUST}\r\n${HB}\r\n\r\n## 简单用法\r\n`
  const seg = broken(text)
  const sim = text.slice(0, seg.insertAt) + NEW + seg.eol + text.slice(seg.insertAt)
  const lines = sim.split(/\r?\n/)
  check('自证：错误实现会把新行放在第 2 行（证明②的断言能红）',
    lines[1].includes('新插入的收尾语'),
    `实际第 2 行：${JSON.stringify(lines[1].slice(0, 40))}`)
  check('自证：错误实现下「必须执行」被挤到第 3 行',
    lines[2].includes('每轮必须无条件执行'),
    `实际第 3 行：${JSON.stringify((lines[2] ?? '').slice(0, 40))}`)
}

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
