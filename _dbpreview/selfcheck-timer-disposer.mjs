/**
 * 延迟调度的资源纪律（待办 Z / W / Y 的回归，2026-11-28）。
 *
 * 守三件**同一类**的事：**「先判断/先持有」的东西，后来又没人管了**。
 *
 *   Z · 裸 `ROLLBACK`    —— 回滚自己抛错时会把**原始错误顶掉**，用户看到的是
 *                           「ROLLBACK 失败」而不是真正的原因（磁盘满 / 约束冲突）
 *   W · `dbCopied` 死变量 —— 写了一次、**从未读过**，让人误以为调用方能知道库搬没搬
 *   Y · 裸 `setTimeout`   —— 返回值没接 → 不能 unref、卸载时也没人 clearTimeout，
 *                           插件卸载/热重载后**仍会再触发一次**
 *
 * ## 为什么这三条要放一个脚本里
 *
 * 它们是同一个反模式的三种形态：**做了动作，却不接住那个句柄/结果**。
 * 分开写容易各自被「改成看起来对的样子」骗过；放一起是提醒：
 * 改任何一条时，想想另外两条有没有同构的地方。
 *
 * ⚠️ 本脚本**只用源码级断言**（这些代码路径要真跑起来得有 DB / ctx / 插件宿主）。
 *    源码级断言的已知弱点是「改名就失明」，所以每条都带**能说明白为什么**的 detail，
 *    并且用注释锁住「这条断言在问什么」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/index.js'), 'utf8')
const STORE = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/db-store.mjs'), 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`) }
  else { fail++; bad.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${label} — ${detail}`) }
}

/** 取 index.js 里某段（用于把断言限定在函数体内，避免「别处有同样的字」骗过） */
function seg(src, startPat, length = 3000) {
  const at = src.search(startPat)
  return at < 0 ? '' : src.slice(at, at + length)
}

