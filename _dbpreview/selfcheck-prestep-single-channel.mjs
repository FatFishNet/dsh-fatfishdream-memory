/**
 * 验证：pre-step 提醒通道（v1）已删除，且**只删了它**。
 *
 * ## 为什么要这个脚本（2026-11-18）
 *
 * `agent/pre-step` 里原来有一条「当场提醒写流水」（v1）。它的闸门是这样写的：
 *
 *   新一轮时   preStepReminded.set(agentId, { turn })   ← 设成「当前轮」
 *   判断时     remindedFor.turn === turn                ← 于是恒为 true
 *
 * 两处是同一个 Map 的唯一写入点，所以 `remindedThisTurn` **恒为真**，
 * `if (!alreadyWrote && !remindedThisTurn)` 永远不成立 →
 * `pre-step-write-nudge` 这条 diag 在全部日志里 **0 次**（同期 `pre-step-hit` 235 次）。
 *
 * 结论：v1 是**结构性死代码**，不是「条件恰好没满足」。删它零行为变化。
 *
 * ## 这个脚本守什么
 *
 * 一、**死代码确实不在了**（防止有人把它原样加回来，把恒真分支又写一遍）
 * 二、**只删了它** —— pre-step 的轮次记账必须原样保留，否则 `/log` 的
 *     重记检测（`currentTurn`）会失效，而那种失效**没有症状**
 * 三、**活的那条通道还在** —— 轮末 v3 提醒是唯一真正会通知模型的路径，
 *     它要是被顺手删掉，漏记就彻底没人管了
 *
 * 第 二、三 条是「保持功能一致性」的可失败断言，不是陪衬。
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

/**
 * 把「说明性注释」剔掉，只留**会执行的代码**。
 *
 * ⚠️ 这个区分是必须的，不是宽容：本次删除后，源码里**仍然应该**在注释中
 * 提到 `preStepReminded` 与那句旧文案 —— 那是留给下一个人的推导记录。
 * 若直接用 `src.includes(...)` 判断，会把「写了注释解释为什么删」
 * 误判成「没删干净」，逼着后来的人把注释也删掉 —— 那是把证据当成垃圾。
 *
 * 判据：这一行去掉前后空白后，是否以 `//` / `*` / `/*` 开头。
 */
const isCommentLine = (l) => {
  const t = l.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}
const codeLines = lines.filter((l) => !isCommentLine(l))
const code = codeLines.join('\n')

// ---------------------------------------------------------------- 一、死代码不在了
console.log('\n=== 1. v1 死代码已删除（判据：可执行代码，不含注释）===')
check('代码里不再声明 preStepReminded', !code.includes('preStepReminded'))
check('代码里不再有 pre-step-write-nudge 这条 diag', !code.includes('pre-step-write-nudge'))
check('代码里不再有 v1 的文案片段「顺手记一条流水」', !code.includes('顺手记一条流水'))
// 反向自证：注释里**应当**还留着推导记录，否则说明连证据一起删了
check(
  '注释里仍保留 preStepReminded 的推导记录（删代码不等于删证据）',
  src.includes('preStepReminded'),
)

// ---------------------------------------------------------------- 二、pre-step 仍然在记账
console.log('\n=== 2. pre-step 的轮次记账保留（删漏了会让 /log 静默失效）===')
const preStepAt = lines.findIndex((l) => l.includes("safeOn('agent/pre-step'"))
check('pre-step 监听器还在', preStepAt !== -1, `L${preStepAt + 1}`)
check('pre-step 仍然写 currentTurn', src.includes('currentTurn.set(agentId, turn)'))
check('pre-step 仍然清零 turnLogWrites', src.includes('turnLogWrites.set(agentId, { turn, writes: 0 })'))
check('pre-step 仍然必须返回 next()', src.includes('return next()'))

// pre-step 体内不该再有「往对话里插消息」的动作 —— 这是本次删除的语义
// 用「监听器起点 → 下一个 safeOn 起点」切出体内文本，避免全文误判
if (preStepAt !== -1) {
  const nextSafeOn = lines.findIndex(
    (l, i) => i > preStepAt && l.includes('safeOn('),
  )
  const body = lines
    .slice(preStepAt, nextSafeOn === -1 ? lines.length : nextSafeOn)
    .join('\n')
  check('pre-step 体内没有 safePushMessage', !body.includes('safePushMessage'))
}

// ---------------------------------------------------------------- 三、活的通道还在
console.log('\n=== 3. 轮末 v3 提醒仍然完整（唯一的活通道）===')
const turnStoppingAt = lines.findIndex((l) => l.includes("safeOn('agent/turn-stopping'"))
check('turn-stopping 监听器还在', turnStoppingAt !== -1, `L${turnStoppingAt + 1}`)
check('仍然有 write-fail-reminder 诊断', src.includes("diag('write-fail-reminder'"))
check('仍然走 safePushMessage 投递', src.includes('const delivered = safePushMessage('))
check('阈值仍然是 1', src.includes('const WRITE_FAIL_STREAK_LIMIT = 1'))
check('防循环闸门仍然存在', src.includes('fatfishSteerGuard'))
check('闸门判据仍然比较 turn 号', src.includes('fatfishSteerGuard.get(guardKey) === bpTurn'))
check('v3 文案仍然要求静默', src.includes('现在**静默补记**'))

// ---------------------------------------------------------------- 四、没有留下悬空引用
console.log('\n=== 4. 无悬空引用 ===')
const danglingHits = lines
  .map((l, i) => ({ l, i }))
  .filter(({ l }) => /preStepReminded|pre-step-write-nudge/.test(l))
  .filter(({ l }) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
check(
  '非注释行里没有残留引用',
  danglingHits.length === 0,
  danglingHits.map(({ i }) => `L${i + 1}`).join(', ') || '无',
)

console.log('\n' + '─'.repeat(40))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exitCode = 1
}
