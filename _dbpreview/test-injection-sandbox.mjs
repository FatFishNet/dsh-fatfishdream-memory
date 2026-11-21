/**
 * 注入沙箱测试：在**临时目录的虚拟库**上跑 300 次注入渲染，验证渲染确定性。
 *
 * ## 为什么要这个（2026-11-19）
 *
 * 生产环境每轮只记一个数：`lastInjectionBytes`（注入总字节）。
 * 总字节对得上，仍可能是「全局规则被挤掉了、而记忆索引刚好长了同样多」——
 * 这是**静默失效**的经典形态（AGENTS.md：「断言在，被测的东西不在」）。
 * 而 `## 全局规则` 是唯一一段来自 `policy.md` 的内容，它一旦缺，
 * 每轮注入里的「心跳收尾语」就没了；模型不会报错，只是不再照做。
 *
 * 所以这个脚本做两件事：
 *   ① 把注入**按段拆开**记账（生产代码只记总数，看不出单段）；
 *   ② 用真实代码路径重复渲染 300 次，证明「库与 policy.md 不变时输出逐字节相同」。
 *
 * ## 为什么是「抽源码执行」而不是「重新实现」
 *
 * `renderFromDb` / `finishInjection` / `policyTextSync` / `activeLines` 都是
 * `apply()` / `createStore()` 的内部函数，有闭包依赖，不能 import。
 * 如果在本脚本里**抄一遍逻辑**，测的就是这份抄件 —— 源码改了它不会红，
 * 正是「假覆盖」。所以沿用 `selfcheck-pure-utils.mjs` 的做法：
 * 从 `index.js` 源码里按状态机（跳过字符串/模板/注释/正则）做大括号配对抠出
 * 函数体，`new Function` 执行，只喂自由变量。测的是**真实源码**。
 *
 * ⚠️ 局限：抽取依赖「函数体不引用我没喂的符号」。源码若新增自由变量，
 *    `new Function` 会在**调用时**抛 ReferenceError，本脚本记成「渲染失败」
 *    并打印 —— 不会静默通过。
 *
 * ## 安全边界（硬约束）
 *
 *   - 真实库 `memory.db` 只以 **readOnly: true** 打开，只做 SELECT；
 *     不开 WAL、不写、不 VACUUM。全部写操作只发生在自建的临时目录里。
 *   - 真实 `policy.md` **只读复制**到临时目录（副本用完即删），原文件不碰。
 *   - 不改 `index.js` / `db-store.mjs` / `db-schema.mjs` / `client.js`。
 *
 * ## 结论的边界（别把话说大）
 *
 * 通过只证明「库与 policy.md 不变时，渲染是确定性的」。
 * **不能**证明「生产环境每轮都注入成功」—— 那要看运行日志
 * （`[heartbeat]` / `lastInjectionBytes` / `lastInjectionHasWriteRule`）。
 *
 * 用法：
 *   node _dbpreview/test-injection-sandbox.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { statSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb, SCHEMA_VERSION } from '../dsh-fatfishdream-memory/db-schema.mjs'
import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const PLUGIN = path.join(REPO, 'dsh-fatfishdream-memory')
const SRC = fs.readFileSync(path.join(PLUGIN, 'index.js'), 'utf8')

/** 被注入的项目（scope 名）。与真实库一致，routeTable 才能对得上。 */
const PROJECT = 'dsh-fatfishdream-memory'
/** 注入回调拿到的 cwd —— resolveProjectKey 会从它推出 scope。 */
const CWD = 'D:\\workspace\\dsh-fatfishdream-memory'
const RUNS = 300

/**
 * 生产实测分段基准。
 *
 * ⚠️⚠️ **只有两项是源码常量，其余是 policy.md 的快照 —— 后者会随用户改规则失效。**
 *
 * 2026-11-19 实踩：用户把「全局规则」那两行从 261 字节改成 471 字节后，
 * `全局规则正文: 261` 立刻过期，测试报「差 210 字节」，
 * 看起来像序号算错，实际是**基准值过期**。同一个错也会让 `PROD_TOTAL` 失效。
 *
 * 分辨标准（改这组数字前先问）：
 *   · `记忆使用说明段` = **源码常量**（`usageLines` 拼出来的，与库无关）→ 可写死
 *   · `记忆索引正文`   = **库内容快照**（routeTable 随 topic 数变）→ 会漂
 *   · `全局规则正文`   = **policy.md 快照**（用户可改）→ 必然漂
 *   · `全局结论` / `项目结论` = **库内容快照** → 会漂
 *
 * 所以凡是快照值，断言里都**不比对绝对字节**，只比对「这次渲染与下一次渲染是否一致」，
 * 或与**现读的文件/库**对账（见 `prodGlobalRulesBytes()`）。
 */
const PROD_SEG = {
  全局结论正文: 792,
  项目结论正文: 80,
  // ⚠️ `记忆索引正文` 曾写死 343。**那违反了本文件第 79-82 行的自定原则**：
  //    「凡是快照值，断言里都不比对绝对字节」。
  //
  // 2026-11-20 实踩：新增第 14 类 topic「闲聊」后，routeTable 的输出多了
  // 「- 闲聊（N 条）」一行，真实值变成 363，而这个常量还是 343 →
  // `test-injection-sandbox` 报红，看起来像「渲染坏了」，
  // 实际只是**基准值过期**（与 AGENTS.md 里 `PROD_TOTAL = 6429` 那次同源）。
  //
  // 修法：不再写死。下面的 `prodRouteTableBytes()` 从**真实库**现算，
  // 取不到就返回 null → 调用方跳过绝对字节断言（不是拿过期值判红）。
  记忆索引正文: null,
  记忆使用说明段: 4422, // 含 `## 记忆使用说明` 标题与换行；源码常量
}

/**
 * 现算真实库里 `routeTable` 本体的字节数（`## 记忆索引` 那段正文）。
 *
 * 为什么必须现算：topic 分布**随使用变化** —— 每写一条流水，对应 topic 的
 * 计数就可能 +1（`（484 条）` → `（485 条）` 是变长字符串），
 * 新增/删空一个 topic 更是整行增减。任何写死的值都会漂。
 *
 * ## ⚠️ SQL 必须与 `db-store.mjs` 的 `routeTable` **逐条对齐**（2026-11-20 实踩）
 *
 * 第一版我是「照猜」写的，结果现算 382、沙箱渲染 363，差 19 字节。
 * 对齐真实实现后才发现三处都不一样：
 *
 *   ① **不含 `profile`** —— routeTable 只 UNION 了 rules + logs；
 *      我多加了 profile，凭空多出「用户画像」等几个 topic 行；
 *   ② **rules 必须排除 `review='retracted'`** —— 用户在 GUI 撤销的规则不算；
 *      （而 `logs` **没有 review 列**，加它会报 `no such column`）
 *   ③ **必须按 `scope` 过滤**（`scope=? OR scope=?`，即本项目 + `__global__`）——
 *      不加就把别的项目的流水也算进来了。
 *
 * 判据：「现算基准」与「沙箱渲染」必须逐字节相等。两者口径不一致时，
 * 这个断言会变成一个**永远对不上**的假红 —— 而且看起来像渲染坏了。
 *
 * ⚠️ 只读打开真实库（`readOnly: true`），只跑 SELECT，不写任何东西。
 * 取不到（库不存在 / 打不开）就返回 null —— 调用方据此跳过断言。
 */
function prodRouteTableBytes(projectName) {
  try {
    const p = 'D:\\dsh-fatfishdream-memory\\memory.db'
    if (!fs.existsSync(p)) return null
    const db = new DatabaseSync(p, { readOnly: true })
    try {
      // 与 db-store.mjs `routeTable` 的 SQL 保持一致（含 GLOBAL 常量 '__global__'）
      const GLOBAL = '__global__'
      const rows = db
        .prepare(
          `SELECT topic, COUNT(*) n FROM (
             SELECT topic, scope FROM rules
              WHERE status='active' AND topic IS NOT NULL
                AND review IS NOT 'retracted'
                AND (scope=? OR scope=?)
             UNION ALL
             SELECT topic, scope FROM logs
              WHERE status='active' AND topic IS NOT NULL AND (scope=? OR scope=?)
           ) GROUP BY topic ORDER BY n DESC`,
        )
        .all(projectName ?? '', GLOBAL, projectName ?? '', GLOBAL)
      if (rows.length === 0) return null
      return Buffer.byteLength(rows.map((r) => `- ${r.topic}（${r.n} 条）`).join('\n'), 'utf8')
    } finally {
      try { db.close() } catch {}
    }
  } catch {
    return null
  }
}

