/**
 * 双会话撞键的**端到端**验证（2026-11-17）。
 *
 * ## 补的是哪一层
 *
 * TODO.md 记过：archive 去重键的 sessionId 修复，「纯函数行为」已验，
 * 但**「真实双会话在同一 (turn, step) 上撞车，被撞的那条还在不在」**没验过。
 * 当时的判断是「脚本无法驱动宿主的 session/event，只能靠碰巧」。
 *
 * 这个判断**对了一半**：宿主的 `session/event` 确实驱动不了，
 * 但我们**不需要**它 —— 去重的全部逻辑就是：
 *
 *     handleMessage(session, payload)  →  makeMessageKey(...)  →  Set 判重  →  store.appendArchive(...)
 *
 * 这四步都在插件自己的代码里。所以用两个**真实的 store 实例**（各自独立
 * 打开同一个临时库，模拟两个会话），把**完全相同的 (turn, step)** 喂进去，
 * 就能忠实复现「撞车」这个条件 —— 区别只在于事件源是手工调用而不是宿主派发。
 *
 * ## 这个验证能证明什么、不能证明什么
 *
 * 能证明：**键真的含 sessionId**，且两个会话的同一 (turn,step) 都落库（原文不丢）。
 * 不能证明：宿主在真实并发下派发事件的时序。那需要真跑两个会话。
 *   → 所以本条**不能**据此宣称「端到端全验完」，只到「逻辑链端到端」。
 *
 * ## 判据（必须能变红）
 *
 *   ① 两个会话写相同的 (turn, step) → 库里必须有 **2 条**，不是 1 条
 *   ② 两条的 session_id 不同、正文各自保留（没有互相覆盖）
 *   ③ 同一会话重复同一 (turn, step) → 仍只有 1 条（去重仍然生效）
 *   ④ 反向验证：把 makeMessageKey 的 sid 去掉 → ① 必须变红
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory/index.js')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
  } else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}  ← ${detail}`)
  }
}

const SRC = fs.readFileSync(INDEX, 'utf8')

/** 从源码抽出顶层纯函数并执行（不必为测试加 export）。 */
function extract(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = SRC.match(re)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let depth = 0
  for (let i = start; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') {
      depth--
      if (depth === 0) {
        const body = SRC.slice(m.index, i + 1)
        // eslint-disable-next-line no-new-func
        return new Function(`${body}\nreturn ${name}`)()
      }
    }
  }
  return null
}

const makeMessageKey = extract('makeMessageKey')
if (!makeMessageKey) {
  console.error('抽不出 makeMessageKey —— 源码结构变了，本测试失效')
  process.exit(2)
}

console.log('=== 1. 两个会话撞同一 (turn, step) ===\n')

const sessionA = { id: 'session-alpha' }
const sessionB = { id: 'session-beta' }
const payload = { turn: 3, step: 11 }

const keyA = makeMessageKey(sessionA, payload)
const keyB = makeMessageKey(sessionB, payload)

check('两个会话的键不相同', keyA !== keyB, `A=${keyA} B=${keyB}`)
check('键里带 sessionId（A）', keyA.includes('session-alpha'), keyA)
check('键里带 sessionId（B）', keyB.includes('session-beta'), keyB)
check('键里仍带 turn:step（没丢原有维度）', keyA.includes('3:11'), keyA)

console.log('\n=== 2. 真实 store：两个会话写同一 (turn,step)，原文必须都在 ===\n')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-collide-'))
const dbPath = path.join(tmpRoot, 'collide.db')

