/**
 * 情绪判定：**后置限定词**降权（2026-11-15 新增）。
 *
 * ## 治的是什么（真实误判，情绪记录 #29）
 *
 * 用户原话：
 *     「…我的想法是，能够影响你怎么看待这些代码，就已经成功了一半，
 *       如何看懂代码是另一回事。」
 *
 * 词典词是「成功了」（喜悦 0.8）。而「成功了一半」的字符序列是
 *     成 功 了 一 半
 * 其中**含有**「成功了」这个子串 → indexOf 命中 → 按 0.8 记成
 * 「用户表达喜悦（成功了·high·0.8）」。
 *
 * 但那是一句**方法论陈述**：「一半」明确表示未完成，不是喜悦表达。
 *
 * 根因不是语义理解不足，而是 **`modifierBefore` 只看命中词前面的字**。
 * 中文里「一半」「一点」「部分」这类削弱语恰好大量出现在**后面**，
 * 于是这类句子永远按满强度记。
 *
 * ## 这个测试为什么不「复刻逻辑」
 *
 * `selfcheck-emotion-lexicon.mjs` / `selfcheck-emotion-guard.mjs` 都是
 * **把 index.js 的逻辑抄一份**再测副本 —— 改了源码，测试不会跟着变红，
 * 那是假覆盖。本脚本改用「从源码抽出 analyzeEmotion 函数体 + 注入闭包变量」
 * 的方式**直接执行真实代码**。
 *
 * 代价：依赖源码里那几个标识符（LEXICON / capScore / …）的名字不变。
 * 一旦改名，本脚本会在装配阶段抛错 —— 那是**响亮失败**，比静默测副本好。
 */
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const SRC_PATH = path.join(REPO, 'dsh-fatfishdream-memory', 'index.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

// ---------------------------------------------------------------- 装配
//
// 把 analyzeEmotion 连同它依赖的模块级常量/函数抽出来，拼成一个可执行的
// 工厂函数。**不读源码文本做断言**，而是真的跑它的判定。
function sliceFunction(src, signature) {
  const start = src.indexOf(signature)
  if (start < 0) throw new Error(`源码里找不到 ${signature}`)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${signature} 的大括号不配对`)
}

/** 截取 `const NAME = <字面量>` 或 `function NAME(...) {...}` */
function sliceConst(src, name) {
  const re = new RegExp(`const ${name} = `)
  const m = re.exec(src)
  if (!m) throw new Error(`源码里找不到 const ${name}`)
  let i = m.index + m[0].length
  // 要么一行结束，要么跟着 { / [ 需要配对
  const first = src[i]
  if (first === '[' || first === '{') {
    const open = first
    const close = first === '[' ? ']' : '}'
    let depth = 0
    for (; i < src.length; i += 1) {
      if (src[i] === open) depth += 1
      else if (src[i] === close) {
        depth -= 1
        if (depth === 0) { i += 1; break }
      }
    }
  } else {
    while (i < src.length && src[i] !== '\n') i += 1
  }
  return src.slice(m.index, i).trim()
}

const NEEDED_CONSTS = [
  'STRONG_THRESHOLD', 'WEAK_THRESHOLD', 'LEXICON', 'LEXICON_EN', 'EMOJI',
  'NEGATIONS', 'NON_NEGATION_PHRASES', 'DIMINISHERS', 'INTENSIFIERS',
  'POST_LIMITERS', 'ADVERSATIVES', 'MENTION_MARKERS',
  'META_DISCUSSION_MARKERS', 'WEAK_CUES', 'NON_EMOTION_COMPOUNDS',
  // 反讽判定链（looksIronic）依赖的三组词表
  'IRONY_MARKERS', 'NEGATIVE_CONTEXT', 'POSITIVE_SURFACE',
]
const NEEDED_FNS = [
  'modifierBefore', 'limiterAfter', 'capScore', 'negatedBefore',
  'occurrencesOf', 'inNonEmotionCompound', 'looksIronic', 'stripNoise',
  'splitByAdversative',
]

let analyzeEmotion
try {
  const parts = []
  for (const name of NEEDED_CONSTS) parts.push(sliceConst(SRC, name))
  for (const name of NEEDED_FNS) parts.push(sliceFunction(SRC, `function ${name}(`))
  parts.push(sliceFunction(SRC, 'function analyzeEmotion('))
  const code = `${parts.join('\n\n')}\nreturn analyzeEmotion`
  // eslint-disable-next-line no-new-func
  analyzeEmotion = new Function(code)()
  console.log('（已从源码装配真实 analyzeEmotion）\n')
} catch (e) {
  console.log(`💥 装配失败：${e.message}`)
  console.log('   这说明 index.js 里相关标识符被改名了 —— 本测试需要跟着更新。')
  console.log('   ⚠️ 失败就是失败，不要因为「测试本身坏了」而放行。')
  process.exit(1)
}

// ---------------------------------------------------------------- 用例

console.log('=== 1. 真实误判原文：成功了一半 ===\n')
const CASE_29 = '其实我这里有一个比较通用的思路 ，我的想法是，能够影响你怎么看待这些代码，就已经成功了一半，如何看懂代码是另一回事。'
const r29 = analyzeEmotion(CASE_29)
console.log('  hits:', JSON.stringify(r29.hits))
const joy29 = r29.hits.find((h) => h.cls === '喜悦')
check('「成功了一半」不再判为 strong 喜悦', !(joy29 && joy29.score >= 0.62),
  joy29 ? `喜悦 score=${joy29.score}` : '（无喜悦命中）')
check('全场不再有 strong 判定', r29.strong === false, `strong=${r29.strong}`)

console.log('\n=== 2. 对照：完整的「成功了」仍应判喜悦 ===\n')
// 后置限定词不能误伤正常表达。这是本次改动最关键的回归点。
const CASE_OK = '太好了，终于成功了！'
const rOk = analyzeEmotion(CASE_OK)
console.log('  hits:', JSON.stringify(rOk.hits))
const joyOk = rOk.hits.find((h) => h.cls === '喜悦')
check('「终于成功了」仍判为 strong 喜悦', !!(joyOk && joyOk.score >= 0.62),
  joyOk ? `喜悦 score=${joyOk.score}` : '（无喜悦命中）')

console.log('\n=== 3. 其他后置限定形态 ===\n')
const limiters = [
  ['对了一半', '只对了一半，还有别的问题'],
  ['开心一点点', '今天有点开心一点点'],
  ['部分搞定', '部分搞定了，剩下的明天做'],
]
for (const [label, text] of limiters) {
  const r = analyzeEmotion(text)
  const top = r.hits[0]
  console.log(`  「${label}」→ top=${top ? `${top.cls} ${top.score}` : '(无)'}  strong=${r.strong}`)
  check(`「${label}」不应判为 strong`, r.strong === false, `strong=${r.strong}`)
}

console.log('\n=== 4. 反证：前置限定词仍生效（没被本次改动破坏）===\n')
const CASE_PRE = '稍微有点开心'
const rPre = analyzeEmotion(CASE_PRE)
const joyPre = rPre.hits.find((h) => h.cls === '喜悦')
check('「稍微有点开心」不判 strong', !(joyPre && joyPre.score >= 0.62),
  joyPre ? `喜悦 score=${joyPre.score}` : '（无喜悦命中）')

console.log('\n=== 5. 源码级：limiterAfter 确实接进了打分路径 ===\n')
// 上一段已经证明「行为变了」，这里再钉住「它是通过 limiterAfter 变的」，
// 防止以后有人把调用删掉、却因为别的原因碰巧还是绿的。
check('analyzeEmotion 内调用了 limiterAfter', COMMON_CHECK_A(SRC))
check('limiter 因子与 modifier 相乘（不是相加）', /capScore\(entry\.i,\s*modifier\s*\*\s*limiter\)/.test(SRC))
check('POST_LIMITERS 已定义', /const POST_LIMITERS = \[/.test(SRC))

function COMMON_CHECK_A(src) {
  const body = sliceFunction(src, 'function analyzeEmotion(')
  return /limiterAfter\(text,\s*at \+ word\.length\)/.test(body)
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