/**
 * 现读 `policy.md` 里全局规则正文字节数（含那两条规则行）。
 *
 * 为什么不写死：`policy.md` 是**用户数据**，随时会改（今天就被改了两次）。
 * 取不到就返回 `null`，调用方据此**跳过**绝对字节断言，而不是拿过期值判红。
 */
function prodGlobalRulesBytes() {
  try {
    const text = fs.readFileSync('D:\\dsh-fatfishdream-memory\\policy.md', 'utf8')
    const start = text.indexOf('## 给模型的规则')
    if (start === -1) return null
    // 「给模型的规则」小节到下一个 ## 之间
    const rest = text.slice(start)
    const nextAt = rest.indexOf('\n## ', 1)
    const body = nextAt === -1 ? rest : rest.slice(0, nextAt)
    const lines = body.split(/\r?\n/).filter((l) => /^[ \t]*-/.test(l))
    if (lines.length === 0) return null
    return Buffer.byteLength(lines.join('\n'), 'utf8')
  } catch {
    return null
  }
}

const B = (s) => Buffer.byteLength(String(s), 'utf8')

// ============================================================ 断言器
let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}${detail ? '  ← ' + detail : ''}`)
  }
  return ok
}

// ============================================================ 源码抽取
/**
 * 从 `index.js` 源码里抠出一个函数的完整定义（含 `function` 与函数体）。
 *
 * 扫描器必须跳过字符串 / 模板字符串 / 注释 —— 只数**代码里**的大括号。
 * `selfcheck-pure-utils.mjs` 的老版本是纯计数，对本目录多数纯函数够用；
 * 但 `finishInjection` 有 300+ 行注释与模板串，纯计数会切错位置。
 *
 * 正则用 `^[ \t]*function`：`activeLines` / `policyTextSync` / `renderFromDb` /
 * `finishInjection` 在闭包里，源码是**两个空格缩进**。
 * 锚死行首（`^function`）会一个都找不到 —— `verify-map-forms.mjs` 记过这个坑。
 */
function sliceFunction(name) {
  const re = new RegExp(`^[ \\t]*function ${name}\\(`, 'm')
  const m = re.exec(SRC)
  if (!m) throw new Error(`源码里找不到 function ${name}（被改名或移走了？）`)
  const start = m.index
  let i = SRC.indexOf('{', start)
  if (i < 0) throw new Error(`function ${name} 没有函数体`)
  let depth = 0
  let mode = 'code'
  while (i < SRC.length) {
    const c = SRC[i]
    const n = SRC[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'sq'; i++; continue }
      if (c === '"') { mode = 'dq'; i++; continue }
      if (c === '`') { mode = 'tpl'; i++; continue }
      if (c === '{') depth++
      else if (c === '}') {
        depth--
        if (depth === 0) return SRC.slice(start, i + 1)
      }
      i++
      continue
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; i++; continue }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i += 2; continue } i++; continue }
    if (mode === 'sq' || mode === 'dq') {
      if (c === '\\') { i += 2; continue }
      if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) mode = 'code'
      i++
      continue
    }
    if (mode === 'tpl') {
      if (c === '\\') { i += 2; continue }
      if (c === '`') { mode = 'code'; i++; continue }
      if (c === '$' && n === '{') {
        // 模板串插值：按代码扫描到配对的 `}`
        let d = 1
        i += 2
        let mm = 'code'
        while (i < SRC.length && d > 0) {
          const cc = SRC[i]
          const nn = SRC[i + 1]
          if (mm === 'code') {
            if (cc === '/' && nn === '/') { mm = 'line'; i += 2; continue }
            if (cc === '/' && nn === '*') { mm = 'block'; i += 2; continue }
            if (cc === "'") { mm = 'sq'; i++; continue }
            if (cc === '"') { mm = 'dq'; i++; continue }
            if (cc === '`') { mm = 'tpl2'; i++; continue }
            if (cc === '{') d++
            else if (cc === '}') { d--; if (d === 0) { i++; break } }
            i++
            continue
          }
          if (mm === 'line') { if (cc === '\n') mm = 'code'; i++; continue }
          if (mm === 'block') { if (cc === '*' && nn === '/') { mm = 'code'; i += 2; continue } i++; continue }
          if (mm === 'sq' || mm === 'dq') {
            if (cc === '\\') { i += 2; continue }
            if ((mm === 'sq' && cc === "'") || (mm === 'dq' && cc === '"')) mm = 'code'
            i++
            continue
          }
          if (mm === 'tpl2') {
            if (cc === '\\') { i += 2; continue }
            if (cc === '`') { mm = 'code'; i++; continue }
            i++
            continue
          }
        }
        continue
      }
      i++
      continue
    }
  }
  throw new Error(`function ${name} 的大括号不配对（抽取器被源码结构搞晕了）`)
}

/**
 * 从源码里抠出一个**模块级常量声明**，原样返回（含 `const` 关键字）。
 *
 * ## 为什么需要它（2026-11-19 踩过）
 *
 * 注入序号实验有个开关 `const POLICY_INJECT_SEQ = true`。测试台第一版
 * 在沙箱源码里**写死**了 `'const POLICY_INJECT_SEQ = true'`，于是：
 *
 *   - 把源码里那个开关改成 `false`
 *   - 测试台**依然 PASS=30** —— 因为它跑的是自己写死的那份
 *
 * 这就是「断言在，被测的差异不在」。所以开关必须从源码读。
 *
 * ⚠️ 与 `sliceFunction` 的分工：那个抓 `function X(`，这个抓 `const X =`。
 *    两者都要允许行首缩进（模块级常量在行首，但注释里的同名字符串不能误抓）。
 */
function sliceConstant(name) {
  const re = new RegExp(`^[ \\t]*(?:const|let)\\s+${name}\\s*=`, 'm')
  const m = re.exec(SRC)
  if (!m) throw new Error(`源码里找不到 const/let ${name}（被改名或移走了？）`)
  const start = m.index
  // 常量声明以换行结束（本项目的模块级常量都是字面量或单行表达式）
  const end = SRC.indexOf('\n', start)
  if (end < 0) throw new Error(`const ${name} 没有找到行尾`)
  const line = SRC.slice(start, end).trimEnd()
  if (line === '') throw new Error(`const ${name} 抠出来是空的`)
  return line
}

/**
 * 把**同一作用域**需要的若干函数拼进一个 `new Function`，共享闭包变量。
 *
 * 为什么不一个个抽：`policyTextSync` 要调 `readCached` / `activeLines` /
 * `truncateBytes`，`readCached` 又要用模块级 `syncCache`。
 * 分别抽取就得手工重连依赖图，源码一改依赖，测试还在跑旧图 —— 静默。
 * 所以整条链放进同一函数作用域，只留自由变量做参数。
 */
const SANDBOX_SOURCE = [
  // ---- 模块级依赖链（policy.md / state.json 的同步读）----
  sliceFunction('byteLength'),
  sliceFunction('parseJson'),
  sliceFunction('truncateBytes'),
  '[SYNC_CACHE_PLACEHOLDER]',
  sliceFunction('readCached'),
  sliceFunction('readStateSync'),
  // ---- 项目名 → scope ----
  sliceFunction('projectNameOf'),
  sliceFunction('slugify'),
  sliceFunction('shortHash'),
  // ---- createStore 闭包内的两段 ----
  sliceFunction('activeLines'),
  sliceFunction('policyTextSync'),
  // ---- 注入序号实验（2026-11-19）：三个函数 + 它们依赖的模块级状态 ----
  //
  // ⚠️ 顺序要求：`POLICY_INJECT_SEQ` 是 const、`policyInjectSeq` 是 let，
  //    **都不提升**，必须出现在 `renderFromDb` 被调用之前。
  //    函数声明会提升，但为了让人一眼看懂依赖顺序，仍放在前面。
  //
  // ⚠️⚠️ **开关必须从源码读，不能在这里写死 `true`**（2026-11-19 踩过）：
  //    第一版写死 `const POLICY_INJECT_SEQ = true`，于是把源码里那个开关
  //    改成 `false` 后，测试台依然 PASS —— 测的是测试台自己的常量，
  //    不是被测代码的常量。这是「断言在，被测的差异不在」的典型形态。
  sliceConstant('POLICY_INJECT_SEQ'),
  'let policyInjectSeq = 0',
  sliceFunction('nextInjectSeq'),
  sliceFunction('injectSeqEnabled'),
  sliceFunction('appendInjectSeq'),
  // ---- apply 闭包内的两段 ----
  sliceFunction('renderFromDb'),
  // finishInjection 会写这两个模块级计数变量，必须在同一作用域声明
  'let lastInjectionBytes = null',
  'let lastInjectionHasWriteRule = null',
  sliceFunction('finishInjection'),
  `return {
    byteLength, parseJson, truncateBytes, readCached, readStateSync,
    projectNameOf, slugify, shortHash, activeLines, policyTextSync,
    renderFromDb, finishInjection,
    nextInjectSeq, injectSeqEnabled, appendInjectSeq,
    get lastInjectionBytes() { return lastInjectionBytes },
    get lastInjectionHasWriteRule() { return lastInjectionHasWriteRule },
    get policyInjectSeq() { return policyInjectSeq },
  }`,
].join('\n').replace('[SYNC_CACHE_PLACEHOLDER]', 'const syncCache = new Map()')

