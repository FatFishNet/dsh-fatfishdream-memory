#!/usr/bin/env node
/**
 * 归档前的「纯标点填充物」闸门回归。
 *
 * ## 守的是什么
 *
 * `session/event` 的 assistant 分支有一道闸门：
 *
 * ```js
 * if (text.trim() === '' || /^[\p{P}\s]+$/u.test(text)) return
 * ```
 *
 * 它决定一条 assistant 消息**要不要进 archive**（进而要不要显示在界面上）。
 *
 * ## 为什么必须由代码兜底，不能只改文案
 *
 * 2026-11-17 晚的实测：补记那一步的提醒文案已经改到「不要输出任何文字」，
 * 模型**仍然每轮发一个中文句号「。」**，界面上孤零零挂一个「。」。
 *
 * 三个文案版本全部失败：
 *   ① 「不要再重复一遍收尾语」        → 照样发
 *   ② 「本步只发 id / topic」         → 发「已补记 id=xxx」，且副作用是收尾语连续消失
 *   ③ 「不要输出任何文字」            → 改成发一个「。」
 *
 * **每一版都在管「模型自己想发的东西」。** 真正的放行点是一行代码：
 * `'。'.trim()` 仍非空，于是照常归档、照常显示。
 *
 * ## 数据依据（为什么可以这样拦）
 *
 * 2026-11-17 全库扫描，长度 ≤10 的 assistant 消息：
 *   · 极短内容**只有**「。」共 16 条（turn 21–38）
 *   · 其余最短都是 7 字符以上的真实过程语
 *     （「先补完整快照。」「开始。先备份。」「让我直接查，不猜。」）
 *   · **没有一个 emoji，没有单字回复**
 *
 * ## 为什么只拦 \p{P}，不拦 \p{S}
 *
 * emoji 属于 Unicode Symbol（`\p{S}`）。用户真的会发纯 emoji 的回复，
 * 那是**有意义的内容**，拦掉就是误伤。所以判据刻意保留 emoji。
 *
 * 用法：node _dbpreview/selfcheck-filler-guard.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const SRC = readFileSync(join(REPO, 'dsh-fatfishdream-memory/index.js'), 'utf8')

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

// ============================================================
console.log('=== 1. 从源码里抽出判据（防「复刻一份来测」）===\n')
// ⚠️ 关键：必须**从源码抽表达式**，不能在这里另写一份同样的正则。
//    否则源码改坏了，测试里那份副本照样绿 —— 「断言在，被测的差异不在」。
//    本项目 grep 不到真判据时，测试应当**直接失败**而不是跳过。
let guardRe = null
{
  const m = SRC.match(/if \(text\.trim\(\) === ''\s*\|\|\s*(\/\^[^/]*\/u)\.test\(text\)\) return/)
  check('源码里能找到「纯标点」判据', m !== null, '锚点没匹配 = 判据被删或改写了')
  if (m) {
    try {
      guardRe = eval(m[1]) // eslint-disable-line no-eval
      check('抽出的表达式是真正则', guardRe instanceof RegExp, String(m[1]))
      check('判据带 u 标志（Unicode 属性转义需要）', guardRe.flags.includes('u'), guardRe.flags)
    } catch (e) {
      check('抽出的表达式可求值', false, String(e?.message ?? e))
    }
  }
}

// 判据抽不出来时，下面的用例没有意义 —— 直接收尾，避免一连串无意义失败
if (guardRe === null) {
  console.log('\n────────────────────────────────')
  console.log(`❌ ${pass} 通过 / ${fail} 失败（判据没抽到，后续用例跳过）`)
  process.exit(1)
}

const blocked = (s) => guardRe.test(s)

// ============================================================
console.log('\n=== 2. 应被拦下：只有标点或空白（不进 archive）===\n')
// 第一个是本次事故的原型：16 条真实脏数据全都是它
for (const s of ['。', '，', '？', '！', '；', '：', '……', '...', '——', ',,,', '。 ', '  。  ', '\n。\n']) {
  check(`拦下 ${JSON.stringify(s)}`, blocked(s) === true, '它没有实质内容')
}

// ============================================================
console.log('\n=== 3. 不能误伤：有实际内容的短消息 ===\n')
// ⚠️ 第二条组是真实出现过的过程语（全库扫描确认存在），绝不能拦
for (const s of ['嗯', '好', 'OK', '1', 'a', '先补完整快照。', '开始。先备份。', '让我直接查，不猜。']) {
  check(`保留 ${JSON.stringify(s)}`, blocked(s) === false, '误伤真实回复')
}

// ============================================================
console.log('\n=== 4. emoji 必须保留（\p{S} 不拦）===\n')
// 这是判据里最容易写错的一处：顺手写成 [\p{P}\p{S}] 就会把 emoji 一起拦掉
for (const s of ['🆗', '🐟', '👍', '🎉']) {
  check(`保留 emoji ${s}`, blocked(s) === false, 'emoji 属于 Symbol，是有意义的内容')
}

// ============================================================
console.log('\n=== 5. 空字符串走的是另一条分支（不能只靠本判据）===\n')
// 纯空白已被本判据覆盖，但空串必须先被 `text.trim() === ''` 拦下 ——
// 两条条件是 `||` 关系，缺一条都会让空消息进 archive。
check('源码里仍有 trim 为空的前置判断', /text\.trim\(\) === ''\s*\|\|/.test(SRC),
  '少了它，纯空白要走正则分支（虽然也能拦，但语义变了）')

// ============================================================
console.log('\n=== 6. 生产者真的用上了它（防「函数在、调用点没了」）===\n')
{
  // AGENTS.md 记过 reportBudget 的教训：函数在、调用点没了，测试全绿但功能失效。
  // 这里断言那段 guard 确实在 assistant 事件分支里、且在归档调用之前。
  const branchStart = SRC.indexOf("if (event?.type !== 'assistant/message') return")
  const guardAt = SRC.search(/if \(text\.trim\(\) === ''\s*\|\|/)
  const archiveAt = SRC.indexOf("diag('archive-assistant'")
  check('assistant 分支存在', branchStart >= 0)
  check('guard 在 assistant 分支之后', branchStart >= 0 && guardAt > branchStart,
    `branch=${branchStart} guard=${guardAt}`)
  check('guard 在归档之前（否则拦不住）', guardAt >= 0 && archiveAt > guardAt,
    `guard=${guardAt} archive=${archiveAt}`)
}

console.log('\n────────────────────────────────')
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
  process.exit(0)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   · ' + b)
  process.exit(1)
}
