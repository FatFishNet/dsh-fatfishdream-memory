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

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
