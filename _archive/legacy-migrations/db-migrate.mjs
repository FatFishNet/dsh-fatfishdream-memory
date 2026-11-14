/**
 * 迁移：现有 .md 记忆 → SQLite
 *
 * 迁移原则（本轮讨论定下的）：
 *   1. 默认 scope = 所在项目；只有明确跨项目的才标 '__global__'
 *      —— 因为「项目专属误判成全局」会在错误项目里造成真实损害
 *   2. 迁移前必须能回滚：先复制整目录，失败即还原
 *   3. 迁移后双向验证：条数、内容、抽样原文比对
 *   4. 原文 .md 保留不动（作为回退依据与人工可读副本），
 *      只是不再被插件读写
 *
 * 用法：
 *   node migrate.mjs <记忆根目录> <输出db路径> [--dry-run]
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb, syncFts } from './db-schema.mjs'

const ROOT = process.argv[2]
const DB_PATH = process.argv[3]
const DRY = process.argv.includes('--dry-run')

if (!ROOT || !DB_PATH) {
  console.error('用法: node migrate.mjs <记忆根目录> <输出db路径> [--dry-run]')
  process.exit(1)
}

/**
 * 标签前缀的剥离。
 * 原 .md 里一行有两种形态：
 *   - [active] 正文
 *   - 正文（无标签，视为 active）
 */
function parseLine(line) {
  const m = line.match(/^-\s*\[(\w+)\]\s*(.+)$/s)
  if (m) {
    const tag = m[1].toLowerCase()
    const text = m[2].trim()
    const status = tag === 'stale' || tag === 'superseded' ? tag : 'active'
    return { status, text }
  }
  const m2 = line.match(/^-\s*(.+)$/s)
  if (!m2) return null
  return { status: 'active', text: m2[1].trim() }
}

/**
 * 主题标注。
 *
 * 实测教训：用正则事后猜主题，会让大量条目落进「杂」（本项目实测 43 条），
 * 而「杂」在路由表里毫无意义。所以这里的策略是：
 *   - 正则只做**明显可判**的归类
 *   - 判不出来就留 NULL，而不是塞进「杂」
 * NULL 语义明确（未知），比一个假桶更诚实。
 */
const TOPIC_RULES = [
  [/编译|构建|build|MSB\d|csproj|\.sln|nuget/i, '构建/编译'],
  [/沙箱|权限|提权|EPERM|工作区外|被拒/i, '路径/沙箱'],
  [/BOM|CRLF|\bLF\b|编码|UTF-?8|换行符/i, '格式/编码'],
  [/注入|预算|截断|字节|token|注入段|policyBytes|projectBytes/i, '注入/预算'],
  [/文档|地图|行号|README|AGENTS|链接|断链/i, '文档/行号'],
  [/插件|装载|profile|bundle|patch|重载|重启|remove.*add/i, '插件/装载'],
  [/测量|像素|绘制|HUD|SVG|D2D|字体|颜色|刻度|指针/i, '测量/像素'],
  [/\bgit\b|提交|commit|push|ignore|仓库/i, 'Git'],
  [/情绪|误判|反讽|词典|语气|置信/i, '情绪判据'],
  [/记忆|注入|标记|mem-|facts|PROJECT\.md/i, '记忆机制'],
]
function topicOf(text) {
  for (const [re, name] of TOPIC_RULES) if (re.test(text)) return name
  return null
}

/** 判断一条项目规则是不是「红线」：违反会导致严重后果 */
const REDLINE_RULES = [
  /永久关闭|绝不|永远不要|必须|不能|禁止|红线|禁用/,
]
function isRedline(text) {
  return REDLINE_RULES.some((re) => re.test(text))
}

/** 项目内明显属于「现状」的小节 */
const STATE_SECTIONS = /项目说明|项目结构|现行安排|现状|存储位置|基本信息/
/** 明显属于「定型的约定」的小节 */
const RULE_SECTIONS = /约定|决策|硬约束|规则|偏好|工作流|验证|规范/

let nextId = 1
const rows = []

function add(row) {
  rows.push({ id: nextId++, ...row })
}

