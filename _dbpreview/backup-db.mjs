/**
 * 在线备份（放到工作区内，因为记忆根目录在沙箱外不可写）。
 * 用 VACUUM INTO 保证一致性，不需要独占锁。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 记忆根目录从指针文件读，不要写死 —— 迁移根目录后脚本会全崩。
// 指针由插件自己维护（~/.dsh/memory-root.json）。
const resolveMemoryRoot = () => {
  const cands = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'memory-root.json'),
  ]
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      if (j && typeof j.root === 'string' && j.root !== '') return j.root
    } catch {
      /* 下一个候选 */
    }
  }
  return 'D:\\dsh-fatfishdream-memory'
}
const MEM_ROOT = resolveMemoryRoot().replace(/\\/g, '/')

const src = `${MEM_ROOT}/memory.db`
// 从脚本自身位置推仓库根，别写死绝对路径（2026-11-13 工作区改名踩过）
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(REPO, '_dbbackup')
fs.mkdirSync(dir, { recursive: true })

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const dst = path.join(dir, `memory.db.before-topic-fill-${ts}`)

const d = new DatabaseSync(src)
try {
  d.exec(`VACUUM INTO '${dst.replace(/\\/g, '/')}'`)
} finally {
  d.close()
}

const size = fs.statSync(dst).size
console.log(`已备份 → ${dst}`)
console.log(`大小: ${(size / 1024 / 1024).toFixed(2)} MB`)

const b = new DatabaseSync(dst, { readOnly: true })
const counts = {}
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  counts[t] = b.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
}
const integ = b.prepare('PRAGMA integrity_check').get().integrity_check
b.close()

const o = new DatabaseSync(src, { readOnly: true })
const orig = {}
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  orig[t] = o.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c
}
o.close()

console.log(`integrity: ${integ}`)
console.log('备份:', JSON.stringify(counts))
console.log('原始:', JSON.stringify(orig))
console.log('一致:', JSON.stringify(counts) === JSON.stringify(orig) ? '是' : '否')
