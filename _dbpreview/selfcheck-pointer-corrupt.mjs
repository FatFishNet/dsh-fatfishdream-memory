/**
 * 指针文件与 state.json 的**损坏处理**（待办 D / G / A3 的回归，2026-11-28）。
 *
 * ## 守的是什么
 *
 * 两条链路都长这样：**文件坏了 → 静默当成「没有」→ 上游覆盖写入 → 数据没了**。
 *
 *   D · `memory-root.json`（指针）
 *       写坏 / 读坏 → `resolveRoot` 当成「没有指针」→ 重新选址并**覆盖指针**
 *       → 记忆根**静默漂移**（用户看到「记忆不见了」）
 *
 *   G · `state.json`
 *       解析失败 → `return fallback` → 下游 `registerProject` 改 `projects`
 *       再 `writeState` → **坏文件被一份 `projects: {}` 覆盖**
 *       → 原项目映射 + `policySyncVersion` 全丢
 *
 * ## 分两层验证，缺一不可
 *
 *   ① **行为级**：把真实实现复制进临时目录，真的写坏文件，看它怎么反应。
 *      这是本脚本的主体 —— 源码正则断言容易被「看起来对的代码」骗过。
 *   ② **源码级**：只补行为级测不到的部分（比如「两种错误必须分开」
 *      这种结构性要求）。
 *
 * ⚠️ 全程用临时目录，**绝不碰真实记忆目录**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/index.js'), 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(label, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${label}`) }
  else { fail++; bad.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  FAIL ${label} — ${detail}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pointer-'))

try {
  // ============================================================
  console.log('\n=== 1. D · 原子写：半截 JSON 不能落成正式文件 ===\n')
  {
    // 复刻 atomicWriteFileSync 的行为：temp + rename
    const { renameSync, unlinkSync } = fs
    function atomicWriteFileSync(p, content) {
      const temp = `${p}.${process.pid}.tmp`
      fs.writeFileSync(temp, content, 'utf8')
      try {
        renameSync(temp, p)
      } catch (error) {
        try { unlinkSync(temp) } catch { /* 脏文件不影响正确性 */ }
        throw error
      }
    }

    const p = path.join(tmp, 'atomic.json')
    atomicWriteFileSync(p, '{"root":"D:/a"}\n')
    const first = fs.readFileSync(p, 'utf8')
    check('首次写入成功', first.includes('D:/a'))

    // 关键：写第二个值时，正式文件在rename之前**必须还是旧内容**
    // （用 rename 的话，任何时刻读都是「完整旧」或「完整新」，不会是半截）
    atomicWriteFileSync(p, '{"root":"D:/b"}\n')
    const second = fs.readFileSync(p, 'utf8')
    check('覆盖写也成功', second.includes('D:/b'))

    // 反证：裸 writeFileSync 在「写到一半」时磁盘上是半截
    const dirty = path.join(tmp, 'dirty.json')
    fs.writeFileSync(dirty, '{"root":"D:/c"', 'utf8')   // 模拟写一半
    let dirtyParsed = null
    try { dirtyParsed = JSON.parse(fs.readFileSync(dirty, 'utf8')) } catch { dirtyParsed = null }
    check(
      '反证：半截 JSON 确实解析不了（所以裸写是真风险，不是理论问题）',
      dirtyParsed === null,
    )

    // 临时文件不能残留
    const leftovers = fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'))
    check('原子写不残留 .tmp 文件', leftovers.length === 0, `残留 ${leftovers.join(', ')}`)
  }

  // ============================================================
  console.log('\n=== 2. D · 两种失败必须分开（ENOENT 静默 / 损坏留痕）===\n')
  {
    // 复刻 readPointer 的判据
    const logs = []
    const log = (stage, detail) => logs.push({ stage, detail })

    function readPointerLike(p) {
      let text
      try {
        text = fs.readFileSync(p, 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') log('pointer-read-FAILED', { code: error?.code })
        return undefined
      }
      try {
        const parsed = JSON.parse(text)
        const root = typeof parsed?.root === 'string' ? parsed.root.trim() : ''
        if (root === '') { log('pointer-INVALID', {}); return undefined }
        return { root }
      } catch (error) {
        log('pointer-CORRUPT', { message: error.message })
        return undefined
      }
    }

    // ① 文件不存在 → 必须**静默**（首次安装的正常路径，不该报错）
    logs.length = 0
    const r1 = readPointerLike(path.join(tmp, 'nope.json'))
    check('文件不存在 → 返回 undefined', r1 === undefined)
    check('文件不存在 → **不**留痕（否则每次首启都刷一条假故障）', logs.length === 0, `实际 ${logs.length} 条`)

    // ② 文件存在但内容坏 → 必须留痕
    const corrupt = path.join(tmp, 'corrupt.json')
    fs.writeFileSync(corrupt, '{ 这不是 JSON', 'utf8')
    logs.length = 0
    const r2 = readPointerLike(corrupt)
    check('内容损坏 → 返回 undefined', r2 === undefined)
    check('内容损坏 → 必须留痕（原来这里是空 catch）', logs.length === 1, `实际 ${logs.length} 条`)
    check('留痕用 CORRUPT 这个 stage', logs[0]?.stage === 'pointer-CORRUPT', `实际 ${logs[0]?.stage}`)

    // ③ 文件在但 root 不是字符串 → 也算坏，要留痕
    const badShape = path.join(tmp, 'badshape.json')
    fs.writeFileSync(badShape, '{"root":12345}', 'utf8')
    logs.length = 0
    readPointerLike(badShape)
    check('root 类型不对 → 也留痕（INVALID）', logs.length === 1 && logs[0].stage === 'pointer-INVALID', `实际 ${JSON.stringify(logs)}`)
  }

  // ============================================================
  console.log('\n=== 3. G · 坏 state.json 必须留底，不能被 fallback 覆盖 ===\n')
  {
    const stateDir = path.join(tmp, 'g')
    fs.mkdirSync(stateDir, { recursive: true })
    const statePath = path.join(stateDir, 'state.json')
    const CORRUPT_TEXT = '{ "projects": { "proj-a": { "name": "A" }  ← 少一个右括号'
    fs.writeFileSync(statePath, CORRUPT_TEXT, 'utf8')

    const logs = []
    const diag = (stage, detail) => logs.push({ stage, detail })

    // 复刻修后的 readState（核心分支）
    async function readStateLike() {
      const fallback = { version: 2, lastConsolidate: null, projects: {} }
      let text
      try { text = fs.readFileSync(statePath, 'utf8') } catch (e) {
        if (e?.code === 'ENOENT') return fallback
        throw e
      }
      let parsed = null
      let corruptReason = null
      try {
        parsed = JSON.parse(text)
        if (!parsed || typeof parsed !== 'object') corruptReason = 'not-an-object'
      } catch (e) { corruptReason = `parse-failed: ${e.message}` }

      if (corruptReason !== null) {
        const backup = `${statePath}.corrupt-${Date.now()}`
        try {
          fs.renameSync(statePath, backup)
          diag('state-CORRUPT-quarantined', { reason: corruptReason, movedTo: backup })
        } catch (e) {
          diag('state-CORRUPT-quarantine-FAILED', {})
          throw new Error('无法改名留底')
        }
        return fallback
      }
      return { version: 2, projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {} }
    }

    const before = fs.readdirSync(stateDir)
    check('前置：目录里只有 state.json', before.length === 1 && before[0] === 'state.json', before.join(','))

    const got = await readStateLike()
    check('解析失败 → 返回 fallback（契约不变）', got.projects && Object.keys(got.projects).length === 0)
    check('解析失败 → 留痕', logs.length === 1 && logs[0].stage === 'state-CORRUPT-quarantined', JSON.stringify(logs))

    // ★ 核心判据：原内容必须还在磁盘上（改名留底，不是删除）
    const after = fs.readdirSync(stateDir)
    const corruptFiles = after.filter((f) => f.startsWith('state.json.corrupt-'))
    check('坏文件被改名留底（不是删除）', corruptFiles.length === 1, after.join(','))
    if (corruptFiles.length === 1) {
      const kept = fs.readFileSync(path.join(stateDir, corruptFiles[0]), 'utf8')
      check('留底文件内容与原始损坏内容逐字节一致', kept === CORRUPT_TEXT)
      check('留底内容里还能看出原来的项目名（人工可捞）', kept.includes('proj-a'))
    }
    check(
      '正式 state.json 已不在原位（所以下游写回不会覆盖它）',
      !fs.existsSync(statePath),
    )

    // ★★ 最关键的一条：模拟下游立刻 writeState，原数据必须仍然完好
    fs.writeFileSync(statePath, JSON.stringify({ version: 2, projects: {} }, null, 2), 'utf8')
    const stillThere = fs.readFileSync(path.join(stateDir, corruptFiles[0]), 'utf8')
    check(
      '下游用空 projects 覆盖写回后，坏文件留底**依然完好**（这才是修复的意义）',
      stillThere === CORRUPT_TEXT,
    )
  }

  // ============================================================
  console.log('\n=== 4. 源码级：结构要求（行为级测不到的部分）===\n')
  {
    // ① writePointer 不许用裸 writeFileSync 写正式文件
    const wpSeg = INDEX.slice(INDEX.indexOf('function writePointer'), INDEX.indexOf('function writePointer') + 1200)
    check(
      'writePointer 用 atomicWriteFileSync 而不是裸 writeFileSync',
      /atomicWriteFileSync\(path/.test(wpSeg),
      '裸写会留下半截 JSON',
    )
    check(
      'writePointer 的 catch 里调了 pointerLog（不再空 catch）',
      /pointerLog\('pointer-write-FAILED'/.test(wpSeg),
    )

    // ② setPointerLog 必须在 resolveRoot 之前装配（否则启动路径上不留痕）
    const setLogAt = INDEX.indexOf('setPointerLog((stage, detail)')
    const resolveCallAt = INDEX.indexOf('const resolvedRoot = resolveRoot(')
    check(
      'setPointerLog 装配在 resolveRoot 调用**之前**',
      setLogAt > 0 && resolveCallAt > 0 && setLogAt < resolveCallAt,
      `setPointerLog@${setLogAt} vs resolveRoot@${resolveCallAt}`,
    )

    // ③ readState 必须区分「不存在」和「损坏」
    check(
      'readState 对 ENOENT 与损坏走不同分支',
      /state-CORRUPT-quarantined/.test(INDEX) && /if \(corruptReason !== null\)/.test(INDEX),
    )
    check(
      'readState 用 rename 留底（不是 unlink 删除）',
      /await rename\(paths\.state, backup\)/.test(INDEX),
    )

    // ④ readStateSync **不该**改名（它是纯读，且在每次注入的热路径上）
    const syncSeg = INDEX.slice(INDEX.indexOf('function readStateSync'), INDEX.indexOf('function readStateSync') + 1800)
    check(
      'readStateSync 只留痕、**不改名**（纯读，无覆盖风险；且跑在注入热路径）',
      /state-sync-CORRUPT/.test(syncSeg) && !/rename\(/.test(syncSeg),
    )

    // ⑤ 两个 catch 都不能再是空的
    check(
      'readPointer 的读失败分支会留痕（不是空 catch）',
      /pointer-read-FAILED/.test(INDEX),
    )

    // ★★★ 2026-11-28 端到端抓到的真 bug：`readState` 在 `createStore` 里，
    //     而 `diag` 定义在 `apply` 闭包里 —— **根本拿不到**。
    //     源码级断言当时全绿（字符串确实在），真跑起来第一行就
    //     `ReferenceError: diag is not defined`。
    //
    //     教训：**「源码里有没有这个字符串」和「这行执行时那个名字在不在作用域里」
    //     是两件事**，而报告里长得一样。
    //     这里把判据改成「createStore 函数体内不许出现裸 diag(」。
    const csStart = INDEX.indexOf('export function createStore(')
    const csEnd = INDEX.indexOf('/** state.json 的同步读，供注入回调使用。 */')
    const csBody = csStart > 0 && csEnd > csStart ? INDEX.slice(csStart, csEnd) : ''
    check('能切出 createStore 的函数体（否则下一条是空断言）', csBody.length > 5000, `长度 ${csBody.length}`)

    // 剥掉注释再判，避免「注释里提到 diag」误报
    const csCode = csBody
      .split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    const bareDiag = csCode.match(/\bdiag\(/g) ?? []
    check(
      'createStore 体内不许出现裸 `diag(`（它定义在 apply 闭包，拿不到）',
      bareDiag.length === 0,
      `发现 ${bareDiag.length} 处 —— 会 ReferenceError`,
    )
  }

  // ============================================================
  console.log('\n=== 5. 反证：这些断言真的能失败 ===\n')
  {
    // 用「修前」的写法跑同样的判据，必须判红
    const oldWritePointer = `
    try {
      writeFileSync(path, payload, 'utf8')
    } catch {
      /* 指针写不了不该影响插件 */
    }`
    check(
      '反证：裸 writeFileSync + 空 catch 会被判红',
      !/atomicWriteFileSync\(path/.test(oldWritePointer) && !/pointerLog/.test(oldWritePointer),
    )

    const oldReadState = `
    try {
      const parsed = parseJson(text)
      if (!parsed || typeof parsed !== 'object') return fallback
      return { version: 2 }
    } catch {
      return fallback
    }`
    check(
      '反证：三种失败共用一个 fallback 的旧写法不含留底逻辑',
      !/state-CORRUPT-quarantined/.test(oldReadState) && !/rename/.test(oldReadState),
    )
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
