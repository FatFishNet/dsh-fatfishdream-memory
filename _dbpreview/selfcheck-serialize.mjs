/**
 * `serialize()` 串行队列的行为回归（2026-11-17）。
 *
 * ## 为什么需要它
 *
 * `serialize()` 是「所有 state.json 读-改-写必须走它」的那把锁（D13）。
 * 但在 2026-11-17 之前，**它只用在 2 处**（enqueueAmbiguous / clearAmbiguous），
 * 而 `registerProject` / `moveProject` / `/scope/rename` 三条读-改-写**没走锁** ——
 * 并发时后写的会把先写的覆盖掉，症状是「记忆还在，项目不见了」。
 *
 * 本脚本锁的就是「这把锁真的能防止覆盖」。
 *
 * ## 关键难点：怎么证明「锁生效」
 *
 * 不能只写一句 `check('有 serialize', ...)` —— 那是源码正则，不验证行为。
 * 这里用**注入延迟**制造确定的交错：
 *
 *   1. 并发发起 N 个 registerProject（不同 cwd）
 *   2. 每个都会「读 state → 加一个项目 → 写 state」
 *   3. 若没有串行队列，它们会读到同一份旧 state，最后只剩 1 个（或少数几个）
 *   4. 有队列时 N 次写依次进行，每个都读到前一个的结果 → N 个都在
 *
 * **判据**：并发注册 N 个项目后，state.projects 里必须有 N 个新增项。
 *
 * ⚠️ 用临时目录，绝不碰真实记忆目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../dsh-fatfishdream-memory/index.js'

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) { pass++ }
  else { fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${name}  ← ${detail}`) }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-serialize-'))

try {
  const store = createStore({ root: tmpRoot })
  await store.ensureLayout()

  // ============================================================
  console.log('=== 1. serialize 是导出的（路由层也要用同一把锁）===\n')
  check('store.serialize 是一个函数', typeof store.serialize === 'function', typeof store.serialize)

  // ============================================================
  console.log('\n=== 2. ★ 并发 registerProject：N 个项目一个都不能丢 ===\n')
  //
  // 这是核心用例。每个 cwd 都会被注册成一个独立项目。
  // 旧代码（没锁）：并发读同一份 state → 各自写回 → 只剩最后那个。
  {
    const N = 12
    const dirs = []
    for (let i = 0; i < N; i++) {
      // 造 N 个独立目录当 cwd（registerProject 用 cwd 算 key）
      const d = path.join(tmpRoot, `proj-${i}`)
      fs.mkdirSync(d, { recursive: true })
      dirs.push(d)
    }

    // **同时**发起（不 await 单个，让它们真正交叠）
    const results = await Promise.all(dirs.map((d) => store.registerProject(d)))

    check(`并发注册 ${N} 个，全部返回了结果`, results.every((r) => r !== undefined), `${results.filter((r) => r === undefined).length} 个返回 undefined`)

    const state = await store.readState()
    const registered = Object.keys(state.projects ?? {}).filter((k) => k.startsWith('proj-'))
    check(
      `并发注册 ${N} 个项目 → state.projects 里必须有 ${N} 个`,
      registered.length === N,
      `实际 ${registered.length} 个（丢了 ${N - registered.length} 个）`,
    )

    if (registered.length !== N) {
      console.log('   实际有的:', registered.join(', '))
      console.log('   ⚠️ 丢项目 = 那个项目的记忆还在库里，但下次开会话找不到它')
    }
  }

  // ============================================================
  console.log('\n=== 3. serialize 内部抛错不会卡死后续任务 ===\n')
  {
    // 第一个任务抛错，第二个必须仍然能跑
    let secondRan = false
    await store.serialize(async () => { throw new Error('故意抛错') }).catch(() => {})
    await store.serialize(async () => { secondRan = true })
    check('前一个任务抛错后，后一个仍会执行', secondRan === true)

    // 再连发几个，确认队列没卡在 rejected 状态
    let count = 0
    await Promise.all([
      store.serialize(async () => { count++ }),
      store.serialize(async () => { count++ }),
      store.serialize(async () => { count++ }),
    ])
    check('抛错后连续 3 个任务都执行了', count === 3, `实际 ${count}`)
  }

  // ============================================================
  console.log('\n=== 4. 任务必须按提交顺序串行执行（不并发）===\n')
  {
    const order = []
    let concurrent = 0
    let maxConcurrent = 0

    const task = (id) => async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      order.push(`start-${id}`)
      // 模拟异步 IO：这期间若有别的任务插进来，concurrent 就会 > 1
      await new Promise((r) => setTimeout(r, 10))
      order.push(`end-${id}`)
      concurrent--
    }

    await Promise.all([
      store.serialize(task(1)),
      store.serialize(task(2)),
      store.serialize(task(3)),
    ])

    check('串行执行：同一时刻最多 1 个任务在跑', maxConcurrent === 1, `峰值 ${maxConcurrent}`)
    // 顺序必须是 1→2→3 完整嵌套，不能交错
    const expected = ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']
    check('执行顺序严格按提交顺序（end 必须在下一个 start 之前）',
      JSON.stringify(order) === JSON.stringify(expected),
      order.join(' → '))
  }

  // ============================================================
  console.log('\n=== 5. registerProject 的返回值仍然正确（包了锁不影响语义）===\n')
  {
    const d = path.join(tmpRoot, 'semantics-check')
    fs.mkdirSync(d, { recursive: true })
    const r = await store.registerProject(d)
    check('返回对象带 key', typeof r?.key === 'string', JSON.stringify(r?.key))
    check('返回对象带 name', typeof r?.name === 'string', String(r?.name))
    check('返回对象带 scope', typeof r?.scope === 'string', String(r?.scope))
    check('key 与目录名一致', r?.key === 'semantics-check', `${r?.key} vs semantics-check`)

    // 重复注册同一个 cwd：不该新增、也不该报错
    const before = Object.keys((await store.readState()).projects ?? {}).length
    const r2 = await store.registerProject(d)
    const after = Object.keys((await store.readState()).projects ?? {}).length
    check('重复注册同一项目不新增条目', before === after, `${before} → ${after}`)
    check('重复注册仍返回同一个 key', r2?.key === r?.key, `${r2?.key} vs ${r?.key}`)
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
