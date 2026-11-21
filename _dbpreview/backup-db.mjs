/**
 * 提交前备份数据库（VACUUM INTO，不能用 Copy-Item —— WAL 有未合并数据）。
 * 用法：node _dbpreview/backup-db.mjs <目标目录>
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const SRC = 'D:/dsh-fatfishdream-memory/memory.db'
const DIR = process.argv[2] || ('D:/workspace/dsh-fatfishdream-memory/_dbbackup/backup-' + Date.now())
const DST = path.join(DIR, 'memory.db')

fs.mkdirSync(DIR, { recursive: true })

const db = new DatabaseSync(SRC, { readOnly: true })
try {
  db.exec("VACUUM INTO '" + DST + "'")
} finally {
  db.close()
}

// 立刻校验
const check = new DatabaseSync(DST, { readOnly: true })
const counts = {}
for (const t of ['profile', 'rules', 'emotion', 'logs', 'archive']) {
  counts[t] = check.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
}
const qc = Object.values(check.prepare('PRAGMA quick_check').get())[0]
check.close()

console.log('备份文件:', DST)
console.log('大小:', (fs.statSync(DST).size / 1024 / 1024).toFixed(2), 'MB')
console.log('条数:', JSON.stringify(counts))
console.log('quick_check:', qc)
if (qc !== 'ok') {
  console.error('❌ 备份不可靠')
  process.exit(1)
}
