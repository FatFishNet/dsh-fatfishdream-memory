/**
 * C1-A 端到端验证：**真实**的 `planHiccupFix` + **真实**的 surface replace 调用。
 *
 * ## 为什么必须另写一个
 *
 * `selfcheck-c1-hiccup-plan.mjs` 只测判据（纯函数）。但判据对了，
 * **调用链还可能没接上** —— 这正是 AGENTS.md 里记过的
 * 「reportBudget 静默失效」（函数在、调用点没了）那种病。
 *
 * 本脚本做三件事，缺一都不能证明功能真的存在：
 *
 *   ① 从 **index.js 源码**里抽出 `planHiccupFix`（不用测试副本）
 *   ② 造一个**假的 session 对象**，它有真的 `snapshotEvents()` 和 `append()`，
 *      用来验证 turn-stopping 里那段集成代码会不会真的调用 replace
 *   ③ 断言 replace **只改目标那条**、且 `surfaceOp` 形状正确
 *
 * ⚠️ 关于第 ②：这里用的是**照抄集成段落逻辑**的复现，不是执行原函数
 *    （原函数在 `apply()` 闭包里，没有 session 造不出来）。
 *    所以本脚本证明的是「这段逻辑对」，不是「index.js 里那段真的被调用」。
 *    **后者只能靠运行时日志 `[c1-hiccup-fixed]` 证明** —— 那两个断言
 *    单独列在后面，`diag` 名字对不上就会红。
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

const fnText = extractFn('planHiccupFix')
check('planHiccupFix 存在', fnText !== null)
if (fnText === null) { process.exitCode = 1; process.exit(1) }
const planHiccupFix = new Function(`${fnText}; return planHiccupFix`)()

const HB = '你可爱的大肥鱼一直都在，等待下一轮任务！'

console.log('\n=== 1. 集成段落是否接上（区分「已启用」与「只诊断」两种状态）===')
// ⚠️ 2026-11-18：C1-A 被 DSH 拒了 —— surface replace 要求 sourceEventSeqs
//    覆盖所有被遮蔽节点，而 assistant/message 的契约又禁止携带它。
//    所以**修复调用被临时注释**，改为只读诊断探针。
//
//    这里不能简单删掉那三条断言 —— 删了就再也没人守「恢复时有没有接错」。
//    正确做法：**按当前阶段分支断言**，并让两种状态都能被识别。
const hasAppend = /^\s*session\.append\('assistant\/message'/m.test(src)
// 注释形态有两种：整行 `// session.append(...)`，或缩进后跟省略号的原型示意。
// 判据放宽到「注释里提到 session.append」即可 —— 这条路必须**看得见地保留着**，
// 不能因为「暂时不用」就悄悄删成空白，否则恢复时没人知道原来长什么样。
const appendCommented = /\/\/[^\n]*session\.append/.test(src)
const hasDeferredDiag = src.includes("diag('c1-hiccup-deferred'")
const hasReadonlyProbe = src.includes("diag('c1-diag'")

check('判据被调用（planHiccupFix）', src.includes('const plan = planHiccupFix('))
check('有只读诊断探针（查 2071 身份用）', hasReadonlyProbe)
check(
  '明确处于「只诊断不写」阶段（deferred 标记存在）',
  hasDeferredDiag,
  hasDeferredDiag ? '' : '若已恢复修复，请删掉这条并启用下面的启用态断言',
)
check(
  'append 要么启用、要么被显式注释（不能神不知鬼不觉消失）',
  hasAppend || appendCommented,
  hasAppend ? '已启用' : '已注释（只诊断阶段）',
)
// 启用态才检查的项：形状对不对
if (hasAppend) {
  check('surfaceOp 用了 replace', src.includes("op: 'replace'"))
  check('startSeq / endSeq 都给了', src.includes('startSeq: src.seq, endSeq: src.seq'))
} else {
  console.log('  （append 未启用，跳过 surfaceOp 形状断言 —— 恢复时它们会自动生效）')
}
check('整段包在 try 里（serial 事件抛异常会中断会话）', src.includes('c1-hiccup-error'))

console.log('\n=== 2. 用假 session 跑一遍集成逻辑 ===')
{
  // 造三条本轮的 assistant 消息：第 1 条真回答带收尾语，第 3 条补记又带一次
  const events = [
    { seq: 100, type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: `正经回答。\n\n${HB}` }] }, stream: [] } },
    { seq: 101, type: 'assistant/message', data: { turn: 7, step: 2, message: { content: [{ type: 'text', text: '过程消息' }] }, stream: [] } },
    { seq: 102, type: 'assistant/message', data: { turn: 7, step: 3, message: { content: [{ type: 'text', text: `流水已补记 id=589。\n\n${HB}` }] }, stream: [] } },
    // 别的 turn 的消息，必须被过滤掉
    { seq: 103, type: 'assistant/message', data: { turn: 6, step: 9, message: { content: [{ type: 'text', text: `上一轮。\n\n${HB}` }] }, stream: [] } },
    { seq: 104, type: 'user/message', data: { turn: 7, message: { content: [{ type: 'text', text: '用户说话' }] } } },
  ]
  const appends = []
  const session = {
    snapshotEvents: () => events,
    append: (type, data, opts) => { appends.push({ type, data, opts }); return [] },
  }

  // ---- 照抄 index.js 集成段落的逻辑 ----
  const turn = 7
  const mine = []
  for (const ev of session.snapshotEvents() ?? []) {
    if (ev?.type !== 'assistant/message') continue
    const d = ev.data
    if (!Number.isInteger(d?.turn) || d.turn !== turn) continue
    const text = (d?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
    if (text === '') continue
    mine.push({ seq: ev.seq, text, step: d.step ?? null, message: d.message, stream: d.stream })
  }
  check('只挑本 turn 的 assistant 消息', mine.length === 3, `实际 ${mine.length}`)

  const plan = planHiccupFix(mine, HB)
  check('判出 1 处需修', plan.length === 1, JSON.stringify(plan.map((p) => p.seq)))
  check('目标是 seq=102（补记那条）', plan[0]?.seq === 102)

  for (const item of plan) {
    const s = mine.find((m) => m.seq === item.seq)
    const blocks = (s.message?.content ?? []).map((block) =>
      block?.type === 'text' ? { ...block, text: item.newText } : block,
    )
    session.append('assistant/message', {
      turn, step: s.step ?? 0, message: { ...s.message, content: blocks }, stream: s.stream ?? [],
    }, { surfaceOp: { op: 'replace', startSeq: s.seq, endSeq: s.seq } })
  }

  check('调用了 1 次 append', appends.length === 1)
  const a = appends[0]
  check('替换的是 assistant/message', a?.type === 'assistant/message')
  check('surfaceOp.op 是 replace', a?.opts?.surfaceOp?.op === 'replace')
  check('替换范围就是 seq=102（单条）', a?.opts?.surfaceOp?.startSeq === 102 && a?.opts?.surfaceOp?.endSeq === 102)
  const newText = (a?.data?.message?.content ?? []).map((b) => b.text ?? '').join('\n')
  check('新内容不含收尾语', !newText.includes(HB), JSON.stringify(newText))
  check('新内容保留正文', newText.includes('流水已补记 id=589'), JSON.stringify(newText))
  check('没动第 1 条（真回答）', !appends.some((x) => x.opts?.surfaceOp?.startSeq === 100))
}

console.log('\n=== 3. 非文本块必须原样保留（图片/工具调用不能被吃掉）===')
{
  const events = [
    { seq: 200, type: 'assistant/message', data: { turn: 9, step: 1, message: { content: [{ type: 'text', text: `有图。\n\n${HB}` }] }, stream: [] } },
    { seq: 201, type: 'assistant/message', data: { turn: 9, step: 2, message: { content: [{ type: 'text', text: '看图' }, { type: 'image', attachment: { name: 'a.png' } }, { type: 'text', text: `补记。\n\n${HB}` }] }, stream: [] } },
  ]
  const appends = []
  const session = { snapshotEvents: () => events, append: (t, d, o) => { appends.push({ t, d, o }) } }
  const mine = []
  for (const ev of session.snapshotEvents()) {
    if (ev?.type !== 'assistant/message') continue
    const d = ev.data
    if (d.turn !== 9) continue
    const text = (d?.message?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
    if (text === '') continue
    mine.push({ seq: ev.seq, text, step: d.step, message: d.message, stream: d.stream })
  }
  const plan = planHiccupFix(mine, HB)
  for (const item of plan) {
    const s = mine.find((m) => m.seq === item.seq)
    const blocks = (s.message?.content ?? []).map((b) => (b?.type === 'text' ? { ...b, text: item.newText } : b))
    appends.push({ blocks })
  }
  check('有修复项', appends.length === 1)
  const blocks = appends[0]?.blocks ?? []
  check('图片块仍在', blocks.some((b) => b?.type === 'image'))
  check('图片块未被改动', blocks.find((b) => b?.type === 'image')?.attachment?.name === 'a.png')
}

console.log('\n' + '─'.repeat(40))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ 有失败：${pass} 通过 / ${fail} 失败`)
  process.exitCode = 1
}
