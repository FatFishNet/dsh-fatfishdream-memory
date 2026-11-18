/**
 * C1-A「打嗝」判据的纯函数回归。
 *
 * ## 要解决的是什么
 *
 * 实测（2026-11-18，全库 1055 个 turn）：
 *
 *   · 97 个 turn（9.2%）里 **≥2 条 assistant 消息各自带了一次收尾语**
 *   · 其中 95 个的形态完全一致：
 *       第 1 条（真正的回答）以收尾语结尾  →  收尾语在正确位置
 *       最后 1 条（补记/补充）又加了一次    →  这是「打嗝」
 *   · 用户形容它像打嗝：正话说完了，嗝一下又出来一句。
 *
 * ## 本脚本只测**判据**，不测干预
 *
 * 判据是纯函数 `planHiccupFix`：给「同一 turn 的 assistant 消息序列」，
 * 返回「该把哪一条的收尾语去掉」。
 *
 * 干预（`surfaceOp: { op:'replace' }`）走另一条路，单独验证 ——
 * 那部分需要真实 session 对象，不能在这里造。
 *
 * ## 为什么判据要按「末尾」而不是「包含」
 *
 * `policy.md` 要求的是「**每轮回复的结尾**加固定一句」。所以：
 *   · 一条消息**以**收尾语结尾  → 它履行了这条规则
 *   · 一条消息**中间**提到收尾语 → 可能是在讨论这个规则本身，不算
 * 只按「包含」判会误伤后者（本项目里真的发生过：我讨论收尾语时引用过它）。
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

/** 从源码里抽出指定顶层函数体（项目里已有的做法，见 selfcheck-message-key） */
function extractFunction(src, name) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => new RegExp(`^function ${name}\\s*\\(`).test(l))
  if (start === -1) return null
  let depth = 0
  let seen = false
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; seen = true }
      else if (ch === '}') { depth-- }
    }
    if (seen && depth === 0) return lines.slice(start, i + 1).join('\n')
  }
  return null
}

const src = fs.readFileSync(SRC, 'utf8')

console.log('=== 0. 判据函数存在且是纯函数 ===')
const fnText = extractFunction(src, 'planHiccupFix')
check('planHiccupFix 已定义', fnText !== null)
if (fnText === null) {
  console.log('\n判据函数还不存在 —— 这是预期的（先写测试，再写实现）')
  process.exitCode = 1
  process.exit(1)
}

// 纯函数判定：不引用 store / session / logger / diag
check('不引用 store', !/\bstore\./.test(fnText))
check('不引用 session', !/\bsession\./.test(fnText))
check('不引用 logger', !/\blogger\b/.test(fnText))

const planHiccupFix = new Function(`${fnText}; return planHiccupFix`)()

const HB = '你可爱的大肥鱼一直都在，等待下一轮任务！'

console.log('\n=== 1. 典型打嗝：第一条正常结尾，最后一条重复 ===')
{
  const msgs = [
    { seq: 10, text: `正文内容。\n\n${HB}` },
    { seq: 11, text: '补记完成（id=123）。' },
    { seq: 12, text: `流水已补记：id=589。\n\n${HB}` },
  ]
  const plan = planHiccupFix(msgs, HB)
  check('识别出 1 处需要修复', plan.length === 1, JSON.stringify(plan))
  check('修复目标是 seq=12（补记那条）', plan[0]?.seq === 12)
  check('**不动** seq=10（真正的回答）', !plan.some((p) => p.seq === 10))
}

console.log('\n=== 2. 两条都只有收尾语（回答只有一句 + 补记只有一句）===')
{
  const msgs = [
    { seq: 20, text: `回答。\n\n${HB}` },
    { seq: 21, text: HB },
  ]
  const plan = planHiccupFix(msgs, HB)
  // 第 2 条删掉收尾语后会**整条变空** —— 那种情况不能写回（会让消息消失），
  // 所以判据放弃这次修复，返回空计划。见 planHiccupFix 里的说明。
  check(
    '重复那条删完会变空 → 放弃修复（不返回空正文）',
    plan.length === 0,
    JSON.stringify(plan),
  )
}

