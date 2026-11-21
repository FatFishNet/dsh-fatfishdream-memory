/**
 * 回归测试：记忆根目录迁移必须把 memory.db 一起带走。
 *
 * 现场（2026-11-13）：用户点「整体迁移」后，新目录里 projects / logs 都在，
 * 但 memory.db 是个 4 KB 的空库 —— 记忆看起来全丢了。
 *
 * 两个 bug：
 *   1. 根级文件清单是文件时代遗留（facts/policy/state），没有 memory.db
 *   2. 就算加进清单也不行 —— copyTree 按文本读写，二进制库必然损坏
 *
 * 本测试用真实 SQLite 文件验证 VACUUM INTO 方案：
 *   - 源库有数据（含 WAL 未 checkpoint 的部分）
 *   - 复制后目标库数据完整
 *   - 目标库能独立打开（不依赖 -wal）
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from '../dsh-fatfishdream-memory/db-schema.mjs'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

const TMP = path.join(os.tmpdir(), `memtest-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })
const SRC = path.join(TMP, 'src.db')
const DST = path.join(TMP, 'dst.db')

/** 与 index.js 的 backupDbFile 相同实现 */
async function backupDbFile(from, to) {
  for (const p of [to, `${to}-wal`, `${to}-shm`]) {
    try { fs.rmSync(p, { force: true }) } catch {}
  }
  const db = new DatabaseSync(from, { readOnly: true })
  try {
    db.exec(`VACUUM INTO '${String(to).replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

console.log('=== 1. 造一个带数据的源库 ===\n')
const src = openMemoryDb(DatabaseSync, SRC)
// ⚠️ 必须走 syncFts 才会建索引 —— 直接 INSERT 到主表不会触发 FTS 更新，
// 那样测「FTS 是否随库复制」就是空测（源库本来就是 0 行）。
const { syncFts, segmentCjk } = await import('../dsh-fatfishdream-memory/db-schema.mjs')
const logRes = src.prepare(`INSERT INTO logs(scope,ts,topic,text,status,writer) VALUES(?,?,?,?,?,?)`).run(
  'proj-a', '2026-11-13T00:00:00.000Z', '开发日志', '第一条流水', 'active', 'model',
)
syncFts(src, 'logs', Number(logRes.lastInsertRowid), { text: '第一条流水', topic: '开发日志' })
const ruleRes = src.prepare(`INSERT INTO rules(scope,kind,ts,topic,text,status,writer,updated) VALUES(?,?,?,?,?,?,?,?)`).run(
  'proj-a', 'pref', '2026-11-13T00:00:00.000Z', '注入/预算', '无工具架构', 'active', 'model', '2026-11-13T00:00:00.000Z',
)
syncFts(src, 'rules', Number(ruleRes.lastInsertRowid), { text: '无工具架构', topic: '注入/预算' })

const srcLogs = src.prepare('SELECT COUNT(*) c FROM logs').get().c
const srcRules = src.prepare('SELECT COUNT(*) c FROM rules').get().c
const srcFts = src.prepare('SELECT COUNT(*) c FROM logs_fts').get().c
console.log(`  源库 logs=${srcLogs} rules=${srcRules} logs_fts=${srcFts}`)
check('源库有数据', srcLogs === 1 && srcRules === 1)
check('源库 FTS 索引已建立', srcFts === 1, `${srcFts}`)

// 关键：故意不 checkpoint，让数据留在 -wal 里
const walSize = fs.existsSync(`${SRC}-wal`) ? fs.statSync(`${SRC}-wal`).size : 0
console.log(`  源库 -wal 大小: ${walSize} 字节 ${walSize > 0 ? '（有未 checkpoint 的数据）' : ''}`)

console.log('\n=== 2. 用 VACUUM INTO 复制（源库仍开着连接）===\n')
await backupDbFile(SRC, DST)
const dstSize = fs.statSync(DST).size
console.log(`  目标库大小: ${(dstSize / 1024).toFixed(1)} KB`)
check('目标库已生成且非空', dstSize > 0)
check('目标库不依赖 -wal', !fs.existsSync(`${DST}-wal`) || fs.statSync(`${DST}-wal`).size === 0)

console.log('\n=== 3. 目标库数据完整性 ===\n')
const dst = new DatabaseSync(DST, { readOnly: true })
const dstLogs = dst.prepare('SELECT COUNT(*) c FROM logs').get().c
const dstRules = dst.prepare('SELECT COUNT(*) c FROM rules').get().c
console.log(`  目标库 logs=${dstLogs} rules=${dstRules}`)
check('logs 条数一致', dstLogs === srcLogs, `${dstLogs} vs ${srcLogs}`)
check('rules 条数一致', dstRules === srcRules, `${dstRules} vs ${srcRules}`)
check('integrity_check ok', dst.prepare('PRAGMA integrity_check').get().integrity_check === 'ok')

// 抽样比对内容
const dstText = dst.prepare("SELECT text FROM logs WHERE scope='proj-a'").get()?.text
check('流水正文一致', dstText === '第一条流水', String(dstText))

// FTS 是否也跟着过去了（查询词必须按 segmentCjk 拆，中文逐字）
try {
  const dstFts = dst.prepare('SELECT COUNT(*) c FROM logs_fts').get().c
  console.log(`  目标库 logs_fts=${dstFts}`)
  check('FTS 索引行数随库复制', dstFts === srcFts, `${dstFts} vs ${srcFts}`)
  const hit = dst.prepare(`SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?`).all(segmentCjk('流水'))
  check('FTS 可检索（中文按字）', hit.length > 0, `${hit.length} 行`)
} catch (e) {
  check('FTS 索引随库复制', false, e.message)
}
dst.close()

console.log('\n=== 4. 反证：copyTree 那种文本复制会损坏库 ===\n')
const BAD = path.join(TMP, 'bad.db')
// 复刻 copyTree 的行为：按 utf8 读、按 utf8 写
const text = fs.readFileSync(SRC, 'utf8')
fs.writeFileSync(BAD, text, 'utf8')
console.log(`  文本方式复制后大小: ${(fs.statSync(BAD).size / 1024).toFixed(1)} KB（原 ${(fs.statSync(SRC).size / 1024).toFixed(1)} KB）`)
let badOk = false
try {
  const b = new DatabaseSync(BAD, { readOnly: true })
  b.prepare('SELECT COUNT(*) c FROM logs').get()
  b.close()
  badOk = true
} catch (e) {
  console.log('  打开失败：' + e.message.slice(0, 60))
}
check('文本方式复制确实会损坏库（证明必须用 VACUUM INTO）', badOk === false, badOk ? '竟然能打开' : '')

console.log('\n=== 5. 清理 ===\n')
src.close()
try {
  // Windows 上 SQLite 文件句柄释放有延迟，直接 rm 偶发 EPERM，
  // 用 maxRetries 让它自己重试（不影响断言结论）。
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  console.log('  临时目录已删除')
} catch (e) {
  console.log('  ⚠️ 临时目录残留（不影响测试结论）：' + TMP)
  console.log('     ' + e.message.slice(0, 80))
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