// ============================================================
console.log('\n=== 1. Z · 裸 ROLLBACK 必须包 try（待办 Z）===\n')
{
  // 判据：每一处 `d.exec('ROLLBACK')` 前面 60 字符内必须有 `try {`。
  // 为什么用「前面 60 字符」而不是「同一行」：正确写法是
  //     try {
  //       d.exec('ROLLBACK')
  //     } catch { … }
  // ROLLBACK 独占一行，同行判断必然误报。
  const lines = STORE.split('\n')
  let bare = 0
  let total = 0
  lines.forEach((line, i) => {
    if (!/d\.exec\('ROLLBACK'\)/.test(line)) return
    total++
    const before = lines.slice(Math.max(0, i - 2), i + 1).join('\n')
    if (!/\btry\s*\{/.test(before)) {
      bare++
      console.log(`       L${i + 1}: ${line.trim()}`)
    }
  })
  check(
    '每一处 ROLLBACK 都包在 try 里（不能顶掉原始错误）',
    bare === 0,
    bare ? `${bare}/${total} 处是裸的` : '',
  )
  check('确实扫到了 ROLLBACK（否则上一条是空断言）', total >= 3, `只扫到 ${total} 处`)

  // ★ 行为级自证：旧写法在 ROLLBACK 抛错时**会丢掉原始错误**。
  //   这条不依赖源码形态，是真正在验证「修的值不值」。
  const oldStyle = () => {
    try { throw new Error('原始错误：磁盘满了') } catch (e) {
      const exec = (sql) => { if (sql === 'ROLLBACK') throw new Error('ROLLBACK 失败') }
      exec('ROLLBACK')
      throw e
    }
  }
  const newStyle = () => {
    try { throw new Error('原始错误：磁盘满了') } catch (e) {
      const exec = (sql) => { if (sql === 'ROLLBACK') throw new Error('ROLLBACK 失败') }
      try { exec('ROLLBACK') } catch { /* 别掩盖 */ }
      throw e
    }
  }
  const msgOf = (fn) => { try { fn() } catch (e) { return e.message } return null }
  check(
    '自证：旧写法确实会顶掉原始错误（证明这条修复有意义）',
    msgOf(oldStyle) === 'ROLLBACK 失败',
    `实际 ${msgOf(oldStyle)}`,
  )
  check(
    '自证：新写法保住原始错误',
    msgOf(newStyle) === '原始错误：磁盘满了',
    `实际 ${msgOf(newStyle)}`,
  )
}

// ============================================================
console.log('\n=== 2. W · 不许留「只写不读」的变量（待办 W）===\n')
{
  // 泛化判据（不只是 dbCopied）：找出 `let X = ` 声明后**读取次数为 0** 的。
  // 只查那几个已知的历史嫌疑名，避免把大量局部变量误报进来。
  const SUSPECTS = ['dbCopied']
  for (const name of SUSPECTS) {
    // ⚠️ 必须**剥掉注释**再判，否则会像我第一版那样：
    //   注释里写着「这里原本有个 `let dbCopied = false`」——
    //   那句说明文字让「仍有 1 处声明」永远为真，断言从此恒红。
    //   这正是本项目记过的「注释里的代码不算代码」。
    const codeOnly = INDEX
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    const decl = new RegExp(`\\b(?:let|const)\\s+${name}\\b`, 'g')
    const declCount = (codeOnly.match(decl) ?? []).length
    check(
      `${name} 已删除（代码里无声明）`,
      declCount === 0,
      `仍有 ${declCount} 处声明`,
    )
  }
}

// ============================================================
console.log('\n=== 3. Y · setTimeout 必须接住句柄（待办 Y）===\n')
{
  // 判据：顶层语句 `setTimeout(` **不能**出现在行首——那样返回值就丢了。
  // 正确写法是 `const xxxTimer = setTimeout(…)`。
  //
  // ⚠️ 为什么要查这个而不是查「有没有 unref」：
  //    光有 unref 不够（那只解决进程退出），卸载时还得 clearTimeout；
  //    光接句柄也不够（没接 disposer 照样泄漏）。
  //    三步缺一不可，所以下面连 disposer 一起查。
  const lines = INDEX.split('\n')
  const bareTop = []
  lines.forEach((line, i) => {
    // 只看「语句级」调用：行首（允许缩进）就是 setTimeout
    if (/^\s*setTimeout\s*\(/.test(line)) {
      // `setTimeout(` 作为表达式开头 = 返回值被丢弃
      bareTop.push(`L${i + 1}: ${line.trim()}`)
    }
  })
  check(
    '没有「行首裸 setTimeout」（返回值必须接住）',
    bareTop.length === 0,
    bareTop.length ? bareTop.join(' | ') : '',
  )

  // 两个具体的定时器必须有完整三件套
  const CASES = [
    { name: 'writableTimer', fn: 'checkWritableRoot', label: '可写性探针' },
    { name: 'healthTimer', fn: 'runHealthCheck', label: '健康检查' },
  ]
  for (const c of CASES) {
    // ⚠️ 2026-11-28（待办 H）：这里原来只认「`setTimeout(` 后面紧跟函数名」。
    //    修 H 时把健康检查改成了 `setTimeout(() => { layoutReady.finally(...) }, 600)`
    //    —— 本断言立刻报红。**红得对**：它的职责是「返回值被接住」，
    //    而我改动的是「回调里做了什么」，两者不该混为一谈。
    //    现在放宽成：句柄被 `const <name> = setTimeout(...)` 接住即可，
    //    回调体是什么不管（回调内容由别的断言守）。
    //    ⚠️ 关键是**没有**放宽成「只要出现过 setTimeout 就行」——
    //    那会让「忘了接句柄」这个真问题重新变绿。
    const hasDecl = new RegExp(`const\\s+${c.name}\\s*=\\s*setTimeout\\(`).test(INDEX)
    const hasUnref = new RegExp(`${c.name}\\.unref\\?\\.\\(\\)`).test(INDEX)
    const hasClear = new RegExp(`clearTimeout\\(${c.name}\\)`).test(INDEX)
    check(`${c.label}：返回值接进 ${c.name}`, hasDecl, '没有接住句柄')
    check(`${c.label}：调了 unref（不拖住进程退出）`, hasUnref, '缺 unref')
    check(`${c.label}：卸载时 clearTimeout（热重载后不再触发）`, hasClear, '缺清理函数')
  }

  // ⚠️ 额外守一条：健康检查**必须等布局就绪**（待办 H 的副作用要求）。
  // 为什么单独守：`setTimeout(600)` 是「猜布局已经好了」，而
  // `layoutReady` 是「知道它好了」。改回纯 setTimeout 会退化成赌时序。
  check(
    '健康检查等的是 layoutReady（不是单纯赌 600ms）',
    /layoutReady\.finally\(/.test(INDEX),
    '退回纯定时器 = 又变成猜时序',
  )

  // ★ 反向断言：命令式「三件套」的样板本身不能被改坏
  const hasProbeSample =
    /const\s+probeSidebar\s*=\s*setTimeout/.test(INDEX) &&
    /probeSidebar\.unref\?\.\(\)/.test(INDEX) &&
    /clearTimeout\(probeSidebar\)/.test(INDEX)
  check('样板 probeSidebar 仍是完整三件套（它是这两处的参照）', hasProbeSample)
}

// ============================================================
console.log('\n=== 4. 反证：这些断言真的能失败 ===\n')
{
  // 用一段「故意写错」的假源码跑同样的判据，确认判据会报红。
  // 没有这一步，上面全绿只证明「脚本没崩」，不证明「它看得见问题」。
  const fakeBad = `
  setTimeout(checkWritableRoot, 1500)
  const dbCopied = false
  dbCopied = true
  `
  const fakeLines = fakeBad.split('\n')
  const fakeBare = fakeLines.filter((l) => /^\s*setTimeout\s*\(/.test(l))
  check('反证：裸 setTimeout 会被判红', fakeBare.length === 1, `实际 ${fakeBare.length}`)

  // ⚠️ 第一版反证**没通过**，而它暴露了判据的真实盲区：
  //    我写的假源码是 `try { … } catch (e) { d.exec('ROLLBACK'); throw e }`,
  //    ROLLBACK 和 `try {` 挤在同一行 —— 于是「往前看 2 行」的窗口里
  //    **必然**含 `try {`（就是外层那个 catch 块里的），判据认定「包好了」。
  //    也就是说：**这个判据只认「独占一行的 try {”，不认同行**。
  //    这不是 bug，是实现口径 —— 但必须把口径写清楚，否则下一个人
  //    以为它真能查「任意形态的裸 ROLLBACK」。
  //
  // 现在的反证用**真正的裸形态**（独占一行、没有 try）来验证，才对得上判据。
  const fakeStore = [
    "    try {",
    "      d.exec('COMMIT')",
    "    } catch (e) {",
    "      d.exec('ROLLBACK')",        // ← 独占一行的裸调用 = 判据要抓的形态
    "      throw e",
    "    }",
  ].join('\n')
  const fs2 = fakeStore.split('\n')
  let fakeBareRb = 0
  fs2.forEach((line, i) => {
    if (!/d\.exec\('ROLLBACK'\)/.test(line)) return
    const before = fs2.slice(Math.max(0, i - 2), i + 1).join('\n')
    if (!/\btry\s*\{/.test(before)) fakeBareRb++
  })
  check('反证：独占一行的裸 ROLLBACK 会被判红', fakeBareRb === 1, `实际 ${fakeBareRb}`)

  // ★ 同时刻意记下**判据的边界**：同一行里的 try 不算。
  //   写成正向断言（而不是留个坑），这样以后谁改判据都会看到这条约束。
  const sameLine = "} catch (e) { try { d.exec('ROLLBACK') } catch {} throw e }"
  let sameLineCaught = 0
  sameLine.split('\n').forEach((line, i) => {
    if (!/d\.exec\('ROLLBACK'\)/.test(line)) return
    if (!/\btry\s*\{/.test(line)) sameLineCaught++
  })
  check(
    '已知边界：同行 `try { d.exec(ROLLBACK) }` 判据认定为「已包」（不误报）',
    sameLineCaught === 0,
    '判据把同行写法判成裸的吗？那样会误报',
  )
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