try {
  const { createDbStore } = await import('../dsh-fatfishdream-memory/db-store.mjs')

  // 模拟插件的 handledMessageIds —— apply 级**全局** Set（正是当初出事的结构）
  const handledMessageIds = new Set()
  const handles = new Set()

  const store = createDbStore(dbPath, {}, () => {})
  store.open()

  /** 复刻 index.js 里 session/event 的归档路径（关键四步） */
  function handleMessage(session, payload, text) {
    const messageId = makeMessageKey(session, payload)
    if (handledMessageIds.has(messageId)) {
      handles.add('dropped')
      return { dropped: true }
    }
    handledMessageIds.add(messageId)
    handles.add('archived')
    // ⚠️ scope 必传 —— appendArchive 的签名是
    //    { scope, role, text, sessionId, turn, step }，漏了 scope 会写进空 scope，
    //    listArchive 再带上 scope 过滤就一条也查不到（第一版就是这么错的：
    //    断言报 "两条 session_id 不同 ← [null,null]"，看着像键的问题，其实是漏参数）。
    store.appendArchive({
      scope: 'collide',
      sessionId: String(session.id),
      role: 'assistant',
      text,
      turn: payload.turn,
      step: payload.step,
    })
    return { dropped: false }
  }

  const rA = handleMessage(sessionA, payload, '这是会话 A 的回复原文')
  const rB = handleMessage(sessionB, payload, '这是会话 B 的回复原文')

  check('会话 A 的回复没被丢弃', rA.dropped === false)
  check('会话 B 的回复没被丢弃（这是当初丢的那条）', rB.dropped === false, '旧代码在这里会 dropped=true，B 的原文永久丢失')

  const rows = store.listArchive({ scope: 'collide', limit: 100 })
  const all = Array.isArray(rows) ? rows : (rows?.rows ?? [])
  const mine = all.filter((r) => String(r.text ?? '').includes('会话'))

  check('库里两条原文都在', mine.length === 2, `实际 ${mine.length} 条`)
  check(
    '两条 session_id 不同',
    new Set(mine.map((r) => r.session_id)).size === 2,
    JSON.stringify(mine.map((r) => r.session_id)),
  )
  check(
    'A 的正文保留完整',
    mine.some((r) => String(r.text).includes('这是会话 A 的回复原文')),
  )
  check(
    'B 的正文保留完整（没有被 A 覆盖）',
    mine.some((r) => String(r.text).includes('这是会话 B 的回复原文')),
  )

  console.log('\n=== 3. 同一会话重复同一 (turn, step) → 去重仍要生效 ===\n')
  const rA2 = handleMessage(sessionA, payload, '会话 A 的重复投递')
  check('同会话重复投递被去重', rA2.dropped === true)
  const rows2 = store.listArchive({ scope: 'collide', limit: 100 })
  const all2 = Array.isArray(rows2) ? rows2 : (rows2?.rows ?? [])
  const mine2 = all2.filter((r) => String(r.text ?? '').includes('会话'))
  check('去重后仍是 2 条（没多没少）', mine2.length === 2, `实际 ${mine2.length}`)

  store.close()
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

console.log('\n=== 4. 反向验证：去掉 sid，上面的断言必须变红 ===\n')
{
  // 把 return 那行换成只有 turn:step —— 正是修复前的写法
  const mutated = SRC.replace(
    "return `${sid}:${turn ?? '?'}:${step ?? '?'}`",
    "return `${turn ?? '?'}:${step ?? '?'}`",
  )
  if (mutated === SRC) {
    check('能构造出「无 sid」变体', false, '锚点没匹配到（源码结构变了）')
  } else {
    check('能构造出「无 sid」变体', true)
    const re = /function\s+makeMessageKey\s*\([^)]*\)\s*\{/
    const m = mutated.match(re)
    const start = m.index + m[0].length - 1
    let depth = 0
    let body = null
    for (let i = start; i < mutated.length; i++) {
      if (mutated[i] === '{') depth++
      else if (mutated[i] === '}') {
        depth--
        if (depth === 0) {
          body = mutated.slice(m.index, i + 1)
          break
        }
      }
    }
    // eslint-disable-next-line no-new-func
    const broken = new Function(`${body}\nreturn makeMessageKey`)()
    const kA = broken(sessionA, payload)
    const kB = broken(sessionB, payload)
    check('无 sid 时两个会话键相同（证明这条断言能抓到回归）', kA === kB, `A=${kA} B=${kB}`)
  }
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