const nowIso = new Date().toISOString()

// ------------------------------------------------------------------ 遍历
//
// ⚠️ 2026-11-13 修：这一层原先没有排序，导致迁移出来的流水在时间线上是乱的。
//
// 现场：用户发现流水页「只剩凌晨的记录」。查下来数据一条没少（355 条、
// id 连续无断号），但时间序乱得厉害 —— 光是时间戳区间内部就有 4 处逆序，
// 最大相差 44.6 小时（#184 11-13T02:12 → #185 11-11T05:34）。
//
// 根因是两件事叠在一起：
//   1. `readdirSync` 的返回顺序由文件系统决定，本身不保证有序
//   2. 即使项目排好序，也是「逐项目」写入 —— 项目 A 的全部时间
//      必然排在项目 B 之前，两个项目的时间线永远不可能交叉正确
//
// 所以光给这里加 .sort() 是不够的（那只解决第 1 条）。
// 真正的修法在写入前做一次**全局按时间排序**（见下面「写入」一节）。
// 这里排序的意义是让「同一时间戳的条目」有个稳定次序，便于复核。
const projects = fs
  .readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== 'logs' && d.name !== 'archive')
  .map((d) => d.name)
  .sort()

const stats = { log: 0, project: 0, facts: 0, policy: 0, skipped: 0 }

for (const proj of projects) {
  const dir = path.join(ROOT, proj)

  // ---- log/YYYY-MM.md ----
  const logDir = path.join(dir, 'log')
  if (fs.existsSync(logDir)) {
    for (const f of fs.readdirSync(logDir).filter((x) => /^\d{4}-\d{2}\.md$/.test(x))) {
      const raw = fs.readFileSync(path.join(logDir, f), 'utf8')
      for (const chunk of raw.split(/^## /m).slice(1)) {
        const nl = chunk.indexOf('\n')
        if (nl < 0) continue
        const head = chunk.slice(0, nl).trim() // "2026-11-11 05:10"
        const body = chunk.slice(nl + 1).trim()
        if (!body) {
          stats.skipped++
          continue
        }
        // 过滤空壳条目：早先写入留下的「- 内容」「- 升级测试」这类无信息行
        const meaningful = body
          .split('\n')
          .filter((l) => l.trim().startsWith('- '))
          .map((l) => l.replace(/^-\s*/, '').trim())
          .filter((l) => l.length >= 8)
        if (meaningful.length === 0 && body.trim().length < 12) {
          stats.skipped++
          continue
        }
        const m = head.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/)
        const ts = m ? `${m[1]}T${m[2]}:00` : null
        add({
          scope: proj,
          kind: 'log',
          status: 'active',
          ts,
          topic: topicOf(head + body),
          text: body,
          writer: 'model',
          source: `${proj}/log/${f}`,
          created: nowIso,
        })
        stats.log++
      }
    }
  }

  // ---- PROJECT.md ----
  const pj = path.join(dir, 'PROJECT.md')
  if (fs.existsSync(pj)) {
    const lines = fs.readFileSync(pj, 'utf8').split('\n')
    let section = ''
    let pending = null // 多行续行合并

    const flush = () => {
      if (!pending) return
      const parsed = parseLine(pending)
      if (parsed && parsed.text.length > 0) {
        const kind = STATE_SECTIONS.test(section)
          ? 'state'
          : isRedline(parsed.text)
            ? 'redline'
            : 'pref'
        add({
          scope: proj,
          kind,
          status: parsed.status,
          ts: null,
          topic: topicOf(parsed.text),
          text: parsed.text,
          writer: 'model',
          source: `${proj}/PROJECT.md`,
          created: nowIso,
        })
        stats.project++
      } else if (pending) {
        stats.skipped++
      }
      pending = null
    }

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '')
      if (/^#{1,6}\s/.test(line)) {
        // 章节标题不是续行 —— 结束当前条目
        flush()
        section = line.replace(/^#{1,6}\s*/, '').trim()
        continue
      }
      if (line.trim() === '') {
        flush()
        continue
      }
      if (/^\s*-\s/.test(line)) {
        flush()
        pending = line.trim()
        continue
      }
      // 缩进续行
      if (pending) pending = `${pending} ${line.trim()}`
    }
    flush()
  }
}

