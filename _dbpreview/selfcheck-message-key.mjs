/**
 * 回归测试：消息去重键 `makeMessageKey(session, payload)`。
 *
 * ## 为什么单独为这一个函数写脚本（2026-11-16）
 *
 * 它守的是**原文层不丢数据**：`handledMessageIds` 是 apply 级全局 Set，
 * 键里不带 sessionId 时，两个会话的同一 `turn:step` 会互相压制 ——
 * 被撞的那条既不进 archive（原文永久丢失）、也不解析标记，**且无任何日志**。
 *
 * 实测（2026-11-16）：全库 2858 条 assistant 只有 1884 个不同键；
 * 两个会话的 step 集合交集为空，其中一个会话的 assistant **一行都没有**。
 *
 * ## 之前为什么验不了
 *
 * 修复是内联在 `session/event` 监听器里的模板字符串，黑盒验证需要
 * 「两个会话并发产生相同 turn:step」，而脚本无法伪造 `session/event`。
 * 单会话测试里 `sid` 恒定，**加不加前缀行为完全一样** —— 那种测试会绿，
 * 但它证明不了修复有效。这正是 AGENTS.md 里「恒真断言」的另一种形态：
 * 断言在，被测的差异不在。
 *
 * 抽成顶层纯函数后就能直接构造两个 session 调两次、断言键不等。
 *
 * ## 方法：从源码抽取函数体执行（同 selfcheck-pure-utils）
 *
 * 不 import index.js（那是插件入口，import 会触发宿主依赖）。
 * 用大括号配对从源码里抠出 `function makeMessageKey` 的完整定义，
 * `new Function` 执行 —— 测的是**真实源码**，不是复制品。
 *
 * ⚠️ 局限：抽取要求函数写在顶层且无闭包依赖。若将来它开始依赖外部变量，
 *    本脚本会**明确报错**，不会静默跳过。
 */
import fs from 'node:fs'

const SRC = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) { pass++ }
  else { fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${name}  ← ${detail}`) }
}

/** 从源码抽取一个顶层函数定义，返回可调用函数（与 selfcheck-pure-utils 同款）。 */
function extract(name) {
  const startRe = new RegExp(`^function ${name}\\(`, 'm')
  const m = startRe.exec(SRC)
  if (!m) throw new Error(`源码里找不到 function ${name}`)

  let i = SRC.indexOf('{', m.index)
  let depth = 0
  let end = -1
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error(`function ${name} 的大括号不配对`)

  const body = SRC.slice(m.index, end)
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn ${name}`)()
}

const makeMessageKey = extract('makeMessageKey')

// ============================================================
console.log('=== 1. ★ 核心：不同 session 的同一 turn:step 必须不同键 ===\n')
{
  // 这一组就是「修复前无法验证」的那件事。
  // 修复前键是 `${turn}:${step}`，下面第一条必然失败。
  const a = makeMessageKey({ id: 'session-A' }, { turn: 1, step: 1 })
  const b = makeMessageKey({ id: 'session-B' }, { turn: 1, step: 1 })

  check('不同 sessionId + 相同 turn/step → 键不同', a !== b, `a=${a} b=${b}`)
  check('键里真的含 sessionId（A）', a.startsWith('session-A:'), a)
  check('键里真的含 sessionId（B）', b.startsWith('session-B:'), b)
  check('两个键都仍带着 turn 与 step', a.endsWith(':1:1') && b.endsWith(':1:1'), `${a} / ${b}`)
}

// ============================================================
console.log('\n=== 2. 同 session 同位置必须同键（去重不能被改坏）===\n')
{
  const a = makeMessageKey({ id: 's1' }, { turn: 3, step: 2 })
  const b = makeMessageKey({ id: 's1' }, { turn: 3, step: 2 })
  check('相同入参 → 键相同', a === b, `${a} vs ${b}`)

  const c = makeMessageKey({ id: 's1' }, { turn: 3, step: 3 })
  check('同 turn 不同 step → 键不同', a !== c, `${a} vs ${c}`)

  const d = makeMessageKey({ id: 's1' }, { turn: 4, step: 2 })
  check('不同 turn 同 step → 键不同', a !== d, `${a} vs ${d}`)
}

// ============================================================
console.log('\n=== 3. sessionId 缺失时降级为 ? （不抛错）===\n')
{
  check('session 为 null → 前缀 ?',
    makeMessageKey(null, { turn: 1, step: 1 }) === '?:1:1')
  check('session 为 undefined → 前缀 ?',
    makeMessageKey(undefined, { turn: 1, step: 1 }) === '?:1:1')
  check('session.id 为 null → 前缀 ?',
    makeMessageKey({ id: null }, { turn: 1, step: 1 }) === '?:1:1')
  check('session.id 为 undefined → 前缀 ?',
    makeMessageKey({ id: undefined }, { turn: 1, step: 1 }) === '?:1:1')
  check('session 没有 id 字段 → 前缀 ?',
    makeMessageKey({}, { turn: 1, step: 1 }) === '?:1:1')
}

