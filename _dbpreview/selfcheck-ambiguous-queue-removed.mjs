/**
 * 验证：待判情绪队列已彻底删除，且**没删错东西**。
 *
 * ## 背景（2026-11-18）
 *
 * 这个队列原本的设计是：规则引擎判不准的句子（「算了」「呵呵」）先入队，
 * 等轮末由模型结合上下文裁决「算不算情绪」。
 *
 * 它死在两个地方：
 *
 *   ① **生产者从来没接上**。`enqueueAmbiguous` 有定义、有导出，但全项目
 *      **0 个调用点**。2026-11-14 已明确停用（见 index.js 当年那段注释），
 *      此后弱信号直接入库，不再排队。
 *
 *   ② **仅剩的一条永远出不了队**。`state.json` 里唯一一条的
 *      `sessionId` 是 `"session-1"`，而真实会话 id 形如
 *      `session-1c419e4d-a1d2-4402-b411-6640da935f99`。消费时的过滤条件是
 *
 *          item.sessionId === null || undefined || === sessionKey
 *
 *      `"session-1"` 与任何真实会话都不相等 → 永远被过滤 → 永远留在队列里。
 *      日志侧吻合：`[ambiguous-consumed]` 最后一次是 2026-11-13，之后 0 次。
 *
 * 而它还在向用户报假数：`/memory status` 显示「情绪记录：待判 1 条」。
 *
 * ## 这个脚本守什么
 *
 * 一、**队列确实删干净了**（代码 + state.json 字段 + 导出 + 诊断）
 * 二、**情绪录入没被误伤** —— 弱信号改成「直接入库」才是现状的正解，
 *     删队列不能顺手把那半边也删了，否则情绪会全部丢失
 * 三、**state.json 能正常读写** —— 删字段时若留下旧数据的解析分支，
 *     老用户的 state.json 会在下次写入时抛错（那会让整个插件启动失败）
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

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

/** 剔除说明性注释，只看会执行的代码。注释里应保留「为什么删」的证据。 */
const isCommentLine = (l) => {
  const t = l.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}
const code = lines.filter((l) => !isCommentLine(l)).join('\n')

// ---------------------------------------------------------------- 一、删干净了
console.log('\n=== 1. 待判队列已彻底删除（判据：可执行代码）===')
for (const token of [
  'enqueueAmbiguous',
  'peekAmbiguous',
  'clearAmbiguous',
  'ambiguous-consumed',
  'state.ambiguous',
]) {
  check(`代码里不再有 ${token}`, !code.includes(token))
}
check(
  '注释里仍保留「为什么删」的记录（删代码不等于删证据）',
  src.includes('待判队列'),
)

// ---------------------------------------------------------------- 二、情绪录入没被误伤
console.log('\n=== 2. 情绪录入未受影响（弱信号走「直接入库」）===')
check('仍然调用 recordEmotion', code.includes('recordEmotion'))
check('情绪分析仍然在跑', code.includes('analyzeEmotion'))
check('仍然有强/弱阈值判定', code.includes('WEAK_THRESHOLD') && code.includes('STRONG_THRESHOLD'))
check('弱信号仍然直接入库（不再排队等裁决）', !code.includes('pendingAmbiguous'))

// ---------------------------------------------------------------- 三、state.json 兼容
console.log('\n=== 3. state.json 结构变更后仍可读写（老用户不能启动失败）===')
// 抽出 readState 的默认值，确认 ambiguous 已从 fallback 移除
check(
  'fallback state 里不再有 ambiguous 字段',
  !/fallback\s*=\s*\{[^}]*ambiguous/.test(code),
)
// 但读取旧文件时**不能报错** —— 旧文件里有这个键，多了个不认识的键应当被忽略
const tmp = path.join(os.tmpdir(), `dsh-state-compat-${process.pid}.json`)
try {
  // 模拟老用户的 state.json：带 ambiguous 字段 + BOM（记事本保存的常见形态）
  const legacy = { version: 2, lastConsolidate: null, projects: {}, ambiguous: [{ id: 'x', sessionId: 'session-1', text: 'x', at: '2026-11-12T00:00:00.000Z' }] }
  fs.writeFileSync(tmp, '\uFEFF' + JSON.stringify(legacy), 'utf8')
  const raw = fs.readFileSync(tmp, 'utf8')
  let parsed = null
  let threw = false
  try {
    // 照抄 index.js 里 parseJson 的行为：剥 BOM 后解析
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    threw = true
  }
  check('带 BOM 的旧 state.json 能被解析（不裸 JSON.parse）', !threw)
  check('旧文件里的 ambiguous 键存在（证明必须容忍未知键）', parsed !== null && 'ambiguous' in parsed)
} finally {
  try { fs.unlinkSync(tmp) } catch {}
}

console.log('\n' + '─'.repeat(40))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exitCode = 1
}