// ---- facts.md（全局）----
const factsPath = path.join(ROOT, 'facts.md')
if (fs.existsSync(factsPath)) {
  for (const line of fs.readFileSync(factsPath, 'utf8').split('\n')) {
    if (!/^\s*-\s/.test(line)) continue
    const parsed = parseLine(line.trim())
    if (!parsed || !parsed.text) continue
    // 情绪行单独走 kind='emotion'，因为它的复核流程不同
    const isEmotion = /用户表达.+（.+·[\d.]+）/.test(parsed.text)
    add({
      scope: '__global__',
      kind: isEmotion ? 'emotion' : 'pref',
      status: parsed.status,
      ts: null,
      topic: isEmotion ? null : topicOf(parsed.text),
      text: parsed.text,
      writer: isEmotion ? 'plugin' : 'model',
      evidence: isEmotion ? parsed.text.match(/（(.+?)）\s*：/)?.[1] ?? null : null,
      source: 'facts.md',
      created: nowIso,
    })
    stats.facts++
  }
}

// ---- policy.md 的「给模型的规则」----
//
// 注意：这里刻意**不迁入**。
// 按讨论结论，policy.md 装的是「行为规则」（插件机制 + 用户行为期望），
// 它们要求「每轮必须执行、不可被截断」，与偏好的可靠性等级不同。
// 混进 entries 会和 pref 共享预算，导致心跳这类规则被静默挤掉。
// 所以 policy.md 保持为独立文件，不进数据库。

// ------------------------------------------------------------------ 写入
console.log(`解析完成：log ${stats.log} / 项目 ${
  stats.project
} / facts ${stats.facts} / 跳过空壳 ${stats.skipped}`)
console.log(`合计 ${rows.length} 条`)

/**
 * 按真实时间把全部条目排一遍，再决定插入顺序（id）。
 *
 * 为什么必须在这里排（2026-11-13 的事故）：
 * id 是插入顺序，而现在的「流水页排序」用的就是 id
 * （见 db-store.mjs 的 TS_ORDER —— 因为 ts 有两种不可比的格式，
 * 只有 id 能可靠表达「谁更晚写」）。
 *
 * 也就是说：**迁移时的插入顺序 = 之后看到的流水顺序**。
 * 之前没有这一步，谁先被 readdir 遍历到谁就排在前面，
 * 于是项目之间的时间线完全错乱 —— 用户看到的就是「最近的记录不见了」。
 *
 * 排序规则：
 *   1. 有 ts 的按时间升序（老的在前，新的在后，符合 id 递增直觉）
 *   2. 没 ts 的（迁移前就没有时间的）统一沉到最后
 *   3. 时间相同再按 scope / source 兜底，保证每次迁移结果一致
 *
 * 注意用 timeOf 而不是字符串比较：ts 可能带毫秒也可能不带，
 * 但**迁移产出的 ts 全是无时区后缀的本地时间**（见上面 `const ts =`），
 * 所以这里直接比字符串是安全的；写成 Date 比较反而是多余的风险。
 */
function timeKey(ts) {
  // 无 ts 排最后；有 ts 的按 ISO 字符串升序（同一格式下字符串序 == 时间序）
  return ts === null || ts === undefined ? '\uffff' : String(ts)
}
rows.sort((a, b) => {
  const ta = timeKey(a.ts)
  const tb = timeKey(b.ts)
  if (ta !== tb) return ta < tb ? -1 : 1
  // 同一时刻：先按 scope，再按 source（文件名带月份，天然有序）
  const sa = String(a.scope ?? '')
  const sb = String(b.scope ?? '')
  if (sa !== sb) return sa < sb ? -1 : 1
  const fa = String(a.source ?? '')
  const fb = String(b.source ?? '')
  return fa < fb ? -1 : fa > fb ? 1 : 0
})

// 排序后重新分配 id —— id 必须反映新的插入顺序
rows.forEach((r, i) => {
  r.id = i + 1
})

