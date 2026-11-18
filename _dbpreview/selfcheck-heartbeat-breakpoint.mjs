#!/usr/bin/env node
/**
 * 断点④：`countHeartbeat()` / `isHeartbeatLast()` 的回归。
 *
 * ## 守的是什么
 *
 * 双收尾语这个问题的主症是「**补写那条消息又加了一条收尾语**」。
 * 原先要判断它，只能事后去查 `archive` 表里的原文 —— 而那样**会数错对象**：
 * 2026-11-17 我拿「整个 turn 的收尾语总数」当判据，把同一轮里其它正常回复
 * 的收尾语也算了进去，得出「补写又加了一条」的**错误结论**，
 * 差点把已经修好的东西当成没修。
 *
 * 断点④把判定挪到**归档那一刻**：消息就在手里，不需要额外 I/O。
 * 本脚本守的就是这两个判定函数本身。
 *
 * ## 为什么能写出会失败的断言
 *
 * 判定逻辑抽成了顶层纯函数（`countHeartbeat` / `isHeartbeatLast`），
 * 所以可以从源码抽出来直接喂样例 —— 而不是「读源码觉得对」。
 * 见 AGENTS.md：「一个修复如果写不出『改坏了它会红』的断言，
 * 先问是不是它和 I/O 缠在一起了」。
 *
 * ## 四种必须能区分的形态
 *
 * | # | 形态 | count | last |
 * |---|---|---|---|
 * | ① | 正常回复，收尾语在末行 | 1 | true |
 * | ② | 补写消息，完全没加 | 0 | false |
 * | ③ | 正文里引用收尾语（表格 / 引用块） | 只算真正的 | — |
 * | ④ | 一条消息出现 2 处（用户形容的「打嗝」） | 2 | true |
 *
 * 用法：node _dbpreview/selfcheck-heartbeat-breakpoint.mjs
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

/**
 * 从源码抽取一个顶层函数（含函数体），返回可调用函数。
 * 与 selfcheck-pure-utils.mjs 同款 —— 不必为了测试把内部符号加进 export。
 */
function extract(name) {
  const startRe = new RegExp(`^function ${name}\\(`, 'm')
  const m = startRe.exec(SRC)
  if (!m) throw new Error(`源码里找不到 function ${name}`)
  const start = m.index
  let i = SRC.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error(`function ${name} 的大括号不配对`)
  const body = SRC.slice(start, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn ${name}`)()
}

const HB = '你可爱的大肥鱼一直都在，等待下一轮任务！'

console.log('=== 1. 两个函数都能从源码抽出来（防锚点漂移）===\n')
let countHeartbeat
let isHeartbeatLast
try {
  countHeartbeat = extract('countHeartbeat')
  isHeartbeatLast = extract('isHeartbeatLast')
  check('抽到 countHeartbeat', typeof countHeartbeat === 'function')
  check('抽到 isHeartbeatLast', typeof isHeartbeatLast === 'function')
} catch (e) {
  check('两个函数都能抽取', false, String(e?.message ?? e))
  console.log(`\n❌ ${pass} 通过 / ${fail} 失败`)
  process.exit(1)
}

console.log('\n=== 2. 形态①：正常回复（收尾语 1 处、在末行）===\n')
{
  const text = '分析内容……\n\n这是结论。\n\n' + HB
  check('正常回复 count = 1', countHeartbeat(text, HB) === 1, `实际 ${countHeartbeat(text, HB)}`)
  check('正常回复 last = true', isHeartbeatLast(text, HB) === true)
}

console.log('\n=== 3. 形态②：补写消息（完全没加收尾语）===\n')
{
  // 这是修复后应该出现的形态：补记只发 id / topic
  const text = '已补记：`id=592 / topic=开发日志`。'
  check('补写消息 count = 0', countHeartbeat(text, HB) === 0, `实际 ${countHeartbeat(text, HB)}`)
  check('补写消息 last = false', isHeartbeatLast(text, HB) === false)
}

console.log('\n=== 4. 形态③：正文里引用收尾语（不该计数）===\n')
{
  // 表格行（以 | 开头）与引用行（以 > 开头）都不算
  const tableText = ['| turn | 收尾语 |', '|---|---|', `| 1 | ${HB} |`, '', HB].join('\n')
  check('表格里的引用不计入', countHeartbeat(tableText, HB) === 1, `实际 ${countHeartbeat(tableText, HB)}`)

  const quoteText = ['> 用户说：' + HB, '', HB].join('\n')
  check('引用块里的不计入', countHeartbeat(quoteText, HB) === 1, `实际 ${countHeartbeat(quoteText, HB)}`)
}

console.log('\n=== 5. 形态④：一条消息出现 2 处（「打嗝」）===\n')
{
  const text = ['前半段', '', HB, '', '后半段', '', HB].join('\n')
  check('两处都数到 count = 2', countHeartbeat(text, HB) === 2, `实际 ${countHeartbeat(text, HB)}`)
  check('两处时 last 仍为 true', isHeartbeatLast(text, HB) === true)
}

console.log('\n=== 6. 边界：没配置收尾语时返回 null（不是 false / 0）===\n')
{
  // ⚠️ 为什么必须是 null：`false` 和「确实没有」看起来一样，
  //    但前者是「不知道」，后者是「查过了，没有」。混成同一个值，
  //    以后就没法区分「插件异常」和「用户没配收尾语」。
  check('空收尾语 → count 为 null', countHeartbeat('随便什么', '') === null)
  check('空收尾语 → last 为 null', isHeartbeatLast('随便什么', '') === null)
  check('undefined 收尾语 → null', countHeartbeat('随便什么', undefined) === null)
  // 非字符串正文不该抛错
  check('正文不是字符串时不抛错', countHeartbeat(undefined, HB) === 0)
}

console.log('\n=== 7. 空行不该被当成命中 ===\n')
{
  // 曾经踩过：用 `includes('')` 判空串会恒真。这里收尾语非空，
  // 但完整走一遍空行分支，确认它们被跳过。
  const text = ['', '  ', '', HB, ''].join('\n')
  check('空行与空白行被跳过', countHeartbeat(text, HB) === 1, `实际 ${countHeartbeat(text, HB)}`)
}

console.log('\n=== 8. 生产者真的用上了这两个函数（防「函数在、调用点没了」）===\n')
{
  // AGENTS.md 记过 reportBudget 的教训：函数在、调用点没了，
  // 测试全绿但功能早已失效。这里断言调用点确实存在。
  const archiveBlock = SRC.slice(
    SRC.indexOf("diag('archive-assistant'") - 900,
    SRC.indexOf("diag('archive-assistant'") + 400,
  )
  check('归档分支调用了 countHeartbeat', /countHeartbeat\(text,\s*hbText\)/.test(archiveBlock))
  check('归档分支调用了 isHeartbeatLast', /isHeartbeatLast\(text,\s*hbText\)/.test(archiveBlock))
  check('diag 里带上 heartbeat 字段', /heartbeat:\s*hbCount/.test(archiveBlock))
  check('diag 里带上 heartbeatLast 字段', /heartbeatLast:\s*isHeartbeatLast/.test(archiveBlock))
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
