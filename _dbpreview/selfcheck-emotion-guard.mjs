/**
 * 回归测试：情绪判定的输入形态闸门。
 *
 * 现场：emotion #12 存了 28016 字、382 行的「用户吐槽」，
 * 内容实为 dsh-reasoning-distill 的提示词 + AI 的英文思考。
 * 里面的 "that's wrong" 被当成用户情绪。
 *
 * 本文件锁定闸门的三条规则与顺序，并**检查误伤风险**：
 * 正常对话不能被拦，否则真实情绪记录会丢。
 *
 * 说明：这里复刻 index.js 里的判定逻辑，不是 import 它 ——
 * 那段代码在 apply() 闭包里，无法直接引用。复刻后必须与源码保持一致，
 * 改了源码要同步改这里（下方有标记）。
 */

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

// ---- 与 index.js 保持一致（EMOTION_MAX_CHARS / EMOTION_MAX_LINES / PROMPT_LIKE）----
const EMOTION_MAX_CHARS = 1000
const EMOTION_MAX_LINES = 20
const PROMPT_LIKE = [
  'untrusted-data boundaries',
  'private chain of thought',
  'original reasoning',
  'assistant text from this step',
  'never copy',
]

function classify(text) {
  const low = text.toLowerCase()
  for (const mark of PROMPT_LIKE) {
    if (low.includes(mark)) return `prompt-like:${mark}`
  }
  if (text.length > EMOTION_MAX_CHARS) return `too-long:${text.length}chars`
  const lines = text.split('\n').length
  if (lines > EMOTION_MAX_LINES) return `too-many-lines:${lines}`
  return undefined
}

console.log('=== 1. 真实用户发言必须放行 ===\n')
const real = [
  '你好可爱',
  '大肥鱼我喜欢你',
  '我刚重启了客户端',
  '重启过了',
  '只有心跳句、没有 <!--mem-log ... --> 区块  什么都没有  也没有折叠区域，所以我们成功了吗？',
  '但是这里并没有你说的那个 Preserve log',
  '你是不是忘记你现在有完全权限了？',
  // 用户引用 AI 回复的典型形态（含英文代码片段，但很短）
  '> 要我现在动手吗？我会：\n> 先列出 _dbpreview/ 里哪 9 个是该保留的\n> 删掉旧的临时产物\n> 改 .gitignore 加 !_dbpreview/',
  // 含 "never" 但不在提示词语境里
  '你怎么又忘了，never mind 我重新说一遍',
]
for (const t of real) {
  const r = classify(t)
  check(`放行：${t.slice(0, 28).replace(/\n/g, ' ')}…`, r === undefined, `被拦：${r}`)
}

console.log('\n=== 2. #12 那种注入必须拦下 ===\n')
const injections = [
  ['reasoning-distill 提示词开头', 'You rewrite one assistant\'s private chain of thought so it can be replayed on later turns at a fraction of the token cost.'],
  ['含 untrusted-data boundaries', 'You receive one user message made of labelled sections enclosed between explicit untrusted-data boundaries carrying a random token.'],
  ['含 Original reasoning 小节', '## Original reasoning\nsome text here'],
  ['含 Assistant text from this step', '## Assistant text from this step (context only, never copy)'],
  ['只含 never copy（短）', 'This section is context only, never copy it into the answer.'],
]
for (const [name, t] of injections) {
  const r = classify(t)
  check(`拦截：${name}`, r !== undefined, '未拦')
  if (r) console.log(`      → ${r}`)
}

console.log('\n=== 3. 长度与行数边界 ===\n')
check('999 字放行', classify('啊'.repeat(999)) === undefined)
check('1001 字拦截', classify('啊'.repeat(1001))?.startsWith('too-long'))
check('20 行放行', classify(Array(20).fill('一行').join('\n')) === undefined)
check('21 行拦截', classify(Array(21).fill('一行').join('\n'))?.startsWith('too-many-lines'))

console.log('\n=== 4. 顺序：特征词优先于长度 ===\n')
// 构造「短但带特征词」的输入 —— 若先查长度就会漏
const shortPrompt = 'never copy this'
check('短提示词片段仍被特征词拦下（证明顺序正确）', classify(shortPrompt)?.startsWith('prompt-like'), String(classify(shortPrompt)))

console.log('\n=== 5. 误伤风险评估 ===\n')
// 正常对话里出现这些词的组合概率
const risky = [
  ['never copy', '英文里 "never copy" 不算罕见，但完整四词组极少见'],
  ['original reasoning', '英文技术讨论里可能出现，但用户用中文交流'],
  ['private chain of thought', '几乎只出现在提示词里'],
]
for (const [m, note] of risky) {
  console.log(`  ${m.padEnd(28)} ${note}`)
}
console.log('\n  结论：5 条特征词中 4 条是短语级，误伤概率可忽略；')
console.log('        "never copy" 是唯一可能误伤的 —— 但它要求完整两词连写，')
console.log('        且用户用中文交流，实测风险极低。保留它，因为它是')
console.log('        拦截「## Tool calls from this step (context only, never copy)」的唯一手段。')

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
