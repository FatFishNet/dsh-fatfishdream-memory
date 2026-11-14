/**
 * 实证：MEM_MARKER_RE 对不同「标记写法」的解析结果，并锁定捕获组下标。
 *
 * 从源码里取出真实正则（不手抄，避免抄错），逐种写法喂进去。
 *
 * ⚠️ 2026-11-14 三层记忆后，正则必须恰好 **5 个捕获组**：
 *    [1]=kind [2]=topic [3]=summary [4]=keywords [5]=正文
 *    参数顺序固定 topic → summary → keywords。
 *
 * 事故回顾（2026-11-14）：kind 组被写成非捕获字面量，正则只剩 2 组，
 * 而处理代码按 3 组下标取值 → topicRaw 拿到正文、body 恒为空 →
 * 所有带标记的回复被静默丢弃，仅日志出现 [topic-rejected]（raw 是正文开头，
 * 极具误导性）。node --check 查不出这种语义错位，只有组下标断言能拦住。
 */
import fs from 'node:fs'

const src = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')
const m = src.match(/const MEM_MARKER_RE = (\/.*?\/gms?)/)
if (!m) { console.log('❌ 抽取 MEM_MARKER_RE 失败'); process.exit(1) }

const RE = new Function(`return ${m[1]}`)()

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? '  ← ' + detail : ''}`)
}

console.log('=== 0. 捕获组下标锁定（事故防线）===\n')
const groupCount = (m[1].match(/\((?!\?:)/g) || []).length
check('正则恰好 5 个捕获组', groupCount === 5,
  `实际 ${groupCount} 个 —— 处理代码按 [1]=kind [2]=topic [3]=summary [4]=keywords [5]=body 取值`)

const probe = '<!--mem-log topic=插件/装载 summary=三层记忆上线 keywords=FTS｜bm25\n正文第一行\n正文第二行\n-->'
const probeHit = [...probe.matchAll(RE)][0]
check('match[1] = kind（mem-log）', probeHit?.[1] === 'mem-log',
  `实际 ${JSON.stringify(probeHit?.[1])}`)
check('match[2] = topic（插件/装载）', probeHit?.[2] === '插件/装载',
  `实际 ${JSON.stringify(probeHit?.[2])} —— 若是正文开头，就是组下标错位事故重现`)
check('match[3] = summary（三层记忆上线）', probeHit?.[3] === '三层记忆上线',
  `实际 ${JSON.stringify(probeHit?.[3])}`)
check('match[4] = keywords（FTS｜bm25）', probeHit?.[4] === 'FTS｜bm25',
  `实际 ${JSON.stringify(probeHit?.[4])}`)
check('match[5] = 正文（非空且不含摘要）',
  typeof probeHit?.[5] === 'string'
  && probeHit[5].includes('正文第一行')
  && !probeHit[5].includes('三层记忆'),
  `实际 ${JSON.stringify(probeHit?.[5]?.slice(0, 30))} —— 若 undefined，body 会静默为空`)

console.log('\n=== 1. 各种标记写法的行为 ===\n')

const CASES = [
  {
    name: 'A. 只写 topic（旧写法，仍可用；会被记 [summary-missing]）',
    text: '<!--mem-log topic=插件/装载\n这是一条正文\n-->',
    expectMatch: true,
    topic: '插件/装载',
    summary: undefined,
  },
  {
    name: 'B. topic + summary + keywords（推荐写法）',
    text: '<!--mem-log topic=开发日志 summary=修好三处并发 bug keywords=rebindDbStore｜VACUUM INTO\n正文\n-->',
    expectMatch: true,
    topic: '开发日志',
    summary: '修好三处并发 bug',
    keywords: 'rebindDbStore｜VACUUM INTO',
  },
  {
    name: 'C. 开标签自带 -->，正文，再裸 --> 收尾',
    text: '<!--mem-log topic=测试 -->\n这是一条正文\n-->',
    expectMatch: true,
    topic: '测试',
  },
  {
    name: 'D. 闭合标签 <!--/mem-log-->（禁令 1）',
    text: '<!--mem-log topic=测试\n正文\n<!--/mem-log-->',
    expectMatch: true,
    topic: '测试',
    expectLeak: true,
  },
  {
    name: 'E. 单行紧凑（禁令 3：整条静默丢失）',
    text: '<!--mem-log topic=插件/装载 今天改了注入 -->',
    expectMatch: false,
  },
  {
    name: 'F. topic 与正文同行（2026-11-14 实踩：正文被当成 topic）',
    text: '<!--mem-log topic=插件/装载 补录正文第一行\n其余正文\n-->',
    expectMatch: true,
    expectTopicPolluted: true,
  },
  {
    name: 'G. 参数顺序写反（keywords 在 summary 前：summary 会丢）',
    text: '<!--mem-log topic=开发日志 keywords=a｜b summary=测试摘要\n正文\n-->',
    expectMatch: true,
    topic: '开发日志',
    summary: undefined,
  },
]

for (const c of CASES) {
  console.log('─'.repeat(70))
  console.log(c.name)
  console.log('输入: ' + JSON.stringify(c.text.slice(0, 80)))
  const hits = [...c.text.matchAll(RE)]
  const matched = hits.length > 0
  check(`「${c.name.slice(0, 24)}…」匹配行为符合预期`, matched === c.expectMatch,
    matched ? '意外匹配' : '意外不匹配（静默丢失）')
  if (!matched) continue
  for (const h of hits) {
    const body = String(h[5] ?? '')
    check('  正文非空', body.trim() !== '', `body=${JSON.stringify(body.slice(0, 20))}`)
    const leaked = /<!--\/?mem-/.test(body)
    if (c.expectLeak !== undefined) {
      check('  泄漏行为符合预期', leaked === c.expectLeak,
        leaked ? 'body 含标记字面量，会永久写进库' : '预期泄漏但没泄')
    }
    if (c.expectTopicPolluted) {
      const clean = (h[2] ?? '').replace(/--+>\s*$/g, '').trim()
      check('  topic 被正文污染（会被 sanitizeTopic 拒收或用前缀兜底）', clean !== '插件/装载',
        '这里验证的是「为什么会被拒」：topic 捕获了 ' + JSON.stringify(clean.slice(0, 30)))
    }
    if ('topic' in c) {
      check(`  topic 解析 = ${JSON.stringify(c.topic)}`, h[2] === c.topic, JSON.stringify(h[2]))
    }
    if ('summary' in c) {
      check(`  summary 解析 = ${JSON.stringify(c.summary)}`, h[3] === c.summary, JSON.stringify(h[3]))
    }
    if ('keywords' in c) {
      check(`  keywords 解析 = ${JSON.stringify(c.keywords)}`, h[4] === c.keywords, JSON.stringify(h[4]))
    }
  }
}

console.log('\n' + '─'.repeat(70))
console.log(`${pass} 通过 / ${fail} 失败`)
console.log('提示：G 顺序写反时 keywords 会吞掉后面的 summary= 文本；')
console.log('      运行时 sanitizeKeywords 会在「 topic=/summary=/keywords=」处截断，')
console.log('      所以不会污染关键词，但摘要会丢并记 [summary-missing]。')
process.exit(fail === 0 ? 0 : 1)