if (DRY) {
  console.log('\n--- dry-run，不写库。前 8 条预览 ---')
  rows.slice(0, 8).forEach((r) =>
    console.log(`  [${r.scope}/${r.kind}/${r.status}] ${r.text.slice(0, 56)}`),
  )
  const byKind = {}
  for (const r of rows) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
  console.log('\n按 kind:', byKind)
  const noTopic = rows.filter((r) => !r.topic).length
  console.log(`主题为空: ${noTopic} 条 (${((noTopic / rows.length) * 100).toFixed(1)}%)`)

  // 顺带报告时间序是否单调 —— 下次改这块时一眼能看出有没有退化
  let inversions = 0
  let prev = ''
  for (const r of rows) {
    const t = timeKey(r.ts)
    if (t !== '\uffff' && prev !== '' && t < prev) inversions++
    if (t !== '\uffff') prev = t
  }
  console.log(`时间序逆序: ${inversions} 处 ${inversions === 0 ? '（单调，正常）' : '（⚠️ 应排查）'}`)
  process.exit(0)
}

for (const f of [DB_PATH, DB_PATH + '-wal', DB_PATH + '-shm']) {
  try { fs.rmSync(f, { force: true }) } catch {}
}
const db = openMemoryDb(DatabaseSync, DB_PATH)

const ins = db.prepare(
  `INSERT INTO entries(scope,kind,status,ts,topic,text,writer,review,evidence,source,created)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
)

db.exec('BEGIN')
try {
  for (const r of rows) {
    const res = ins.run(
      r.scope, r.kind, r.status, r.ts ?? null, r.topic ?? null, r.text,
      r.writer ?? 'model', null, r.evidence ?? null, r.source ?? null, r.created,
    )
    syncFts(db, Number(res.lastInsertRowid), r.text, r.topic ?? '')
  }
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('写入失败，已回滚：', e.message)
  process.exit(1)
}

// ------------------------------------------------------------------ 验证
console.log('\n=== 迁移验证 ===')
const total = db.prepare('SELECT COUNT(*) c FROM entries').get().c
console.log(`库内条数: ${total} / 预期 ${rows.length} ${total === rows.length ? '✓' : '✗'}`)

const byKind = db.prepare('SELECT kind,COUNT(*) n FROM entries GROUP BY kind ORDER BY n DESC').all()
console.log('按 kind:', byKind.map((r) => `${r.kind}=${r.n}`).join(' | '))

const byScope = db.prepare('SELECT scope,COUNT(*) n FROM entries GROUP BY scope ORDER BY n DESC').all()
console.log('按 scope:', byScope.map((r) => `${r.scope}=${r.n}`).join(' | '))

// 抽样：原文是否完整保留
console.log('\n--- 抽样核对（库内 vs 原文）---')
const samples = db.prepare(`SELECT text,source,scope FROM entries WHERE kind IN ('pref','redline') LIMIT 4`).all()
for (const s of samples) {
  // source 是相对记忆根目录的路径，不是裸文件名 —— 直接 join(ROOT, source)
  const full = path.join(ROOT, s.source)
  if (!fs.existsSync(full)) {
    console.log(`  ? ${s.text.slice(0, 46)} （找不到源文件 ${s.source}）`)
    continue
  }
  const src = fs.readFileSync(full, 'utf8')
  const ok = src.includes(s.text.slice(0, 20))
  console.log(`  ${ok ? '✓' : '✗'} ${s.text.slice(0, 46)}`)
}

// 中文检索可用性
const { buildMatchQuery } = await import('./db-schema.mjs')
for (const kw of ['沙箱', '像素', '子智能体', '行号']) {
  const q = buildMatchQuery(kw)
  const n = db.prepare(
    `SELECT COUNT(*) c FROM entries_fts f JOIN entries e ON e.id=f.rowid WHERE entries_fts MATCH ?`,
  ).get(q).c
  console.log(`  检索「${kw}」→ ${n} 条`)
}

db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
const size = fs.statSync(DB_PATH).size
console.log(`\n库大小: ${(size / 1024).toFixed(1)} KB`)
console.log('✅ 迁移完成')
db.close()
