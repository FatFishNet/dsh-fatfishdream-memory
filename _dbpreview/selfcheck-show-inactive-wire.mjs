/**
 * 回归测试：「显示已停用」开关的**前后端接线**（2026-11-20 用户实报）。
 *
 * ============================================================
 * 这个 bug 值得单独一个脚本，因为它的形态极其典型
 * ============================================================
 *
 * 用户报：**在全局规则里停用了一条规则，勾选「显示已停用的」却看不到它。**
 *
 * 实测（本机，2026-11-20）：
 *
 *     GET /entries?table=rules                 → total=8，8 条全是 active
 *     GET /entries?table=rules&status=all      → total=9，多出 1 条 stale
 *
 * **后端是对的。** `index.js` 的 `/entries` 路由里有一大段 2026-11-16 的注释，
 * 专门解释了为什么不能靠「传 undefined」而要用显式 `includeAll` 开关：
 *
 *     status: q.get('status') || 'active',
 *     includeAll: q.get('status') === 'all',
 *
 * **前端漏了。** `client.js` 里只有「不勾」这一支：
 *
 *     if (!showInactive) params.set('status', 'active')
 *
 * 勾选时**什么都不传** → 后端回落成 `'active'` → 停用条目永远列不出来。
 *
 * ============================================================
 * 为什么之前没有任何脚本抓到它
 * ============================================================
 *
 * `audit-rules.mjs` 有一条规则检测「`|| 'active'` 附近有没有 `includeAll` 开关」——
 * 它守的是**后端**，而后端确实改好了，所以一直绿。
 * `selfcheck-full.mjs` 只核对 client.js 的依赖数组里有没有 `showInactive`，
 * 不核对**它的值有没有真的被用上**。
 *
 * 于是：**两端各自的测试都是绿的，接缝处是断的。**
 *
 * 这类 bug 的判据是：
 * **「一个跨两端的约定，有没有一端在测试里被验证过它真的传了？」**
 * 只验证「字段存在」不够 —— 要看那个字段在**该传值的那条分支上**被赋予了正确的值。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const CLIENT = path.join(ROOT, 'dsh-fatfishdream-memory', 'client.js')
const INDEX = path.join(ROOT, 'dsh-fatfishdream-memory', 'index.js')

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

const clientSrc = fs.readFileSync(CLIENT, 'utf8')
const indexSrc = fs.readFileSync(INDEX, 'utf8')

/**
 * 去掉 `//` 行注释后再做匹配。
 *
 * ## 为什么必须有这一步（2026-11-20 踩，本脚本第一版就栽在这里）
 *
 * 修复时我**故意把旧写法留在了注释里**作对照说明：
 *
 *     //     if (!showInactive) params.set('status', 'active')     ← 讲解用
 *     if (showInactive) { params.set('status', 'all') }
 *
 * 而第一版断言直接在原文上跑正则 →
 *   · 「旧的『只处理不勾』写法已消失」**误报失败**（命中了注释里那句）；
 *   · 「前端发出的字面量」取到了注释里的 `'active'`，与后端 `'all'` 比对失败。
 *
 * 两条都是**假红**。这正是 AGENTS.md 记的「断言命中的是注释而不是代码」——
 * 2026-11-19 在 `writeUsesBlockRe` 上踩过一模一样的一次。
 *
 * 判据：**注释里的代码不算代码。** 断言前先剥掉，除非你要断言的对象就是注释本身。
 */
