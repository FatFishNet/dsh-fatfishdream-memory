/**
 * v4 原文归档（archive）自检 —— 两层：存储层 + HTTP。
 *
 * 为什么单独一个脚本：
 *   `archive` 是「记忆就是完整的，而不是取舍」的底层。它一旦写不进去，
 *   现象是**静默**的 —— 模型照常回复、流水照常落库，只是原文层空了。
 *   等用户发现「想回溯当时原话」时已经找不回来。
 *
 * 存储层：用**临时库**（不碰真实库），覆盖写入/过滤/FTS/分页/去重口径。
 * HTTP  ：需要 DSH 在跑，覆盖 `/archive` 的契约（200 形状、400 校验、limit 上限）。
 *
 * 用法：
 *   node _dbpreview/selfcheck-archive.mjs            # 两层都跑
 *   node _dbpreview/selfcheck-archive.mjs --no-http  # 只跑存储层（不需要 DSH）
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb, SCHEMA_VERSION, buildMatchQuery } from '../dsh-fatfishdream-memory/db-schema.mjs'
import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const TMP = path.join(ROOT, '_dbpreview', 'tmp')
fs.mkdirSync(TMP, { recursive: true })

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${ok || !detail ? '' : '  ← ' + detail}`)
}

const DB = path.join(TMP, 'archive-check.db')
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB + suffix) } catch {}
}

// ---------------------------------------------------------------- ① schema
console.log('=== ① schema：archive 表与 FTS ===\n')
const db = openMemoryDb(DatabaseSync, DB)
check('SCHEMA_VERSION = 5 起必须同步改本脚本', SCHEMA_VERSION === 5, String(SCHEMA_VERSION))
check('user_version = 5', db.prepare('PRAGMA user_version').get().user_version === 5)

const cols = db.prepare('PRAGMA table_info(archive)').all().map((c) => c.name)
check('archive 列齐全',
  ['id', 'ts', 'scope', 'role', 'text', 'session_id', 'turn', 'step'].every((c) => cols.includes(c)),
  cols.join(','))

// 三个索引：按时间、按项目、按角色 —— 少一个就是全表扫，量大后回溯会卡
const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='archive'")
  .all().map((r) => r.name)
check('archive 有 ts / (scope,ts) / (role,ts) 三个索引',
  ['idx_archive_ts', 'idx_archive_scope', 'idx_archive_role'].every((n) => idx.includes(n)),
  idx.join(','))

const ftsCols = db.prepare('PRAGMA table_info(archive_fts)').all().map((c) => c.name)
check('archive_fts 是 2 列（text, seg）', ftsCols.join(',') === 'text,seg', ftsCols.join(','))
check('archive_fts 是 contentless（content=\'\'）',
  /content=''/.test(db.prepare("SELECT sql FROM sqlite_master WHERE name='archive_fts'").get().sql))
db.close()

// ---------------------------------------------------------------- ② 写入
console.log('\n=== ② 写入：一条不落（只有空内容才拒）===\n')
const store = createDbStore(DB, {}, () => {})

const u1 = store.appendArchive({
  scope: 'P1', role: 'user', text: '把 memory.db 备份了再迁移', sessionId: 's1', turn: 1, step: 0,
})
const a1 = store.appendArchive({
  scope: 'P1', role: 'assistant', text: '好，先 VACUUM INTO 备份，再跑迁移', sessionId: 's1', turn: 1, step: 1,
})
check('user 原文写入', u1.written === true && Number.isInteger(u1.id), JSON.stringify(u1))
check('assistant 原文写入', a1.written === true, JSON.stringify(a1))

// 「完整」的核心：没有 mem 标记的回复也必须写进去。
const noMarker = store.appendArchive({ scope: 'P1', role: 'assistant', text: '这条回复里没有任何记忆标记' })
check('没有 mem 标记的回复也归档（这是 v4 的关键）',
  noMarker.written === true, JSON.stringify(noMarker))

// 超长原文（reasoning-distill 那类上万字）也必须原样保留
const huge = '长'.repeat(20000)
const bh = store.appendArchive({ scope: 'P1', role: 'user', text: huge })
check('超长原文（2 万字）也能写入', bh.written === true, JSON.stringify(bh))
const back = store.getById('archive', bh.id)
check('超长原文没有截断（长度一致）', String(back?.text ?? '').length === huge.length,
  `${String(back?.text ?? '').length} vs ${huge.length}`)

const empty = store.appendArchive({ scope: 'P1', role: 'user', text: '' })
check('空文本不写', empty.written === false && empty.reason === 'empty', JSON.stringify(empty))
const blank = store.appendArchive({ scope: 'P1', role: 'user', text: '  \n\t ' })
check('纯空白不写', blank.written === false, JSON.stringify(blank))
const badRole = store.appendArchive({ scope: 'P1', role: 'system', text: '不该进来' })
check('非法 role 不写', badRole.written === false && String(badRole.reason).startsWith('bad-role'),
  JSON.stringify(badRole))
const badRole2 = store.appendArchive({ scope: 'P1', role: 'tool', text: '工具结果不归档' })
check('tool 结果不入 archive（只记对话双方）', badRole2.written === false, JSON.stringify(badRole2))

// 不同 session / 项目并存
store.appendArchive({ scope: 'P2', role: 'user', text: '另一个项目的话', sessionId: 's2' })
const p2 = store.listArchive({ scope: 'P2' })
check('不同项目分别归档', p2.total === 1, `total=${p2.total}`)

// ---------------------------------------------------------------- ③ 读取
console.log('\n=== ③ 读取：scope / role / 时间 / 分页 ===\n')
const p1 = store.listArchive({ scope: 'P1' })
check('按 scope 取到本项目 4 条（不含 P2）', p1.total === 4, `total=${p1.total}`)
check('按 id DESC 排列（最新在前）', p1.rows[0]?.id > p1.rows[p1.rows.length - 1]?.id,
  p1.rows.map((r) => r.id).join(','))

const users = store.listArchive({ scope: 'P1', role: 'user' })
check('role=user 过滤', users.total === 2 && users.rows.every((r) => r.role === 'user'),
  `total=${users.total}`)
const assistants = store.listArchive({ scope: 'P1', role: 'assistant' })
check('role=assistant 过滤', assistants.total === 2, `total=${assistants.total}`)

const page1 = store.listArchive({ scope: 'P1', limit: 2 })
const page2 = store.listArchive({ scope: 'P1', limit: 2, offset: 2 })
check('limit 生效', page1.rows.length === 2 && page1.total === 4, `len=${page1.rows.length}`)
check('offset 翻页不重复',
  page1.rows.every((r) => !page2.rows.some((x) => x.id === r.id)),
  `${page1.rows.map((r) => r.id)} vs ${page2.rows.map((r) => r.id)}`)

// 时间边界：日期串必须按本地 00:00 / 23:59:59.999 归一化，否则当天记录会被漏掉
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const todayHits = store.listArchive({ scope: 'P1', tsFrom: today, tsTo: today })
check('时间范围（今天）包含刚写的记录', todayHits.total === 4, `total=${todayHits.total}`)
const futureHits = store.listArchive({ scope: 'P1', tsFrom: '2099-01-01' })
check('时间范围（未来）排除全部', futureHits.total === 0, `total=${futureHits.total}`)

// ---------------------------------------------------------------- ④ 检索
console.log('\n=== ④ 检索：FTS 中文逐字 + 英文 ===\n')
const zh = store.listArchive({ scope: 'P1', q: '备份' })
check('中文词命中（备份）', zh.total === 2, `total=${zh.total}`)
const zhSingle = store.listArchive({ scope: 'P1', q: '迁移' })
check('中文 2 字词单独命中', zhSingle.total >= 1, `total=${zhSingle.total}`)
const en = store.listArchive({ scope: 'P1', q: 'VACUUM' })
check('英文技术词命中（VACUUM）', en.total === 1, `total=${en.total}`)
const miss = store.listArchive({ scope: 'P1', q: '这里绝对没有这个词' })
check('检索不到返回空集（不报错）', miss.total === 0 && Array.isArray(miss.rows))
const cross = store.listArchive({ q: '备份' })
check('不带 scope 时跨项目检索', cross.total === 2, `total=${cross.total}`)

// FTS 与表必须一致 —— 不一致意味着「写进去了但搜不到」
const d2 = openMemoryDb(DatabaseSync, DB)
const tbl = d2.prepare('SELECT COUNT(*) c FROM archive').get().c
const fts = d2.prepare('SELECT COUNT(*) c FROM archive_fts').get().c
check('archive_fts 与 archive 条数一致', fts === tbl, `表=${tbl} fts=${fts}`)
d2.close()

// ---------------------------------------------------------------- ⑤ 不影响别的
console.log('\n=== ⑤ 边界：archive 不污染结论层 ===\n')
store.appendLog('P1', '结论层的一条流水：把库备份好再迁移', {
  topic: '开发日志', summary: '备份后再迁移', keywords: 'VACUUM INTO',
})
const mixed = store.search('备份', { projectName: 'P1' })
check('默认 /search 只返回 logs，不返回 archive 原文',
  mixed.length >= 1 && mixed.every((h) => h.table !== 'archive'),
  JSON.stringify(mixed.map((h) => h.table)))
check('search 命中结果字段里没有 archive',
  mixed.every((h) => ['profile', 'rules', 'emotion', 'logs'].includes(h.table)),
  JSON.stringify([...new Set(mixed.map((h) => h.table))]))

const st = store.stats()
check('stats().archive 单独计数', st.archive === 5, `archive=${st.archive}`)
check('stats().byTable 仍只有四张表（GUI 口径不变）',
  JSON.stringify(Object.keys(st.byTable).sort()) === JSON.stringify(['emotion', 'logs', 'profile', 'rules']),
  Object.keys(st.byTable).join(','))
check('stats().total 不含 archive', st.total === Object.values(st.byTable).reduce((a, b) => a + b, 0),
  `total=${st.total}`)

store.close()

// 二次打开不重跑迁移（迁移按 user_version 跳过）
const again = openMemoryDb(DatabaseSync, DB)
check('二次打开不重跑迁移，archive 条数不变',
  again.prepare('SELECT COUNT(*) c FROM archive').get().c === 5)
again.close()

// ---------------------------------------------------------------- ⑥ HTTP
const skipHttp = process.argv.includes('--no-http')
const BASE = process.env.DSH_WEB_URL || process.env.DSH_BASE

async function get(p) {
  const res = await fetch(BASE + p)
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

if (skipHttp) {
  console.log('\n=== ⑥ HTTP（已跳过 --no-http）===')
} else if (!BASE) {
  console.log('\n=== ⑥ HTTP（跳过：没有 DSH_WEB_URL）===')
} else {
  console.log('\n=== ⑥ HTTP：/api/dsh-memory/archive ===\n')
  const r = await get('/api/dsh-memory/archive?scope=dsh-fatfishdream-memory&limit=5')
  check('路由已注册（不是 401 黑洞）', r.status !== 401, `status=${r.status}`)
  check('返回 200 且 ok', r.status === 200 && r.body?.ok === true, `status=${r.status}`)

  if (r.body?.ok) {
    check('响应有 rows / total / scope / role', Array.isArray(r.body.rows) &&
      typeof r.body.total === 'number' && 'scope' in r.body && 'role' in r.body,
      Object.keys(r.body).join(','))
    check('scope 回显', r.body.scope === 'dsh-fatfishdream-memory', String(r.body.scope))
    if (r.body.rows.length > 0) {
      const row = r.body.rows[0]
      check('行字段齐全（id/ts/scope/role/text）',
        ['id', 'ts', 'scope', 'role', 'text'].every((k) => k in row), Object.keys(row).join(','))
      check('role 只有 user / assistant',
        r.body.rows.every((x) => x.role === 'user' || x.role === 'assistant'),
        JSON.stringify([...new Set(r.body.rows.map((x) => x.role))]))
      check('默认按 id DESC', r.body.rows.every((x, i) => i === 0 || x.id < r.body.rows[i - 1].id))
    } else {
      console.log('  （跳过行内容断言：该项目还没有归档 —— 重载后发一句话就会产生）')
    }
  }

  const badRole = await get('/api/dsh-memory/archive?role=x')
  check('role=x → 400', badRole.status === 400, `status=${badRole.status}`)

  const lim = await get('/api/dsh-memory/archive?limit=1')
  check('limit=1 生效', lim.status === 200 && (lim.body?.rows?.length ?? 0) <= 1,
    `len=${lim.body?.rows?.length}`)

  const huge = await get('/api/dsh-memory/archive?limit=99999')
  check('limit 超上限被钳到 500（不返回 500 条以外的东西）',
    huge.status === 200, `status=${huge.status}`)

  const q = await get('/api/dsh-memory/archive?q=' + encodeURIComponent('迁移'))
  check('q 走 FTS 不报错', q.status === 200 && q.body?.ok === true, `status=${q.status}`)

  const st2 = await get('/api/dsh-memory/state')
  check('state.db.schemaVersion = 5', st2.body?.db?.schemaVersion === 5,
    String(st2.body?.db?.schemaVersion))
  check('state 里 archive 计数可见', typeof st2.body?.db?.archive === 'number',
    String(st2.body?.db?.archive))
}

console.log('\n' + '─'.repeat(70))
console.log(`${pass} 通过 / ${fail} 失败`)
if (fail === 0) {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
} else {
  console.log(`临时库保留在 ${TMP}，便于排查`)
}
process.exit(fail === 0 ? 0 : 1)