/** 自由变量只喂这些；多喂一个就少一分「真实」。 */
function buildSandbox({ paths, config, storeRef, projectDirOf }) {
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'statSync',
    'readFileSync',
    'resolve',
    'basename',
    'createHash',
    'join',
    'paths',
    'name',
    'store',
    'config',
    'dbStoreExists',
    'projectDir',
    SANDBOX_SOURCE,
  )
  return factory(
    statSync,
    readFileSync,
    path.resolve,
    path.basename,
    crypto.createHash,
    path.join,
    paths,
    PROJECT,
    storeRef,
    config,
    () => true, // dbStoreExists：本项目走数据库模式
    projectDirOf,
  )
}

/** 从源码里取插件自己的名字，避免脚本里再写一份（写两份就会不一致）。 */
function pluginNameFromSource() {
  const m = /^export const name = '([^']+)'/m.exec(SRC)
  if (!m) throw new Error('index.js 里找不到 `export const name = ...`')
  return m[1]
}

// ============================================================ 真实库（只读）
/**
 * 找真实记忆根目录。优先级与插件一致：环境变量 > 指针文件 > 本机默认。
 * **只用来读**；任何写操作都不许走这里。
 */
function realMemoryRoot() {
  if (process.env.DSH_MEMORY_ROOT) return process.env.DSH_MEMORY_ROOT
  const pointer = path.join(os.homedir(), '.dsh', 'memory-root.json')
  try {
    const parsed = JSON.parse(fs.readFileSync(pointer, 'utf8'))
    if (typeof parsed?.root === 'string' && parsed.root !== '') return parsed.root
  } catch {
    /* 没有指针文件就走默认 */
  }
  return 'D:\\dsh-fatfishdream-memory'
}

/**
 * 只读扫描真实库，产出一份「等量数据蓝图」。
 *
 * 为什么连**每条文本的字节数**都要读出来：
 *   `## 全局结论` / `## 项目结论` 的字节数完全由库里文本长度决定。
 *   只对齐「条数」的话这两段必然与生产不同，测试台就没法跟生产实测的
 *   6429 对账，只能自说自话。对齐字节数后，假数据能复现**逐段相同**的字节账。
 */
function probeRealDb(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const q = (sql, ...a) => db.prepare(sql).all(...a)
    const num = (v) => parseInt(v, 10)
    const profile = q(
      `SELECT topic,status,review,LENGTH(CAST(text AS BLOB)) b FROM profile ORDER BY id`,
    ).map((r) => ({ topic: r.topic, status: r.status, review: r.review, bytes: num(r.b) }))
    const rules = q(
      `SELECT scope,kind,topic,status,review,LENGTH(CAST(text AS BLOB)) b FROM rules ORDER BY id`,
    ).map((r) => ({
      scope: r.scope, kind: r.kind, topic: r.topic,
      status: r.status, review: r.review, bytes: num(r.b),
    }))
    const logs = q(
      `SELECT scope,topic,status,LENGTH(CAST(text AS BLOB)) b FROM logs ORDER BY id`,
    ).map((r) => ({ scope: r.scope, topic: r.topic, status: r.status, bytes: num(r.b) }))
    const schema = num(db.prepare('PRAGMA user_version').get().user_version)
    const tableInfo = {}
    for (const t of ['profile', 'rules', 'emotion', 'logs', 'archive']) {
      tableInfo[t] = q(`PRAGMA table_info(${t})`).map((c) => `${c.name}:${c.type}:${c.notnull}`)
    }
    const count = (t) => num(db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n)
    const totals = {
      profile: count('profile'), rules: count('rules'),
      logs: count('logs'), archive: count('archive'), emotion: count('emotion'),
    }
    return { source: 'real', dbPath, schema, profile, rules, logs, tableInfo, totals }
  } finally {
    db.close()
  }
}

/**
 * 真实库读不到时的退路：2026-11-19 的只读实测快照。
 *
 * 保留它是为了让脚本在库被占用时仍可运行，但**必须打印用的是哪一份** ——
 * 否则读数对不上时会去查一个不存在的问题。
 */
function fallbackBlueprint() {
  const P = (bytes, status, review, topic = null) => ({ bytes, status, review, topic })
  const profile = [
    P(100, 'active', 'edited', '情绪判据'), P(117, 'deleted', null, '测量/像素'),
    P(86, 'deleted', null, 'Git'), P(102, 'deleted', null, '构建/编译'),
    P(93, 'deleted', null, null), P(135, 'active', 'edited', '情绪判据'),
    P(326, 'deleted', 'edited', null), P(153, 'deleted', null, '注入/预算'),
    P(36, 'deleted', null, null), P(65, 'deleted', null, 'pref'),
    P(100, 'active', 'edited', 'pref'), P(86, 'deleted', 'edited', 'pref'),
    P(99, 'deleted', null, 'pref'),
  ]
  const R = (scope, topic, bytes, review = null) => ({
    scope, kind: 'pref', topic, status: 'active', review, bytes,
  })
  const rules = [
    R('dsh-skill-switch-main', '插件/装载', 101), R('dsh-skill-switch-main', '插件/装载', 115),
    R('__global__', '用户画像', 119, 'edited'), R('__global__', '用户画像', 87, 'edited'),
    R('__global__', '用户画像', 93, 'edited'), R('__global__', null, 57), R('__global__', null, 78),
    R(PROJECT, null, 42, 'edited'), R(PROJECT, null, 33),
  ]
  const logCounts = [
    [PROJECT, '开发日志', 'active', 365], [PROJECT, '技术讨论', 'active', 206],
    [PROJECT, '文档/行号', 'active', 45], [PROJECT, 'GUI/界面', 'active', 30],
    [PROJECT, '插件/装载', 'active', 26], [PROJECT, '注入/预算', 'active', 24],
    [PROJECT, '用户画像', 'active', 18], [PROJECT, 'Git', 'active', 16],
    [PROJECT, '数据清理', 'active', 11], [PROJECT, '情绪判据', 'active', 8],
    [PROJECT, '路径/沙箱', 'active', 3], [PROJECT, null, 'active', 3],
    [PROJECT, '格式/编码', 'active', 1], [PROJECT, '构建/编译', 'active', 1],
    [PROJECT, '开发日志', 'deleted', 58],
    ['SoftTest', '开发日志', 'active', 46], ['SoftTest', '技术讨论', 'active', 30],
    ['SoftTest', '情绪判据', 'active', 9], ['SoftTest', null, 'active', 4],
    ['SoftTest', '用户画像', 'active', 1], ['SoftTest', '格式/编码', 'active', 1],
    ['ForzaOverlay', '开发日志', 'active', 10], ['ForzaOverlay', '技术讨论', 'active', 8],
    ['ForzaOverlay', '文档/行号', 'active', 5], ['ForzaOverlay', '情绪判据', 'active', 4],
    ['ForzaOverlay', '构建/编译', 'active', 3], ['ForzaOverlay', '用户画像', 'active', 2],
    ['ForzaOverlay', '插件/装载', 'active', 2], ['ForzaOverlay', '数据清理', 'active', 1],
    ['design', '开发日志', 'active', 7], ['design', '技术讨论', 'active', 3],
    ['desktop', '开发日志', 'active', 2], ['desktop', '开发日志', 'deleted', 1],
    ['dsh-skill-switch-main', '开发日志', 'active', 2],
    ['dsh-wsprobe', '技术讨论', 'active', 1], ['dsh-wsprobe', '开发日志', 'active', 1],
  ]
  const logs = []
  for (const [scope, topic, status, n] of logCounts) {
    for (let i = 0; i < n; i++) logs.push({ scope, topic, status, bytes: 500 })
  }
  return {
    source: 'fallback-snapshot', dbPath: null, schema: SCHEMA_VERSION,
    profile, rules, logs, tableInfo: null,
    totals: { profile: profile.length, rules: rules.length, logs: logs.length, archive: 0, emotion: 0 },
  }
}