function stripLineComments(src) {
  return src
    .split('\n')
    .map((line) => {
      // 行首（允许缩进）就是 //  → 整行去掉
      if (/^\s*\/\//.test(line)) return ''
      // 行内有 // 且不在字符串里的情况这里不做精细解析 ——
      // 本项目这个位置没有「字符串里带 //」的写法；
      // 真出现时宁可误报，也不要静默漏掉（有断言盯着更好）。
      return line
    })
    .join('\n')
}

/** 取 loadEntries 里构造 params 的那一段（已剥注释）。 */
function paramsSegment() {
  const src = stripLineComments(clientSrc)
  const start = src.indexOf("params.set('table', table)")
  const end = src.indexOf('const response = await fetch(`${API_ENTRIES}', start)
  return start >= 0 && end > start ? src.slice(start, end) : ''
}

// ============================================================
console.log('=== A. 前端：勾选时必须传 status=all ===\n')

{
  // ⚠️ 必须用**剥掉注释**后的片段 —— 修复时我把旧写法留在注释里作对照，
  //    直接在原文上匹配会命中注释（本脚本第一版就是这么假红的）。
  const seg = paramsSegment()

  check('能截出参数构造段', seg.length > 100, `长度 ${seg.length}`)
  // ⚠️ 切片非空必须先断言 —— 空切片会让下面所有 includes 断言**恒假**
  // （形态 2：被切片的变量是空串）

  // ★ 核心断言 1：`status=all` 必须真的出现
  check("参数段里有 params.set('status', 'all')",
    /params\.set\(\s*'status'\s*,\s*'all'\s*\)/.test(seg),
    '缺失 → 勾选时什么状态都不传，后端回落 active')

  // ★ 核心断言 2：`status=all` 必须在 **showInactive 为真** 的那条分支上
  //
  // 只断言「文件里有 status=all」不够 —— 它可能被写在 else 分支里，
  // 那样勾选时依然不生效。这正是「断言在，但守错了分支」。
  const trueBranch = /if\s*\(\s*showInactive\s*\)\s*\{[\s\S]{0,200}?params\.set\(\s*'status'\s*,\s*'all'\s*\)/.test(seg)
  check('status=all 位于 showInactive 为真的分支内', trueBranch,
    '写在别处等于没修')

  // 反向：不勾时必须仍传 active（别把这条一起改坏）
  const falseBranch = /else\s*\{[\s\S]{0,120}?params\.set\(\s*'status'\s*,\s*'active'\s*\)/.test(seg)
  check("不勾时仍传 status='active'", falseBranch)

  // 反向：不许残留旧写法（只处理「不勾」）
  const oldForm = /if\s*\(\s*!\s*showInactive\s*\)\s*params\.set\(\s*'status'\s*,\s*'active'\s*\)/.test(seg)
  check('旧的「只处理不勾」写法已消失（注释里留作对照不算）', oldForm === false,
    '旧写法在的话，勾选时依然不传 status')
}

// ============================================================
console.log('\n=== B. 后端：必须认 status=all 并给出全量 ===\n')

{
  // 后端约定（2026-11-16 那段的产物）：
  //   status: q.get('status') || 'active'
  //   includeAll: q.get('status') === 'all'
  check("后端把 status=all 映射到 includeAll",
    /includeAll\s*:\s*q\.get\(\s*'status'\s*\)\s*===\s*'all'/.test(indexSrc),
    '后端不认 all → 前端传了也没用')

  check('后端缺省时回落 active（保持既有行为）',
    /status\s*:\s*q\.get\(\s*'status'\s*\)\s*\|\|\s*'active'/.test(indexSrc))

  // listEntries 必须真的用 includeAll 绕开默认参数
  const storeSrc = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory', 'db-store.mjs'), 'utf8')
  check('listEntries 用 includeAll 绕开默认 status 参数',
    /if\s*\(\s*!includeAll\s*&&\s*status\s*\)/.test(storeSrc),
    '不用 includeAll 的话，传 all 会被当成一个名叫 all 的状态 → 返 0 条')
}

// ============================================================
console.log('\n=== C. 两端约定一致（这是接缝，最容易断）===\n')

{
  // 前端发出去的字符串，必须正好是后端认的那个字面量。
  // 用「从两边各自抽出字面量再比对」的方式，而不是各写一个期望值 ——
  // 后者在两边都改错时会一起通过。
  //
  // ⚠️ 两边都要剥注释再抽：client.js 的注释里留了旧写法（`'active'`），
  //    index.js 的注释里也讲过 `'all'`。不剥的话抽到的是注释内容。
  const seg = paramsSegment()

  // 抽「showInactive 为真」那条分支里的字面量（而不是文件里第一个）
  const trueBranchSeg = /if\s*\(\s*showInactive\s*\)\s*\{([\s\S]{0,200}?)\}/.exec(seg)?.[1] ?? ''
  const frontAll = /params\.set\(\s*'status'\s*,\s*'([^']+)'\s*\)/.exec(trueBranchSeg)?.[1]

  const indexNoComment = stripLineComments(indexSrc)
  const backAll = /includeAll\s*:\s*q\.get\(\s*'status'\s*\)\s*===\s*'([^']+)'/.exec(indexNoComment)?.[1]

  check('能从前端 showInactive 分支抽出字面量', typeof frontAll === 'string', String(frontAll))
  check('能从后端抽 includeAll 认可的字面量', typeof backAll === 'string', String(backAll))

  check('前端发出的字面量 = 后端认可的字面量',
    typeof frontAll === 'string' && frontAll === backAll,
    `前端='${frontAll}' 后端='${backAll}'`)
  check('这个字面量是 all（约定本身没被悄悄改掉）',
    frontAll === 'all', String(frontAll))
}

