/**
 * 代码完整自检 —— 静态规则集（纯数据 + 扫描函数）。
 *
 * ## 它是什么、不是什么
 *
 * 2026-11-16 第 7 轮用 9 个子代理逐行审了 9736 行，找出 13 CRITICAL + 42 HIGH。
 * 那种审法的成本是 **O(全文件行数)**，而且每次都要重付。
 *
 * 这个文件把那次的**形态类**发现固化成规则：成本 O(规则数)。
 * 但**语义类**问题（「转折加成写在 capScore 之后」「isInside 方向写反」）
 * 脚本判不了 —— 它们列在 `NEEDS_EYES` 里，只打印不判定，留给真需要读代码时。
 *
 * 所以：**脚本不能替代逐行审阅，它把「读 9736 行」降级成「读可疑的 8 处」。**
 *
 * ## 每条规则必须自带失败测试（这是本文件最重要的设计）
 *
 * 本项目反复踩过同一类坑（见 AGENTS.md「已知行为与坑」）：
 *   - `reportBudget` 从 1.0.0 起没有调用点，功能静默失效两天
 *   - 变异测试把 `SKIP` 当通过，那条防线**根本不存在**却报绿
 *   - `check(name, true)` 恒真断言，声称验了两件事实际一件没验
 *
 * 静态规则集是同一类风险的高发区：正则写歪了 → 什么都抓不到 → 输出
 * 「新增 0」→ 看起来一切正常。**所以每条规则必须带两个样本**：
 *
 *   mustCatch  一条「已知有问题」的代码，scan **必须**抓到。抓不到 = 规则失效。
 *   mustMiss   一条「已知没问题」的代码，scan **必须**放过。抓到 = 规则过宽。
 *
 * 跑 `audit-rules.mjs --self-test` 只验规则本身，不扫生产代码。
 * `audit-full.mjs` 每次都会先跑这一步，任何一条规则失效即判红 ——
 * 不允许「规则坏了但输出看起来正常」。
 *
 * ## 命中 ≠ 缺陷
 *
 * 命中只说明「形态可疑」。已经确认安全或已知未修的位置写在
 * `audit-baseline.json`（按**行内容指纹**登记，不用行号 —— 行号会漂移）。
 * 所以输出分三种状态：
 *
 *   🔴 新增    规则命中，基线里没有           → 判红，exit 1
 *   🟡 已知    基线里有对应指纹               → 不判红，只计数
 *   🟢 已修复  基线里有、但本次没命中         → 提示可以移出基线
 *
 * 第三种最有价值：修掉的 bug 会自动从已知列表里消失，不需要人工维护。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO = path.resolve(HERE, '..')

/** 受检的生产文件（相对仓库根）。规则里用这里的键引用。 */
export const FILES = {
  index: 'dsh-fatfishdream-memory/index.js',
  client: 'dsh-fatfishdream-memory/client.js',
  store: 'dsh-fatfishdream-memory/db-store.mjs',
  schema: 'dsh-fatfishdream-memory/db-schema.mjs',
}

// ---------------------------------------------------------------- 扫描工具

/**
 * 逐行正则扫描。pattern **不要带 g 标志**（复用会因 lastIndex 漏行）。
 *
 * 自动带上 `ctx`（前后各 2 行），保证指纹唯一 —— 否则像 `} catch {}`
 * 这种多行完全相同的写法会共用同一个 hash，基线去重就失效了。
 *
 * ## ⚠️ 注释行必须跳过（2026-11-16 第三次踩到）
 *
 * 我在修复代码时习惯在注释里引用**原来的错误写法**，比如：
 *     // 原来写的是 `catch { current = POLICY_TEMPLATE }`，这是错的
 *     // 不能用 rel.startsWith('..') 判越界
 * 这些注释里的字面量会被逐行规则当成真代码，报成「新增命中」——
 * 于是**修好了反而变红**。
 *
 * 已踩过的三次：`isInside` 注释里的 `startsWith('..')`、
 * C2 注释里的 `|| 'active'`、第 9 条注释里的 `catch{}`。
 *
 * 所以：**逐行规则一律跳过纯注释行**。块注释（`*` 开头）也一并跳过。
 * 这不是某条规则的补丁，是所有逐行规则共同的前提。
 */