console.log('\n=== 3. 只有一条带收尾语 → 不动 ===')
{
  const msgs = [
    { seq: 30, text: '过程消息，不带收尾语' },
    { seq: 31, text: `最终回答。\n\n${HB}` },
  ]
  const plan = planHiccupFix(msgs, HB)
  check('无修复项', plan.length === 0, JSON.stringify(plan))
}

console.log('\n=== 4. 收尾语出现在**中间**不算（讨论规则的情形）===')
{
  const msgs = [
    { seq: 40, text: 'policy.md 里那句是「你可爱的大肥鱼一直都在，等待下一轮任务！」，规则要求放末行。' },
    { seq: 41, text: `结论如上。\n\n${HB}` },
  ]
  const plan = planHiccupFix(msgs, HB)
  check(
    '中间提到不算一次「打嗝」，不动',
    plan.length === 0,
    JSON.stringify(plan),
  )
}

console.log('\n=== 5. 三条以上都带收尾语 → 只保留**第一条**（实测形态决定）===')
{
  const msgs = [
    { seq: 50, text: `A\n\n${HB}` },
    { seq: 51, text: `B\n\n${HB}` },
    { seq: 52, text: `C\n\n${HB}` },
  ]
  const plan = planHiccupFix(msgs, HB)
  // ⚠️ 这里的方向极易搞反，特意说明：
  //
  //   直觉是「收尾语要保持在最后，所以保留最后一条、删前面的」。
  //   **但实测数据是反的**：97 个打嗝 turn 里 95 个的形态是
  //
  //       第 1 条 = 真正的回答（长、有实质内容），以收尾语结尾  ← 位置本来是对的
  //       最后 1 条 = 补记/补充（短、工具性），又加了一次          ← 这才是多出来的
  //
  //   若按「保留最后一条」改，就会把**正确的那条**的收尾语删掉，
  //   而保留补记消息上那次 —— 那正是历史上一直想消灭的东西
  //   （「已补记 id=xxx」那类消息本来就该静默）。
  //
  //   所以判据是：**保留最先出现的那条，删掉后续的**。
  check('修复 2 处（后两条）', plan.length === 2, JSON.stringify(plan.map((p) => p.seq)))
  check('保留第一条 seq=50', !plan.some((p) => p.seq === 50))
  check('修复 seq=51 与 seq=52', plan.some((p) => p.seq === 51) && plan.some((p) => p.seq === 52))
}

console.log('\n=== 6. 收尾语未配置（空串）→ 一律不动 ===')
{
  const msgs = [
    { seq: 60, text: `A\n\n${HB}` },
    { seq: 61, text: `B\n\n${HB}` },
  ]
  const plan = planHiccupFix(msgs, '')
  check('空收尾语时无修复项', plan.length === 0)
}

console.log('\n=== 7. 修复结果里不含收尾语，且正文保留 ===')
{
  const msgs = [
    { seq: 70, text: `正文甲。\n\n${HB}` },
    { seq: 71, text: `补记 id=1。\n\n${HB}` },
  ]
  const plan = planHiccupFix(msgs, HB)
  check('有修复项', plan.length === 1)
  if (plan.length === 1) {
    check('修复的是 seq=71（补记那条）', plan[0].seq === 71)
    const fixed = plan[0].newText
    check('修复后不含收尾语', !fixed.includes(HB), fixed)
    check('修复后保留原有正文', fixed.includes('补记 id=1'), fixed)
    check('修复后不留空尾行', fixed === fixed.trimEnd(), JSON.stringify(fixed))
  }
}

console.log('\n=== 8. 保留的那条不受影响（防「修了这边坏了那边」）===')
{
  const first = `完整回答正文。\n\n${HB}`
  const msgs = [
    { seq: 80, text: first },
    { seq: 81, text: `补充。\n\n${HB}` },
  ]
  const plan = planHiccupFix(msgs, HB)
  check('修复项里没有 seq=80', !plan.some((p) => p.seq === 80))
  check('传入的 messages 未被就地改动', msgs[0].text === first)
}

console.log('\n' + '─'.repeat(40))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exitCode = 1
}
