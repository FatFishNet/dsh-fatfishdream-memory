/**
 * 校验 `AGENTS.md` 里的「代码事实」引用是否真实存在。
 *
 * ## 为什么需要这个脚本（2026-11-18）
 *
 * `AGENTS.md` 里有一类引用是**代码事实**：
 *
 *   代码事实（`index.js` 的 `ensureLayout()`）：`if (!(await exists(paths.policy)))` ——
 *
 * 它声称两件事，**此前一个都没人验**：
 *   ① `index.js` 里真的存在 `ensureLayout()` 这个函数；
 *   ② 那个函数里真的有 `if (!(await exists(paths.policy)))` 这段代码。
 *
 * 2026-11-18 实测（当时的引用写的是行号 `L2086`）：
 *
 *   - 真实位置是 `L2145`，`L2086` 是 `.map((line) => line.trim())` —— **指错了**
 *   - 改成正确行号后，把行号换成**不存在的函数名** `noSuchFunctionXYZ()`，
 *     `verify-map` / `verify-map-content` / `verify-symbol-lines` /
 *     `verify-map-forms` / `verify-doc-links` **五个脚本全部报绿**
 *   - 换成**真实存在但无关**的 `analyzeEmotion()`，同样全绿
 *
 * 根因：`verify-map` 系只读 `docs/项目地图.md`；`verify-doc-links` 读 `AGENTS.md`
 * 但**只查链接目标是否存在**，不查代码引用。于是 `AGENTS.md` 里的代码事实
 * **完全没有守卫** —— 这正是本文件自己记着的那条教训：
 *
 *   > 「0 失败」只说明「它看的那部分是对的」，不说明文档是对的。
 *
 * ## 判据（每条都必须能失败）
 *
 * 对每一处 `代码事实（`文件名` 的 `符号()`）：`代码片段``：
 *   1. 文件存在
 *   2. 符号在文件里**有且仅有一个**定义（多个 = 无法唯一定位，也算失败）
 *   3. 代码片段在文件里**存在**
 *   4. 两者处于同一函数体内（符号定义行 < 片段行，且中间没有别的顶层函数介入）
 *
 * ## 故障注入
 *
 * 本脚本自带 `--self-test`：它会篡改内存中的文档副本，
 * 断言上面 4 条判据**确实会红**。跑法：
 *
 *   node _dbpreview/verify-agents-codefacts.mjs --self-test
 *
 * 不加参数时只校验真实文档。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const DOC = path.join(REPO, 'AGENTS.md')

const SELF_TEST = process.argv.includes('--self-test')

let pass = 0
let fail = 0
const failures = []

const check = (label, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`)
  }
}

/**
 * 从文档里抽出所有「代码事实」引用。
 *
 * 形态限定得很窄，是刻意的：
 *   - 只认带 `代码事实` 这个词的行 —— 它是一处**声明**，不是顺口一提；
 *   - 只认「`文件名` 的 `符号()`」+「`代码片段`」同时出现。
 *
 * ⚠️ 不要放宽成「任何反引号里的东西」：文档里大量反引号是术语
 * （`policy.md`、`scope=all`），把它们当代码引用会产生海量误报，
 * 而**一个误报很多的检查等于没有检查**（人会开始忽略它）。
 */