// ============================================================ 造数据
/**
 * 造一条**多字节安全、指定 UTF-8 字节长度**的单行假文本。
 *
 * 为什么必须精确到字节：注入里每段字节数是断言对象。
 * 用「大概 500 字」的随机文本，`## 项目结论` 会是 78 或 83 字节，
 * 断言就只能写成「恒定」而不能写成「= 80」—— 弱一档。
 *
 * 约束：不含换行（否则会被当成新的一行，改变 joinWithBudget 的行数）；
 * 不以 `- ` / `[stale]` 等会被 activeLines 或 Markdown 解释的前缀开头。
 * 汉字 3 字节、ASCII 1 字节，末尾用 `x` 补齐余数即可精确命中。
 */
function makeText(exactBytes, seed = 0) {
  const POOL = '记忆注入沙箱测试虚拟数据条目标题结论规则画像流水情绪检索预算行号'
  let out = ''
  let used = 0
  let i = seed
  while (used + 3 <= exactBytes) {
    out += POOL[i % POOL.length]
    used += 3
    i += 7
  }
  return out + 'x'.repeat(exactBytes - used)
}

/** 把蓝图灌进临时库。**只写临时库**，调用方负责路径闸门。 */
function seedTempDb(dbPath, blueprint) {
  const db = openMemoryDb(DatabaseSync, dbPath)
  try {
    db.exec('BEGIN')
    const ts = '2026-11-19T00:00:00.000Z'
    const insProfile = db.prepare(
      `INSERT INTO profile(ts,topic,text,status,writer,review) VALUES(?,?,?,?,?,?)`,
    )
    blueprint.profile.forEach((r, i) => {
      insProfile.run(ts, r.topic, makeText(r.bytes, i), r.status, 'model', r.review)
    })
    const insRules = db.prepare(
      `INSERT INTO rules(scope,kind,ts,topic,text,status,writer,review) VALUES(?,?,?,?,?,?,?,?)`,
    )
    blueprint.rules.forEach((r, i) => {
      insRules.run(r.scope, r.kind, ts, r.topic, makeText(r.bytes, i + 101), r.status, 'model', r.review)
    })
    const insLogs = db.prepare(
      `INSERT INTO logs(scope,ts,topic,text,status,writer,summary) VALUES(?,?,?,?,?,?,?)`,
    )
    blueprint.logs.forEach((r, i) => {
      const text = makeText(r.bytes, i)
      insLogs.run(r.scope, ts, r.topic, text, r.status, 'model', text.slice(0, 40))
    })
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

// ============================================================ 分段拆解
/**
 * 把 `parts` 数组按段归组。
 *
 * ⚠️ 必须按**标题**归组，不能按固定下标取：项目段为空时 parts 会整体前移，
 * 按下标取会把「记忆索引」标成「项目结论」（2026-11-14 踩过，
 * 见 `show-injection.mjs` 的注释）。
 */
function decompose(parts) {
  const groups = []
  for (const p of parts) {
    const m = /^## ([^\n]+)/.exec(p)
    if (m) {
      const label = '## ' + m[1].replace(/<!--[\s\S]*$/, '').replace(/（.*$/, '').trim()
      groups.push({ label, chunks: [p] })
    } else if (groups.length > 0) {
      groups[groups.length - 1].chunks.push(p)
    } else {
      groups.push({ label: '(无标题)', chunks: [p] })
    }
  }
  return groups.map((g) => {
    const text = g.chunks.join('\n\n')
    const firstChunk = g.chunks[0]
    const nl = firstChunk.indexOf('\n')
    const titleText = nl < 0 ? firstChunk : firstChunk.slice(0, nl)
    const restOfFirst = nl < 0 ? '' : firstChunk.slice(nl + 1)
    const bodyText = g.chunks.length > 1
      ? [restOfFirst, ...g.chunks.slice(1)].filter((s) => s !== '').join('\n\n')
      : restOfFirst
    return {
      label: g.label,
      titleText,
      bodyText,
      bytes: B(text),
      titleBytes: B(titleText),
      bodyBytes: B(bodyText),
    }
  })
}

/**
 * 从完整注入里切出 `## 记忆索引` 段的 **routeTable 本体**（不含标题与指路句）。
 *
 * 为什么不直接取 `parts` 那一项：`renderFromDb` 把标题、指路句、路由表拼成
 * **同一个**字符串，`decompose()` 只能切到「首行 / 其余」。而要跟独立重算的
 * routeTable 逐行比对，必须把前面那句指路去掉。
 *
 * 判据：`（scope 必带）。\n` 之后到下一个 `\n\n## ` 之前，就是路由表。
 */
function routesOf(full) {
  const marker = '（scope 必带）。\n'
  const start = full.indexOf(marker)
  if (start < 0) return ''
  const from = start + marker.length
  const end = full.indexOf('\n\n## ', from)
  const tail = end < 0 ? full.slice(from) : full.slice(from, end)
  return tail.replace(/\n+$/, '')
}

/** 注入里的固定 hint 文本（与 finishInjection 的 dbMode 分支一致）。 */
function hintText() {
  return '<!-- 本段由插件注入。记忆存于 SQLite；模型用 HTTP 接口写流水，不要写进正文。 -->'
}

/**
 * 按蓝图重算 factsTextSync 的期望字节数 —— **独立实现**，不复用 db-store。
 *
 * 独立重算是刻意的：两边都调同一个函数，「对账」就退化成自证。
 * 过滤条件必须与 db-store.mjs 的 SQL 一致：
 *   profile：status='active' AND review IS NOT 'retracted'
 *   rules  ：scope='__global__' AND kind='pref' AND status='active' AND review IS NOT 'retracted'
 * 每行拼成 `- ${text}`，用 '\n' 连接。
 */
function expectedFactsBytes(blueprint) {
  const sizes = []
  for (const r of blueprint.profile) {
    if (r.status !== 'active' || r.review === 'retracted') continue
    sizes.push(2 + r.bytes)
  }
  for (const r of blueprint.rules) {
    if (r.scope !== '__global__' || r.kind !== 'pref' || r.status !== 'active') continue
    if (r.review === 'retracted') continue
    sizes.push(2 + r.bytes)
  }
  if (sizes.length === 0) return 0
  return sizes.reduce((a, b) => a + b, 0) + (sizes.length - 1)
}

/** 按蓝图重算 projectTextSync 的期望字节数（本项目 rules，红线优先、再按插入序）。 */
function expectedProjectBytes(blueprint, project) {
  const rank = { redline: 0, pref: 1, state: 2 }
  const rows = blueprint.rules
    .filter((r) => r.scope === project && r.status === 'active' && r.review !== 'retracted')
    .map((r, idx) => ({ ...r, idx }))
    .sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3) || a.idx - b.idx)
  if (rows.length === 0) return 0
  return rows.reduce((a, r) => a + 2 + r.bytes, 0) + (rows.length - 1)
}

/**
 * 按蓝图独立重算 routeTable（与 db-store.mjs 的 SQL 同口径），返回**行数组**。
 *
 * ⚠️ 返回数组而不是字符串，因为 `ORDER BY n DESC` **没有 tiebreaker**：
 *    n 相同的 topic 谁在前由 SQLite 内部顺序决定，不是稳定排序。
 *    实测（2026-11-19）：真实库里 n=1 的两个 topic 出的是
 *    `格式/编码` → `构建/编译`，而临时库里出的是反的 ——
 *    两行字节数相同（都是 27），所以**总字节不变、段字节不变**，
 *    但这种顺序差异会让 sha256 不同。
 *
 *    对「本库连续 300 次是否相同」这个命题没有影响（同一个库文件、同一份
 *    索引，SQLite 每次都给出同一顺序）；但**不能**拿它去和另一个库逐字比对。
 *    所以这里按「集合相同」断言，把顺序差异单独报出来。
 */
