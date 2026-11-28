/**
 * `rebindDbStore` 读不读 `close()` 的返回值（2026-11-28 新增，待办 X 的护栏）。
 *
 * ## 守什么
 *
 * `dbStore.close()` **不抛错** —— 它把失败包成 `{ok:false, error}` 返回
 * （`db-store.mjs` 的 close()：体内 0 处 throw）。而原来 `rebindDbStore` 里
 * 只写了一个 `catch`，等于**守着一扇不存在的门**：
 *
 *   · 那个 catch 是**恒假分支** —— 日志里永远不会有 `db-rebind-close-FAILED`
 *   · 真正的失败信号（旧句柄没关掉）**彻底消失**，GUI 照样收到 `dbRebound: true`
 *   · 用户侧的症状是「迁移成功，但旧目录删不掉」，且没有任何线索说为什么
 *
 * 这条缺陷的来历值得记住：**2026-11-16 把 close() 改成「返回失败」时，
 * 只改了生产端，没改消费端** —— 于是能力做了、信号有了，就是没人看。
 * 本项目记过「写死了值、却没人读的字段 = 恒假分支」，这是同一族的另一半：
 * **返回了值、却没人读的返回值**。
 *
 * ## 为什么测纯函数而不是 rebindDbStore
 *
 * `rebindDbStore` 在 `apply` 的闭包里，要测它得注入
 * `config` / `dbPath` / `initDbStore` / `diag` / `dbStore` 一整套 ——
 * `_dbpreview/` 里没有脚本这么干过，守卫成本会远高于修法本身。
 * 所以修法先把判断抽成顶层的 `classifyCloseResult`，本脚本**从源码抽出它**执行
 * （不抄一份 —— 抄一份的话源码改坏了这里照样绿，那正是「假绿断言」）。
 *
 * ## 代价与坦白
 *
 * 本脚本**证明不了** `rebindDbStore` 真的调了 `classifyCloseResult` ——
 * 那属于「接线」，只能靠第 ③ 段的源码级断言（形如「必须出现 closed = ...close...」
 * 与「stage 必须真的被 diag 出去」）。纯函数级 + 接线级，两层合起来才算守住了。
 * ⚠️ 这是刻意分开写的：如果只测纯函数，把调用删掉本脚本照样绿。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/index.js'), 'utf8')
const STORE = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/db-store.mjs'), 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(label, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${label}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${label}  ← ${detail}`)
  }
}

/** 从源码抽一个函数定义（大括号配对）。找不到就抛，绝不静默跳过。 */
function extractFn(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = src.match(re)
  if (m === null) throw new Error(`源码里找不到 function ${name}（锚点已漂移）`)
  const start = m.index + m[0].length - 1
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(m.index, i + 1)
    }
  }
  throw new Error(`function ${name} 的大括号没配对完`)
}

