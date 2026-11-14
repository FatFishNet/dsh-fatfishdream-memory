/** 备份数据库（VACUUM INTO，在线备份，不需独占锁） */
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import fs from 'node:fs'

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

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = 'D:/workspace/dsh-fatfishdream-memory/_dbbackup'
fs.mkdirSync(outDir, { recursive: true })
const out = `${outDir}/memory.db.before-scope-${stamp}`

const db = new DatabaseSync(`${MEM_ROOT}/memory.db`)
db.exec(`VACUUM INTO '${out}'`)
db.close()

const size = fs.statSync(out).size
console.log(`备份完成：${out}`)
console.log(`大小：${(size / 1024 / 1024).toFixed(2)} MB`)