// ============================================================
console.log('\n=== 4. id=0 / turn=0 / step=0 不能被当成「缺失」===\n')
{
  // `0 ?? '?'` 是 0 不是 '?'，但用 `||` 就会降级成 '?' —— 这正是要防的。
  // 真实场景：会话 id 或 step 从 0 开始时，若被当成缺失，所有第 0 步会撞成一条。
  check('session.id = 0 → 前缀 "0" 而不是 "?"',
    makeMessageKey({ id: 0 }, { turn: 1, step: 1 }) === '0:1:1',
    makeMessageKey({ id: 0 }, { turn: 1, step: 1 }))
  check('turn = 0 → 保留 0',
    makeMessageKey({ id: 's' }, { turn: 0, step: 1 }) === 's:0:1',
    makeMessageKey({ id: 's' }, { turn: 0, step: 1 }))
  check('step = 0 → 保留 0',
    makeMessageKey({ id: 's' }, { turn: 1, step: 0 }) === 's:1:0',
    makeMessageKey({ id: 's' }, { turn: 1, step: 0 }))
  check('id=0 与 id 缺失不是同一个键',
    makeMessageKey({ id: 0 }, { turn: 1, step: 1 }) !== makeMessageKey(null, { turn: 1, step: 1 }))
}

// ============================================================
console.log('\n=== 5. turn / step 缺失时降级为 ? （不抛错）===\n')
{
  check('payload 为 null → ?:?:?',
    makeMessageKey({ id: 's' }, null) === 's:?:?', makeMessageKey({ id: 's' }, null))
  check('payload 为 undefined → ?:?:?',
    makeMessageKey({ id: 's' }, undefined) === 's:?:?', makeMessageKey({ id: 's' }, undefined))
  check('payload 为空对象 → ?:?:?',
    makeMessageKey({ id: 's' }, {}) === 's:?:?', makeMessageKey({ id: 's' }, {}))
  check('只缺 step → turn 保留、step 为 ?',
    makeMessageKey({ id: 's' }, { turn: 2 }) === 's:2:?',
    makeMessageKey({ id: 's' }, { turn: 2 }))
  check('只缺 turn → turn 为 ?、step 保留',
    makeMessageKey({ id: 's' }, { step: 7 }) === 's:?:7',
    makeMessageKey({ id: 's' }, { step: 7 }))
}

// ============================================================
console.log('\n=== 6. 返回值形态：永远是字符串、且可安全当 Set 键 ===\n')
{
  const samples = [
    makeMessageKey({ id: 's' }, { turn: 1, step: 1 }),
    makeMessageKey(null, null),
    makeMessageKey({ id: 0 }, { turn: 0, step: 0 }),
    makeMessageKey({ id: '中文会话' }, { turn: 1, step: 1 }),
  ]
  check('全部返回 string', samples.every((s) => typeof s === 'string'))

  // 正常样例必须恰好 3 段（字段本身含冒号的情况不在考虑内：id 是宿主生成的标量）
  check('正常样例恰好 3 段（2 个冒号）',
    makeMessageKey({ id: 's' }, { turn: 1, step: 1 }).split(':').length === 3)

  // 数字 id 与字符串 id 表示同一个会话 → 同键（String() 归一化，不是缺陷）
  check('数字 id 与同值字符串 id → 同键（意图如此）',
    makeMessageKey({ id: 42 }, { turn: 1, step: 1 }) === makeMessageKey({ id: '42' }, { turn: 1, step: 1 }))
}

// ============================================================
console.log('\n=== 7. 对照：旧实现（不含 sessionId）会撞 ===\n')
{
  // 这不测生产代码，是**把 bug 复现一遍**，证明上面第 1 组的断言不是白写的：
  // 若 makeMessageKey 退化成旧写法，第 1 组必红，且这里展示的就是它红的原因。
  const oldStyle = (payload) => `${payload.turn ?? '?'}:${payload.step ?? '?'}`
  const oa = oldStyle({ turn: 1, step: 1 })
  const ob = oldStyle({ turn: 1, step: 1 })
  check('旧写法确实会把两个会话撞成同一键（这就是当年丢原文的原因）', oa === ob, `${oa} vs ${ob}`)

  const na = makeMessageKey({ id: 'A' }, { turn: 1, step: 1 })
  const nb = makeMessageKey({ id: 'B' }, { turn: 1, step: 1 })
  check('新写法在同样输入下不撞', na !== nb)
}

// ============================================================
console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log(`  - ${b}`)
  process.exit(1)
}