// ============================================================
console.log('\n=== 1. 前提：close() 确实不抛错（否则本脚本的整个前提就变了）===\n')
{
  // 抽 close() 函数体，断言里面**没有 throw 语句**。
  // ⚠️ 若哪天 close() 改成抛错，这里的红是**正确**的 —— 那时应该回来重读
  //    rebindDbStore 的注释，而不是把这条改成绿。
  // close 是 `const close = () => {` 形式，不是 `function close(` ——
  // 所以不能用 extractFn（它只认 function 声明），单独按箭头函数定位。
  const m = STORE.match(/const close = \(\) => \{/)
  check('能在 db-store.mjs 里定位 close()', m !== null)
  if (m !== null) {
    const start = m.index + m[0].length - 1
    let depth = 0
    let end = -1
    for (let i = start; i < STORE.length; i++) {
      if (STORE[i] === '{') depth++
      else if (STORE[i] === '}') {
        depth--
        if (depth === 0) { end = i; break }
      }
    }
    check('close() 函数体配对完整', end > start)
    const body = STORE.slice(m.index, end + 1)
    const codeLines = body
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    const throws = codeLines.filter((l) => /\bthrow\b/.test(l))
    check(
      'close() 体内零 throw（它返回 {ok:false} 而不是抛错）',
      throws.length === 0,
      throws.join(' | '),
    )
    // 反向确认：它**确实**有返回失败的路径（不然「不抛」就成了「不会失败」）
    check(
      'close() 确实会返回 {ok:false}',
      /return \{ ok: false/.test(body),
      '如果没有这条，「不抛错」会被误读成「不会失败」',
    )
    // 反向：失败时不清空引用（这是 db-store.mjs 2026-11-16 的修复，别退化）
    const failBranch = body.slice(body.indexOf('ok: false') - 400)
    check(
      'close() 失败分支保留 db 引用（让下次 close 还有机会）',
      !/ok: false[\s\S]{0,200}db = undefined/.test(failBranch),
      '失败时清空引用 = 那个连接再也关不掉',
    )
  }
}

// ============================================================
console.log('\n=== 2. classifyCloseResult：五种返回值的分类 ===\n')
let classify
{
  const body = extractFn(INDEX, 'classifyCloseResult')
  classify = new Function(`${body}\nreturn classifyCloseResult`)()
  check('能从源码抽出 classifyCloseResult', typeof classify === 'function')
}

if (typeof classify === 'function') {
  const cases = [
    {
      label: 'close 失败 {ok:false} → 必须留痕并带出原始错误',
      input: [{ ok: false, error: 'handle busy' }, false],
      kind: 'close-failed',
      stage: 'db-rebind-close-refused',
      mustContain: 'handle busy',
    },
    {
      label: 'checkpoint 失败 {ok:true, checkpointError} → 独立留痕',
      input: [{ ok: true, checkpointError: 'wal locked' }, false],
      kind: 'checkpoint-failed',
      stage: 'db-rebind-checkpoint-failed',
      mustContain: 'wal locked',
    },
    {
      label: '干净关闭 → 不留痕',
      input: [{ ok: true, checkpointError: null }, false],
      kind: 'clean',
      stage: undefined,
    },
    {
      label: '本来就没开 alreadyClosed → 不留痕',
      input: [{ ok: true, alreadyClosed: true }, false],
      kind: 'already-closed',
      stage: undefined,
    },
    {
      label: '没有 store（undefined）→ no-store，不许报成失败',
      input: [undefined, false],
      kind: 'no-store',
      stage: undefined,
    },
    {
      label: 'close 抛错 → threw（catch 已记，不重复报）',
      input: [undefined, true],
      kind: 'threw',
      stage: undefined,
    },
  ]

  for (const c of cases) {
    const r = classify(...c.input)
    check(c.label, r?.kind === c.kind && r?.stage === c.stage,
      `实际 kind=${r?.kind} stage=${r?.stage}`)
    if (c.mustContain !== undefined) {
      check(`${c.kind} 的错误原文被带出来`,
        JSON.stringify(r?.detail ?? {}).includes(c.mustContain))
    }
  }

  // ⚠️ 反向：不能把「没 store」误解成「关闭失败」——
  //    首次迁移前 dbStore 可能是 undefined（initDbStore 早早失败过），
  //    报成失败会让日志说「库关不掉」，而它根本不存在。
  const noStore = classify(undefined, false)
  check('反向：no-store 不得走失败分支', noStore.kind !== 'close-failed' && noStore.stage === undefined)
  const nullish = classify(null, false)
  check('反向：null 同样按 no-store 处理（不许抛）', nullish.kind === 'no-store')
  // 反向：抛错时不许再报一次「close 拒绝」—— 一次故障只该有一条日志
  const threw = classify({ ok: false, error: 'x' }, true)
  check('反向：抛错时不与 close-failed 重复报', threw.kind === 'threw' && threw.stage === undefined)
}

// ============================================================
console.log('\n=== 3. 接线：rebindDbStore 真的用了它，且顺序对 ===\n')
{
  // 抽 rebindDbStore 整体（大括号配对）
  const body = extractFn(INDEX, 'rebindDbStore')

  check('rebindDbStore 接住了 close() 的返回值', /= dbStore\?\.close\?\.\(\)/.test(body),
    '只写 `dbStore?.close?.()` 而不赋值 = 返回值又没人读，缺陷原样复活')
  check('rebindDbStore 调用了 classifyCloseResult', /classifyCloseResult\(closed/.test(body))
  check('classifyCloseResult 的 stage 真的被 diag 出去', /diag\(cc\.stage/.test(body),
    '抽出来不接线 = 又是一条恒假分支')
  check('db-rebound 日志里带 closed 分类', /closed: cc\.kind/.test(body),
    '不写进日志，出问题时仍然看不出那次切换是怎么收场的')

  // ⚠️ 顺序守卫：初始化必须在分类之前。
  //    理由：initDbStore() 会把 dbStore 覆盖成新对象，而日志的价值就是
  //    「切换之后新库起没起来」。摆到前面，日志里的 to 会指向旧路径 —— 假信息。
  const idxInit = body.indexOf('const ok = initDbStore()')
  const idxClassify = body.indexOf('classifyCloseResult(closed')
  check('先 initDbStore() 再 classifyCloseResult（顺序不能反）',
    idxInit >= 0 && idxClassify > idxInit,
    `initDbStore 在 ${idxInit}，classify 在 ${idxClassify}`)

  // 原 catch 必须保留 —— 它守的是「契约将来改成抛错」那种情况，
  // 删掉就成了「只防已知形态、不防契约变更」。
  check('保留 catch（守「契约改成抛错」的情况）', /catch \(error\)/.test(body),
    'close 现在不抛错，但契约变更时必须还能兜住')
  // 但 catch 里必须**同时**告诉 classify「这是抛的」，否则 classify 拿到
  // undefined 会判成 no-store，日志会把「抛错」说成「没有库」。
  check('catch 里把 closeThrew 置真（否则抛错会被误判成 no-store）',
    /closeThrew = true/.test(body),
    '抛错时 closed 仍是 undefined，不置标志就会被 classify 当成「本来就没库」')
}

// ============================================================
console.log('\n=== 4. 回归：initDbStore 的返回值语义没被带歪 ===\n')
{
  // 关键取舍：dbOk 只看 initDbStore()，**不被 close 状态污染**。
  // 理由：/root/move 的三元文案把 dbOk=false 说成「新位置的数据库打不开，
  // 已回退文件模式」。若让 close 失败把 dbOk 拉成 false，那句话就是**假话**
  // —— 新库明明开着。
  const body = extractFn(INDEX, 'rebindDbStore')
  check('rebindDbStore 的返回值仍是 initDbStore() 的结果',
    /const ok = initDbStore\(\)/.test(body) && /return ok/.test(body))
  // 反向：不许出现「close 失败就 return false」这种把两件事混进一个布尔的写法
  check('反向：close 状态不许污染返回值',
    !/closed[\s\S]{0,120}return false/.test(body),
    'close 失败 ≠ 新库不可用；混进 dbOk 会让 GUI 说「已回退文件模式」（假话）')
}

// ============================================================
console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