function expectedRoutes(blueprint, project) {
  const tally = new Map()
  const bump = (topic) => tally.set(topic, (tally.get(topic) ?? 0) + 1)
  for (const r of blueprint.rules) {
    if (r.status !== 'active' || r.topic === null || r.topic === undefined) continue
    if (r.scope === project || r.scope === '__global__') bump(r.topic)
  }
  for (const r of blueprint.logs) {
    if (r.status !== 'active' || r.topic === null || r.topic === undefined) continue
    if (r.scope === project || r.scope === '__global__') bump(r.topic)
  }
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `- ${t}（${n} 条）`)
}

/** 某 topic 在注入口径下的 active 条数（本项目 + 全局）。 */
function countActive(blueprint, project, topic) {
  const rows = [...blueprint.logs, ...blueprint.rules]
  return rows.filter(
    (r) => r.topic === topic && r.status === 'active' && (r.scope === project || r.scope === '__global__'),
  ).length
}

// ============================================================ 主流程
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inject-sandbox-'))
const tmpDb = path.join(tmpRoot, 'memory.db')

// 写操作前的硬闸门：临时库必须真的落在刚建的临时目录里。
// 记忆根目录在工作区之外，「拼错路径写坏真库」是这里唯一不可逆的错误。
if (!path.resolve(tmpDb).startsWith(path.resolve(tmpRoot) + path.sep)) {
  throw new Error(`临时库路径越界，拒绝继续：${tmpDb}`)
}

let dbStore = null
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try {
    dbStore?.close?.()
  } catch (error) {
    console.log(`⚠️ 关闭 dbStore 失败：${error?.message ?? error}`)
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch (error) {
    console.log(`⚠️ 删除临时目录失败：${tmpRoot}（${error?.message ?? error}）`)
  }
}