function scanLines(src, pattern) {
  const out = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 跳过注释行：// 开头、* 开头（块注释内）、/* 开头
    const t = line.trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    if (pattern.test(line)) {
      out.push({ line: i + 1, text: line, ctx: contextAround(lines, i) })
    }
  }
  return out
}

/**
 * 从第 `from` 行向上找最近的 `function xxx(` 起点，返回 { start, name }。
 * 找不到返回 null（不在任何顶层函数里）。
 */
function enclosingFunction(lines, from) {
  for (let i = from; i >= 0; i--) {
    const m = lines[i].match(/^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
    if (m) return { start: i, name: m[1] }
  }
  return null
}

/**
 * 写路由缺少方法白名单 —— 本次审查里覆盖最广的一条。
 *
 * 判据：`await readBody(req)` 所在的 handler 里，**在它之前**有没有
 * `req.method` 判定。没有 → 任何 HTTP 方法都会走到写分支。
 *
 * 为什么致命：`readBody` 对空 body 返回 `{}`，空 body 常被解释成
 * 「删掉某个字段」或「写入空串」。`curl -I`（HEAD）、探活、误发的
 * DELETE 都会命中，而且返回 `ok:true`。
 *
 * 已知实例：`/heartbeat` 的 HEAD 会删掉 policy.md 的收尾语行。
 */
function scanWriteRoutes(src) {
  const lines = src.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!/await\s+readBody\s*\(\s*req\s*\)/.test(lines[i])) continue

    // 向上找 handler 起点
    let start = -1
    for (let k = i; k >= 0 && k > i - 40; k--) {
      if (/handler:\s*async\s*\(/.test(lines[k])) { start = k; break }
    }
    if (start < 0) {
      out.push({
        line: i + 1,
        text: lines[i].trim(),
        route: '(不在已知 handler 结构里)',
        ctx: contextAround(lines, i),
      })
      continue
    }

    // path 通常在 handler 上方的 1~6 行
    let route = '(未识别路径)'
    for (let k = start; k >= 0 && k > start - 8; k--) {
      const m = lines[k].match(/path:\s*'([^']+)'/)
      if (m) { route = m[1]; break }
    }

    const before = lines.slice(start, i).join('\n')
    if (!/req\.method/.test(before)) {
      out.push({ line: i + 1, text: lines[i].trim(), route, ctx: route })
    }
  }
  return out
}

/**
 * SQL 里直接插值 `${table}` 且函数体内没有任何白名单校验。
 *
 * 按**函数粒度**判定，不按行 —— 白名单可能写在函数开头几行，
 * 逐行扫会把它当成「这一行没校验」而误报。
 *
 * 还必须**只认 SQL 上下文**：`${table}` 也常出现在错误消息里
 * （`` throw new Error(`未知的表：${table}`) ``），那不是注入面。
 * 实测漏掉这一条会误报 `purgeByStatus` 的 throw 行。
 */
