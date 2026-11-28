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

  // ============================================================
  console.log('\n=== 6. ★ 重入保护：锁内再调不得永久卡死（待办 J / A1）===\n')
  //
  // 待办 J 的原始现场（子代理 2026-11-24 实测）：
  //   嵌套调用后 `3 秒后 innerRan=false outerSettled=false`，**队列永久卡死**，
  //   此后所有排队写入一并停摆，**无任何日志**。
  //
  // 为什么必须单独测：现成的 4 组用例（并发不丢、抛错不卡、串行顺序、返回值）
  // 全绿也挡不住这个 —— 它们**从来没在锁内再调过 serialize**。
  // 这正是「测试全绿」与「有测试守着」是两件事。
  //
  // 判据（两条，缺一不可）：
  //   ① 锁内再调必须立刻 **reject**（不是排队等待 —— 排队就是等自己，死锁）
  //   ② reject 之后**队列仍然可用**（不能把 writeQueue 污染成 rejected）
  {
    // 先确认基线：锁内再调现在的行为。用 Promise.race 加超时，
    // **不能**直接 await —— 旧代码下它会永远不 settle，把整个测试挂死。
    let innerRan = false
    let outerSettled = false

    const outer = store.serialize(async () => {
      await store.serialize(async () => { innerRan = true })
      outerSettled = true
    })

    const timedOut = await Promise.race([
      outer.then(() => 'settled', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('timeout'), 1500)),
    ])

    check(
      '锁内再调 serialize 必须立刻返回结果（不得卡死）',
      timedOut !== 'timeout',
      '1.5 秒内没有 settle —— 队列已永久卡死，此后所有写入停摆',
    )
    check(
      '锁内再调必须被拒绝，而不是排队执行',
      innerRan === false,
      '内层任务竟然执行了 —— 说明没有重入检测',
    )

    // ★ 最关键的一条：撞了重入之后，队列必须还能用。
    //   如果实现是把 writeQueue 变成 rejected 状态，这里会再卡一次。
    let afterReentry = false
    const recovered = await Promise.race([
      store.serialize(async () => { afterReentry = true }).then(() => 'ok', () => 'rejected'),
      new Promise((r) => setTimeout(() => r('timeout'), 1500)),
    ])
    check(
      '重入被拒之后，队列仍可正常使用',
      recovered === 'ok' && afterReentry === true,
      `实际 ${recovered} / afterReentry=${afterReentry}`,
    )

    // 再连发 3 个，确认不是「恰好活了一次」
    let n = 0
    const batch = await Promise.race([
      Promise.all([1, 2, 3].map(() => store.serialize(async () => { n++ }))).then(() => 'ok'),
      new Promise((r) => setTimeout(() => r('timeout'), 1500)),
    ])
    check('重入之后连续 3 个任务都执行了', batch === 'ok' && n === 3, `实际 ${batch} / n=${n}`)
  }

  // ============================================================
  console.log('\n=== 7. 重入必须留痕（不能静默）===\n')
  {
    // 硬约束 15 的思路：这类「写不进去」的失败**不能静默**。
    // 重入被拒时必须有可查的痕迹，否则表现为「写入没生效但日志干净」。
    const seen = []
    const store2 = createStore({ root: tmpRoot, onSerializeReentry: (info) => seen.push(info) })
    await store2.ensureLayout()
    await store2.serialize(async () => {
      await store2.serialize(async () => {}).catch(() => {})
    })
    check(
      '重入被拒时会调用 onSerializeReentry 回调（可留痕）',
      seen.length === 1,
      `实际调用 ${seen.length} 次`,
    )
  }

  // ============================================================
  console.log('\n=== 8. ★ 读-改-写必须进锁（待办 H / I）===\n')
  //
  // 这两条是「并发下会静默丢数据」的形态，靠**源码级断言**守：
  //   · H：`ensureLayout` 里的「读 state → 改 → 写回」不进锁的话，
  //        启动窗口内 registerProject 抢在中间写入，过期快照会把它抹掉
  //        → D13「记忆还在但项目不见了」；
  //   · I：`/memory consolidate` 是同一把锁的**第四个调用点**，
  //        修前三个时漏掉的那个。
  //
  // ⚠️ 为什么用源码级断言而不是行为级：
  //    这两处的竞态窗口是**异步 IO 之间的间隙**，要在测试里稳定复现得靠
  //    注入延迟——而这两段代码都在 `createStore`/`apply` 闭包里，外部拿不到。
  //    行为级能做的部分（锁本身的并发正确性）已经在第 2、4 节覆盖了。
  //    这里守的是「**这两处接上锁了没有**」这件事，判据要写得能失效。
  {
    const fs2 = await import('node:fs')
    const path2 = await import('node:path')
    const SRC = path2.resolve(path2.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
    const idx = fs2.readFileSync(path2.join(SRC, 'dsh-fatfishdream-memory', 'index.js'), 'utf8')

    // ---- I：consolidate 必须包在 store.serialize 里 ----
    const consAt = idx.indexOf("action === 'consolidate'")
    check('能定位到 consolidate 分支（否则下一条无意义）', consAt > 0, 'index.js 里找不到该分支')
    if (consAt > 0) {
      // 取该分支之后的一段
      const seg = idx.slice(consAt, consAt + 1200)
      // 截止到下一个 action 判断或三行大括号结束
      const body = seg.split(/\n\s*return \{ kind: 'error', text: `未知动作/)[0]
      check(
        'I · consolidate 的读-改-写包在 store.serialize 里',
        /store\.serialize\(async \(\) => \{/.test(body),
        '没进锁 → 与另三处读-改-写并发时后写的会覆盖先写的',
      )
      check(
        'I · 用的是 store.serialize 而不是自己另起 Promise 链',
        !/new Promise\(|writeQueue\.then/.test(body),
        '两把锁互不排斥 = 等于没锁',
      )
      // 反向：读与写必须都在锁内 —— 只把 writeState 包进去是不够的
      check(
        'I · readState 也在锁内（否则读到的仍是过期快照）',
        /serialize\(async \(\) => \{[\s\S]*readState\(\)[\s\S]*writeState\(/.test(body),
        '只包 writeState 不解决问题：读与写之间的间隙才是竞态窗口',
      )
    }

    // ---- H：ensureLayout 的读-改-写进锁，且 IO 留在锁外 ----
    const elAt = idx.indexOf('async function ensureLayout()')
    check('能定位到 ensureLayout（否则下面几条无意义）', elAt > 0)
    if (elAt > 0) {
      const seg = idx.slice(elAt, elAt + 3000)
      // 函数体到下一个顶层 async function 为止
      const body = seg.split(/\n  async function readState\(\)/)[0]
      check(
        'H · ensureLayout 的读-改-写进了 serialize',
        /await serialize\(async \(\) => \{/.test(body),
      )
      check(
        'H · 锁内重新读了 state（不是用函数顶部的旧快照）',
        /serialize\(async \(\) => \{[\s\S]*?const st = await readState\(\)/.test(body),
        '用旧快照写回 = 竞态窗口里新登记的项目会被抹掉',
      )
      check(
        'H · mkdir / policy.md 写入留在锁外（慢 IO 不该占住全局写队列）',
        !/serialize\(async \(\) => \{\s*await mkdir\(/.test(body),
        '把长 IO 塞进全局写队列 = 给所有 state 写入加了一个无关的长锁',
      )
      // 重入拒绝不能被当成「policy 同步失败」悄悄吞掉
      check(
        'H · 能区分「重入被拒」与「policy 同步失败」',
        /SERIALIZE_REENTRY/.test(body),
        '混为一谈会把编程错误伪装成运行时偶发故障',
      )
    }

    // ---- H 第二半：调用点必须接住那个 Promise ----
    check(
      'H · ensureLayout 的返回值被接住（不是裸丢弃的 .then 链）',
      /const layoutReady = store\s*\n?\s*\.ensureLayout\(\)/.test(idx),
      'Promise 被丢弃 → 没有任何地方在等布局就绪',
    )
    check(
      'H · layoutReady 真的被读过（不能是只写不读的死变量）',
      (idx.match(/layoutReady/g) ?? []).length >= 2,
      '只赋值不读取 = 又一个 dbCopied（待办 W 的形态）',
    )
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
