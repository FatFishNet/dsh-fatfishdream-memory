/**
 * C1-A（修正版）：**补记消息不该带收尾语**。
 *
 * ## 用户 2026-11-18 的观察（比我的判据更准）
 *
 * > 「你在一段话感觉要结束的时候，收尾语会先出来，但是下面显示你依然在执行指令，
 * >  指令结束后打嗝并发出第二条收尾语」
 *
 * 对应到代码，实盘三轮（本会话）：
 *
 * | turn | 真回答带收尾语 | 补记带收尾语 | 用户看到的 |
 * |---|---|---|---|
 * | 13 | ✅ len=831 | ✅ len=33 | 两条 → 打嗝 |
 * | 14 | ❌ len=2816（没带） | ✅ len=33 | 一条，但在**补记**上 |
 * | 15 | ✅ len=1225 | ✅ len=33 | 两条 → 打嗝 |
 *
 * **共同点：补记那条每次都带收尾语。** 它是插件用 `steer` 触发的
 * 工具性步骤（POST 一条流水），**本来就不是「一轮回复」**，不该有收尾语。
 *
 * ## 为什么必须由代码兜底，不能再改文案
 *
 * v3 的提醒文案**已经写明**：
 *
 *   「不要写「已补记」「id=xxx」之类的确认，也不要写正文、不要加收尾语」
 *
 * 模型仍然加了。历史记录：三个版本的文案全部失败 ——
 *   ①「不要再重复一遍收尾语」      → 照样发
 *   ②「本步只发 id / topic」       → 收尾语连续消失（副作用更糟）
 *   ③「不要输出任何文字」          → 改成发一个「。」
 *
 * **每一版都在管「模型想发什么」；放行点在代码里。**
 * 与 `selfcheck-filler-guard.mjs` 同一个思路：那次也是文案三版失败、
 * 最后靠归档闸门拦住「。」。
 *
 * ## 这个脚本守什么
 *
 * 判据是纯函数 `stripHeartbeatFromToolStep(text, heartbeat, isToolStep)`：
 * 给「这条消息的正文」「用户的收尾语」「这是不是补记步骤产生的消息」，
 * 返回应该写进 archive 的正文。
 *
 * **它只改归档那一份，不改会话里已经显示的消息** ——
 * 后者需要 surface replace，已被证实结构上不可能（见 C1-C4 文档）。
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = path.join(REPO, 'dsh-fatfishdream-memory', 'index.js')

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  OK   ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

const src = fs.readFileSync(SRC, 'utf8')
const lines = src.split('\n')

function extractFn(name) {
  const start = lines.findIndex((l) => new RegExp(`^function ${name}\\s*\\(`).test(l))
  if (start === -1) return null
  let depth = 0
  let seen = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true } else if (ch === '}') depth--
    }
    if (seen && depth === 0) return lines.slice(start, i + 1).join('\n')
  }
  return null
}

const fnText = extractFn('stripHeartbeatFromToolStep')
check('判据函数 stripHeartbeatFromToolStep 已定义', fnText !== null)
if (fnText === null) {
  console.log('\n判据函数还不存在 —— 这是预期的（先写测试，再写实现）')
  process.exitCode = 1
  process.exit(1)
}

// 纯函数判定：不引用外部状态
check('不引用 store', !/\bstore\./.test(fnText))
check('不引用 session', !/\bsession\./.test(fnText))
check('不引用 logger', !/\blogger\b/.test(fnText))

const strip = new Function(`${fnText}; return stripHeartbeatFromToolStep`)()

const HB = '你可爱的大肥鱼一直都在，等待下一轮任务！'

console.log('\n=== 1. 典型补记消息：正文 + 收尾语 → 只留正文 ===')
{
  const text = `已记（id=762）。\n\n${HB}`
  const out = strip(text, HB, true)
  check('结果不含收尾语', !out.includes(HB), JSON.stringify(out))
  check('结果保留正文', out.includes('id=762'), JSON.stringify(out))
  check('不留空尾行', out === out.trimEnd() || out.endsWith('\n') === false, JSON.stringify(out))
}

console.log('\n=== 2. 真回答（非补记步骤）→ 一个字都不动 ===')
{
  const text = `这是真正的回答，很长很长。\n\n${HB}`
  const out = strip(text, HB, false)
  check('原样返回', out === text, JSON.stringify(out.slice(-40)))
}

console.log('\n=== 3. 补记消息但没带收尾语 → 不动 ===')
{
  const text = '已记（id=762）。'
  const out = strip(text, HB, true)
  check('原样返回', out === text, JSON.stringify(out))
}

console.log('\n=== 4. 补记正文中间提到收尾语 → 只删末尾那次 ===')
{
  const text = `规则里那句是「${HB}」，我照做了。\n\n${HB}`
  const out = strip(text, HB, true)
  check('末尾那次被删', !out.trimEnd().endsWith(HB), JSON.stringify(out.slice(-40)))
  check('中间那次保留', out.includes(HB), '中间那句应还在')
}

console.log('\n=== 5. 只有收尾语、没有正文的补记 → 返回空串（交给上层决定丢不丢）===')
{
  const out = strip(HB, HB, true)
  check('返回空串', out.trim() === '', JSON.stringify(out))
}

console.log('\n=== 6. 收尾语未配置（空串）→ 一律不动 ===')
{
  const text = `已记。\n\n${HB}`
  check('空收尾语原样返回', strip(text, '', true) === text)
}

console.log('\n=== 7. 一条消息里有 2 次收尾语（真的打嗝）→ 只删末尾 ===')
{
  const text = `正文。\n\n${HB}\n\n补一句。\n\n${HB}`
  const out = strip(text, HB, true)
  const occurrences = out.split(HB).length - 1
  check('剩 1 次', occurrences === 1, `实际 ${occurrences} 次`)
}

console.log('\n=== 8. 保留正文里的换行结构（不能压成一行）===')
{
  const text = `第一行\n第二行\n\n${HB}`
  const out = strip(text, HB, true)
  check('换行还在', out.includes('\n第二行'), JSON.stringify(out))
}

console.log('\n' + '─'.repeat(40))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exitCode = 1
}