// ============================================================
console.log('\n=== D. 自证：撤掉修复，断言必须变红 ===\n')

{
  // 把 if/else 换回旧写法，重跑 A 段的核心判据
  const OLD = "if (!showInactive) params.set('status', 'active')"
  const seg = paramsSegment()

  const brokenSeg = seg.replace(
    /if\s*\(\s*showInactive\s*\)\s*\{[\s\S]*?\}\s*else\s*\{[\s\S]*?\}/,
    OLD,
  )
  const replaced = brokenSeg !== seg
  check('自证：能把修复换回旧写法（锚点有效）', replaced === true)

  if (replaced) {
    // 用和 A 段**完全相同**的三条判据跑坏版本
    const brokenHasAll = /params\.set\(\s*'status'\s*,\s*'all'\s*\)/.test(brokenSeg)
    check('自证：旧写法下没有 status=all（证明 A 段断言能红）', brokenHasAll === false)

    const brokenTrueBranch = /if\s*\(\s*showInactive\s*\)\s*\{[\s\S]{0,200}?params\.set\(\s*'status'\s*,\s*'all'\s*\)/.test(brokenSeg)
    check('自证：旧写法下 showInactive 分支不传 all（证明分支断言能红）', brokenTrueBranch === false)

    const brokenOldForm = /if\s*\(\s*!\s*showInactive\s*\)\s*params\.set\(\s*'status'\s*,\s*'active'\s*\)/.test(brokenSeg)
    check('自证：旧写法被「旧形式已消失」那条断言抓到', brokenOldForm === true)

    // 再自证 C 段：坏版本下抽不出 showInactive 分支的字面量
    const brokenTrueSeg = /if\s*\(\s*showInactive\s*\)\s*\{([\s\S]{0,200}?)\}/.exec(brokenSeg)?.[1] ?? ''
    const brokenFront = /params\.set\(\s*'status'\s*,\s*'([^']+)'\s*\)/.exec(brokenTrueSeg)?.[1]
    check('自证：坏版本下前端字面量抽不到（证明 C 段能红）',
      brokenFront === undefined, String(brokenFront))
  }
}

// ============================================================
console.log('\n=== E. 行为验证提示（本脚本只查接线，查不到真实数据）===\n')
{
  // ⚠️ 本脚本是**静态**的：它证明「前端会传 status=all」「后端认 all」，
  //    但**证明不了**「用户的停用条目真的出现在列表里」—— 那需要真实库。
  //    这条边界必须写出来，否则下一个人会以为它全验过了。
  console.log('   ℹ️ 本脚本只验证前后端的**接线**（静态）。')
  console.log('      真实数据是否出现，要跑：')
  console.log('        GET /api/dsh-memory/entries?table=rules&status=all')
  console.log('      并与不带 status 的结果对比 total（应多出 stale/deleted 那些）。')
  console.log('      实测基线（2026-11-20 本机）：8（不带）vs 9（带 all）')
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