function scanTableInterpolation(src) {
  const lines = src.split('\n')
  const out = []
  const seenFn = new Set()

  // SQL 上下文判据：该行参与构造 SQL
  const SQL_CTX = /prepare\s*\(|\.exec\s*\(|\b(SELECT|INSERT|UPDATE|DELETE|PRAGMA)\b/i

  for (let i = 0; i < lines.length; i++) {
    if (!/\$\{table\}/.test(lines[i])) continue
    if (!SQL_CTX.test(lines[i])) continue        // 错误消息里的插值不是注入面
    if (/throw\s+new\s+Error/.test(lines[i])) continue

    const fn = enclosingFunction(lines, i)
    if (!fn || seenFn.has(fn.name)) continue
    seenFn.add(fn.name)

    // 函数体：从起点到下一个同/浅缩进的 function 或文件末尾
    let end = lines.length
    for (let k = fn.start + 1; k < lines.length; k++) {
      if (/^\s{0,4}(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(lines[k])) { end = k; break }
    }
    const body = lines.slice(fn.start, end).join('\n')

    // 任一形态的白名单都算通过。
    // 注意 `!==` 也算 —— purgeByStatus 写的是 `table !== 'rules' && table !== 'logs'`，
    // 只认 `===` 会把它误报成「无白名单」（实测）。
    const guarded = /table\s*[!=]==\s*'/.test(body)
      || /assertTable\s*\(/.test(body)
      || /['"]rules['"]\s*,\s*['"]logs['"]/.test(body)
      || /includes\(table\)/.test(body)
    if (guarded) continue

    out.push({ line: i + 1, text: lines[i].trim(), fn: fn.name, ctx: fn.name })
  }
  return out
}

/**
 * archive 去重键不含 sessionId。
 *
 * 键 = `${turn}:${step}` 且 Set 是 apply 级全局 → 两个会话的同一 turn:step
 * 互相压制，被撞的那条**既不进 archive 也不解析标记**，且无任何日志。
 * 子代理实测：2858 条 assistant 只有 1884 个不同键。
 */
function scanDedupeKey(src) {
  const lines = src.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/const\s+messageId\s*=\s*(.+)$/)
    if (!m) continue
    const rhs = m[1]
    // 只要出现任何 session 相关标识就算带上了
    if (/session|sid|sessionKey/i.test(rhs)) continue
    out.push({ line: i + 1, text: lines[i].trim(), ctx: contextAround(lines, i) })
  }
  return out
}

/**
 * 迁移时把 `memory.db` 放进**文本**复制循环。
 *
 * `copyTree` / 文本循环用 utf8 读再写回 → 二进制被破坏。
 * 实测：8,327,168 字节 → 9,435,410 字节，554,311 个 U+FFFD。
 */
function scanMigrateDbInTextLoop(src) {
  const lines = src.split('\n')
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!/for\s*\(\s*const\s+file\s+of\s*\[/.test(lines[i])) continue
    if (!/memory\.db/.test(lines[i])) continue
    out.push({ line: i + 1, text: lines[i].trim(), ctx: contextAround(lines, i) })
  }
  return out
}

// ---------------------------------------------------------------- 语义类清单

/**
 * 脚本判不了、但知道「该看哪里」的语义问题。
 *
 * **只打印，不判定，不判红。** 它省的是「翻文件找位置」，不是「思考」。
 * 每条都注明「怎么确认」，因为这类问题的正确答案往往依赖上下文。
 */
export const NEEDS_EYES = [
  {
    ref: 'H45/H46',
    at: 'dsh-fatfishdream-memory/index.js',
    // 用「调用点」作锚点：定义行与注释行也会命中 capScore，
    // 但要看的是「转折加成乘进去的那一步在封顶之前还是之后」。
    anchor: 'capScore(entry.i',
    what: '情绪「转折加成 ×1.4」是否写在 capScore 之后',
    how:
      '若在封顶之后加成，承诺的封顶失效 —— 实测「不行但很有意思」判成 strong 0.854。' +
      'L1342 的注释明确要求「必须在 capScore 之前乘进去」，核对实际调用是否确实如此。',
  },
  {
    ref: 'C10',
    at: 'dsh-fatfishdream-memory/index.js',
    anchor: 'isInside(nextRoot',
    what: 'isInside 参数方向：应 isInside(root, nextRoot)',
    how: '还有 `isInside(root, dir)` 的调用点方向是对的，可作反证；写反则子目录边界检查永远成立',
  },
  {
    ref: 'C13',
    at: 'dsh-fatfishdream-memory/db-store.mjs',
    anchor: 'COMMIT',
    what: 'renameScope 的校验是否在 COMMIT 之后',
    how: '校验失败只 throw、事务已提交 → 用户按提示回滚会丢掉刚合并的数据',
  },
  {
    ref: 'C12',
    at: 'dsh-fatfishdream-memory/db-store.mjs',
    // syncFts 的定义在 db-schema.mjs，这里要定位的是**调用点**有没有事务
    anchor: 'syncFts(d, table, id, row)',
    what: '「主表写 + syncFts」有无事务包裹',
    how: 'contentless FTS 的 delete 在旧值不匹配时**静默成功** → 一旦失配永久无法靠重试修复',
  },
  {
    ref: 'H35',
    at: 'dsh-fatfishdream-memory/db-store.mjs',
    // 要看的是 FTS 查询本身有没有 ORDER BY，不是全文件第一个 ORDER BY
    anchor: 'FROM logs_fts f',
    what: 'FTS 检索有没有 ORDER BY bm25，还是先 LIMIT 再排序',
    how: '先截断再排序（LIMIT 在 ORDER BY 之前生效）会让最相关的结果被丢掉',
  },
  {
    ref: 'H22/H32',
    at: 'dsh-fatfishdream-memory/index.js',
    anchor: 'const blockRe =',
    what: '收尾语续行跟踪会不会吞掉缩进的子条目；policyTextSync 的小节锚点会不会匹配到含该子串的任意标题',
    how: '实测过：吞标题让 policy.md 从 13850 → 13791 字节、零报错',
  },
  {
    ref: 'C11',
    at: 'dsh-fatfishdream-memory/index.js',
    anchor: 'function copyTree',
    what: 'copyTree 是否用 utf8 文本读写复制任意文件（用户放的图片/压缩包会被破坏）',
    how: '实测 14 字节 PNG → 24 字节；应改为 readFile/writeFile 不带 encoding（原始 Buffer）',
  },
  {
    ref: 'C5',
    at: 'dsh-fatfishdream-memory/index.js',
    anchor: 'function writeHeartbeat',
    what: '读失败时是否用 POLICY_TEMPLATE 整体覆盖 policy.md',
    how: '文件被占用/瞬时 IO 错 → 用户手改的规则一次全丢，且返回 200。对比 readIfExists 只吞 ENOENT',
  },
  {
    ref: 'C6',
    at: 'dsh-fatfishdream-memory/index.js',
    anchor: 'function restoreHeartbeat',
    what: '用户文本是否被当成 String.replace 的替换串（$ 会展开）',
    how: "实测 \"花了$'一百\" 会把文件尾部注入进行内；\"测试$&注入\" 会把旧规则复制进来。替换串必须用 () => text 函数形式",
  },
]

// ---------------------------------------------------------------- 规则集

/**
 * 规则结构：
 *   id        唯一标识，基线按它分组
 *   sev       CRITICAL / HIGH / MEDIUM
 *   ref       对应 01-审查发现全清单.md 的编号
 *   files     要扫哪些文件（FILES 的键）
 *   scan      (src) => [{ line, text, ... }]
 *   mustCatch 一条已知有问题的样本，scan 必须抓到（防规则写歪）
 *   mustMiss  一条已知没问题的样本，scan 必须放过（防规则过宽）
 *   why/fix   人话说明
 */
export const RULES = [
  {
    id: 'write-route-no-method-guard',
    sev: 'CRITICAL',
    ref: 'C3（扩展）',
    files: ['index'],
    scan: scanWriteRoutes,
    mustCatch: [
      "        kind: 'exact',",
      "        path: '/api/dsh-memory/foo',",
      '        handler: async (req, res) => {',
      '          const body = await readBody(req)',
    ].join('\n'),
    mustMiss: [
      '        handler: async (req, res) => {',
      "          if (req.method !== 'POST') return json(res, 405, { ok: false })",
      '          const body = await readBody(req)',
    ].join('\n'),
    why:
      'readBody 对空 body 返回 {}，空 body 常被解释成「写入空串」或「删掉某字段」。' +
      '没有方法白名单时，HEAD/GET/DELETE 都会走到写分支且返回 ok:true。' +
      '实测：curl -I /heartbeat 会删掉 policy.md 的收尾语行。',
    fix: "在 await readBody 之前加 if (req.method !== 'POST') return json(res, 405, { ok: false, error: '...' })",
  },
  {
    id: 'bare-json-parse',
    sev: 'HIGH',
    ref: 'H10',
    files: ['index'],
    scan: (src) => scanLines(src, /(?<!parseJson\()\bJSON\.parse\s*\(/),
    mustCatch: "return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')",
    mustMiss: 'return parseJson(Buffer.concat(chunks).toString("utf8") || "{}")',
    why:
      'Windows 上记事本 / PowerShell 保存的 JSON 常带 UTF-8 BOM，裸 JSON.parse 会抛错，' +
      '外层 catch 把它吞成「无数据」—— 表现为记忆突然读不到，比报错更难查。',
    fix: '改用 parseJson()（硬约束 4）',
  },
  {
    id: 'migrate-db-in-text-loop',
    sev: 'CRITICAL',
    ref: 'C9',
    files: ['index'],
    scan: scanMigrateDbInTextLoop,
    mustCatch: "    for (const file of ['policy.md', 'state.json', 'memory.db']) {",
    mustMiss: "    for (const file of ['policy.md', 'state.json']) {",
    why:
      'memory.db 是二进制，走 utf8 文本循环会被破坏。实测 8,327,168 → 9,435,410 字节、' +
      '554,311 个 U+FFFD。正常路径下 VACUUM INTO 会覆盖，但中途崩溃则新根留下坏库。',
    fix: "从数组里删掉 'memory.db'（库只能由 VACUUM INTO 产生）",
  },
  {
    id: 'dedupe-key-no-session',
    sev: 'CRITICAL',
    ref: 'C4',
    files: ['index'],
    scan: scanDedupeKey,
    mustCatch: "      const messageId = `${payload.turn ?? '?'}:${payload.step ?? '?'}`",
    mustMiss: "      const messageId = `${sessionKey}:${payload.turn ?? '?'}:${payload.step ?? '?'}`",
    why:
      'handledMessageIds 是 apply 级全局 Set，键不含 sessionId → 跨会话互相压制。' +
      '被撞的那条既不进 archive（原文永久丢失）也不解析标记，且无任何日志。',
    fix: '键加上 sessionKey 前缀',
  },
  {
    id: 'dotdot-prefix-false-positive',
    sev: 'HIGH',
    ref: 'H1',
    files: ['index'],
    scan: (src) => scanLines(src, /startsWith\(\s*['"]\.\.['"]\s*\)/),
    mustCatch: "  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))",
    mustMiss: "  return rel === '' || (!/^\\.\\.($|[\\\\/])/.test(rel) && !isAbsolute(rel))",
    why: "rel.startsWith('..') 会把 '..backup' 这类正常子目录判成越界（实测）。",
    fix: "改成 /^\\.\\.($|[\\\\/])/.test(rel)",
  },
  {
    id: 'url-pathname-not-fileURLToPath',
    sev: 'HIGH',
    ref: 'H2',
    files: ['index', 'client'],
    scan: (src) => scanLines(src, /new URL\(import\.meta\.url\)\.pathname/),
    mustCatch: "  const here = dirname(new URL(import.meta.url).pathname.replace(/^\\/([A-Za-z]:)/, '$1'))",
    mustMiss: '  const here = dirname(fileURLToPath(import.meta.url))',
    why:
      'URL.pathname 是百分号编码的。路径含空格或中文时读 package.json 会 ENOENT，' +
      '而外层 catch 吞成空串 → 界面永远不显示版本号，且无报错（实测）。',
    fix: '改用 fileURLToPath(import.meta.url)（node:url）',
  },
  {
    id: 'status-fallback-to-active',
    sev: 'CRITICAL',
    ref: 'C2',
    files: ['index'],
    // 2026-11-16 改进：这个规则原来只匹配 `|| 'active'`，于是修复之后
    // `status: q.get('status') || 'active'` 仍在（默认列表要干净），
    // 配了 `includeAll` 开关就不再是缺陷 —— 规则必须能识别这一点，
    // 否则它会把已修好的代码一直报成新增（假警报会让整个自检失去意义）。
    //
    // 新判据：命中 `|| 'active'`，且**同一处附近没有 includeAll 开关**。
    scan: (src) => {
      const lines = src.split('\n')
      const out = []
      for (let i = 0; i < lines.length; i++) {
        if (!/\|\|\s*['"]active['"]/.test(lines[i])) continue
        // 注释里的字面量不算（说明了「原来写的是 xxx」不等于代码还那样）
        if (/^\s*\/\//.test(lines[i])) continue
        // 看前后 6 行内有没有 includeAll 开关
        const from = Math.max(0, i - 6)
        const to = Math.min(lines.length - 1, i + 6)
        const window = lines.slice(from, to + 1).join('\n')
        if (/includeAll/.test(window)) continue
        out.push({ line: i + 1, text: lines[i], ctx: contextAround(lines, i) })
      }
      return out
    },
    mustCatch: [
      '            const { rows, total } = dbStore.listEntries(table, {',
      "              status: q.get('status') || 'active',",
      '            })',
    ].join('\n'),
    mustMiss: [
      '            const { rows, total } = dbStore.listEntries(table, {',
      "              status: q.get('status') || 'active',",
      "              includeAll: q.get('status') === 'all',",
      '            })',
      '',
      // 注释里提到旧写法也不算
      "            // 原来写的是 status: q.get('status') || 'active'",
      '            const x = 1',
    ].join('\n'),
    why:
      '前端勾选「显示已停用」时不传 status，后端回落成 active → 已删除/停用的条目' +
      '永远列不出来，而删除文案写的是「软删除，可恢复」。',
    fix:
      '加显式的 includeAll 开关（不能靠传 undefined —— listEntries 的 status 是' +
      '默认参数，传 undefined 仍会套用默认值，那样改等于没改）',
  },
  {
    id: 'table-sql-no-whitelist',
    sev: 'HIGH',
    ref: 'H11/H38',
    files: ['store'],
    scan: scanTableInterpolation,
    mustCatch: [
      '  function setReview(table, id, review, note = null) {',
      '    const d = open()',
      '    d.prepare(`UPDATE ${table} SET review=? WHERE id=?`).run(review, id)',
      '    return { ok: true, id }',
      '  }',
    ].join('\n'),
    mustMiss: [
      "  function setTopic(table, id, topic) {",
      "    const t = table === 'logs' ? 'logs' : table === 'rules' ? 'rules' : null",
      '    if (!t) throw new Error("该表没有 topic 列")',
      '    d.prepare(`SELECT x FROM ${t} WHERE id=?`).get(id)',
      '  }',
      '',
      // ★ 反例 2：白名单写成 !== 的形态（purgeByStatus）也必须放过 ——
      //   只认 === 会把它误报成「无白名单」，2026-11-16 实测。
      '  function purgeByStatus(table, statuses) {',
      "    if (table !== 'rules' && table !== 'logs') throw new Error('只支持 rules / logs')",
      '    d.prepare(`SELECT * FROM ${table} WHERE status IN (?)`).all(1)',
      '  }',
      '',
      // ★ 反例 3：错误消息里的 ${table} 不是注入面，必须放过。
      '  function insertInto(table, row) {',
      '    if (table === "profile") { /* … */ }',
      '    else { throw new Error(`未知的表：${table}`) }',
      '  }',
    ].join('\n'),
    why:
      'table 来自 HTTP body，直接拼进 SQL → 子代理实测能读到 sqlite_master、' +
      '改写 rules 全表。purgeByStatus / setTopic / listScopes 有白名单，其余没有。',
    fix: '加 assertTable(table)，白名单 [profile, rules, emotion, logs]，所有拼 ${table} 的 SQL 前调用',
  },
  {
    id: 'empty-catch-swallow',
    sev: 'MEDIUM',
    ref: 'H42/H37 等',
    files: ['index', 'client', 'store', 'schema'],
    scan: (src) => scanLines(src, /catch\s*(?:\([^)]*\))?\s*\{\s*\}/),
    mustCatch: '    try { db.close() } catch {}',
    mustMiss: [
      '    try { db.close() } catch { /* 已关闭 */ }',
      '',
      // ★ 反例 2：注释里引用旧写法不能算命中（2026-11-16 第 9 条踩到）
      '  // 原来是 try{ syncFts }catch{} 这种空吞，已改成事务',
      '  //   catch{}  ← 这里提到但只是说明',
      '  withFtsTransaction(() => {})',
    ].join('\n'),
    why:
      '完全空的 catch 会让失败静默消失。本项目多次因此查不出问题：' +
      'FTS 同步失败被空吞 → 主表改了索引没改；close() 后无条件置 undefined → 句柄泄漏。' +
      '注：其中有些是刻意忽略的（如 wal_checkpoint、已关闭文件的 unlink），登记在基线里。',
    fix: '至少写一句注释说明为什么可以忽略；写操作的空吞应改成记录或抛错',
  },
]

// ---------------------------------------------------------------- 行指纹

/**
 * 基线不用行号，用「归一化行内容 + 上下文标识」的短哈希。
 *
 * 原因：改任何一行都会让后面所有行号漂移，用行号的基线第二天就全废。
 * 内容指纹在代码只是**移动**时保持稳定，只有**改写**同一行才会变 ——
 * 而改写同一行本来就该重新审视。
 *
 * ## ⚠️ 必须带唯一上下文，否则去重机制会静默失效
 *
 * 2026-11-16 实测踩到：9 个写路由的 `await readBody(req)` 行内容**完全相同**，
 * 只按行内容算指纹 → 9 处共用一个 hash。后果是修好其中一处，
 * 另外 8 处会一起显示「已修复」，基线整段失效。
 *
 * 这和 AGENTS.md 里「变异锚点必须唯一，新增代码会抢走老锚点」是同一个病：
 * **锚点不唯一时，工具不报错，只会测错地方。**
 *
 * 所以每个 scan 必须产出 `ctx`（唯一上下文）：
 *   - 路由类用 path（`/api/dsh-memory/entry/update` 天然唯一）
 *   - 函数类用函数名
 *   - 其余用前后各 2 行归一化内容
 */
export function lineHash(ruleId, file, text, ctx = '') {
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ')
  return createHash('sha1')
    .update(`${ruleId}\u0000${file}\u0000${norm(ctx)}\u0000${norm(text)}`)
    .digest('hex')
    .slice(0, 12)
}

/**
 * 给定行号，取前后各 2 行拼成上下文串（给没有天然唯一标识的规则用）。
 */
function contextAround(lines, idx) {
  const from = Math.max(0, idx - 2)
  const to = Math.min(lines.length - 1, idx + 1)
  return lines.slice(from, to + 1).map((s) => s.trim()).join(' ¶ ')
}

// ---------------------------------------------------------------- 执行

/** 跑全部规则，返回 { hits, errors }。errors 非空表示规则本身失效。 */
export function runRules({ selfTest = true } = {}) {
  const hits = []
  const errors = []

  const sources = {}
  for (const [key, rel] of Object.entries(FILES)) {
    try {
      sources[key] = fs.readFileSync(path.join(REPO, rel), 'utf8')
    } catch (e) {
      errors.push(`读不到 ${rel}：${e.message}`)
    }
  }

  for (const rule of RULES) {
    // ① 规则自检：抓不住已知问题 = 规则失效（不允许静默通过）
    if (selfTest) {
      const got = rule.scan(rule.mustCatch)
      if (got.length === 0) {
        errors.push(`${rule.id}：mustCatch 样本没被抓到 → 规则已失效（正则写歪了？）`)
      }
      const over = rule.scan(rule.mustMiss)
      if (over.length > 0) {
        errors.push(`${rule.id}：mustMiss 样本被误抓 → 规则过宽（会制造假警报）`)
      }
    }

    // ② 扫生产代码
    for (const key of rule.files) {
      const src = sources[key]
      if (src === undefined) continue
      const rel = FILES[key]
      let found = []
      try {
        found = rule.scan(src)
      } catch (e) {
        errors.push(`${rule.id} 扫描 ${rel} 时抛错：${e.message}`)
        continue
      }
      for (const h of found) {
        hits.push({
          ruleId: rule.id,
          sev: rule.sev,
          ref: rule.ref,
          file: rel,
          line: h.line,
          text: String(h.text).trim().slice(0, 160),
          extra: h.route ? `路由 ${h.route}` : h.fn ? `函数 ${h.fn}` : '',
          // ctx 保证同一规则的多处命中指纹互不相同（见 lineHash 注释）
          hash: lineHash(rule.id, rel, h.text, h.ctx),
        })
      }
    }
  }

  return { hits, errors }
}

export default { RULES, NEEDS_EYES, runRules, FILES, REPO, lineHash }
