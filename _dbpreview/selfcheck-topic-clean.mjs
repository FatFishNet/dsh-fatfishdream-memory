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
// 2026-11-17 加：第 9 节要把错误提示的生成方式与白名单对照，
// 需要读 index.js 源码（本文件其余各节只做纯函数测试，不需要 IO）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const MEM_MARKER_RE = /^<!--mem-(log|fact|note|fix)(?:[ \t]+topic=([^\n]*?))?[ \t]*(?:\n|-->)([\s\S]*?)-->/gm
/**
 * ⚠️ **这是 `index.js` 里 `TOPIC_WHITELIST` 的手工副本。**
 *
 * 为什么留一份副本而不 import：`index.js` 是 DSH 插件入口，
 * import 会触发宿主依赖（`ctx` / `logger` 等），单跑会炸。
 *
 * **代价是它会漂移** —— 主数组加了一类而忘了改这里，测试就会报
 * 「合法 topic 被拒收」的假红。2026-11-20 新增「闲聊」时就踩了这个：
 * 主数组改了、这里没改，第 92 行那段「每个白名单项都能通过 sanitizeTopic」
 * 立刻红。
 *
 * 所以改主数组时**必须同步这一份**。下面第 2 段有断言专门核对两边一致。
 */
const TOPIC_WHITELIST = [
  '开发日志', '技术讨论', '构建/编译', '注入/预算', '插件/装载', '路径/沙箱',
  '格式/编码', '文档/行号', '情绪判据', '用户画像', '数据清理', 'GUI/界面', 'Git',
  '闲聊',
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

// ---------------------------------------------------------------------------
// 9. **错误提示里的 topic 清单必须与白名单一致**（2026-11-17 真 bug）
//
// ## 这条守的是什么
//
// `/log` 路由在 topic 非法时会返回 400，文案里带一份「请改用其中之一（…）」。
// **那份清单原来是手写的**，于是和 `TOPIC_WHITELIST` 漂移了：
//
//   文案有、白名单没有：**情感交流** / **待办**   ← 照做必失败
//   白名单有、文案没有：**格式/编码** / **情绪判据** ← 永远找不到
//
// 后果是**无限循环**：照提示改 → 再被 400 拒 → 报错还是同一份清单 → 出不去。
//
// 实测（隔壁工作区 SoftTest，2026-11-17 10:33）：
//   `待办事项` → 400；改 `待办` → 400（提示里仍写着「待办」）
//
// 修法是让文案从 `TOPIC_WHITELIST.join(' / ')` 生成。
// **这条断言守的就是「别再改回手写」。**
//
// ⚠️ 判据不是「文案里有 13 个词」——那样手写也能过。
//    必须要求源码里出现 `TOPIC_WHITELIST.join` 这个**生成动作**。
console.log('\n=== 9. 错误提示的 topic 清单必须由白名单生成 ===\n')
{
  const idxSrc = fs.readFileSync(
    path.join(REPO, 'dsh-fatfishdream-memory/index.js'),
    'utf8',
  )

  // ① 存在生成动作
  check(
    '错误文案用 TOPIC_WHITELIST.join 生成（不是手写）',
    /请改用其中之一（\$\{TOPIC_WHITELIST\.join\(' \/ '\)\}）/.test(idxSrc),
    '找不到 TOPIC_WHITELIST.join —— 可能又被改回手写清单了',
  )

  // ② 手写的两个「幽灵项」不得再出现在错误文案里
  //
  // 只在该文案附近找，避免命中文档/注释里的历史说明。
  const anchor = idxSrc.indexOf('请改用其中之一')
  const nearby = anchor < 0 ? '' : idxSrc.slice(anchor, anchor + 400)
  for (const ghost of ['情感交流', '待办']) {
    check(
      `错误文案里不再出现幽灵项「${ghost}」`,
      !nearby.includes(ghost),
      `「${ghost}」不在 TOPIC_WHITELIST 里，写进提示会把人引向死路`,
    )
  }

  // ③ ★ 本文件那份手工副本必须与 index.js 的主数组**完全一致**
  //
  // 为什么需要这条（2026-11-20 新增「闲聊」时实踩）：
  // 主数组加了 '闲聊'、这里的副本没加 —— 于是第 92 行那段
  // 「每个白名单项都能通过 sanitizeTopic」立刻报假红。
  // 那次是我自己发现的；但没有断言的话，下次可能是
  // **副本多了一项**（主数组没有），那时 sanitizeTopic 会把它拒收，
  // 而所有当前测试仍然全绿 —— 副本就成了一个假的「合法清单」。
  //
  // 判据：从 index.js 抽出主数组的字面量项，与本文件的常量逐项比对。
  {
    // 只取 `const TOPIC_WHITELIST = [` 到最近的 `]`
    const m = /const TOPIC_WHITELIST = \[([\s\S]*?)\n  \]/.exec(idxSrc)
    check('能从 index.js 抽出 TOPIC_WHITELIST 主数组', m !== null,
      '抽不到 → 主数组的写法变了（缩进/结尾）？')

    if (m) {
      // 只取引号内的字符串，忽略注释
      const body = m[1].replace(/\/\/[^\n]*/g, '')
      const mainList = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1])
      check('主数组至少 10 项（防止抽到空）', mainList.length >= 10, `${mainList.length} 项`)

      const same =
        mainList.length === TOPIC_WHITELIST.length &&
        mainList.every((t, i) => t === TOPIC_WHITELIST[i])

      check(
        '本文件的副本与 index.js 主数组逐项一致（含顺序）',
        same,
        `主数组 ${mainList.length} 项 / 副本 ${TOPIC_WHITELIST.length} 项` +
          (same ? '' : `\n     主: ${mainList.join(',')}\n     副: ${TOPIC_WHITELIST.join(',')}`),
      )

      // ★ 2026-11-20 新增：**计数文案**也必须与白名单一致。
      //
      // ## 为什么补这一条（真实事故，本节唯一一次由测试方发现两次）
      //
      // 2026-11-17 把 400 提示里的**清单**改成 `TOPIC_WHITELIST.join()` 之后，
      // 清单再没漂过 —— 但**「13 类」这个数字仍是手写的**。
      // 2026-11-20 加第 14 类「闲聊」时，提示变成了：
      //
      //     topic 不在允许的 13 类里：… 请改用其中之一（…14 个词… / 闲聊）
      //
      // **一句话里先说 13、后面列了 14 个。**
      //
      // 这正是 AGENTS.md 记的「改了一端、另一端没接上」：
      // 上面那条断言守的是**清单**，而漂移的是**计数** —— 两个部分各写各的。
      // 判据必须**从两端各自抽出字面量再比对**，而不是各写一个期望值
      // （后者在两边都改错时会一起通过）。
      //
      // 现在计数改成 `${TOPIC_WHITELIST.length}`，所以源码里**不该再有**
      // 「N 类」这种手写数字出现在**模板字符串里**。
      // ⚠️ 注释里的历史记录（如「原来的 13 类里…」）不算 —— 先剥注释再查。
      const codeOnly = idxSrc
        .split('\n')
        .map((line) => {
          const t = line.trimStart()
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return ''
          const i = line.indexOf('//')
          return i >= 0 ? line.slice(0, i) : line
        })
        .join('\n')

      // 只挑**会进错误提示**的模板串，且**只认「不在允许的 N 类」/「N 类里」**
      // 这种「表示 topic 总数」的用法。
      //
      // ⚠️ 不能笼统匹配「N 类」：`POLICY_TEMPLATE` 里有
      //    「但传了就必须是 14 类之一」「分类只用这 14 个」
      //    —— 那是「属于哪一类」的用法，**本来就是正确的**（= 14 = 白名单长度）。
      //    第一版正则太宽，把它们全判成手写计数 → **假红**。
      //    这与 AGENTS.md 记的「断言命中注释」是同一类错误：
      //    **判据的量错了对象**。
      const countPattern = /`[^`\n]*?(?:不在允许的|不在)\s*(\d+)\s*类[^`\n]*?`/g
      const hardcodedCounts = [...codeOnly.matchAll(countPattern)]
        .map((x) => x[0])
        .filter((s) => !/TOPIC_WHITELIST\.length/.test(s))

      check(
        '「不在允许的 N 类」这类提示里的 N 不许手写 —— 必须用 TOPIC_WHITELIST.length',
        hardcodedCounts.length === 0,
        `找到手写计数：${hardcodedCounts.slice(0, 3).join(' | ')}。` +
          `2026-11-20 就因为这个「13 类」而实际列了 14 个 —— 提示自相矛盾。`,
      )

      // 反向自证：确认上面的判据**能抓到**手写数字
      // （否则「0 处」可能只是正则匹配不上，而不是真的没有）
      const fakeSrc = '`topic 不在允许的 13 类里：` + `请改用其中之一`'
      const fakeHits = [...fakeSrc.matchAll(countPattern)]
        .map((x) => x[0])
        .filter((s) => !/TOPIC_WHITELIST\.length/.test(s))
      check('自证：手写「不在允许的 13 类」会被上面这条判据抓到', fakeHits.length === 1,
        `实际匹配 ${fakeHits.length} 处 —— 0 处说明正则失效，那条断言会恒真`)

      // 再自证一条：**正确的动态写法不能被判红**
      // （否则「改对了反而红」，人会去放宽判据，防线就拆了）
      const goodSrc = '`topic 不在允许的 ${TOPIC_WHITELIST.length} 类里：`'
      const goodHits = [...goodSrc.matchAll(countPattern)]
        .map((x) => x[0])
        .filter((s) => !/TOPIC_WHITELIST\.length/.test(s))
      check('自证：动态写法（TOPIC_WHITELIST.length）不会被误判为手写', goodHits.length === 0,
        `实际匹配 ${goodHits.length} 处 —— 非 0 说明判据会误伤正确写法`)
    }
  }
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
