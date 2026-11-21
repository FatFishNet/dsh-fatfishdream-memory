/**
 * 数据库记忆存储层（v2：四张表）。
 *
 * 四张表按**生命周期与访问方式**划分：
 *   profile  用户画像   量极小、人工维护、每轮注入、几乎不变
 *   rules    规则与偏好  量小、人工维护、按项目注入、偶尔改
 *   emotion  情绪记录   自动录入、需复核、不注入
 *   logs     记忆流水   量大、只追加、永不注入、只检索
 *
 * 对外接口保持与 v1 一致，便于 index.js 平滑替换。
 */
import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import {
  openMemoryDb,
  syncFts,
  removeFts,
  FTS_TABLE,
  buildMatchQuery,
  SCHEMA_VERSION,
} from './db-schema.mjs'

const GLOBAL = '__global__'

/**
 * 合法的表名白名单。
 *
 * ## 为什么必须有（2026-11-16 第 7 条修复）
 *
 * 多个函数把 `table` 直接拼进 SQL：`SELECT * FROM ${table} WHERE id=?`。
 * 而 `table` 来自 HTTP body —— 不校验就等于**开放 SQL 注入**。
 * 子代理实测过：传 `sqlite_master` 能读到库结构，
 * 传构造出来的字符串能改写 rules 全表。
 *
 * ## 为什么用白名单而不是转义
 *
 * 表名**不能**用占位符（`?`）绑定 —— SQLite 只允许参数化**值**，不允许标识符。
 * 所以唯一安全的做法就是「只接受枚举内的值」。
 *
 * ## 注意：这是**四张业务表**
 *
 * `archive` 是原文层（v4），走自己的 `appendArchive` / `listArchive`，
 * 不参与检索与注入，也不该被 updateText / setStatus 改写。
 *
 * **但按 id 读一条原文是合法的** —— `selfcheck-archive` 就在用
 * `getById('archive', id)` 验证「2 万字原文没有被截断」。
 * 2026-11-16 我一开始把 archive 整体排除，那条测试立刻变红 ——
 * 说明「一律只允许四张表」这个前提是错的：白名单要按**函数的能力**分，
 * 不能一刀切。所以另开一个更窄的口子 READABLE_EXTRA_TABLES。
 */
const VALID_TABLES = new Set(['profile', 'rules', 'emotion', 'logs'])

/** 只读场景额外允许的表（目前只有 archive）。 */
const READABLE_EXTRA_TABLES = new Set(['archive'])

/**
 * 校验表名，非法就抛错。
 *
 * 抛错而不是返回 false：这些函数的调用方（路由层）都用 try/catch 包着，
 * 抛错会变成 400，用户能看到明确原因。静默返回 undefined 会让
 * 「表名写错」看起来像「条目不存在」，那是最难查的一类。
 *
 * 导出理由：index.js 的路由层也想**提前**校验（在进 store 之前），
 * 这样错误信息能带上「哪个路由、收到什么值」，比 store 层深处抛出来更好排查。
 *
 * @param {string} table
 * @param {{ allowExtra?: boolean }} [opts]
 *        `allowExtra: true` 时额外允许 archive —— **只给只读函数用**。
 */
export function assertTable(table, opts = {}) {
  const inBase = typeof table === 'string' && VALID_TABLES.has(table)
  const inExtra = opts.allowExtra === true && typeof table === 'string' && READABLE_EXTRA_TABLES.has(table)
  if (!inBase && !inExtra) {
    throw new Error(
      `未知的表：${String(table)}（只支持 profile / rules / emotion / logs` +
        `${opts.allowExtra === true ? ' / archive' : ''}）`,
    )
  }
  return table
}


/**
 * 人称规范。
 *
 * 为什么要有：memory 的写者和读者是同一个模型，但 GUI 的读者是人类。
 * 中文的「我」依附于说话人，三方视角一混就读错 ——
 * 「用户称呼我为大肥鱼」在人类读者眼里会变成「用户自己叫大肥鱼」。
 *
 * 规矩：
 *   - 指人类 → 「用户」
 *   - 指模型自己 → 「AI」
 *   - 禁用「我」「你」「本助手」「这个模型」等会随视角漂移的词
 */
export const PERSONA_FORBIDDEN = [
  { word: '我', reason: '「我」会随视角漂移：人类读成自己，模型读成自己', suggest: 'AI' },
  { word: '你', reason: '「你」在记忆文件里没有确定的所指', suggest: '用户' },
  { word: '本助手', reason: '应统一说「AI」', suggest: 'AI' },
  { word: '这个模型', reason: '应统一说「AI」', suggest: 'AI' },
  { word: '咱们', reason: '指代不清', suggest: '用户和 AI' },
]

/**
 * 检查一段文本是否有禁用词。
 *
 * 返回命中列表（可能为空）。注意：
 *   - 只报告，不阻止写入 —— 已有历史数据大量含「我」，硬阻止会让人无法保存
 *   - 引号内、代码里的「我」也算命中，因为简单起见不做语法分析；
 *     宁可多报，让人自己判断
 */
export function checkPersona(text) {
  const s = String(text ?? '')
  const hits = []
  for (const rule of PERSONA_FORBIDDEN) {
    if (s.includes(rule.word)) {
      hits.push({ word: rule.word, reason: rule.reason, suggest: rule.suggest })
    }
  }
  return hits
}

const DEFAULT_BUDGET = { factsBytes: 8000, policyBytes: 8000, projectBytes: 4096 }

const byteLen = (s) => Buffer.byteLength(String(s ?? ''), 'utf8')

/**
 * 写入时间统一用**本地时间**（不带 Z），格式 `YYYY-MM-DDTHH:mm:ss.sss`。
 *
 * 为什么不用 `toISOString()`（2026-11-14 统一）：
 *   库里原本混着两种写法 —— .md 迁移来的 234 条是本地时间无后缀，
 *   新写入的 213 条是 UTC 带 Z，两者字符串比较差 8 小时。
 *   表现：时间筛选（from/to）错 8 小时；模型读到 `03:21Z` 当成本地
 *   03:21 报给用户，实际是 11:21。
 *   现在统一成本地时间，模型读 raw ts 不需要换算。
 *   代价：ts 不再是 TZ 绝对的（换机器/改时区会失真）—— 本机单用户场景可接受。
 */