function extractCodeFacts(docText) {
  const out = []
  const lines = docText.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.includes('代码事实')) continue
    // 形态：`x.js` 的 `fn()`）：`code`
    const m = line.match(
      /`([\w./-]+\.(?:js|mjs))`\s*的\s*`([A-Za-z_$][\w$]*)\(\)`\s*[）)]?\s*[:：]\s*`([^`]+)`/,
    )
    if (!m) {
      out.push({ line: i + 1, raw: line.trim(), parseError: true })
      continue
    }
    out.push({
      line: i + 1,
      raw: line.trim(),
      file: m[1],
      symbol: m[2],
      snippet: m[3].trim(),
    })
  }
  return out
}

/**
 * 找符号的**定义**行（不是调用行）。
 *
 * 只看两种形态：`function name(`、`const name =`。
 * 为什么不用「包含这个名字」：`ensureLayout(` 也会在调用处命中，
 * 那样「符号存在」会永远成立 —— 又是一个恒真判据。
 */
function findDefinition(lines, symbol) {
  const hits = []
  const reFn = new RegExp(`^\\s*(?:async\\s+)?function\\s+${symbol}\\s*\\(`)
  const reConst = new RegExp(`^\\s*(?:const|let|var)\\s+${symbol}\\s*=`)
  lines.forEach((l, i) => {
    if (reFn.test(l) || reConst.test(l)) hits.push(i + 1)
  })
  return hits
}

/**
 * 判定「片段是否在该符号的函数体内」。
 *
 * 做法：从符号定义行往下扫，遇到**缩进不深于符号定义行**的另一条
 * 函数/常量声明就停 —— 那是下一个顶层成员。
 *
 * ⚠️ 不能用「向上找最近的顶格 function」：本项目的 store 工厂函数
 * 是缩进两格的（`  async function ensureLayout() {`），按顶格找会
 * 跨到几百行之前的另一个函数上去。2026-11-18 实测踩过这个坑。
 */
function snippetInsideSymbol(lines, defLine, snippet) {
  const defIndent = (lines[defLine - 1].match(/^\s*/) ?? [''])[0].length
  for (let i = defLine; i < lines.length; i++) {
    const l = lines[i]
    const txt = l.trim()
    if (txt === '') continue
    const ind = (l.match(/^\s*/) ?? [''])[0].length
    // 缩进回退到定义同级或更浅，且看起来是另一个成员 → 已经出界
    if (i > defLine && ind <= defIndent && /^(?:async\s+)?function\s+\w+|^(?:const|let|var)\s+\w+\s*=/.test(txt)) {
      return { inside: false, at: i + 1 }
    }
    if (txt.includes(snippet)) return { inside: true, at: i + 1 }
  }
  return { inside: false, at: null }
}

function runOn(docText, label) {
  console.log(`\n=== ${label} ===\n`)
  const facts = extractCodeFacts(docText)
  console.log(`  抽到 ${facts.length} 处「代码事实」引用\n`)

  if (facts.length === 0) {
    // 不产生断言 —— 没有断言可写就不要制造一个恒真的
    console.log('  本段不适用：文档里没有「代码事实」引用。')
    return
  }

  for (const f of facts) {
    const tag = `L${f.line}`
    if (f.parseError) {
      check(`${tag} 引用形态可解析`, false, `无法解析：${f.raw.slice(0, 80)}`)
      continue
    }

    const abs = path.join(REPO, 'dsh-fatfishdream-memory', path.basename(f.file))
    if (!fs.existsSync(abs)) {
      check(`${tag} 文件存在（${f.file}）`, false)
      continue
    }
    const src = fs.readFileSync(abs, 'utf8')
    const lines = src.split(/\r?\n/)

    // ① 符号有且仅有一个定义
    const defs = findDefinition(lines, f.symbol)
    check(
      `${tag} 符号 \`${f.symbol}()\` 有唯一定义`,
      defs.length === 1,
      defs.length === 0 ? '找不到定义' : defs.length > 1 ? `找到 ${defs.length} 处：L${defs.join(', L')}` : `L${defs[0]}`,
    )
    if (defs.length !== 1) continue

    // ② 代码片段存在
    const snippetLine = lines.findIndex((l) => l.includes(f.snippet))
    check(
      `${tag} 代码片段存在于 ${f.file}`,
      snippetLine >= 0,
      snippetLine >= 0 ? `L${snippetLine + 1}` : `找不到：${f.snippet.slice(0, 60)}`,
    )
    if (snippetLine < 0) continue

    // ③ 片段位于该符号体内
    const rel = snippetInsideSymbol(lines, defs[0], f.snippet)
    check(
      `${tag} 片段位于 \`${f.symbol}()\` 体内`,
      rel.inside,
      rel.inside ? `符号 L${defs[0]} → 片段 L${rel.at}` : `片段 L${snippetLine + 1} 在符号 L${defs[0]} 之外`,
    )
  }
}

// ---- 主流程 ----
const docText = fs.readFileSync(DOC, 'utf8')
runOn(docText, '真实文档校验')

if (SELF_TEST) {
  // 故障注入：每条篡改都必须让判据变红。
  // 没有这一段，就无法证明上面的断言不是恒真的。
  console.log('\n\n########## 故障注入（--self-test）##########')

  const origin = extractCodeFacts(docText)[0]
  if (!origin || origin.parseError) {
    console.log('\n  跳过故障注入：文档里没有可用的「代码事实」引用可篡改。')
  } else {
    const before = pass
    const beforeFail = fail

    // ① 换成不存在的函数名
    {
      const p0 = pass
      const f0 = fail
      const mutated = docText.replace(`\`${origin.symbol}()\``, '`noSuchFunctionXYZ()`')
      pass = 0
      fail = 0
      runOn(mutated, '注入 1：不存在的函数名')
      check(
        '注入 1 必须让校验变红',
        fail > 0,
        `实际 PASS=${pass} FAIL=${fail}`,
      )
      pass = p0
      fail = f0
    }

    // ② 换成真实但无关的函数
    //
    // ⚠️ 2026-11-18 修：原来用 `allFns.find(n => n !== origin.symbol)` ——
    // 它永远取文件里**第一个**函数（实测是 L109 的 `safePushMessage`）。
    // 结果虽然会红，但只测了「离得最远的那个」，**没测「离得最近的」** ——
    // 而后者才是真会出事的误写形态（手滑写成本函数上面那个）。
    // 现在取「定义位置离目标符号最近的那个其它函数」，那是最难区分的诱饵。
    {
      const srcPath = path.join(REPO, 'dsh-fatfishdream-memory', path.basename(origin.file))
      const src = fs.readFileSync(srcPath, 'utf8')
      const srcLines = src.split(/\r?\n/)

      // 目标符号的真实定义行
      const targetDef = findDefinition(srcLines, origin.symbol)[0]

      // 收集全部函数定义：{name, line}
      const fnDefs = []
      srcLines.forEach((l, i) => {
        const m = l.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
        if (m) fnDefs.push({ name: m[1], line: i + 1 })
      })

      // 取离目标最近的（行距最小），且不是自己
      const near = fnDefs
        .filter((f) => f.name !== origin.symbol)
        .sort((a, b) => Math.abs(a.line - targetDef) - Math.abs(b.line - targetDef))[0]

      if (!near) {
        console.log('\n  注入 2 不适用：源文件里没有别的函数名可用。')
      } else {
        const p0 = pass
        const f0 = fail
        const mutated = docText.replace(`\`${origin.symbol}()\``, `\`${near.name}()\``)
        pass = 0
        fail = 0
        runOn(
          mutated,
          `注入 2：换成最近的无关函数 \`${near.name}()\`（L${near.line}，距目标 ${Math.abs(near.line - targetDef)} 行）`,
        )
        check('注入 2 必须让校验变红', fail > 0, `实际 PASS=${pass} FAIL=${fail}`)
        pass = p0
        fail = f0
      }
    }

    // ③ 篡改代码片段（改成源码里没有的）
    {
      const p0 = pass
      const f0 = fail
      const mutated = docText.replace(origin.snippet, 'if (!(await exists(GHOST_PATH_XYZ)))')
      pass = 0
      fail = 0
      runOn(mutated, '注入 3：不存在的代码片段')
      check('注入 3 必须让校验变红', fail > 0, `实际 PASS=${pass} FAIL=${fail}`)
      pass = p0
      fail = f0
    }

    // 复原真实统计（注入期间的 pass/fail 已归还）
    console.log(`\n  注入前基准：PASS=${before} FAIL=${beforeFail}`)
  }
}

console.log('\n────────────────')
console.log(fail === 0 ? `✅ 结果：PASS=${pass} FAIL=${fail}` : `❌ 结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：' + failures.join(' | '))
}
process.exit(fail === 0 ? 0 : 1)