try {
  // ---- 1. 真实库只读蓝图 ----
  const realRoot = realMemoryRoot()
  const realDbPath = path.join(realRoot, 'memory.db')
  const realPolicy = path.join(realRoot, 'policy.md')
  let blueprint
  try {
    blueprint = probeRealDb(realDbPath)
  } catch (error) {
    console.log(`⚠️ 真实库不可读（${error?.message ?? error}），改用 2026-11-19 只读快照蓝图`)
    blueprint = fallbackBlueprint()
  }

  // ---- 2. policy.md：只读复制到临时目录 ----
  const tmpPolicy = path.join(tmpRoot, 'policy.md')
  let policySource = '内置等效文本'
  if (fs.existsSync(realPolicy)) {
    fs.copyFileSync(realPolicy, tmpPolicy) // 只读源文件，写的是临时副本
    policySource = '真实文件的只读副本'
  } else {
    fs.writeFileSync(
      tmpPolicy,
      '## 给模型的规则\n\n' +
        '- 每轮回复的结尾，加固定一句：大肥鱼是漂亮老婆！ 这是会话的「心跳」，用来确认本轮执行完整。放在最后一行，不用解释、不要变形。\n\n' +
        '- 立即执行 `& .\\.dsh-fatfishdream-memory\\log.ps1 "一句话结论"`。\n\n' +
        '## 简单用法\n- 示例\n',
      'utf8',
    )
  }

  const policyTotalBytes = B(fs.readFileSync(tmpPolicy, 'utf8'))

  // ---- 3. 建临时库并灌数据 ----
  seedTempDb(tmpDb, blueprint)

  // ---- 4. 装配真实渲染路径 ----
  const config = { factsBytes: 8000, policyBytes: 8000, projectBytes: 4096 }
  const paths = { policy: tmpPolicy, state: path.join(tmpRoot, 'state.json'), policyBackup: null }
  // state.json：让 resolveProjectKey 能把 CWD 解析成 scope=项目名
  fs.writeFileSync(
    paths.state,
    JSON.stringify({
      version: 2,
      lastConsolidate: null,
      projects: {
        [PROJECT]: { name: PROJECT, dir: path.join(tmpRoot, PROJECT), cwd: path.resolve(CWD) },
      },
    }),
    'utf8',
  )

  // createStore 里 projectDir 是 `(key, state) => state?.projects?.[key]?.dir ?? join(root, key)`
  // —— 一行箭头函数，抽取器只处理 function 声明；这里照抄同一行语义。
  const rootRef = { root: tmpRoot }
  const projectDirOf = (key, state) =>
    state?.projects?.[key]?.dir ?? path.join(rootRef.root, key)

  const storeRef = {
    get root() { return rootRef.root },
    get paths() { return paths },
  }
  const sandbox = buildSandbox({ paths, config, storeRef, projectDirOf })
  // store 的这三个方法来自 createStore 闭包 —— 直接把抽取出来的真实实现挂上去
  storeRef.policyTextSync = (maxBytes) => sandbox.policyTextSync(maxBytes)
  storeRef.readStateSync = (s) => sandbox.readStateSync(s)
  storeRef.resolveProjectKey = (cwd, state) => {
    const nm = sandbox.projectNameOf(cwd)
    if (nm === undefined) return undefined
    const base = sandbox.slugify(nm)
    if (base === '') return undefined
    const claimed = state?.projects?.[base]
    const key = claimed !== undefined && claimed.cwd !== undefined &&
      path.resolve(claimed.cwd) !== path.resolve(cwd)
      ? `${base}-${sandbox.shortHash(cwd)}`
      : base
    const entry = state?.projects?.[key]
    const scope = typeof entry?.scope === 'string' && entry.scope !== '' ? entry.scope : key
    return { key, name: nm, scope, dir: projectDirOf(key, state) }
  }

  dbStore = createDbStore(tmpDb, config, () => {})
  dbStore.open()

  const projectName = storeRef.resolveProjectKey(CWD, sandbox.readStateSync(storeRef))?.scope

  // ---- 5. 300 次渲染 ----
  console.log(`临时库：${tmpDb}`)
  console.log(`开始 ${RUNS} 次注入渲染（每次随机间隔 0~50ms）…\n`)

  const records = []
  const renderErrors = []
  for (let i = 0; i < RUNS; i++) {
    await new Promise((r) => setTimeout(r, Math.random() * 50))
    try {
      const parts = []
      sandbox.renderFromDb(dbStore, projectName, parts)
      const full = sandbox.finishInjection(parts, config, projectName)
      records.push({
        i,
        total: B(full),
        sha: crypto.createHash('sha256').update(full, 'utf8').digest('hex'),
        segs: decompose(parts),
        full,
      })
    } catch (error) {
      renderErrors.push({ i, message: `${error?.name ?? 'Error'}: ${error?.message ?? error}` })
      if (renderErrors.length <= 3) console.log(`❌ 第 ${i} 次渲染抛错：${error?.stack ?? error}`)
    }
  }

  // 一次都没渲染成功时，后面的逐项对账会拿 undefined 崩在别的行上，
  // 报出一个与真实病因无关的 TypeError。先在这里截断。
  if (records.length === 0) {
    // 这里写**推导出来的表达式**而不是字面量 false：
    // 字面量断言虽然在守卫分支里合法，但扫描器无法区分它与恒真断言，
    // 而且「用真实表达式」还能顺带证明计数确实对得上。
    check(
      `${RUNS} 次渲染全部成功（无异常）`,
      renderErrors.length === 0 && records.length === RUNS,
      `成功 ${records.length}/${RUNS}，首个异常：${renderErrors[0]?.message ?? '(无)'}`,
    )
    console.log(`\n断言：PASS=${pass} FAIL=${fail}`)
    console.log('渲染全部失败，无法继续对账（上面已打印首个异常堆栈）。')
    process.exitCode = 1
    // 用带 code 的哨兵跳出，避免打印一段与本病因无关的「未捕获异常」堆栈。
    const abort = new Error('render-all-failed')
    abort.code = 'SANDBOX_ABORT'
    throw abort
  }

  // ---- 6. 对账数据 ----
  const first = records[0]
  const segOf = (rec, label) => rec?.segs.find((s) => s.label === label)
  const bodyBytesAll = (label) => records.map((r) => segOf(r, label)?.bodyBytes)
  const segBytesAll = (label) => records.map((r) => segOf(r, label)?.bytes)
  const unique = (arr) => [...new Set(arr)]
  const constant = (arr) => unique(arr).length === 1

  // 不恒定的段：打印「哪一段、变了多少、内容差异」
  const allLabels = [...new Set(records.flatMap((r) => r.segs.map((s) => s.label)))]
  const unstable = []
  for (const label of allLabels) {
    const values = records.map((r) => segOf(r, label)?.bytes)
    if (!constant(values)) unstable.push({ label, values })
  }
  if (unstable.length > 0) {
    console.log('\n=== ⚠️ 检测到不恒定的段 ===')
    for (const u of unstable) {
      const uniq = unique(u.values)
      const a = records.find((r) => segOf(r, u.label)?.bytes === uniq[0])
      const b = records.find((r) => segOf(r, u.label)?.bytes === uniq[1])
      console.log(`\n段：${u.label}`)
      console.log(`  出现的字节数：${uniq.join(' / ')}`)
      console.log(`  首次：run#${a.i} = ${uniq[0]} 字节`)
      console.log(`  差异：run#${b.i} = ${uniq[1]} 字节（差 ${uniq[1] - uniq[0]}）`)
      const sa = segOf(a, u.label)
      const sb = segOf(b, u.label)
      console.log(`  标题：${JSON.stringify(sa?.titleText)}`)
      console.log(`      vs ${JSON.stringify(sb?.titleText)}`)
      console.log(`  正文：${JSON.stringify((sa?.bodyText ?? '').slice(0, 200))}`)
      console.log(`      vs ${JSON.stringify((sb?.bodyText ?? '').slice(0, 200))}`)
    }
  }

  const routesInRender = routesOf(first.full)
  const indexSegBytes = B(routesInRender)
  const routeLines = expectedRoutes(blueprint, PROJECT) // 行数组（不 join）
  const renderLines = routesInRender.split('\n')
  const routesExpected = routeLines.join('\n')
  const factsExpected = expectedFactsBytes(blueprint)
  const projExpected = expectedProjectBytes(blueprint, PROJECT)

  // 被过滤掉的条目数（用来证明过滤真的生效，而不是「恰好没有这些数据」）
  const droppedOtherScope = blueprint.logs.filter(
    (r) => r.scope !== PROJECT && r.status === 'active' && r.topic !== null,
  ).length
  const droppedNullTopic = blueprint.logs.filter(
    (r) => r.scope === PROJECT && r.status === 'active' && r.topic === null,
  ).length
  const droppedDeleted = blueprint.logs.filter(
    (r) => r.scope === PROJECT && r.status === 'deleted',
  ).length

  // ---- 7. 断言 ----
  check(
    `${RUNS} 次渲染全部成功（无异常）`,
    renderErrors.length === 0 && records.length === RUNS,
    `成功 ${records.length}/${RUNS}，异常 ${renderErrors.length} 次` +
      (renderErrors[0] ? `：${renderErrors[0].message}` : ''),
  )

  const presence = (label) => records.filter((r) => segOf(r, label) !== undefined).length
  check(
    `\`## 全局规则\` 段 ${RUNS}/${RUNS} 次都存在（policy.md「给模型的规则」）`,
    presence('## 全局规则') === RUNS,
    `实际 ${presence('## 全局规则')}/${RUNS}`,
  )

  const policyBodies = bodyBytesAll('## 全局规则')
  // ★ 2026-11-19 实验期断言（`POLICY_INJECT_SEQ = true`）：
  //
  // 注入序号会给「写流水」那一行追加 `\u2063#N`（U+2063 占 3 字节，`#` 1 字节，
  // 序号 1~3 位），因此正文**每轮不同**，长度 = 原文 + 5 / 6 / 7。
  //
  // 所以这里不再断言「恒定 261」，改断言两件更本质的事：
  //   ① 每一轮都比 policy.md 原文**长**（说明序号确实被追加了）
  //   ② 长度落在预期窗口内
  //
  // ⚠️ 2026-11-19：**实验已关闭**（`POLICY_INJECT_SEQ = false`）。
  //    序号不再追加，所以「全局规则正文」应当**恒等于 policy.md 原文长度**。
  //
  //    而且这个长度不能再写死：policy.md 是用户数据，今天就被改了两次。
  //    改为现读（`prodGlobalRulesBytes()`，取不到就跳过这条断言）。
  const liveRules = prodGlobalRulesBytes()
  if (liveRules === null) {
    console.log('  本段不适用：读不到真实 policy.md，跳过「全局规则正文恒等」断言')
  } else {
    check(
      `\`## 全局规则\` 正文恒为 policy.md 原文 ${liveRules} 字节（序号已关闭，不再追加）`,
      policyBodies.length === RUNS && policyBodies.every((b) => b === liveRules),
      `实际 ${unique(policyBodies).join(' / ')}，期望恒为 ${liveRules}`,
    )
  }
  check(
    '`## 全局规则` 正文恰好 2 行（两行没挤成一行，也没被 [stale] 过滤掉）',
    (segOf(first, '## 全局规则')?.bodyText ?? '').split('\n').length === 2,
    `实际 ${JSON.stringify(segOf(first, '## 全局规则')?.bodyText ?? '')}`,
  )

  const factsBodies = bodyBytesAll('## 全局结论')
  check(
    '`## 全局结论` 正文字节数恒定且非空',
    constant(factsBodies) && factsBodies[0] > 0,
    `实际 ${unique(factsBodies).join(' / ')}`,
  )
  check(
    '`## 全局结论` 正文 = profile(active) + rules(__global__,pref) 字节之和（按蓝图独立重算）',
    factsBodies[0] === factsExpected,
    `实际 ${factsBodies[0]}，独立重算 ${factsExpected}`,
  )

  const projBodies = bodyBytesAll('## 项目结论')
  check(
    '`## 项目结论` 正文字节数恒定且非空',
    constant(projBodies) && projBodies[0] > 0,
    `实际 ${unique(projBodies).join(' / ')}`,
  )
  check(
    '`## 项目结论` 正文 = 本项目 rules 字节之和（红线优先排序，按蓝图独立重算）',
    projBodies[0] === projExpected,
    `实际 ${projBodies[0]}，独立重算 ${projExpected}`,
  )

  const routesBodies = bodyBytesAll('## 记忆索引')
  check(
    '`## 记忆索引` 段字节数恒定且非空',
    constant(routesBodies) && routesBodies[0] > 0,
    `实际 ${unique(routesBodies).join(' / ')}`,
  )
  // 路由表逐行比对：按「行集合 + 顺序」两层分开断言。
  //
  // 为什么不写一条 `routesInRender === routesExpected`：
  //   `ORDER BY n DESC` 没有 tiebreaker，n 相同的 topic 顺序由 SQLite 内部
  //   决定（真实库 n=1 出 `格式/编码→构建/编译`，临时库出反的）。
  //   一条混在一起的断言失败时，看不出是「topic 或条数错了」还是
  //   「只是两个同值行的先后不同」—— 而后者不影响任何字节数。
  //   实测确认：两者 bytes 都是 27，所以段字节完全一致。
  const setEq = (a, b) => {
    const sa = [...a].sort()
    const sb = [...b].sort()
    return sa.length === sb.length && sa.every((x, i) => x === sb[i])
  }
  check(
    '`## 记忆索引` 的 topic 与条数集合与独立重算完全一致（12 类以上，含并列值）',
    setEq(renderLines, routeLines) && renderLines.length === routeLines.length,
    setEq(renderLines, routeLines)
      ? ''
      : `渲染 ${renderLines.length} 行 vs 期望 ${routeLines.length} 行；` +
        `多出 ${JSON.stringify(renderLines.filter((l) => !routeLines.includes(l)))}，` +
        `缺少 ${JSON.stringify(routeLines.filter((l) => !renderLines.includes(l)))}`,
  )
  check(
    '`## 记忆索引` 行顺序与重算一致（count 降序；并列项顺序不保证，见注释）',
    (() => {
      const counts = renderLines.map((l) => Number(/（(\d+) 条）/.exec(l)?.[1] ?? -1))
      const descending = counts.every((c, i) => i === 0 || counts[i - 1] >= c)
      // 并列项允许顺序不同，逐位比对只在「不等值」位置上做
      const mismatchAt = renderLines.findIndex((l, i) => {
        if (l === routeLines[i]) return false
        const a = Number(/（(\d+) 条）/.exec(l)?.[1] ?? -1)
        const b = Number(/（(\d+) 条）/.exec(routeLines[i] ?? '')?.[1] ?? -1)
        return a !== b // 条数不同才算错位；并列互换不算
      })
      return descending && mismatchAt === -1
    })(),
    `渲染顺序 ${JSON.stringify(renderLines.map((l) => l.slice(0, 8)))}`,
  )
  // 并列顺序是否与生产一致：单独一条，**不参与总体 PASS/FAIL 判定**，只报告。
  if (renderLines.join('\n') !== routesExpected) {
    const tieOnly = setEq(renderLines, routeLines)
    console.log(
      tieOnly
        ? 'ℹ️ 路由表行序与生产库在「同 count 的并列项」上不同（字节数不受影响，非失败）'
        : '⚠️ 路由表内容与生产库不同（上面已判失败）',
    )
  }

  // 现算基准：取不到就**不产生断言**（AGENTS.md：没有断言可写就不要产生断言）
  const prodIdx = prodRouteTableBytes(PROJECT)
  if (prodIdx === null) {
    console.log(
      '   ℹ️ 读不到真实库的 routeTable（库不存在或打不开）——「记忆索引」段不比对绝对字节。',
    )
    console.log('      本段不适用：无法确认渲染结果与生产一致。')
  } else {
    check(
      `\`## 记忆索引\` 路由表 = ${prodIdx} 字节（真实库现算）`,
      indexSegBytes === prodIdx,
      `实际 ${indexSegBytes}`,
    )
  }

  const usageSeg = segBytesAll('## 记忆使用说明')
  check(
    `\`## 记忆使用说明\` 段恒为 ${PROD_SEG.记忆使用说明段} 字节（源码常量，与库内容无关）`,
    constant(usageSeg) && usageSeg[0] === PROD_SEG.记忆使用说明段,
    `实际 ${unique(usageSeg).join(' / ')}，期望 ${PROD_SEG.记忆使用说明段}`,
  )
  check(
    '`## 记忆使用说明` 含「写流水」「一行命令」与 scope 两种写法警告（说明段没被截半）',
    ['写流水', '一行命令', 'scope=all'].every((kw) =>
      (segOf(first, '## 记忆使用说明')?.bodyText ?? '').includes(kw)),
  )

  const shas = unique(records.map((r) => r.sha))
  // ★ 2026-11-19 实验期断言（`POLICY_INJECT_SEQ = true`）：
  //
  // 序号让注入每轮不同 —— **这正是实验目的**（强制 cache miss）。
  // 所以断言从「必须全部相同」翻成「必须全部不同」。
  //
  // ⚠️ 这条断言的方向与实验开关绑定。关掉实验后要改回来，
  //    否则它会因为「又变回全部相同」而红。两者必须一起翻。
  // ⚠️ 2026-11-19：**实验已关闭**（`POLICY_INJECT_SEQ = false`）。
  //    断言方向随开关一起翻回来 —— 这正是上面注释要求的联动。
  //    序号关掉后注入逐字节恒定，所以「只有 1 种」才是正确状态。
  check(
    `${RUNS} 次 sha256 全部相同（序号已关闭 → 注入逐轮恒定）`,
    shas.length === 1,
    `出现 ${shas.length} 种（期望 1 种）`,
  )

  const totals = unique(records.map((r) => r.total))
  // 序号关掉后总字节应当**完全恒定**（只有 1 种）。
  check(
    '总字节数完全恒定（序号已关闭，其余各段没有漂移）',
    totals.length === 1,
    `出现 ${totals.length} 种：${totals.join(' / ')}`,
  )

  const prefixBytes = B(`# 记忆（${pluginNameFromSource()}）`) + B(hintText()) + 4
  const segSum = first.segs.reduce((a, s) => a + s.bytes, 0)
  const accounted = prefixBytes + segSum + 2 * (first.segs.length - 1) + 1
  check(
    '总字节 = 标题+hint + 各段之和 + 段间分隔符 + 末尾换行（分段账无漏项）',
    accounted === first.total,
    `分解 ${accounted} vs 实际 ${first.total}`,
  )

  check(
    '总字节自洽：分段账加总 = 实际渲染总字节',
    // ⚠️ 2026-11-19：原来这里断言「与生产实测 6429 完全相等」。
    //    那个 6429 是**某一时刻 policy.md 的快照**，用户一改规则就过期。
    //    快照值当判据 = 下一个人会看到莫名其妙的红（今天已经踩过一次）。
    //
    //    所以改为**自洽检查**：分段账加总必须等于总字节。
    //    这条不依赖任何外部基准，改 policy.md 也不会误伤。
    //    与真实生产注入的逐字节对账，交给 `prodGlobalRulesBytes()` 那条（现读）。
    accounted === first.total,
    `分解 ${accounted} vs 实际 ${first.total}`,
  )

  check(
    `scope 过滤生效：其他 scope 的 ${droppedOtherScope} 条 active 流水未计入索引`,
    droppedOtherScope > 0 && !routesInRender.includes('SoftTest') && !routesInRender.includes('ForzaOverlay'),
    `其他 scope 条数 ${droppedOtherScope}`,
  )
  check(
    `topic IS NULL 的 ${droppedNullTopic} 条未计入索引`,
    droppedNullTopic > 0 && !routesInRender.includes('null'),
    `实际 ${droppedNullTopic} 条`,
  )
  check(
    `status=deleted 未污染索引：开发日志 = ${countActive(blueprint, PROJECT, '开发日志')} 条（不是 +${droppedDeleted}）`,
    droppedDeleted > 0 &&
      routesInRender.includes(`- 开发日志（${countActive(blueprint, PROJECT, '开发日志')} 条）`),
    `渲染首行 ${JSON.stringify(routesInRender.split('\n')[0])}`,
  )

  if (blueprint.tableInfo) {
    const tmpSchema = new DatabaseSync(tmpDb, { readOnly: true })
    try {
      const diffs = []
      for (const t of Object.keys(blueprint.tableInfo)) {
        const cols = tmpSchema
          .prepare(`PRAGMA table_info(${t})`)
          .all()
          .map((c) => `${c.name}:${c.type}:${c.notnull}`)
        if (cols.join('|') !== blueprint.tableInfo[t].join('|')) diffs.push(t)
      }
      const v = parseInt(tmpSchema.prepare('PRAGMA user_version').get().user_version, 10)
      check(
        '临时库与真实库表结构逐列一致（profile/rules/emotion/logs/archive）',
        diffs.length === 0,
        `不一致：${diffs.join(', ')}`,
      )
      check(
        `临时库 schema 版本 = ${blueprint.schema}（与真实库同版本）`,
        v === blueprint.schema,
        `实际 ${v}`,
      )
    } finally {
      tmpSchema.close()
    }
  } else {
    console.log('ℹ️ 表结构对账本段不适用（用的是内置快照蓝图，没有真实库可对）')
  }

  // ---- 8. 负向对照：证明上面那些断言**真的会失败** ----
  //
  // ① policy 正文多一个字符 → 全局规则断言必须变红。
  //    ⚠️ 必须改**正文行**，不能只改小节标题：标题不参与 activeLines 的输出，
  //    改标题字节数不变，这条对照会退化成恒真（2026-11-19 初版踩过）。
  {
    const original = fs.readFileSync(tmpPolicy, 'utf8')
    const mutated = original.replace('大肥鱼是漂亮老婆！', '大肥鱼是漂亮老婆！！')
    check(
      '负向对照的前提：临时 policy 副本里确实命中了要改的那句（否则下一条恒真）',
      mutated !== original,
      '真实 policy.md 的第一行规则与预期不符',
    )
    const bumped = path.join(tmpRoot, 'policy-bumped.md')
    fs.writeFileSync(bumped, mutated, 'utf8')
    const probe = buildSandbox({
      paths: { ...paths, policy: bumped },
      config,
      storeRef: { get root() { return rootRef.root }, get paths() { return paths } },
      projectDirOf,
    })
    const delta = B(probe.policyTextSync(8000).text) - (policyBodies[0] ?? 0)
    check(
      '负向对照：policy 正文多一个「！」→ 全局规则正文随之变化（261 那条断言不是恒真）',
      delta !== 0,
      `变化 ${delta} 字节`,
    )
  }

  // ② 库加一条流水 → sha256 变、索引段变，而 policy 与使用说明段纹丝不动。
  //
  // ⚠️ 必须挑一个**会改变字节数**的 topic：条数 365→366 是同一个位数，
  //    `- 开发日志（365 条）` 与 `- 开发日志（366 条）` 都是 27 字节 ——
  //    索引段字节数不变（2026-11-19 初版就栽在这，表面上像"库变了输出没变"）。
  //    选一个 count 会增加**位数**的 topic 才行，所以这里挑 `格式/编码`：
  //    它原本 1 条，+1 变 2 条仍是 1 位 —— 不够。
  //    正确做法：直接断言 **sha256 变 + 路由表文本变**（文本里数字变了），
  //    字节数不变是允许的，不该当成"索引段变"的必要条件。
  {
    const beforeRoutes = routesOf(first.full)
    const ins = new DatabaseSync(tmpDb)
    try {
      ins.prepare(`INSERT INTO logs(scope,ts,topic,text,status,writer) VALUES(?,?,?,?,?,?)`)
        .run(PROJECT, '2026-11-19T00:00:00.000Z', '开发日志', makeText(120, 999), 'active', 'model')
    } finally {
      ins.close()
    }
    const parts2 = []
    sandbox.renderFromDb(dbStore, projectName, parts2)
    const full2 = sandbox.finishInjection(parts2, config, projectName)
    const segs2 = decompose(parts2)
    const sha2 = crypto.createHash('sha256').update(full2, 'utf8').digest('hex')
    const g2 = (label, key) => segs2.find((s) => s.label === label)?.[key]
    const afterRoutes = routesOf(full2)
    check(
      '负向对照：库加一条流水 → sha256 变化（sha 比较确实在看库内容）',
      sha2 !== first.sha,
    )
    check(
      '负向对照：库加一条流水 → 路由表文本变化（开发日志计数 +1 出现在注入里）',
      afterRoutes !== beforeRoutes &&
        afterRoutes.includes('- 开发日志（') &&
        afterRoutes.includes(`${countActive(blueprint, PROJECT, '开发日志') + 1} 条`),
      `前 ${JSON.stringify(beforeRoutes.split('\n')[0])} → 后 ${JSON.stringify(afterRoutes.split('\n')[0])}`,
    )
    check(
      '负向对照：库变了 → 全局规则正文与使用说明段都纹丝不动（两段与库无关）',
      // ⚠️ 2026-11-19：实验关闭后序号不再追加，policy 正文应当**逐字节不变**。
      //    原来断言「仍在原文+序号窗口内」，现在改为「恒等于第一次渲染的值」——
      //    这才是「与库无关」的真正判据，且不依赖任何写死的基准值。
      g2('## 全局规则', 'bodyBytes') === policyBodies[0] &&
        g2('## 记忆使用说明', 'bytes') === usageSeg[0],
      `policy ${g2('## 全局规则', 'bodyBytes')} / ${policyBodies[0]}；` +
        `usage ${g2('## 记忆使用说明', 'bytes')} / ${usageSeg[0]}`,
    )
  }

  // ---- 9. 清理 + 清理断言（必须在汇总之前计数）----
  cleanup()
  check('临时目录已清理（不留临时库与 policy 副本）', !fs.existsSync(tmpRoot), `仍存在：${tmpRoot}`)

  // ---- 10. 报告 ----
  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - B(String(s))))
  const mark = (vals) => (constant(vals) ? '恒定 ✅' : '变化 ❌')

  console.log(`=== 注入沙箱测试（${RUNS} 次）===\n`)
  console.log(`数据源：${blueprint.source}${blueprint.dbPath ? `（${blueprint.dbPath}，只读）` : '（内置快照）'}`)
  console.log(`真实库条数：profile=${blueprint.totals.profile} rules=${blueprint.totals.rules} ` +
    `logs=${blueprint.totals.logs} archive=${blueprint.totals.archive} emotion=${blueprint.totals.emotion}`)
  console.log(`policy.md：${policySource}（共 ${policyTotalBytes} 字节；本测试只取「给模型的规则」节）`)
  console.log(`临时库：${tmpDb}（已删除）\n`)

  console.log('各段字节数（恒定/变化）：')
  console.log(`  ${pad('标题+hint', 14)} ${pad(prefixBytes, 5)}  恒定 ✅`)
  for (const s of first.segs) {
    const vals = records.map((r) => segOf(r, s.label)?.bytes)
    // ⚠️ `记忆索引` 这一段 `parts` 里是「标题 + 指路句 + 路由表」三样拼在一个
    //    字符串里，所以这里的正文数（471）比 routeTable 本体（343）多 128 字节
    //    —— 多出来的是指路句。两个数都报，避免看的人以为对不上。
    const note = s.label === '## 记忆索引'
      ? `（其中 routeTable 本体 ${indexSegBytes} + 指路句 ${s.bodyBytes - indexSegBytes}）`
      : ''
    console.log(
      `  ${pad(s.label.replace(/^## /, ''), 14)} ${pad(s.bodyBytes, 5)}  ` +
        `（标题 ${s.titleBytes} + 正文 ${note || ''}；整段 ${s.bytes}）  ${mark(vals)}`,
    )
  }
  console.log(`  ${pad('段间分隔符', 14)} ${pad(2 * (first.segs.length - 1), 5)}  恒定 ✅`)
  console.log(`  ${pad('末尾换行', 14)} ${pad(1, 5)}  恒定 ✅`)
  console.log(`  ${'─'.repeat(52)}`)
  console.log(`  ${pad('合计', 14)} ${pad(totals.join(' / '), 5)}  ${totals.length === 1 ? '恒定 ✅' : '变化 ❌'}`)

  console.log('\n关键段与基准对账（⚠️ 快照值会漂，仅供参考，不作判据）：')
  const cmp = (label, got, want, hard) => {
    const ok = got === want
    const tail = ok ? '一致 ✅' : hard ? '不一致 ⚠️（基准值可能已过期）' : '不一致 ⚠️（假数据文本长度）'
    console.log(`  ${pad(label, 14)} ${pad(got, 5)} / 基准 ${pad(want, 5)} ${tail}`)
  }
  // ⚠️ 2026-11-19：实验已关闭，policy 正文不再追加序号。
  //    但**不要**拿写死的 `PROD_SEG.全局规则正文` 判红 —— 那是 policy.md 的快照，
  //    用户改一次规则它就过期（今天踩过）。这里改用现读值。
  //    变量名带 2：上面第 9 段已经用过 `liveRules`，同一模块作用域不能重名。
  const liveRulesPrint = prodGlobalRulesBytes()
  if (liveRulesPrint !== null) {
    console.log(`  ${pad('全局规则正文', 14)} ${pad(policyBodies[0], 5)} / 现读 ${pad(liveRulesPrint, 5)} ` +
      `${policyBodies[0] === liveRulesPrint ? '一致 ✅' : '不一致 ❌'}`)
  } else {
    console.log('  本段不适用：读不到真实 policy.md')
  }
  // routeTable 本体也改成现算（原来用写死的 343，加一个 topic 就过期）
  const prodIdxPrint = prodRouteTableBytes(PROJECT)
  if (prodIdxPrint !== null) {
    console.log(`  ${pad('routeTable 本体', 14)} ${pad(indexSegBytes, 5)} / 现读 ${pad(prodIdxPrint, 5)} ` +
      `${indexSegBytes === prodIdxPrint ? '一致 ✅' : '不一致 ❌'}`)
  } else {
    console.log('  本段不适用：读不到真实库的 routeTable')
  }
  cmp('记忆使用说明段', usageSeg[0], PROD_SEG.记忆使用说明段, true)
  cmp('全局结论正文', factsBodies[0], PROD_SEG.全局结论正文, false)
  cmp('项目结论正文', projBodies[0], PROD_SEG.项目结论正文, false)
  console.log(`  ${pad('总字节', 14)} ${pad(first.total, 5)}（序号已关闭，应与分段账加总相同）`)

  console.log(`\n临时库 routeTable（${indexSegBytes} 字节，与生产同 topic / 同条数）：`)
  for (const line of routesInRender.split('\n')) console.log(`  ${line}`)

  console.log(`\nsha256：${RUNS} 次里出现 ${shas.length} 种` +
    `（实验期期望 = ${RUNS}，即每轮都不同 → 强制 cache miss）`)
  console.log(`首轮 sha256 = ${first.sha}`)
  console.log(`\n断言：PASS=${pass} FAIL=${fail}`)
  if (fail > 0) {
    console.log('\n失败项：')
    for (const b of bad) console.log(`  - ${b}`)
  }
  console.log('')
  console.log('⚠️ 结论边界：本测试只证明「库与 policy.md 不变时，渲染结果逐字节确定」。')
  console.log('   它不能证明「生产环境每轮都注入成功」—— 那要看运行日志（[heartbeat] / lastInjectionBytes）。')
} finally {
  cleanup() // 幂等：正常路径已清理，异常路径在这里兜底
}

if (fail > 0) process.exitCode = 1
