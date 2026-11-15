/**
 * 纯逻辑单测：验证剥离正则的行为。
 *
 * 重点验证：
 *   1. 完整标记能被删掉（多行、含引号、含斜杠）
 *   2. 讲解格式时写的行内代码片段**不被误删**（实测踩过的 bug）
 *   3. 未闭合的标记（流式中途）能被整段擦掉
 *   4. 普通正文不受影响
 */

const MEM_STRIP_RE = /^[ \t]*<!--mem-(?:log|fact|note|fix)\b[^`]*?-->[ \t]*$/gm
const MEM_PARTIAL_RE = /^[ \t]*<!--mem-(?:l(?:og)?|f(?:act|ix)?|n(?:ote)?)?[\s\S]*$/m

/** 复刻 client.js 里的剥离逻辑 */
function strip(src) {
  let after = src.replace(MEM_STRIP_RE, '')
  const partial = MEM_PARTIAL_RE.exec(after)
  if (partial) {
    after = after.slice(0, partial.index) + after.slice(partial.index + partial[0].length)
  }
  return after
}

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok) {
    console.log(`   期望: ${JSON.stringify(expected)}`)
    console.log(`   实际: ${JSON.stringify(actual)}`)
  }
}

console.log('=== 1. 完整标记剥离 ===\n')

check(
  '单行流水被完全删除',
  strip('正文\n<!--mem-log topic=开发日志\n- 一行\n-->\n结尾'),
  '正文\n\n结尾',
)

check(
  '多行含引号斜杠加粗',
  strip('A\n<!--mem-log topic=注入/预算\n- 含"引号"和**加粗**\n- 第二行\n-->\nB'),
  'A\n\nB',
)

check(
  '一条回复里有两个标记',
  strip('X\n<!--mem-log topic=a\n- 1\n-->\nY\n<!--mem-note topic=b\n- 2\n-->\nZ'),
  'X\n\nY\n\nZ',
)

check(
  '四种 kind 都认',
  strip('<!--mem-log a\n1\n-->\n<!--mem-fact b\n2\n-->\n<!--mem-note c\n3\n-->\n<!--mem-fix d\n4\n-->'),
  '\n\n\n',
)

console.log('\n=== 2. 不该被删的（实测踩过的 bug）===\n')

// 🔴 这就是我回复里讲格式时会写的句子。
// 旧正则 /<!--mem-(?:log|fact|note|fix)[\s\S]*?-->/g 会把它整段吃掉。
check(
  '行内代码里讲解标记格式 → 一字不动',
  strip('写法是 `<!--mem-log` 加内容 `-->` 这样'),
  '写法是 `<!--mem-log` 加内容 `-->` 这样',
)

check(
  '不完整的 <!--mem 不匹配',
  strip('这里不要写 <!--mem 这种'),
  '这里不要写 <!--mem 这种',
)

check(
  '非 mem 的 HTML 注释不动',
  strip('<!-- 普通注释 -->'),
  '<!-- 普通注释 -->',
)

check(
  '正文中间提到标记但不在行首 → 不动',
  strip('前面有内容 <!--mem-log topic=x --> 后面'),
  '前面有内容 <!--mem-log topic=x --> 后面',
)

console.log('\n=== 3. 流式未闭合标记（应整段擦掉）===\n')

check(
  '未闭合标记整段擦除',
  strip('结论写完了\n<!--mem-log topic=技术讨论\n- 第一点'),
  '结论写完了\n',
)

// 只敲到 `<!--mem` 时还没出现 kind，无法判断这是标记还是正文，
// 所以故意不擦（宁可闪一下，也不要误伤正文）。
// 一旦 `-l` / `-f` / `-n` 出现就确定了。
check(
  '只敲到 <!--mem（还没 kind）→ 不擦',
  strip('正文\n<!--mem'),
  '正文\n<!--mem',
)

check(
  '敲出 <!--mem-l（kind 开头）→ 擦',
  strip('正文\n<!--mem-l'),
  '正文\n',
)

check(
  '前缀不完整的 <!--me 不算（不擦）',
  strip('正文\n<!--me'),
  '正文\n<!--me',
)

console.log('\n=== 4. 边界 ===\n')

check(
  '空字符串安全',
  strip(''),
  '',
)

check(
  '只有正常正文 → 完全不变',
  strip('这是一段普通的回复，没有任何标记。'),
  '这是一段普通的回复，没有任何标记。',
)

check(
  '标记在回复最开头',
  strip('<!--mem-log topic=x\n- a\n-->\n正文开始'),
  '\n正文开始',
)

console.log('\n=== 5. 源码纪律：不许删 React 管的节点（2026-11-14 闪烁事故）===\n')
{
  const fs = await import('node:fs')
  const src = fs.readFileSync('dsh-fatfishdream-memory/client.js', 'utf8')
  // 事故：擦完变空的元素用 el.remove() 删掉，React 发现节点没了会重插，
  // 擦除器下一帧再删 → 每轮回复结尾一直闪烁才停。
  // 正确做法：只改文本 + 打 data 标记 + CSS 隐藏。
  const codeOnly = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')
  const hasElRemove = /\.remove\(\)/.test(codeOnly)
  if (!hasElRemove) pass++
  else fail++
  console.log(`${hasElRemove ? '❌' : '✅'} 擦除器不调用 .remove() 删节点` +
    (hasElRemove ? '  ← React 会重插，导致闪烁' : ''))

  const usesBlankAttr = /data-dsh-mem-blank/.test(codeOnly)
  if (usesBlankAttr) pass++
  else fail++
  console.log(`${usesBlankAttr ? '✅' : '❌'} 用 data 标记 + CSS 收掉空段落`)
}

console.log('\n=== 6. 收窄「打标记」的范围（2026-11-15 滚动条事故）===\n')
{
  // 事故：用户报「每次改动功能，全局 skills 的滚动条都失效」。
  //
  // 根因：打标记的判据只有 `el !== document.body`，而配套 CSS 是
  //   `[data-dsh-mem-blank] { display: none !important }` —— 全局、无法覆盖。
  // 于是滚动容器里的某个子元素被擦空 → 打标记 → display:none
  //   → 父容器 scrollHeight 塌成 0 → 滚动条消失。
  //
  // 这三条断言锁住修复：**不能再退回「除 body 外全都可以隐藏」**。
  const fs = await import('node:fs')
  const src = fs.readFileSync('dsh-fatfishdream-memory/client.js', 'utf8')
  const codeOnly = src
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

  // ① 必须存在「安全折叠判断」这个函数，且在打标记前被调用
  const hasGuardFn = /function isSafeToCollapse\s*\(/.test(codeOnly)
  if (hasGuardFn) pass++
  else fail++
  console.log(`${hasGuardFn ? '✅' : '❌'} 存在 isSafeToCollapse 守卫` +
    (hasGuardFn ? '' : '  ← 没有它就会退化成「除 body 外全能隐藏」'))

  // ⚠️ 这条断言必须精确到「调用发生在 if 条件里」。
  //
  // 2026-11-15 变异测试抓到：第一版写的是
  //     /isSafeToCollapse\s*\(\s*el\s*\)/
  // 而函数定义本身是 `function isSafeToCollapse(el) {` —— **也匹配**。
  // 于是把 if 条件里的调用删掉（改成 `true`），断言仍然通过，变异存活。
  //
  // 正确判据：`setAttribute('data-dsh-mem-blank'` 之前**紧邻**的条件块里
  // 必须出现 isSafeToCollapse。用「打标记语句前 400 字符内」做窗口。
  const markIdx = codeOnly.indexOf("setAttribute('data-dsh-mem-blank'")
  const guardBeforeMark = markIdx > 0 &&
    codeOnly.slice(Math.max(0, markIdx - 400), markIdx).includes('isSafeToCollapse(el)')
  if (guardBeforeMark) pass++
  else fail++
  console.log(`${guardBeforeMark ? '✅' : '❌'} 守卫真的挡在打标记之前（不只是定义存在）` +
    (guardBeforeMark ? '' : '  ← 只查「函数存在」会被「删掉调用点」骗过'))

  // ② 守卫必须检查滚动祖先 —— 这是本次事故的直接防线
  const checksScrollAncestor =
    /overflowY\s*===\s*'auto'/.test(codeOnly) && /overflowY\s*===\s*'scroll'/.test(codeOnly)
  if (checksScrollAncestor) pass++
  else fail++
  console.log(`${checksScrollAncestor ? '✅' : '❌'} 守卫排除「祖先里有滚动容器」的元素` +
    (checksScrollAncestor ? '' : '  ← 这正是滚动条消失的直接原因'))

  // ③ 必须有 tag 白名单（黑名单永远列不全，白名单漏掉只是「少隐藏一个」）
  const hasTagWhitelist = /SAFE_TAGS/.test(codeOnly)
  if (hasTagWhitelist) pass++
  else fail++
  console.log(`${hasTagWhitelist ? '✅' : '❌'} 只对白名单内的行内元素打标记`)

  // ④ style 注入必须去重（禁用→启用会重置模块变量，但标签还在 head 里）
  const dedupesStyle =
    /style\[data-dsh-memory="blank-collapse"\]/.test(codeOnly) ||
    /querySelector\(['"]style\[data-dsh-memory/.test(codeOnly)
  if (dedupesStyle) pass++
  else fail++
  console.log(`${dedupesStyle ? '✅' : '❌'} 注入样式前先查重（避免重载后堆积）`)
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
