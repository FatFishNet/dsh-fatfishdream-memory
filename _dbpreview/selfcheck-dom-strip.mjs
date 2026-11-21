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

/**
 * 「假装是标记的命令式注释」—— 2026-11-21 用户实报后新增。
 *
 * 现场：另一个工作区把写记忆写成 `<!-- 记忆写入命令：…log.ps1 "正文" -->`，
 * 既没进库（解析正则不认）也没被擦掉（擦除正则只认 `mem-*`），原样露在界面上。
 */
const MEM_COMMENT_LIKE_RE = /^[ \t]*<!--[ \t]+[^`\n]{2,}?-->[ \t]*$/gm

/** 复刻 client.js 里的剥离逻辑 */
function strip(src) {
  let after = src.replace(MEM_STRIP_RE, '')
  // ★ 2026-11-21：与 client.js 同序 —— 完整标记 → 命令式注释 → 未闭合尾巴
  after = after.replace(MEM_COMMENT_LIKE_RE, '')
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
  // ★ 2026-11-21 用户定案（方案 A）：**正文里的普通 HTML 注释也擦掉。**
  //
  // 原断言（2026-11-13 写的）是「非 mem 的 HTML 注释不动」，
  // 而 ForzaOverlay 那种「命令式注释」要擦 —— 两者形态完全一样
  // （`<!--` + 空格 + 中文 + `-->`，独占一行），**光看形态区分不开**。
  //
  // 用户选择「宁可一起擦」。判据：这个项目里**只有模型会写 `<!-- -->`**，
  // 而它写这个只可能是两种意图 ——
  //   ① 想触发标记（写法错了，擦掉正好）
  //   ② 想写给人看的注释（HTML 注释渲染后本来就不显示，等于白写）
  // **两种情况擦掉都不亏。**
  // 代价也写清：从此「看不见的注释」这个概念在本插件里不存在。
  '普通 HTML 注释也擦掉（2026-11-21 用户定案 A）',
  strip('<!-- 普通注释 -->'),
  '',
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

console.log('\n=== 5. 「命令式注释」擦除（2026-11-21 用户实报）===\n')

// 现场原文（ForzaOverlay 工作区里实际露出来的那一行）
const FIELD_CASE =
  '<!-- 记忆写入命令：& .\\.dsh-fatfishdream-memory\\log.ps1 "用户撒娇捏小屁股" "闲聊" -->'

check('现场形态：被擦掉', strip(FIELD_CASE), '')
check(
  '现场形态：前后正文保留',
  strip('前一句\n' + FIELD_CASE + '\n后一句'),
  '前一句\n\n后一句',
)

// 同类变体 —— 按**形态**判断，不绑死在 log.ps1 上
check('变体：POST 接口写法', strip('<!-- 记忆：POST /api/dsh-memory/log -->'), '')
check('变体：带制表符缩进', strip('\t<!-- 记一条流水 -->'), '')

// ★ 四条反向守卫：宁可漏，不可误伤
check(
  '不误伤：讲解格式时写的行内代码',
  strip('写法是 `<!-- 某某 -->` 这样'),
  '写法是 `<!-- 某某 -->` 这样',
)
check('不误伤：普通正文', strip('这是一段普通的话，没有注释'), '这是一段普通的话，没有注释')
check('不误伤：空壳注释', strip('<!---->'), '<!---->')
check(
  '不误伤：跨行的注释块（多行不在此规则内）',
  strip('<!--\n记忆写入\n-->'),
  '<!--\n记忆写入\n-->',
)
check(
  '不误伤：真实 mem-log 标记仍由 MEM_STRIP_RE 处理',
  strip('<!--mem-log topic=开发日志 summary=测试 -->'),
  '',
)

// ★ 源码一致性：本脚本复刻了两条正则，必须与 client.js 逐字一致。
//   不加这条的话，改了 client.js 它会静默测着旧规则
//   （这正是 AGENTS.md 记的「断言在，被测的差异不在」）。
{
  const fs = await import('node:fs')
  const path = await import('node:path')
  const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
  const CLIENT = path.join(ROOT, 'dsh-fatfishdream-memory', 'client.js')
  const src = fs.readFileSync(CLIENT, 'utf8')

  check(
    '源码一致性：client.js 里的 MEM_STRIP_RE 与本脚本相同',
    src.includes('const MEM_STRIP_RE = /^[ \\t]*<!--mem-(?:log|fact|note|fix)\\b[^`]*?-->[ \\t]*$/gm'),
    true,
  )
  check(
    '源码一致性：client.js 里的 MEM_COMMENT_LIKE_RE 与本脚本相同',
    src.includes('const MEM_COMMENT_LIKE_RE = /^[ \\t]*<!--[ \\t]+[^`\\n]{2,}?-->[ \\t]*$/gm'),
    true,
  )
  // 接线核对：新正则必须**真的被用上**，不能只是定义了
  check(
    '接线：MEM_COMMENT_LIKE_RE 在 stripMemMarkers 里被 replace 调用',
    /after\.replace\(MEM_COMMENT_LIKE_RE/.test(src),
    true,
  )

  // ★★ 2026-11-21 血的教训：**「要不要处理」的判据也必须认注释形态。**
  //
  // 我第一版只改了 `acceptNode` 和擦除正则，**漏了 `hasMarker` / `COMPLETE_MARKER_HINT`**。
  // 用户实测（DevTools）：擦除器装了、`首屏擦除 0 处`，而
  // 正文里的 `<!-- 测试 -->` 照样露着 —— 因为 MutationObserver 收到新消息时
  // **先问 `hasCompleteMarker(n)`**，它只认 `<!--mem-` → false → 根本不进擦除。
  //
  // 判据：这**四个**地方必须同时认两种形态，少一处就是「改了一端、另一端没接上」：
  //   ① acceptNode 的候选筛  ② MEM_STRIP_RE  ③ MEM_COMMENT_LIKE_RE
  //   ④ hasMarker  ⑤ COMPLETE_MARKER_HINT（这两个决定「要不要处理」）
  {
    // hasMarker 必须认 `<!-- ` 带空格
    const hasMarkerSrc = (() => {
      const at = src.indexOf('const hasMarker = (node) =>')
      return at < 0 ? '' : src.slice(at, at + 900)
    })()
    check('hasMarker 认「命令式注释」形态（<!-- 带空格）',
      hasMarkerSrc.includes("includes('<!-- ')"),
      true)

    // COMPLETE_MARKER_HINT 必须同时含 mem- 与 `<!-- `
    const m = src.match(/const COMPLETE_MARKER_HINT = \/(.+?)\/([a-z]*)/)
    check('能解析 COMPLETE_MARKER_HINT 正则', m !== null, true)
    if (m) {
      const body = m[1]
      check('COMPLETE_MARKER_HINT 含 mem- 分支', body.includes('mem-'), true)
      check('COMPLETE_MARKER_HINT 含「<!-- 」分支', body.includes('<!-- '), true)
    }
  }
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)