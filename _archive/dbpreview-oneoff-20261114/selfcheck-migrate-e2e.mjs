/**
 * 端到端迁移测试：把真实库迁到临时目录，验证整条链路。
 *
 * 目标目录用系统临时区的子目录，**不影响真实记忆库**（只读它）。
 * 测完自动清理。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const SRC_ROOT = 'D:/dsh-fatfishdream-memory'
const TMP_ROOT = path.join(os.tmpdir(), `migrate-e2e-${Date.now()}`)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

console.log(`源根: ${SRC_ROOT}`)
console.log(`目标: ${TMP_ROOT}\n`)

// ---- 1. 源库基线 ----
console.log('=== 1. 源库基线 ===\n')
const src = new DatabaseSync(path.join(SRC_ROOT, 'memory.db'), { readOnly: true })
const baseline = {}
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  baseline[t] = src.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
}
baseline.ftsLogs = src.prepare('SELECT COUNT(*) c FROM logs_fts').get().c
for (const [k, v] of Object.entries(baseline)) console.log(`  ${k.padEnd(8)} ${v}`)
src.close()

// ---- 2. 执行迁移（复刻 index.js 的 migrateRoot 关键步骤）----
console.log('\n=== 2. 执行迁移 ===\n')
fs.mkdirSync(TMP_ROOT, { recursive: true })

// 2a. 根级文本文件
let moved = 0
for (const f of ['policy.md', 'state.json']) {
  const s = path.join(SRC_ROOT, f)
  if (!fs.existsSync(s)) continue
  fs.copyFileSync(s, path.join(TMP_ROOT, f))
  moved++
}
console.log(`  文本文件复制 ${moved} 个`)

// 2b. 主数据库 —— VACUUM INTO（本次修复的核心）
const t0 = Date.now()
const db = new DatabaseSync(path.join(SRC_ROOT, 'memory.db'), { readOnly: true })
db.exec(`VACUUM INTO '${path.join(TMP_ROOT, 'memory.db').replace(/\\/g, '/')}'`)
db.close()
const nowIos = Date.now() - t0
console.log(`  memory.db 备份完成（${nowIos}ms）`)

// 2c. logs 目录
const logsSrc = path.join(SRC_ROOT, 'logs')
if (fs.existsSync(logsSrc)) {
  fs.mkdirSync(path.join(TMP_ROOT, 'logs'), { recursive: true })
  for (const f of fs.readdirSync(logsSrc)) {
    fs.copyFileSync(path.join(logsSrc, f), path.join(TMP_ROOT, 'logs', f))
  }
  console.log(`  logs 复制 ${fs.readdirSync(logsSrc).length} 个`)
}

// ---- 3. 校验 ----
console.log('\n=== 3. 迁移结果校验 ===\n')
const dst = new DatabaseSync(path.join(TMP_ROOT, 'memory.db'), { readOnly: true })
let allSame = true
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  const n = dst.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
  const ok = n === baseline[t]
  if (!ok) allSame = false
  console.log(`  ${ok ? '✅' : '❌'} ${t.padEnd(8)} ${n} / ${baseline[t]}`)
}
const dstFts = dst.prepare('SELECT COUNT(*) c FROM logs_fts').get().c
check('FTS 索引一致', dstFts === baseline.ftsLogs, `${dstFts} vs ${baseline.ftsLogs}`)
check('四张表条数全部一致', allSame)
check('integrity_check ok', dst.prepare('PRAGMA integrity_check').get().integrity_check === 'ok')

// 抽样比对真实内容
const sample = dst.prepare("SELECT text FROM rules WHERE status='active' LIMIT 1").get()
console.log(`\n  抽样规则: ${String(sample?.text ?? '').slice(0, 46)}…`)
check('抽样内容可读', typeof sample?.text === 'string' && sample.text.length > 0)

// 中文检索
const { segmentCjk } = await import('../dsh-memory/db-schema.mjs')
try {
  const hits = dst.prepare('SELECT rowid FROM logs_fts WHERE logs_fts MATCH ?').all(segmentCjk('沙箱'))
  console.log(`  中文检索「沙箱」→ ${hits.length} 行`)
  check('迁移后中文检索正常', hits.length > 0, `${hits.length}`)
} catch (e) {
  check('迁移后中文检索正常', false, e.message)
}
dst.close()

// ---- 4. 文件清单对比 ----
console.log('\n=== 4. 目标目录内容 ===\n')
for (const f of fs.readdirSync(TMP_ROOT)) {
  const st = fs.statSync(path.join(TMP_ROOT, f))
  console.log(`  ${st.isDirectory() ? '[目录]' : '[文件]'} ${f.padEnd(28)} ${st.isDirectory() ? '' : (st.size / 1024).toFixed(1) + ' KB'}`)
}

console.log('\n=== 5. 清理 ===\n')
try {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  console.log('  临时目录已删除')
} catch (e) {
  console.log('  ⚠️ 残留（不影响结论）：' + TMP_ROOT)
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
console.log('\n注意：本次只读取真实库，未修改它一个字。')
process.exit(fail === 0 ? 0 : 1)