const nowIso = () => {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`
  )
}

/**
 * 排序用表达式：把 ts 归一成「可比的真实时刻」。
 *
 * ⚠️ 2026-11-14 更新：库里两种 ts 格式**已统一为本地时间（无 Z）**，
 *    下面第 1、2 条描述的「无后缀 vs 带 Z 混存」已经不存在（260 条已迁移）。
 *    保留原文是为了记住「为什么排序最终用 id」—— 那仍然有效：
 *    迁移来的老数据内部有逆序（第 3 条），任何按 ts 的排序都救不了。
 *
 * ## 曾有一个 tsSortKey() 常量，2026-11-15 删除
 *
 * 它做的是「截到年-月-日 时:分」的粗粒度比较（`substr(ts,1,16)`）。
 * 但实际排序用的是下面那个 **TS_ORDER 常量**（id 主排序），这个函数式的
 * 版本从 1.0.0 起就没被调用过，属于重构遗留。
 *
 * 保留它想表达的结论：**只比较到分钟是不够的** ——
 * 同一分钟内的顺序要靠 id 决定，否则 ts 精度差异（有无毫秒）会干扰排序。
 *
 * 以下为历史记录（2026-11-13 排查现场）：
 * 库里 355 条流水的时间戳有三种毛病叠在一起：
 *
 *   1. **两种格式**：#1~#234 无时区后缀（`2026-11-12T03:51:00`），
 *      #235 起带 Z（`2026-11-13T00:35:42.518Z`）。
 *      直接按字符串比较，`00:35Z` 会排到 `02:12` 后面。
 *
 *   2. **SQLite 的 julianday 不解决这个问题**：实测它对无后缀字符串
 *      一律按 UTC 解读（已用 `2026-11-13T00:00:00` 与 `...00:00:00Z`
 *      的 JD 完全相等验证过），所以两种格式还是混在一条时间轴上。
 *
 *   3. **迁移时项目间乱序**：`db-migrate.mjs` 按目录名顺序逐项目导入，
 *      每个项目内部有序但项目之间没有 —— 无后缀区间内部就有 4 处逆序，
 *      最大相差 44.6 小时（#184 2026-11-13T02:12 → #185 2026-11-11T05:34）。
 *
 * 对第 3 条的结论：**老数据的时间本身不可信，不能用它当唯一排序依据**。
 * 而 id 是插入顺序，迁移后新写入的 id 严格递增 —— 它比 ts 可靠得多。
 */

/**
 * 流水页的排序子句。
 *
 * ⚠️ 这里用 **id 主排序**，不是 ts。原因是实测出来的，不是偏好：
 *
 * 库里 355 条流水的时间戳有两种互不可比的写法 ——
 *   #1~#234   无时区后缀 `2026-11-12T03:51:00`（.md 迁移来的）
 *   #235 起   带 Z       `2026-11-13T00:35:42.518Z`
 *
 * 我先后试过三种「按时间排」的写法，全部失败：
 *
 *   1. `ORDER BY ts DESC`（原始写法）
 *      `2026-11-13T02:12` > `2026-11-13T00:35Z` → 最新记录被压到后面。
 *      用户看到的现象就是「流水页顶部停在凌晨」。
 *
 *   2. `ORDER BY julianday(ts)`（试图归一化）
 *      实测 SQLite 对**无后缀字符串一律按 UTC 解读** ——
 *      `julianday('2026-11-13T00:00:00')` 与
 *      `julianday('2026-11-13T00:00:00Z')` 完全相等。
 *      所以两种格式还是压在一条错位的时间轴上，等于没修。
 *      结论已固化为断言：_dbpreview/selfcheck-ts-sort.mjs 第 1 节（探查脚本已移走）。
 *
 *   3. `ORDER BY substr(ts,1,16)`（截到分钟再比）
 *      仍然错：`02:12` 的字符串依旧大于 `00:35`。
 *
 * 而 **id 是插入顺序**：迁移后新写入的 id 严格递增，且全库 355 条
 * id 连续无断号（已断言）。它比 ts 可靠得多 —— 这正是「最近写的在最上面」
 * 这个需求真正要的东西。
 *
 * 顺带一提：老数据内部还有 4 处时间逆序（最大差 44.6 小时），
 * 那是 `db-migrate.mjs` 按目录名逐项目导入造成的，任何排序都救不了。
 * 用 id 排序反而让它们各归其位。
 */
const TS_ORDER = `ts IS NULL, id DESC`

export function createDbStore(dbPath, config = {}, log = () => {}) {
  const budget = { ...DEFAULT_BUDGET, ...config }
  let db
  let closed = false

  const open = () => {
    if (db && !closed) return db
    db = openMemoryDb(DatabaseSync, dbPath)
    closed = false
    return db
  }

  /**
   * 关闭数据库连接。
   *
   * ⚠️ 2026-11-16 修（第 12 条）：原来两个 catch 都是空的，然后**无条件**
   * 把 `db = undefined`。后果：
   *   ① `db.close()` 真的失败时（句柄被别处占用），错误被吞掉，
   *      引用却已清空 —— 那个连接再也关不掉了，**句柄泄漏**；
   *   ② 日志里一个字都没有，将来查「文件被占用」类问题没有线索。
   *
   * 现在的做法：
   *   - checkpoint 失败只记不抛（它本来就是尽力而为，失败不该阻断 close）
   *   - close 失败**保留引用**（让下一次 close 还有机会），并把错误交给 log
   *   - 成功才清空引用
   *
   * 注意：`log` 是 createDbStore 的第三参（默认空函数），
   * 不是全局 logger —— 存储层不依赖 index.js 的作用域。
   */
  const close = () => {
    if (!db) return { ok: true, alreadyClosed: true }

    let checkpointError = null
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch (error) {
      // 尽力而为：checkpoint 失败不该阻断关闭，但必须留痕
      checkpointError = error
      log('db-checkpoint-failed', { message: String(error?.message ?? error) })
    }

    try {
      db.close()
      db = undefined
      closed = true
      return { ok: true, checkpointError: checkpointError === null ? null : String(checkpointError?.message ?? checkpointError) }
    } catch (error) {
      // ⚠️ 关键：**不清空引用** —— 保留它，下一次 close 还能重试。
      // 之前这里无条件 db = undefined，等于放弃了最后一次机会。
      log('db-close-failed', { message: String(error?.message ?? error) })
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /**
   * 按预算拼段，超限时头 40% + 尾 60%。
   *
   * 为什么不用「只保头部」：最新的记忆追加在末尾，
   * 只保头部会让最该看的新结论最先被丢掉。
   *
   * ⚠️ 2026-11-17 修：**单条就超预算**时，原来会整条消失。
   *
   *   head/tail 两个循环都要求 `used + b <= 预算`，若某一条自己就比预算还大，
   *   两个循环都不会收它（head 立刻 break，tail 也立刻 break）→ head 与 tail 全空
   *   → 输出只剩一句「…（省略 1 条）…」。
   *
   *   实测（一条 1400 字的红线规则，projectBytes=4096）：
   *     count=1 truncated=true，注入文本只有 10 字节，「红线红线」出现次数 0
   *   也就是说：**库里唯一的红线规则，注入里一个字都没有**，而模型完全不知道。
   *
   *   修法：收尾时若 head 与 tail 都空（说明被丢的都是「太大」而不是「太多」），
   *   取最长的那条按字符边界截断塞进去 —— 宁可是「截断的一条」，也不要「零条」。
   *   截断用 byteLen 回退到完整字符，避免切断多字节汉字/emoji。
   */
  function joinWithBudget(lines, maxBytes) {
    if (lines.length === 0) return { text: '', truncated: false, count: 0 }
    const full = lines.join('\n')
    if (byteLen(full) <= maxBytes) {
      return { text: full, truncated: false, count: lines.length }
    }
    const headBudget = Math.floor(maxBytes * 0.4)
    const tailBudget = maxBytes - headBudget
    const head = []
    let used = 0
    let i = 0
    for (; i < lines.length; i++) {
      const b = byteLen(lines[i]) + 1
      if (used + b > headBudget) break
      head.push(lines[i])
      used += b
    }
    const tail = []
    used = 0
    let j = lines.length - 1
    for (; j > i; j--) {
      const b = byteLen(lines[j]) + 1
      if (used + b > tailBudget) break
      tail.unshift(lines[j])
      used += b
    }
    const omitted = lines.length - head.length - tail.length

    // ① 正常情况：头尾都收到了一些
    if (head.length > 0 || tail.length > 0) {
      return {
        text: [...head, `…（省略 ${omitted} 条）…`, ...tail].join('\n'),
        truncated: true,
        count: lines.length,
      }
    }

    // ② 全军覆没：说明每条都超过预算。取最长的一条，硬截到 tailBudget。
    //    「最长」而不是「第一条」：最长的那条通常信息量最大（例如红线规则）。
    let longest = lines[0]
    for (const l of lines) {
      if (byteLen(l) > byteLen(longest)) longest = l
    }
    let cut = longest
    // 按完整字符回退，不切断多字节
    while (byteLen(cut) > Math.max(0, tailBudget - 20) && cut.length > 0) {
      cut = cut.slice(0, Math.max(0, cut.length - Math.max(1, Math.ceil(cut.length / 10))))
    }
    const marker = omitted > 0 ? `…（超预算，已截断，共 ${lines.length} 条）…\n` : ''
    return {
      text: marker + cut + (cut.length < longest.length ? '…' : ''),
      truncated: true,
      // ⚠️ emptied 让上层能把文案改准：这不是「按头尾保留」，是「截断了一条」
      emptied: true,
      count: lines.length,
    }
  }

  const usage = (seg, b) => ({
    bytes: byteLen(seg.text),
    budget: b,
    percent: b > 0 ? Math.round((byteLen(seg.text) / b) * 1000) / 10 : 0,
    truncated: seg.truncated,
    nearLimit: b > 0 && byteLen(seg.text) >= b * 0.8,
  })

  // ================================================================ 读取

  /** 全局段：画像 + 全局规则（对应旧 facts 段） */
  function factsTextSync(maxBytes) {
    const b = maxBytes ?? budget.factsBytes
    const d = open()
    const profileRows = d
      .prepare(`SELECT text FROM profile WHERE status='active' AND review IS NOT 'retracted' ORDER BY id ASC`)
      .all()
    const ruleRows = d
      .prepare(`SELECT text FROM rules WHERE scope=? AND kind='pref' AND status='active' AND review IS NOT 'retracted' ORDER BY id ASC`)
      .all(GLOBAL)
    const lines = [...profileRows, ...ruleRows].map((r) => `- ${r.text}`)
    return joinWithBudget(lines, b)
  }

  /** 项目段：红线 + 偏好 + 现状 + 事实 */
  function projectTextSync(projectName, maxBytes) {
    if (!projectName) return { text: '', truncated: false, count: 0 }
    const b = maxBytes ?? budget.projectBytes
    const d = open()
    const rows = d
      .prepare(
        `SELECT kind,text FROM rules
         WHERE scope=? AND status='active' AND review IS NOT 'retracted'
         ORDER BY CASE kind WHEN 'redline' THEN 0 WHEN 'pref' THEN 1 WHEN 'state' THEN 2 ELSE 3 END, id ASC`,
      )
      .all(projectName)
    return joinWithBudget(rows.map((r) => `- ${r.text}`), b)
  }

  /**
   * 路由表：告诉模型「记忆里有什么主题、去查哪个词」。
   * 用 GROUP BY 现算而不是存储 —— 存下来会过期，聚合永远准确。
   */
  function routeTable(projectName) {
    const d = open()
    // ⚠️ 2026-11-19 修（TODO 待办 M）：**rules 侧必须排除 `review='retracted'`**。
    //
    // ## 改了什么
    //
    // 原来 rules 与 logs 用的都是同一句 `WHERE status='active' AND topic IS NOT NULL`。
    // 但这两张表的列**不一样**：
    //   · `rules` 有 `review` 列（用户在 GUI 里可以「撤销」一条规则 → review='retracted'）
    //   · `logs` **没有** `review` 列（流水不存在「撤销」这个动作）
    //
    // 所以只在 rules 那段加 `review IS NOT 'retracted'`，**logs 段原样不动**。
    // 往 logs 上加这个条件会直接报 `no such column: review`。
    //
    // ## 为什么必须修
    //
    // 历史修复 `search()`（2026-11-17 第 L 条）加了同一个条件，理由是
    // 「用户明确撤销的规则仍被当有效结论检索给模型」。`routeTable` 是**同一类通道**
    // —— 它告诉模型「记忆里有哪些主题、各多少条」，撤销的规则仍然算在数字里，
    // 等于**用户撤销了但索引还在替他数**。这是 L 的漏网之鱼。
    //
    // ## 判据
    //
    // 造一条 `review='retracted'` 的 rules 记录，`routeTable` 的计数**不应**包含它；
    // 同时造一条 `status='deleted'` 的，也不应包含（原有行为，别改坏）。
    const rows = d
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
    if (rows.length === 0) return ''
    return rows.map((r) => `- ${r.topic}（${r.n} 条）`).join('\n')
  }

  // ================================================================ 写入

  /**
   * 往指定表插一条。
   * ts 默认当前时间 —— 每条记忆都该知道自己什么时候进来的。
   */
  /**
   * 在事务里跑一段「主表写 + FTS 同步」，失败整体回滚。
   *
   * ## 为什么需要（2026-11-16 第 9 条）
   *
   * 原来的 `insertInto` 是「先 INSERT 主表 → 再 syncFts」两步裸跑。
   * 第二步炸了（索引写失败、磁盘满、FTS 结构问题），**主表那行已经落库**，
   * 于是这条记忆：
   *   - 能按 id 查到（`getById` 走主表）
   *   - 但**永远搜不到**（索引里没有它）
   * 反过来在更新路径上，主表改了、索引没改 → 搜出来的是旧内容。
   *
   * 实测（临时库构造）：不加事务时主表多一行、索引没有；加事务后整体回滚。
   *
   * ## 为什么用 BEGIN IMMEDIATE
   *
   * 默认的 `BEGIN` 是 deferred —— 事务在**第一次写**时才真正拿写锁。
   * 而这里一进事务就立刻要写，用 IMMEDIATE 提前拿锁，
   * 避免「拿到锁之前别人已经写了、然后自己 busy」的多余重试。
   *
   * ## 嵌套保护
   *
   * SQLite 不支持嵌套 BEGIN。这个函数只被最外层写操作调用，
   * 但为了将来安全，用 `inTransaction` 标记防重入 —— 已经在事务里就**不再开新的**，
   * 由外层统一提交/回滚。
   */
  let inTransaction = false
  function withFtsTransaction(fn) {
    const d = open()
    if (inTransaction) {
      // 已在外层事务里：直接执行，让外层负责提交/回滚
      return fn(d)
    }
    d.exec('BEGIN IMMEDIATE')
    inTransaction = true
    try {
      const result = fn(d)
      d.exec('COMMIT')
      return result
    } catch (error) {
      try { d.exec('ROLLBACK') } catch { /* 回滚失败也没别的办法了 */ }
      throw error
    } finally {
      inTransaction = false
    }
  }

  function insertInto(table, row) {
    return withFtsTransaction((d) => {
      const ts = row.ts ?? nowIso()
      let id
      if (table === 'profile') {
        const r = d
          .prepare(`INSERT INTO profile(ts,topic,text,status,writer,updated) VALUES(?,?,?,?,?,?)`)
          .run(ts, row.topic ?? null, row.text, row.status ?? 'active', row.writer ?? 'model', nowIso())
        id = Number(r.lastInsertRowid)
      } else if (table === 'rules') {
        const r = d
          .prepare(`INSERT INTO rules(scope,kind,ts,topic,text,status,writer,updated) VALUES(?,?,?,?,?,?,?,?)`)
          .run(row.scope ?? GLOBAL, row.kind ?? 'pref', ts, row.topic ?? null, row.text,
               row.status ?? 'active', row.writer ?? 'model', nowIso())
        id = Number(r.lastInsertRowid)
      } else if (table === 'emotion') {
        const r = d
          .prepare(`INSERT INTO emotion(ts,cls,quote,evidence,confidence,score,text,status,writer) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(ts, row.cls ?? null, row.quote ?? row.text, row.evidence ?? null,
               row.confidence ?? null, row.score ?? null, row.text,
               row.status ?? 'active', row.writer ?? 'plugin')
        id = Number(r.lastInsertRowid)
      } else if (table === 'logs') {
        const r = d
          .prepare(`INSERT INTO logs(scope,ts,topic,summary,keywords,text,status,writer) VALUES(?,?,?,?,?,?,?,?)`)
          .run(row.scope ?? GLOBAL, ts, row.topic ?? null, row.summary ?? null,
               row.keywords ?? null, row.text, row.status ?? 'active', row.writer ?? 'model')
        id = Number(r.lastInsertRowid)
      } else {
        throw new Error(`未知的表：${table}`)
      }
      syncFts(d, table, id, row)
      return id
    })
  }

  /**
   * 追加流水。
   *
   * v3 起多两个可选字段（三层记忆的 L1 层）：
   *   summary  ≤35 字，给以后的自己「一眼判断这条相不相关」
   *   keywords 用 `｜` 分隔的技术名词，用于精确命中
   * 两者都可以为空 —— 没写摘要的流水会在检索时用正文前 80 字兜底，
   * 但那时才截断会截在句子中间、丢技术名词，所以写入时就该写。
   *
   * 第三参兼容旧的「直接传 topic 字符串」写法，避免测试脚本一夜全红。
   */
  function appendLog(projectName, content, opts = {}) {
    const o = typeof opts === 'string' ? { topic: opts } : (opts ?? {})
    const body = String(content ?? '').trim()
    if (!body) throw new Error('内容为空')
    const scope = projectName || GLOBAL
    const id = insertInto('logs', {
      scope,
      text: body,
      topic: o.topic ?? null,
      summary: o.summary ?? null,
      keywords: o.keywords ?? null,
    })
    return { id, project: scope, bytes: byteLen(body), summary: o.summary ?? null }
  }

  /** 追加全局偏好（进 rules，scope=__global__） */
  function appendFact(content) {
    const body = String(content ?? '').trim()
    if (!body) throw new Error('内容为空')
    const d = open()
    const dup = d.prepare(`SELECT id FROM rules WHERE scope=? AND text=? LIMIT 1`).get(GLOBAL, body)
    const usageOf = () => usage(factsTextSync(), budget.factsBytes)
    if (dup) return { written: false, reason: 'duplicate', added: 0, usage: usageOf() }
    insertInto('rules', { scope: GLOBAL, kind: 'pref', text: body })
    return { written: true, added: 1, usage: usageOf() }
  }

  /** 追加项目规则 */
  function appendProjectNote(projectName, content, kind = 'pref') {
    const body = String(content ?? '').trim()
    if (!body) throw new Error('内容为空')
    if (!projectName) throw new Error('无法确定项目')
    const d = open()
    const dup = d.prepare(`SELECT id FROM rules WHERE scope=? AND text=? LIMIT 1`).get(projectName, body)
    const usageOf = () => usage(projectTextSync(projectName), budget.projectBytes)
    if (dup) {
      return { written: false, reason: 'duplicate', project: projectName, added: 0, usage: usageOf() }
    }
    insertInto('rules', { scope: projectName, kind, text: body })
    return { written: true, project: projectName, added: 1, usage: usageOf() }
  }

  /** 情绪自动录入（独立表、writer=plugin、需复核） */
  function recordEmotion({ kind, evidence, text, confidence = 'high', score }) {
    const quote = String(text ?? '').trim()
    if (!quote) throw new Error('内容为空')
    const detail = [evidence, confidence, score != null ? String(score) : null].filter(Boolean).join('·')
    const body = `用户表达${kind}（${detail}）：${quote}`
    const d = open()
    const dup = d.prepare(`SELECT id FROM emotion WHERE text=? LIMIT 1`).get(body)
    if (dup) return { written: false, reason: 'duplicate' }
    insertInto('emotion', {
      cls: kind, quote, evidence: evidence ?? null, confidence,
      score: score ?? null, text: body,
    })
    return { written: true }
  }

  /** 新增一条（GUI 用）：按传入的 kind 决定进哪张表 */
  function createEntry({ scope, kind = 'pref', text, table }) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('内容为空')
    // 人称规范检查：只报警告，不阻止写入
    const persona = checkPersona(body)
    // 显式表名优先；否则按 scope/kind 推断
    let target = table
    if (!target) {
      if (kind === 'emotion') target = 'emotion'
      else if (kind === 'log') target = 'logs'
      else if (kind === 'profile' || (!scope || scope === GLOBAL) && kind === 'pref' && !scope) target = 'profile'
      else target = 'rules'
    }
    if (target === 'profile') {
      const d = open()
      const dup = d.prepare(`SELECT id FROM profile WHERE text=? LIMIT 1`).get(body)
      if (dup) return { ok: true, id: dup.id, duplicate: true, table: 'profile', persona }
      const id = insertInto('profile', { text: body, topic: kind === 'profile' ? null : kind })
      return { ok: true, id, duplicate: false, table: 'profile', persona }
    }
    if (target === 'rules') {
      const s = String(scope ?? '').trim()
      if (!s) throw new Error('需要 scope')
      const d = open()
      const dup = d.prepare(`SELECT id FROM rules WHERE scope=? AND text=? LIMIT 1`).get(s, body)
      if (dup) return { ok: true, id: dup.id, duplicate: true, table: 'rules', persona }
      const id = insertInto('rules', { scope: s, kind, text: body })
      return { ok: true, id, duplicate: false, table: 'rules', persona }
    }
    throw new Error(`不支持直接创建 ${target} 类条目`)
  }

  // ================================================================ 维护

  /** 通用的「改文本」。先查在哪张表，再改，再同步 FTS。 */
  function updateText(table, id, text) {
    assertTable(table) // 同 setStatus：table 拼进 SQL
    const d = open()
    // logs 多两列（v3）。其他表没有，硬查会抛 no such column。
    const row = table === 'logs'
      ? d.prepare(`SELECT text,topic,summary,keywords FROM logs WHERE id=?`).get(id)
      : d.prepare(`SELECT text,topic FROM ${table} WHERE id=?`).get(id)
    if (!row) throw new Error('条目不存在')
    const persona = checkPersona(text)

    // ⚠️ 各表列不同：logs 没有 review / updated。
    // 2026-11-13 修：原来无条件 `SET text=?, review='edited', updated=?`，
    // 在 logs 上会抛 `no such column: review` —— 表现为「改流水正文失败」，
    // 而 GUI 只显示一个笼统错误，很难看出是列不存在的结构性原因。
    // 这里按实际存在的列拼 SQL。
    const cols = new Set(
      d.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
    )
    const sets = ['text=?']
    const params = [text]
    // 流水改正文时，若 summary 仍是「正文前 40 字」的旧兜底，就跟着刷新 ——
    // 否则改完正文，列表里的摘要还是改之前的，看起来像没保存。
    // 用户/模型**手写过**的 summary 不属于兜底，保持不动。
    let nextSummary = row.summary ?? null
    if (cols.has('summary')) {
      const wasFallback = nextSummary === null || nextSummary === ''
        || nextSummary === String(row.text ?? '').slice(0, 40)
      if (wasFallback) {
        nextSummary = String(text).slice(0, 40)
        sets.push('summary=?')
        params.push(nextSummary)
      }
    }
    if (cols.has('review')) {
      sets.push("review='edited'")
    }
    if (cols.has('updated')) {
      sets.push('updated=?')
      params.push(nowIso())
    }
    params.push(id)

    // 2026-11-16（第 9 条）：主表 UPDATE 与 FTS 同步必须同事务。
    // 不加事务时，若 syncFts 失败 → 主表已是新内容、索引还是旧内容，
    // 表现为「改完正文，搜出来的还是旧的那句」，且重试也修不回来
    //（contentless FTS 用旧值 delete 时若值不匹配会**静默失败**，见 syncFts 注释）。
    withFtsTransaction((dd) => {
      dd.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id=?`).run(...params)
      syncFts(dd, table, id,
        { text, topic: row.topic, summary: nextSummary, keywords: row.keywords }, row)
    })
    return { ok: true, id, persona }
  }

  /**
   * 停用 / 启用 / 软删。
   * stale  = 当前不用了（可能过阵子又想启用）
   * deleted = 记错了，当它没发生
   */
  function setStatus(table, id, status) {
    assertTable(table) // table 拼进 SQL，必须先校验（见 assertTable 注释）
    const allowed = new Set(['active', 'stale', 'deleted'])
    if (!allowed.has(status)) throw new Error(`不支持的状态：${status}`)
    const d = open()
    const row = d.prepare(`SELECT status FROM ${table} WHERE id=?`).get(id)
    if (!row) throw new Error('条目不存在')
    d.prepare(`UPDATE ${table} SET status=? WHERE id=?`).run(status, id)
    return { ok: true, id, from: row.status, to: status }
  }

  function softDelete(table, id) {
    return setStatus(table, id, 'deleted')
  }

  /**
   * 物理删除某表里指定状态的条目（2026-11-16 新增）。
   *
   * ## 为什么要它
   *
   * 软删除（`status='deleted'`）只是让条目不再注入、不再检索，**行还在库里**。
   * 实测 `rules` 攒了 125 条 deleted + 5 条 stale，占该表 136 条里的 130 条 ——
   * 库体积一直背着这些死数据。用户要求彻底清掉。
   *
   * ## 为什么不能直接 `DELETE FROM rules WHERE status='deleted'`
   *
   * 这张表挂了 FTS5 外部内容索引（`rules_fts`）。**只删主表不同步 FTS** 会留下
   * 孤立索引行：搜「已删内容」仍能命中，点进去 404 —— 而且是静默的。
   * `removeFts()` 的第三个参数必须是**完整的那一行**：FTS5 的 'delete' 指令
   * 要靠原值反查索引项，传空对象会删不掉（这就是它默认 row=null 的坑）。
   * 所以这里先取出整行，再逐条 removeFts + DELETE。
   *
   * ## 为什么整体包在事务里
   *
   * 逐条删 130 行，中途失败会留下「主表删了、FTS 没删」的半状态。
   *
   * @param {string} table - 'rules' | 'logs'（只有这两张有 status 列）
   * @param {string[]} statuses - 要物理删除的状态，如 ['deleted','stale']
   * @param {{dryRun?: boolean}} opts - dryRun 只报数不动库
   */
  function purgeByStatus(table, statuses, opts = {}) {
    if (table !== 'rules' && table !== 'logs') {
      throw new Error(`只支持 rules / logs（有 status 列的表），收到：${table}`)
    }
    const list = Array.isArray(statuses) ? statuses.filter((s) => typeof s === 'string') : []
    if (list.length === 0) throw new Error('statuses 不能为空')
    const allowed = new Set(['active', 'stale', 'deleted'])
    for (const s of list) {
      if (!allowed.has(s)) throw new Error(`不支持的状态：${s}`)
    }
    // 硬护栏：绝不接受 active —— 那是「所有能用的记忆」，一次手滑就清空全部。
    // 这个函数的存在意义就是清垃圾，不是清数据。
    if (list.includes('active')) {
      throw new Error('拒绝删除 active 条目：本函数只用于清理 stale / deleted 垃圾')
    }

    const d = open()
    const ph = list.map(() => '?').join(',')
    const rows = d.prepare(`SELECT * FROM ${table} WHERE status IN (${ph})`).all(...list)
    if (opts.dryRun) {
      const byStatus = {}
      for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
      return { ok: true, dryRun: true, table, wouldDelete: rows.length, byStatus }
    }
    if (rows.length === 0) return { ok: true, table, deleted: 0, byStatus: {} }

    const ftsTable = FTS_TABLE[table]
    let deleted = 0
    d.exec('BEGIN')
    try {
      for (const row of rows) {
        if (ftsTable) removeFts(d, table, row.id, row)
        d.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.id)
        deleted += 1
      }
      d.exec('COMMIT')
    } catch (error) {
      try {
        d.exec('ROLLBACK')
      } catch {
        /* 回滚失败就让它抛出去，别掩盖原始错误 */
      }
      throw error
    }
    const byStatus = {}
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
    // 主表删完立刻让缓存失效，否则 stats-breakdown 还会返回旧数字
    invalidateBreakdown()
    return { ok: true, table, deleted, byStatus }
  }

  /**
   * 只改 topic，不动正文。
   *
   * 为什么单独一个方法：2026-11-13 补历史遗留的空 topic 时，
   * 需要批量给 156 条打标签但**不能碰正文**（updateText 会同时标
   * review='edited'，那会污染「用户改过」的语义）。
   * 也不走 `write`/`pwsh` 直改库 —— 那是硬约束 5 明令禁止的。
   *
   * 安全性：只允许改 topic 这一列；topic 传 null/'' 视为清空。
   * 不做正则批量，调用方必须给明确的 id。
   */
  function setTopic(table, id, topic) {
    // 只允许有 topic 列的两张表
    const t = table === 'logs' ? 'logs' : table === 'rules' ? 'rules' : null
    if (!t) throw new Error(`该表没有 topic 列：${table}`)
    const d = open()
    const sel = t === 'logs' ? 'topic,text,summary,keywords' : 'topic,text'
    const row = d.prepare(`SELECT ${sel} FROM ${t} WHERE id=?`).get(id)
    if (!row) throw new Error('条目不存在')
    const next = typeof topic === 'string' && topic.trim() !== '' ? topic.trim() : null
    // ⚠️ 2026-11-16（第 9 条）：原来是「UPDATE 主表 → try{ syncFts }catch{}」。
    //
    // 那个**空 catch** 是这条 bug 最坏的部分：FTS 同步失败被完全吞掉，
    // topic 写进去了、索引还是旧的 → 按 topic 搜永远找不到刚改的那条，
    // 而且日志里没有任何线索。**重试也没用** —— 旧值已经变了，
    // contentless FTS 用不匹配的旧值 delete 是静默失败（实测确认）。
    //
    // 现在：同事务 + 失败向上抛。
    // 宁可让这次改 topic 报错（用户看得见、可以重试），
    // 也不要留下一个「看起来改成功、实际搜不到」的状态。
    withFtsTransaction((dd) => {
      dd.prepare(`UPDATE ${t} SET topic=? WHERE id=?`).run(next, id)
      const fresh = dd.prepare(`SELECT ${sel} FROM ${t} WHERE id=?`).get(id)
      syncFts(dd, t, id, fresh, row)
    })
    return { ok: true, id, from: row.topic ?? null, to: next }
  }

  function setReview(table, id, review, note = null) {
    assertTable(table) // 原来这里完全没有校验，子代理实测可改写全表
    const d = open()
    d.prepare(`UPDATE ${table} SET review=?, review_note=? WHERE id=?`).run(review, note, id)
    return { ok: true, id }
  }

  // ============================================================
  // 工作区（scope）迁移
  // ============================================================

  /** 有 scope 列的表。profile / emotion 是「用户这个人」，不分项目，迁移不碰。 */
  const SCOPE_TABLES = ['rules', 'logs', 'archive']

  /**
   * 采一份 scope 的数据量快照 —— **迁移前与迁移后都用这一个函数**。
   *
   * ## 为什么要快照而不是只数条数
   *
   * 用户 2026-11-15 的要求：迁移前先整理「待迁移区域的数据量」，
   * 迁移后报告「与迁移前是否一致」。
   *
   * 只数条数是不够的 —— 若 UPDATE 漏掉一批、又误伤另一批，总量可能碰巧不变。
   * 所以每张表同时记 `minId` / `maxId`：**行集合没变，头尾就没理由变**。
   *
   * ## 为什么给两套数字（all / active）
   *
   * 同一个 scope 在不同入口能读出三个数（2026-11-15 实测 SoftTest：
   * `dryRun` 说 162、`/state` 的 byScope 说 42、`listScopes('rules')` 说没有）：
   *   - `countScope` 原来不按 status 过滤 → 把已删条目也算进去
   *   - `byScope` 只数 active 的 rules + logs
   *   - `archive` 压根不进任何统计
   * 三个数都有各自的道理，但用户点「预览影响」时只看到一个，必然误判。
   * 所以这里一次给全，让调用方把口径摊开说清楚。
   *
   * ⚠️ `archive` 表**没有 status 列**（原文层一条不落，没有「停用」概念），
   * 所以它的 `all` 与 `active` 恒等。这不是算错，调用方要照实展示。
   *
   * @param {string} scope 要采样的工作区名
   * @returns {{scope:string, tables:Record<string,{all:number,active:number,minId:number|null,maxId:number|null}>, total:{all:number,active:number}}}
   */
  function snapshotScope(scope) {
    const s = String(scope ?? '')
    const d = open()
    const tables = {}
    let allTotal = 0
    let activeTotal = 0

    for (const t of SCOPE_TABLES) {
      // archive 没有 status 列，只有它不能被 status='active' 过滤
      const hasStatus = t !== 'archive'
      const row = hasStatus
        ? d
            .prepare(
              `SELECT COUNT(*) all_, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) act, MIN(id) mn, MAX(id) mx
               FROM ${t} WHERE scope=?`,
            )
            .get(s)
        : d
            .prepare(`SELECT COUNT(*) all_, COUNT(*) act, MIN(id) mn, MAX(id) mx FROM ${t} WHERE scope=?`)
            .get(s)

      const all = Number(row?.all_ ?? 0)
      // 👆 无行时 SQLite 的 SUM 返回 NULL，不能直接转数字
      const active = hasStatus ? Number(row?.act ?? 0) : all
      tables[t] = {
        all,
        active,
        minId: all > 0 ? Number(row?.mn) : null,
        maxId: all > 0 ? Number(row?.mx) : null,
      }
      allTotal += all
      activeTotal += active
    }

    return { scope: s, tables, total: { all: allTotal, active: activeTotal } }
  }

  /** 数一个 scope 在某表里有多少行（干跑用，单表版） */
  function countScope(table, scope, { activeOnly = false } = {}) {
    const t = String(table ?? '')
    if (!SCOPE_TABLES.includes(t)) throw new Error(`该表没有 scope 列：${t}`)
    // archive 没有 status 列，activeOnly 对它无效（原文层不分启用/停用）
    const where = activeOnly && t !== 'archive' ? `scope=? AND status='active'` : `scope=?`
    return open().prepare(`SELECT COUNT(*) c FROM ${t} WHERE ${where}`).get(String(scope ?? '')).c
  }

  /**
   * 把一个 scope 的全部数据改名成另一个（工作区改名用）。
   *
   * 2026-11-15 加：用户把工作区 `干杂活` 改名成 `SoftTest`，
   * 但库里 129 条数据仍挂在旧 scope 上 —— 查新名字一条都查不到。
   *
   * **为什么只 UPDATE 就够了（不需要同步 FTS）**：
   * `scope` **不参与任何 FTS 索引**（看 FTS_COLUMNS：只有 text / topic / seg /
   * summary / keywords），所以改 scope 不影响检索，也不存在索引失配。
   * 这点已核对 db-schema.mjs 的 FTS_COLUMNS 与建表语句，不是推测。
   *
   * ## 迁移内建的「前后一致性」校验（2026-11-15 用户要求）
   *
   * 用户原话：「迁移前先整理待迁移区域的数据量，迁移后报告与迁移前是否一致」。
   * 所以这里不是「改完返回 ok」而是**自己验一遍**：三张表各比对三项，
   * 任何一项不符就 **ROLLBACK** 并把差异原样报出来。
   *
   * ## 合并（allowMerge）—— 2026-11-15 用户追加要求
   *
   * 用户原话：「这里允许合并，新建工作区然后再去迁移记忆的情况是很常见的」。
   *
   * 场景：用户先建了工作区「大白饭」，在里面聊了几句（产生了原文），
   * 然后想把旧工作区「SoftTest」的记忆并进来。此时目标区域**必然非空**，
   * 如果一律拒绝，这条路就走不通。
   *
   * 所以：
   *   - 默认（allowMerge=false）仍然拒绝，保持 API 的保守语义
   *   - `allowMerge: true` 时合并：`to` 原有的行**原样保留**，`from` 的行改挂过去
   *   - **校验公式随合并调整**（这是最容易写错的地方）：
   *       ① 条数：迁后 to = 迁前 from + 迁前 to
   *       ③ 行集合：迁后 to 的 id 跨度 = 两者并集。
   *          即 min=min(from.min, to.min)、max=max(from.max, to.max)。
   *          注意目标原先为空时其 min/max 是 null，要单独处理。
   *
   * **合并后两批数据无法再拆开** —— 这是用户已知的取舍（备份是唯一退路），
   * 所以 GUI 必须在预览里把「会合并多少、合并后一共多少」说清楚。
   *
   * @param {string} from 旧 scope
   * @param {string} to   新 scope
   * @param {{allowMerge?: boolean, force?: boolean}} [options]
   *   allowMerge=true  目标已有数据时合并而非拒绝
   *   force=true       跳过占用检查（仅供自检脚本模拟）
   * @returns {{ok:boolean, from:string, to:string, merged:boolean, tables:Record<string,number>, total:number,
   *            before:object, targetBefore:object, after:object, verify:object}}
   */
  function renameScope(from, to, options = {}) {
    const a = String(from ?? '').trim()
    const b = String(to ?? '').trim()
    if (a === '' || b === '') throw new Error('需要 from 与 to')
    if (a === b) throw new Error('新旧名字相同')
    // 全局 scope 是保留值，改名会破坏「跨项目」语义
    if (a === GLOBAL || b === GLOBAL) throw new Error(`${GLOBAL} 是保留值，不能改名`)

    const d = open()

    // ---- 迁前：待迁移区域的数据量 ----
    const before = snapshotScope(a)
    if (before.total.all === 0) {
      throw new Error(`工作区「${a}」没有任何数据，无需迁移（检查名字是否写错）`)
    }

    // ---- 迁前：目标区域的数据量（合并时要用它算校验基线）----
    const targetBefore = snapshotScope(b)

    // ---- 目标占用检查：默认拒绝，allowMerge 时合并 ----
    let merged = false
    if (options.force !== true) {
      const hasTarget = targetBefore.total.all > 0
      if (hasTarget && options.allowMerge !== true) {
        const detail = SCOPE_TABLES.filter((t) => targetBefore.tables[t].all > 0)
          .map((t) => `${t} ${targetBefore.tables[t].all} 行`)
          .join('、')
        throw new Error(
          `目标工作区「${b}」已有数据（${detail}）。` +
            `如需把两者合并，请勾选「合并到目标工作区」后重试。`,
        )
      }
      merged = hasTarget
    }

    // ---- 事务：三张表一起改，任一失败整体回滚 ----
    //
    // 原来没有事务：逐表 UPDATE，第 2 张表失败就只改了一半，
    // 而界面上还报「迁移完成」。这是 2026-11-15 审出来的最危险的一条。
    const tables = {}
    let total = 0
    d.exec('BEGIN')
    try {
      for (const t of SCOPE_TABLES) {
        const n = before.tables[t].all
        if (n > 0) d.prepare(`UPDATE ${t} SET scope=? WHERE scope=?`).run(b, a)
        tables[t] = n
        total += n
      }
      d.exec('COMMIT')
    } catch (error) {
      d.exec('ROLLBACK')
      throw new Error(`迁移失败已回滚（数据未变）：${error?.message ?? error}`)
    }

    // ---- 迁后：同一函数再采一次，逐项比对 ----
    const afterNew = snapshotScope(b)
    const afterOld = snapshotScope(a)

    const checks = []
    const fail = []
    for (const t of SCOPE_TABLES) {
      const wantFrom = before.tables[t]
      const wantTarget = targetBefore.tables[t]
      const gotNew = afterNew.tables[t]
      const gotOld = afterOld.tables[t]

      // ① 条数：非合并 = from 的；合并 = from + 目标原有的
      const wantCount = merged ? wantFrom.all + wantTarget.all : wantFrom.all
      const countOk = gotNew.all === wantCount
      checks.push({
        table: t,
        check: merged ? 'count-merged' : 'count',
        want: wantCount,
        got: gotNew.all,
        ok: countOk,
        detail: merged ? `${wantFrom.all}（迁入）+ ${wantTarget.all}（原有）` : undefined,
      })
      if (!countOk) {
        fail.push(
          merged
            ? `${t} 合并后条数不符：期望 ${wantFrom.all}+${wantTarget.all}=${wantCount}，实际 ${gotNew.all}`
            : `${t} 条数不符：迁前 ${wantCount} → 迁后 ${gotNew.all}`,
        )
      }

      // ② 旧区归零
      const emptyOk = gotOld.all === 0
      checks.push({ table: t, check: 'old-empty', want: 0, got: gotOld.all, ok: emptyOk })
      if (!emptyOk) fail.push(`${t} 旧区残留 ${gotOld.all} 条`)

      // ③ 行集合
      //    非合并：必须与迁前完全一致
      //    合并：必须是两者的并集（目标原为空时就是迁前 from 的）
      const spans = [wantFrom, wantTarget].filter((x) => x.all > 0 && x.minId !== null)
      const wantMin = spans.length > 0 ? Math.min(...spans.map((x) => x.minId)) : null
      const wantMax = spans.length > 0 ? Math.max(...spans.map((x) => x.maxId)) : null
      const idsOk = gotNew.minId === wantMin && gotNew.maxId === wantMax
      checks.push({
        table: t,
        check: merged ? 'id-range-merged' : 'id-range',
        want: `${wantMin}-${wantMax}`,
        got: `${gotNew.minId}-${gotNew.maxId}`,
        ok: idsOk,
      })
      if (!idsOk) {
        fail.push(`${t} 行集合变了：期望 ${wantMin}-${wantMax}，实际 ${gotNew.minId}-${gotNew.maxId}`)
      }
    }

    // 校验不过说明「事务提交了但内容不对」——这种情况极罕见（逻辑错才会），
    // 但不能装作成功：把差异原样抛出去，让调用方决定要不要用备份回退。
    if (fail.length > 0) {
      throw new Error(`迁移后校验未通过，请用备份回退：${fail.join('；')}`)
    }

    return {
      ok: true,
      from: a,
      to: b,
      // merged=true 表示这次是「并进一个已有工作区」，而不是新开一个名字。
      // GUI 要据此把结果文案写成「已合并」而不是「已改名」。
      merged,
      tables,
      total,
      // 迁前 / 迁后两份快照原样返回，GUI 要拿来并排展示
      before,
      // 合并时目标区域原有的数据量（非合并时全为 0）
      targetBefore,
      after: { to: afterNew, from: afterOld },
      verify: { ok: true, checks },
    }
  }

  /** 项目规则升级为全局（单向，不提供降级） */
  function upgradeToGlobal(id) {
    const d = open()
    const row = d.prepare(`SELECT scope FROM rules WHERE id=?`).get(id)
    if (!row) throw new Error('规则不存在')
    if (row.scope === GLOBAL) return { ok: true, changed: false }
    d.prepare(`UPDATE rules SET scope=? WHERE id=?`).run(GLOBAL, id)
    return { ok: true, changed: true, from: row.scope }
  }

  /** 按正则软删全局规则（对应旧 mem-fix） */
  function removeGlobalByRegex(patternText) {
    const source = String(patternText ?? '').trim()
    if (!source) throw new Error('mem-fix 内容为空')
    if (source.length > 120) throw new Error('mem-fix 正则过长（上限 120 字符）')
    let re
    try { re = new RegExp(source, 'u') } catch (e) { throw new Error(`mem-fix 正则无效：${e.message}`) }
    const d = open()
    const rows = d.prepare(`SELECT id,text FROM rules WHERE scope=? AND status='active'`).all(GLOBAL)
    const hit = rows.filter((r) => re.test(r.text))
    if (hit.length === 0) return { removed: 0 }
    d.exec('BEGIN')
    try {
      for (const h of hit) d.prepare(`UPDATE rules SET status='deleted' WHERE id=?`).run(h.id)
      d.exec('COMMIT')
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
    return { removed: hit.length, sample: hit.slice(0, 3).map((h) => h.text) }
  }

  // ================================================================ 检索

  /**
   * 跨四张表的检索。
   *
   * 拆表后检索要 UNION —— 这是拆表的代价，但换来的是
   * 每张表的结构与访问方式都清晰。
   *
   * ============================================================
   * 2026-11-13 重要变更：项目检索改为**硬隔离**
   * ============================================================
   *
   * 之前 projectName 是「可选过滤」，两个调用方都没传 —— 等于全库检索。
   * 用户实测后明确要求：**只允许搜本项目**。原话是
   * 「其他项目的记忆看多了会出现 AI 幻觉」。
   *
   * 为什么这不是过度保守：别的项目的经验往往是**看起来能用、实际不适用**，
   * 比如 ForzaOverlay 的 HUD 坐标常量被拿去套 FatFishDream 的布局。
   * 那比「没搜到」更糟 —— 模型会自信地用错知识，且无从察觉。
   *
   * 隔离边界：
   *   rules  → 只搜 scope=? 与 scope='__global__'（全局规则本来就跨项目）
   *   logs   → 只搜 scope=?（流水是项目内的事）
   *   profile → 不隔离（画像是「用户这个人」，天然跨项目）
   *   emotion → **不在检索池里**（v5，见函数内的长注释）
   *
   * `crossProject: true` 可显式取消隔离，仅供用户主动要求「看看别的项目」时用。
   */
  function search(query, { limit = 30, projectName = null, crossProject = false } = {}) {
    const d = open()
    const q = buildMatchQuery(query)
    if (!q) return []
    // 三张表各存一桶，最后**交错**输出。为什么不能混在一起排，见函数末尾的长注释。
    const buckets = { profile: [], rules: [], logs: [] }

    // 只有显式 crossProject 或不传 projectName 时才跨项目（后者留给旧调用方/测试）
    const isolate = !crossProject && projectName !== null && projectName !== undefined

    const push = (table, rows, scopeOf) => {
      for (const r of rows) {
        buckets[table].push({
          table,
          id: r.id,
          ts: r.ts ?? null,
          scope: scopeOf(r),
          kind: table,
          topic: r.topic ?? null,
          summary: r.summary ?? null,
          keywords: r.keywords ?? null,
          text: r.text,
          score: r.score,
        })
      }
    }

    // ⚠️ 2026-11-16 修（第 10 条）：这 5 条 FTS 查询原来**都没有 ORDER BY**。
    //
    // 后果：SQLite 拿不到排序依据 → 按 FTS 内部返回顺序（近似 rowid）取前 N 条，
    // 再让上层按 score 排 —— 但**最相关的那几条可能根本没进前 N**。
    // 小库上不明显，库里一旦有几千条原文（archive 现在 3800+），
    // 搜出来的就是「能搜到但搜不准」。
    //
    // 为什么必须写 `ORDER BY score` 而不是别的：bm25() 是**越小越相关**，
    // 且它是唯一能利用 FTS 索引顺序的排序键。写成 DESC 会把最不相关的排前面。
    // 注意必须用别名 score（SQLite 允许在 ORDER BY 里引用 select 别名）。

    // ⚠️ 2026-11-17 修（TODO 待办 L / M）：三条 SQL 都补上 `review` 过滤。
    //
    // 问题：用户在 GUI 里点「撤回」会把 `review` 置成 `'retracted'`，
    // 语义是「这条不对，别再用了」。但 `search()` 原来**只过滤 status**，
    // 所以模型仍能搜到并把它当有效结论 —— 用户的决定被静默忽略。
    //
    // 而**注入侧早就过滤了**（本文件 L326 / L343 都有 `review IS NOT 'retracted'`），
    // 于是出现更糟的分裂：同一桌面上的两条通道对「这条还算不算数」给出相反答案。
    //
    // `IS NOT` 而不是 `!=`：`review` 可能是 NULL（从未复核），
    // 而 `NULL != 'retracted'` 求值为 NULL（假），会把所有正常条目也过滤掉。
    // `IS NOT` 是 NULL-safe 的，这是 SQLite 的正确写法。
    //
    // ⚠️ **`logs` 表没有 `review` 列**（见 db-schema.mjs 的建表），
    //    所以下面 logs 那条**不能**加这个条件 —— 加了会直接报错。

    // profile（无 scope 概念，永不隔离）
    push('profile', d.prepare(
      `SELECT p.id,p.ts,p.topic,p.text,bm25(profile_fts) score FROM profile_fts f
       JOIN profile p ON p.id=f.rowid
       WHERE profile_fts MATCH ? AND p.status='active' AND p.review IS NOT 'retracted'
       ORDER BY score LIMIT ?`
    ).all(q, limit), () => GLOBAL)

    // rules：隔离时包含本项目 + 全局规则
    if (isolate) {
      push('rules', d.prepare(
        `SELECT r.id,r.ts,r.scope,r.kind,r.topic,r.text,bm25(rules_fts) score FROM rules_fts f
         JOIN rules r ON r.id=f.rowid
         WHERE rules_fts MATCH ? AND r.status='active' AND r.review IS NOT 'retracted'
           AND (r.scope=? OR r.scope=?)
         ORDER BY score LIMIT ?`
      ).all(q, projectName, GLOBAL, limit), (r) => r.scope)
    } else {
      push('rules', d.prepare(
        `SELECT r.id,r.ts,r.scope,r.kind,r.topic,r.text,bm25(rules_fts) score FROM rules_fts f
         JOIN rules r ON r.id=f.rowid
         WHERE rules_fts MATCH ? AND r.status='active' AND r.review IS NOT 'retracted'
         ORDER BY score LIMIT ?`
      ).all(q, limit), (r) => r.scope)
    }

    // ⚠️ emotion **故意不在这里**（2026-11-14，schema v5）。
    //
    // 为什么：情绪记录是「个人兴趣记录」，不是可检索的知识。
    // 用户原话「这些不进上下文，也不需要查询，仅作为个人兴趣记录」。
    // 而 `emotion.text` 存的是模板句：
    //     用户表达爱意（喜欢·高置信·0.90）：大肥鱼我喜欢你
    //                ↑分类  ↑证据  ↑置信度      ↑这才是内容
    // 分类名/证据词/置信度**全被写进了 FTS 索引**，于是搜「爱意」「高置信」
    // 「用户表达」都命中一堆模板，把结论层（logs / rules）挤出结果位。
    // 实测：q=爱意 → 5 条里 4 条是 emotion；q=用户表达 → 5 条全是 emotion。
    //
    // 边界（别改回去）：
    //   - GUI「情绪记录」页签走 `/entries?table=emotion`，**不经过这里**，照常可看可搜；
    //   - `emotion_fts` 保留，供页签内的搜索框用；
    //   - 情绪不进注入、也要能被模型检索到 —— 设计前提就是「只给用户看」。
    //     要让模型能查情绪，得显式加一条独立路由，不要偷偷塞回这个函数。

    // logs（v3：5 列 bm25 权重，顺序与 logs_fts 建表列顺序一致）
    //
    // 权重含义：keywords 3.0（人工挑的词最精确）> summary 2.0（一眼判断）
    // > text / topic 1.0 > seg 1.0。
    //
    // seg 为什么必须给 1 而不是 0：中文查询是**逐字**命中 seg 列的
    // （unicode61 对中文整段成词，text 列搜不到单字）。seg 权重给 0
    // 会让所有中文命中同分、排序退化成入库顺序。
    //
    // ⚠️ 权重个数必须等于列数（5 个），少写会直接报错或错位加权。
    const LOGS_BM25 = 'bm25(logs_fts, 3.0, 2.0, 1.0, 1.0, 1.0)'
    if (isolate) {
      push('logs', d.prepare(
        `SELECT l.id,l.ts,l.scope,l.topic,l.summary,l.keywords,l.text,${LOGS_BM25} score FROM logs_fts f
         JOIN logs l ON l.id=f.rowid
         WHERE logs_fts MATCH ? AND l.status='active' AND l.scope=?
         ORDER BY score LIMIT ?`
      ).all(q, projectName, limit), (r) => r.scope)
    } else {
      push('logs', d.prepare(
        `SELECT l.id,l.ts,l.scope,l.topic,l.summary,l.keywords,l.text,${LOGS_BM25} score FROM logs_fts f
         JOIN logs l ON l.id=f.rowid WHERE logs_fts MATCH ? AND l.status='active'
         ORDER BY score LIMIT ?`
      ).all(q, limit), (r) => r.scope)
    }

    // ---- 输出顺序：组内按 bm25，组间按表轮取（2026-11-14）----
    //
    // 旧实现是把三张表的 score 混在一起 `sort((a,b) => a.score - b.score)`。
    // 这是错的，因为 **bm25 是每张表各自语料算出来的**：文档数、平均长度、
    // 词频分布都不同，跨表比大小没有意义。实测两处反例：
    //
    //   q=大肥鱼  → logs -7.876 压在 profile -4.668 前面
    //               （profile 那条正是「用户称呼 AI 为大肥鱼」的直接定义）
    //   q=不要    → 所有 logs 都是 -0（该词在每条流水里都有，IDF≈0），
    //               于是被 rules 的 -2.06 全体压到后面
    //
    // 「给 logs 加权」解决不了：加权的 5 个值调的是 logs_fts **列**权重
    // （见上面的 LOGS_BM25），跟跨表量纲无关。
    //
    // 所以改成两层：
    //   组内：score 升序（bm25 越小越相关），各表内部仍是真相关度
    //   组间：固定 profile → rules → logs，**轮流各取一条**
    //
    // 为什么轮流而不是「整组排完再下一组」：limit 小的时候（注入里建议
    // 先用 summary=1 取 3 条）整组排会让结果被条数最多的表占满，
    // 另一张表一条都看不到 —— 那等于把「跨表不可比」换成了「跨表不公平」。
    const TIER = ['profile', 'rules', 'logs']
    for (const t of TIER) buckets[t].sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
    const out = []
    for (let round = 0; out.length < limit; round++) {
      let took = false
      for (const t of TIER) {
        if (round >= buckets[t].length) continue
        out.push(buckets[t][round])
        took = true
        if (out.length >= limit) break
      }
      if (!took) break
    }
    return out
  }

  /**
   * 最近一条流水的写入时间（原始 ts 字符串）；一条都没有返回 null。
   *
   * 用途：`agent/created` 那句「距上次记忆整理已 N 天」的判据。
   * **不要**改用 `state.lastConsolidate`：那个字段只有用户手动跑
   * `/memory consolidate` 才会写，模型写 mem-log 从不更新它 ——
   * 于是条件永远成立，每个新会话都提醒一次（2026-11-14 用户反馈「每轮都吵」）。
   *
   * 为什么按 id 而不是 MAX(ts) 取最新：ts 有三种写法（无后缀 / 带 Z / 带毫秒），
   * 字符串比较会错位，见 TS_ORDER 的长注释。id 是插入顺序，可靠。
   */
  function lastLogTs() {
    const d = open()
    const row = d.prepare(`SELECT ts FROM logs ORDER BY id DESC LIMIT 1`).get()
    if (row === undefined || row.ts === null || row.ts === undefined) return null
    return String(row.ts)
  }

  /**
   * GUI 用：列出某张表的条目。
   * 时间范围用 tsFrom / tsTo（YYYY-MM-DD 或 ISO）。
   *
   * 2026-11-13 加 `cap`：只保留**最近 N 条**的可翻范围。
   * 为什么需要：流水会无限增长，界面若允许一直往后翻，用户点「下一页」
   * 就会一路触发 OFFSET 越深越慢的查询。记忆流水是「看最近发生了什么」，
   * 不是「考古」，所以界面只给最近一段；更早的内容靠 /memory search 检索。
   * cap 的实现方式：先按同样条件取最近 cap 条的最新 ts 作为下界，
   * 再在主查询上加 `ts >= 下界` —— 而不是简单的 LIMIT，
   * 否则翻页时拿不到正确总数。
   */
  function listEntries(table, {
    scope, kind,
    // status 的默认值保持 'active'（不要改！）。
    //
    // ⚠️ 2026-11-16 踩过的坑：我曾把默认值删掉想实现「不传就不过滤」，
    // 但 JS 的默认参数在传 undefined 时**仍然生效**，所以那样改毫无效果；
    // 而真正的默认值一删，所有依赖「默认只看 active」的调用点
    //（共 20+ 处，多数在测试脚本里）行为会一起改变 —— 那是更大的风险。
    //
    // 正确做法：加一个**显式**的 includeAll 开关。
    //   includeAll: true  → 完全不过滤 status（GUI 勾选「显示已停用」时用）
    //   否则              → 按 status 过滤，默认 'active'
    status = 'active', includeAll = false,
    q, tsFrom, tsTo, limit = 200, offset = 0, cap = 0,
  } = {}) {
    // ⚠️ 2026-11-16（第 7 条）：这个函数原来**没有**表名校验。
    // 它的 cols 是三元表达式兜底到 rules，但 `FROM ${table}` 原样拼接 ——
    // 传 `sqlite_master` 会拼出 `SELECT ... FROM sqlite_master LIMIT ?`，
    // 因为列名对不上而报错，但**报错本身已经泄露了表是否存在**；
    // 更糟的是配合 `q` 参数它会把表名带进子查询。
    // 必须在这里就拦掉，而不是指望 SQL 报错。
    assertTable(table)
    const d = open()
    const cols = table === 'logs'
      ? 'id,scope,ts,topic,summary,keywords,text,status,writer'
      : table === 'emotion'
        ? 'id,ts,cls,quote,evidence,text,status,review,review_note,writer'
        : table === 'profile'
          ? 'id,ts,topic,text,status,writer,review,review_note,updated'
          : 'id,scope,kind,ts,topic,text,status,writer,review,review_note,updated'
    const where = []
    const params = []
    if (scope && table !== 'profile' && table !== 'emotion') { where.push('scope=?'); params.push(scope) }
    if (kind && table === 'rules') { where.push('kind=?'); params.push(kind) }
    // includeAll=true 时**完全不加** status 条件 —— 这样才能把
    // 已删除 / 已停用的条目也列出来（GUI 的「显示已停用」需要）。
    if (!includeAll && status) { where.push('status=?'); params.push(status) }
    if (tsFrom) { where.push('ts IS NOT NULL AND ts >= ?'); params.push(normalizeFrom(tsFrom)) }
    if (tsTo) { where.push('ts IS NOT NULL AND ts <= ?'); params.push(normalizeTo(tsTo)) }
    if (q) {
      const mq = buildMatchQuery(q)
      if (mq) {
        where.push(`id IN (SELECT rowid FROM ${table}_fts WHERE ${table}_fts MATCH ?)`)
        params.push(mq)
      }
    }

    // cap：把可翻范围限制在最近 cap 条。
    // 取「第 cap 新的那条」的 id 作为下界，再用 id >= 过滤 ——
    // 排序键是 id（原因见 TS_ORDER 的长注释），所以边界也必须用 id，
    // 口径不一致会导致翻页漏行或重复。
    let capWhere = ''
    const capParams = []
    if (Number(cap) > 0) {
      const boundary = d
        .prepare(
          `SELECT ts,id FROM ${table}
           ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
           ORDER BY ${TS_ORDER} LIMIT 1 OFFSET ?`,
        )
        .get(...params, Number(cap) - 1)
      if (boundary === undefined) {
        // 总数不足 cap，不需要额外限制
      } else {
        // 排序与边界都用 id（见 TS_ORDER 的长注释），所以这里只要 id 下界。
        capWhere = ' AND id >= ?'
        capParams.push(boundary.id)
      }
    }

    const allWhere = where.length ? 'WHERE ' + where.join(' AND ') + capWhere : capWhere ? 'WHERE 1=1' + capWhere : ''
    const allParams = [...params, ...capParams]
    const sql = `SELECT ${cols} FROM ${table}
                 ${allWhere}
                 ORDER BY ${TS_ORDER} LIMIT ? OFFSET ?`
    const rows = d.prepare(sql).all(...allParams, limit, offset)
    const total = d.prepare(`SELECT COUNT(*) c FROM ${table} ${allWhere}`).get(...allParams).c
    return { rows, total }
  }

  function normalizeFrom(s) {
    const t = String(s).trim()
    // 本地时间口径：日期边界用本地 00:00（不带 Z），与库里的 ts 格式一致
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00.000` : t
  }
  function normalizeTo(s) {
    const t = String(s).trim()
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T23:59:59.999` : t
  }

  function getById(table, id) {
    // allowExtra: 只读，且 archive 有 id 列 —— 读一条原文是合法的
    // （selfcheck-archive 用它验证超长原文没被截断）。
    // 注意别的函数**不**传这个开关：updateText / setStatus 等会改写数据，
    // 对 archive 的列假设不成立，必须继续只认四张业务表。
    assertTable(table, { allowExtra: true })
    const d = open()
    return d.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
  }

  /**
   * 库体积分层（GUI「存储设置」页用）。
   *
   * ⚠️ **不要把这个塞进 stats()。** 它查 `dbstat` 虚拟表，是**全库页扫描**，
   * 耗时与库体积线性相关。2026-11-14 实测：
   *     1.8 MB → 0.7 ms
   *     5.2 MB → 8.7 ms
   *    10.2 MB → 16.6 ms      ← 推算 100 MB ≈ 160 ms
   * 而 `/state` 是 GUI 每次切页签都会拉的接口，主线程被它卡住不划算。
   * 所以单独一条路由 + 进程内缓存（默认 30 秒），只有真正要看的页面才付这个代价。
   *
   * 分层口径（这是这个函数存在的理由）：
   *   - `core`    ：profile / rules / emotion / logs 四张业务表 + 它们的 FTS 与索引
   *                 —— 这才是「记忆条目」，长到 100 MB 才真该担心；
   *   - `archive` ：原文层，只增不减（见 docs/TODO.md），膨胀是预期内的；
   *   - `system`  ：sqlite_schema 之类；
   *   - `free`    ：空闲页 —— DROP 之后不 VACUUM 就会积在这里（v5 删 entries 时踩过）。
   *
   * 没有这一层时，`dbSize` 一个数字会被读成「记忆条目爆了」，
   * 而实际上 archive 可能占三分之一、空闲页还占一块。
   */
  let breakdownCache = { at: 0, value: null }
  function statsBreakdown({ maxAgeMs = 30_000 } = {}) {
    const now = Date.now()
    if (breakdownCache.value !== null && now - breakdownCache.at < maxAgeMs) {
      return { ...breakdownCache.value, cached: true }
    }
    const d = open()
    let fileSize = 0
    try { fileSize = statSync(dbPath).size } catch {}

    let rows = []
    try {
      rows = d.prepare('SELECT name, SUM(pgsize) bytes FROM dbstat GROUP BY name').all()
    } catch {
      // dbstat 未编译进 SQLite 时退化成「只有一个总数」，不让整个面板报错
      return {
        total: fileSize, core: null, archive: null, system: null, free: null,
        freePages: 0, byObject: [], cached: false, unavailable: 'dbstat',
      }
    }

    // 归属判定：索引名不总是以表名开头（idx_rules_scope 属于 rules，
    // idx_archive_role 属于 archive），所以要先看索引定义再归类。
    const owner = (name) => {
      if (name.startsWith('sqlite_')) return 'system'
      const base = name.replace(/_fts(_data|_idx|_config|_docsize)?$/, '')
      for (const t of ['profile', 'rules', 'emotion', 'logs', 'archive']) {
        if (base === t) return t === 'archive' ? 'archive' : 'core'
      }
      // idx_xxx：查它属于哪张表
      if (name.startsWith('idx_')) {
        const hit = d
          .prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?")
          .get(name)
        if (hit) {
          if (hit.tbl_name === 'archive') return 'archive'
          if (['profile', 'rules', 'emotion', 'logs'].includes(hit.tbl_name)) return 'core'
        }
      }
      return 'system'
    }

    const agg = { core: 0, archive: 0, system: 0 }
    for (const r of rows) agg[owner(r.name)] += r.bytes

    // ⚠️ `dbstat` **不列空闲页**（2026-11-14 实测：147 页里 freelist 7 页，
    // dbstat 只报 140 页）。所以口径是：
    //     page_count × page_size = dbstat 合计 + freelist × page_size
    // 想拿 `total` 当分母，就必须**另加** free 这一项，否则各类占比加起来不到 100%，
    // 而那个差值正是「DROP 之后没 VACUUM 的垃圾」—— 最该被看见的一块。
    const freePages = d.prepare('PRAGMA freelist_count').get().freelist_count
    const pageSize = d.prepare('PRAGMA page_size').get().page_size
    const pageCount = d.prepare('PRAGMA page_count').get().page_count
    const free = freePages * pageSize
    // 用 page_count 口径当 total，而不是文件大小：WAL 里的未落盘内容不该算进「库体积」，
    // 否则每次刚写完都会看到数字跳动。
    const total = pageCount * pageSize

    const value = {
      total,                       // page_count 口径（不含 WAL）
      fileSize,                    // 磁盘上实际占用，供对照
      core: agg.core,
      archive: agg.archive,
      system: agg.system,
      free,
      freePages,
      pageCount,
      pageSize,
      pct: {
        core: total ? Number((agg.core / total * 100).toFixed(1)) : 0,
        archive: total ? Number((agg.archive / total * 100).toFixed(1)) : 0,
        system: total ? Number((agg.system / total * 100).toFixed(1)) : 0,
        free: total ? Number((free / total * 100).toFixed(1)) : 0,
      },
      // 自检用：四类之和应当**精确等于** total，不等就是分类漏了对象
      _sum: agg.core + agg.archive + agg.system + free,
      byObject: rows
        .map((r) => ({ name: r.name, bytes: r.bytes, bucket: owner(r.name) }))
        .sort((a, b) => b.bytes - a.bytes),
      cached: false,
    }
    breakdownCache = { at: now, value }
    return value
  }

  /** 库结构变更后清掉缓存（迁移、VACUUM、删表后必须调） */
  function invalidateBreakdown() {
    breakdownCache = { at: 0, value: null }
  }

  /**
   * VACUUM：把空闲页真正还给磁盘（2026-11-16 新增）。
   *
   * ## 为什么删了行体积不变
   *
   * SQLite 的 DELETE 只把页标记为空闲，文件不会缩小 —— 空闲页留在
   * `freelist_count` 里等下次复用。实测 purge 130 条后 `page_count` 反而
   * 从 1709 涨到 1712、freelist 从 1 涨到 8，**`db.size` 一点没变**。
   * 只有 VACUUM 才真回收（与 v5 删 entries 表时同一个教训，见本文件
   * `statsBreakdown` 里 `free` 那段的注释）。
   *
   * ## 风险与约束
   *
   * - VACUUM 会**重写整个库**，运行期间需要约 2 倍磁盘空间做临时副本
   * - 不能在事务里执行（SQLite 限制），所以这里不包 BEGIN
   * - 期间不能有其他写操作；`busy_timeout=5000` 已经设了，会短暂等待
   * - 完成后必须清缓存，否则 breakdown 仍返回旧的 free 数字
   */
  function vacuum() {
    const d = open()
    const before = {
      pageCount: d.prepare('PRAGMA page_count').get().page_count,
      freelist: d.prepare('PRAGMA freelist_count').get().freelist_count,
      bytes: statSync(dbPath).size,
    }
    d.exec('VACUUM')
    const after = {
      pageCount: d.prepare('PRAGMA page_count').get().page_count,
      freelist: d.prepare('PRAGMA freelist_count').get().freelist_count,
      bytes: statSync(dbPath).size,
    }
    invalidateBreakdown()
    return {
      ok: true,
      before,
      after,
      reclaimedBytes: before.bytes - after.bytes,
    }
  }

  /** GUI 用：各表统计 */
  function stats() {
    const d = open()
    const count = (tbl) => d.prepare(`SELECT COUNT(*) c FROM ${tbl} WHERE status='active'`).get().c
    const byTable = {
      profile: count('profile'),
      rules: count('rules'),
      emotion: count('emotion'),
      logs: count('logs'),
    }
    const byScope = d.prepare(
      `SELECT scope, COUNT(*) n FROM rules WHERE status='active' GROUP BY scope
       UNION ALL SELECT scope, COUNT(*) n FROM logs WHERE status='active' GROUP BY scope`,
    ).all()
    const scopeAgg = {}
    for (const r of byScope) scopeAgg[r.scope] = (scopeAgg[r.scope] ?? 0) + r.n
    // 原始归档单独计数：它不是「记忆条目」，混进 byTable 会让 GUI/健康检查的
    // 「四表」口径变味，所以只作为附加字段返回。
    let archive = 0
    try { archive = d.prepare('SELECT COUNT(*) c FROM archive').get().c } catch {}
    let size = 0
    try { size = statSync(dbPath).size } catch {}
    return {
      byTable,
      archive,
      byScope: Object.entries(scopeAgg).map(([scope, n]) => ({ scope, n })).sort((a, b) => b.n - a.n),
      total: Object.values(byTable).reduce((a, b) => a + b, 0),
      dbPath,
      dbSize: size,
      schemaVersion: SCHEMA_VERSION,
    }
  }

  /**
   * 已知 scope 列表（GUI 下拉框用），带条数。
   *
   * ⚠️ 默认只统计 **rules 表** —— 因为下拉框是「规则与偏好」页的筛选器，
   * 数字必须与点进去看到的条目数一致。
   *
   * 不要把 profile（用户画像）算进 __global__：
   * 画像是独立表、有独立页签，混进来会让下拉框显示 6 条
   * 而点进去只有 4 条，用户会以为丢了数据。
   *
   * 2026-11-13 补充 `table` 参数：记忆流水页要按**项目**筛，但两边 scope 并不一致 ——
   * 实测 `干杂活` 有 19 条流水、0 条规则；`__global__` 有规则、无流水。
   * 若流水页复用 rules 的统计，下拉框会**漏掉干杂活**，用户以为那个项目的流水没了。
   * 所以按页签传对应的表。
   */
  function listScopes(table = 'rules') {
    const d = open()
    // 只允许这两张有 scope 列的表，避免拼出非法表名
    const t = table === 'logs' ? 'logs' : 'rules'
    return d
      .prepare(`SELECT scope, COUNT(*) n FROM ${t} WHERE status='active' GROUP BY scope`)
      .all()
      .sort((a, b) => a.scope.localeCompare(b.scope))
  }

  /**
   * 列出**所有**存在数据的工作区（工作区改名页的下拉框用）。
   *
   * ⚠️ 为什么不能复用 `listScopes` 或 `/state` 的 `byScope`：
   * 那两个都只统计 `status='active'` 的 rules + logs，而且完全不看 archive。
   * 2026-11-15 实测踩到 —— 工作区 `design` 有 **18 行 rules 全部是停用状态**，
   * 于是 `byScope` 里根本没有它，下拉框就漏掉了这个有数据的工作区，
   * 用户会以为「没有 design 这个工作区」。
   *
   * 所以这里按 `snapshotScope` 同一口径数：三张表**全部行**（不过滤 status），
   * 保证「下拉框里有的 = 改名时确实会动的」。
   *
   * @param {{includeGlobal?: boolean}} [options] includeGlobal 默认 false ——
   *   `__global__` 是保留值，不能改名，列在「选择要改名的工作区」下拉里只会误导
   *   （点下去必然被后端拒绝）。需要统计全局规则的地方自行传 true。
   * @returns {Array<{scope:string, total:number, tables:Record<string,number>}>} 按总数降序
   */
  function listScopesWithData({ includeGlobal = false } = {}) {
    const d = open()
    // 三张表的 scope 并集，再逐个数。用 UNION 一次拿全，避免三次全表扫描。
    const rows = d
      .prepare(
        `SELECT scope, 'rules' t, COUNT(*) n FROM rules GROUP BY scope
         UNION ALL
         SELECT scope, 'logs' t, COUNT(*) n FROM logs GROUP BY scope
         UNION ALL
         SELECT scope, 'archive' t, COUNT(*) n FROM archive GROUP BY scope`,
      )
      .all()

    const agg = new Map()
    for (const r of rows) {
      const key = r.scope
      const cur = agg.get(key) ?? { scope: key, total: 0, tables: { rules: 0, logs: 0, archive: 0 } }
      cur.tables[r.t] = Number(r.n)
      cur.total += Number(r.n)
      agg.set(key, cur)
    }
    return [...agg.values()]
      .filter((x) => x.total > 0)
      .filter((x) => includeGlobal || x.scope !== GLOBAL)
      .sort((a, b) => b.total - a.total || a.scope.localeCompare(b.scope))
  }

  /**
   * 扫描全部条目中的人称问题（GUI 的「检查」按钮用）。
   * 只报告，不改数据。
   */
  function scanPersona() {
    const d = open()
    const out = []
    const scan = (table, sql) => {
      for (const r of d.prepare(sql).all()) {
        const hits = checkPersona(r.text)
        if (hits.length > 0) {
          out.push({ table, id: r.id, text: r.text, hits: hits.map((h) => h.word) })
        }
      }
    }
    scan('profile', `SELECT id,text FROM profile WHERE status='active'`)
    scan('rules', `SELECT id,text FROM rules WHERE status='active'`)
    return out
  }

  /**
   * 原始对话归档（v4）：user / assistant 的原文一条不落地存下来。
   *
   * 与 logs 的分工：logs 是模型「整理过的结论」，archive 是「不可变的原文」。
   * 这里**不做任何内容判断** —— 空文本之外一律写入。
   * 返回 written=false 只表示空内容，不是「不值得记」。
   */
  function appendArchive({ scope, role, text, sessionId = null, turn = null, step = null } = {}) {
    const body = String(text ?? '')
    if (body.trim() === '') return { written: false, reason: 'empty' }
    if (role !== 'user' && role !== 'assistant') {
      return { written: false, reason: `bad-role:${role}` }
    }
    // ⚠️ 2026-11-17 修：主表 + FTS **必须在同一个事务里**。
    //
    // 这是 `insertInto` 早就要修过的同一个病（见本文件 L380-402 的长注释）：
    // 「先 INSERT 主表 → 再 syncFts」两步裸跑，一旦 syncFts 失败，
    // 主表已提交、索引没写 —— 于是这条原文**按 id 查得到、按关键词永远搜不到**。
    //
    // 更糟的是调用方（index.js 的 archive 写入处）把异常 catch 成一条 diag，
    // 于是三方认知全不一致：
    //   数据库：写了     调用方：失败了     用户检索：查不到
    //
    // 2026-11-17 实测复现（人为 DROP archive_fts 后写一条）：
    //   抛错 "no such table: archive_fts"，而 archive 主表实际是 2 行。
    //
    // 修法照 `insertInto`：整段包进 withFtsTransaction，失败一起回滚。
    return withFtsTransaction((d) => {
      const r = d
        .prepare(`INSERT INTO archive(ts,scope,role,text,session_id,turn,step) VALUES(?,?,?,?,?,?,?)`)
        .run(nowIso(), scope || GLOBAL, role, body, sessionId ?? null, turn ?? null, step ?? null)
      const id = Number(r.lastInsertRowid)
      syncFts(d, 'archive', id, { text: body })
      return { id, written: true, role }
    })
  }

  /**
   * 归档检索（原文层）。不参与默认 /search，避免把结论检索淹掉。
   * q 走 FTS（中文逐字分词），空 q 时按时间倒序翻页。
   */
  function listArchive({ scope, role, q, tsFrom, tsTo, limit = 100, offset = 0 } = {}) {
    const d = open()
    const where = []
    const params = []
    if (scope) { where.push('scope=?'); params.push(scope) }
    if (role) { where.push('role=?'); params.push(role) }
    if (tsFrom) { where.push('ts >= ?'); params.push(normalizeFrom(tsFrom)) }
    if (tsTo) { where.push('ts <= ?'); params.push(normalizeTo(tsTo)) }
    if (q) {
      const mq = buildMatchQuery(q)
      if (mq) {
        where.push(`id IN (SELECT rowid FROM archive_fts WHERE archive_fts MATCH ?)`)
        params.push(mq)
      }
    }
    const w = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''
    const rows = d
      .prepare(`SELECT id,ts,scope,role,text,session_id,turn,step FROM archive ${w} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
    const total = d.prepare(`SELECT COUNT(*) c FROM archive ${w}`).get(...params).c
    return { rows, total }
  }

  return {
    // 读取
    factsTextSync, projectTextSync, routeTable,
    // 写入
    appendLog, appendFact, appendProjectNote, recordEmotion, createEntry, appendArchive,
    // 维护
    setReview, softDelete, setStatus, updateText, upgradeToGlobal, removeGlobalByRegex, setTopic,
    // 物理清理（2026-11-16）：软删除只是标记，这个才真删行 + 同步 FTS + 事务保护
    purgeByStatus,
    // 删完必须 VACUUM 才真省空间（DELETE 只把页标为空闲）
    vacuum,
    // 工作区改名（scope 迁移，2026-11-15）：snapshotScope 是迁前/迁后共用的数据量采样
    renameScope, countScope, snapshotScope, listScopesWithData, SCOPE_TABLES,
    // 检索
    search, listEntries, listScopes, getById, stats, scanPersona, listArchive, lastLogTs,
    // 体积分层（单独一条路由用，别塞进 stats）
    statsBreakdown, invalidateBreakdown,
    // 生命周期
    open, close,
    get path() { return dbPath },
    GLOBAL,
  }
}
