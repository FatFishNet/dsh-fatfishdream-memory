/**
 * 回归测试：topic 不得被 `-->` 污染。
 *
 * 现场（2026-11-13）：10 条流水的 topic 变成 `开发日志 -->` / `数据清理 -->`。
 * 根因是正则的 topic 捕获组用 `[^\n]+` 一路吃到行尾；
 * 而我在回复里讲解这个问题时，把 `-->` 原样写了进去，消息自己污染了自己。
 *
 * 危害：畸形 topic 不在 13 个白名单内，**每条都在注入的「记忆索引」里
 * 占一行**，白耗预算还让模型看到假分类。
 */

// ---- 与 index.js 保持一致 ----
const MEM_MARKER_RE = /^<!--mem-(log|fact|note|fix)(?:[ \t]+topic=([^\n]*?))?[ \t]*(?:\n|-->)([\s\S]*?)-->/gm
const TOPIC_WHITELIST = [
  '开发日志', '技术讨论', '构建/编译', '注入/预算', '插件/装载', '路径/沙箱',
  '格式/编码', '文档/行号', '情绪判据', '用户画像', '数据清理', 'GUI/界面', 'Git',
]
function sanitizeTopic(raw) {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/--+>\s*$/g, '').replace(/^["'`\s]+|["'`\s]+$/g, '').trim()
  if (cleaned === '') return null
  if (TOPIC_WHITELIST.includes(cleaned)) return cleaned
  const prefixed = TOPIC_WHITELIST.find((t) => cleaned.startsWith(t))
  if (prefixed !== undefined) return prefixed
  return null
}

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

function parse(text) {
  MEM_MARKER_RE.lastIndex = 0
  const out = []
  for (const m of text.matchAll(MEM_MARKER_RE)) {
    out.push({ kind: m[1], topic: sanitizeTopic(m[2]), rawTopic: m[2], body: String(m[3] ?? '').trim() })
  }
  return out
}

console.log('=== 1. 正常写法 ===\n')
{
  const r = parse('正文\n\n<!--mem-log topic=开发日志\n- 一行\n-->\n')
  check('解析出 1 条', r.length === 1, String(r.length))
  check('topic=开发日志', r[0]?.topic === '开发日志', JSON.stringify(r[0]?.topic))
  check('正文正确', r[0]?.body === '- 一行', JSON.stringify(r[0]?.body))
}

console.log('\n=== 2. 🔴 事故形态：正文里出现 -->（本次要防的）===\n')
{
  // 复刻我讲解时的原话：里面同时有 topic 写法与 --> 字样
  const text = [
    '解析出的 topic 就是 **`开发日志 -->`**，而不是 `开发日志`',
    '',
    '<!--mem-log topic=开发日志',
    '- 真正的正文',
    '-->',
  ].join('\n')
  const r = parse(text)
  console.log(`  解析出 ${r.length} 条`)
  for (const x of r) console.log(`    topic=${JSON.stringify(x.topic)} raw=${JSON.stringify(x.rawTopic)}`)
  const real = r.find((x) => x.body.includes('真正的正文'))
  check('真标记的 topic 未被污染', real?.topic === '开发日志', JSON.stringify(real?.topic))
  check('没有任何 topic 含 -->', r.every((x) => !String(x.topic ?? '').includes('--')), JSON.stringify(r.map((x) => x.topic)))
}

console.log('\n=== 3. 历史脏数据能被清洗 ===\n')
for (const dirty of ['开发日志 -->', '数据清理 -->', '开发日志-->', '开发日志 ', '`开发日志`', '"Git"']) {
  const got = sanitizeTopic(dirty)
  check(`sanitize(${JSON.stringify(dirty)}) → ${JSON.stringify(got)}`, got !== null && !got.includes('-'), String(got))
}

console.log('\n=== 4. 非白名单 topic 一律丢弃 ===\n')
for (const bad of ['随便写的', '记忆机制', '测量/像素', '杂', 'LOG']) {
  check(`sanitize(${JSON.stringify(bad)}) → null`, sanitizeTopic(bad) === null, String(sanitizeTopic(bad)))
}

console.log('\n=== 5. 正常 topic 全部保留 ===\n')
for (const t of TOPIC_WHITELIST) {
  check(`保留 ${t}`, sanitizeTopic(t) === t, String(sanitizeTopic(t)))
}

console.log('\n=== 6. 无 topic 标记仍正常 ===\n')
{
  const r = parse('正文\n\n<!--mem-log\n- 无 topic\n-->\n')
  check('解析出 1 条', r.length === 1, String(r.length))
  check('topic 为 null', r[0]?.topic === null, JSON.stringify(r[0]?.topic))
  check('正文正确', r[0]?.body === '- 无 topic', JSON.stringify(r[0]?.body))
}

console.log('\n=== 7. 四种 kind 都不受影响 ===\n')
for (const kind of ['log', 'fact', 'note', 'fix']) {
  const r = parse(`<!--mem-${kind} topic=技术讨论\n内容\n-->\n`)
  check(`mem-${kind} 解析正常`, r.length === 1 && r[0].kind === kind && r[0].topic === '技术讨论', JSON.stringify(r[0]))
}

console.log('\n=== 8. 多行正文不被误截 ===\n')
{
  const r = parse('<!--mem-log topic=插件/装载\n- 第一行\n- 第二行\n- 第三行\n-->\n')
  check('三条要点都在', r[0]?.body.split('\n').length === 3, JSON.stringify(r[0]?.body))
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
