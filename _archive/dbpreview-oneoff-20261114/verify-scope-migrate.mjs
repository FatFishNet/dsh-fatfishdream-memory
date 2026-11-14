/**
 * 迁移后完整核对。
 *
 * 重点区分两件事，别混为一谈：
 *   - `exists` = 磁盘上还有没有 D:\FatFishDream-memory\<项目名> 目录
 *                 （数据早已迁进 SQLite，目录删掉是正常的）
 *   - 真正的数据 = memory.db 里按 scope 的条数
 */
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

const db = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })
const state = JSON.parse(fs.readFileSync(`${MEM_ROOT}/state.json`, 'utf8').replace(/^\uFEFF/, ''))

console.log('=== state.json 里注册的项目 vs 库里实际条数 ===\n')
let ok = 0
let bad = 0
for (const [key, p] of Object.entries(state.projects)) {
  const r = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(key).c
  const l = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(key).c
  const dirExists = p.cwd ? fs.existsSync(p.cwd) : false
  const hasData = r + l > 0
  const healthy = dirExists && hasData
  if (healthy) ok++
  else bad++
  console.log(`  ${healthy ? '✓' : '⚠'} ${key}`)
  console.log(`      cwd ${dirExists ? '存在' : '不存在'} | rules ${r} / logs ${l}`)
}

console.log(`\n  正常 ${ok} 个 / 异常 ${bad} 个`)

console.log('\n=== 库里所有 scope（含未注册的）===\n')
const scopes = new Set()
for (const t of ['rules', 'logs']) {
  for (const row of db.prepare(`SELECT DISTINCT scope FROM ${t} WHERE scope IS NOT NULL`).all()) {
    scopes.add(row.scope)
  }
}
for (const s of [...scopes].sort()) {
  const r = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(s).c
  const l = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(s).c
  const registered = s in state.projects ? '' : '  ← 未在 state.json 注册'
  console.log(`  ${s.padEnd(26)} rules ${String(r).padStart(3)} / logs ${String(l).padStart(3)}${registered}`)
}

console.log('\n=== 旧 scope 是否已彻底清除 ===\n')
for (const s of ['FatFishDream']) {
  const r = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(s).c
  const l = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(s).c
  console.log(`  ${s}: rules ${r} / logs ${l} ${r + l === 0 ? '✓ 已清空' : '✗ 仍有残留'}`)
}

console.log('\n=== 数据完整性 ===\n')
console.log('  integrity_check:', db.prepare('PRAGMA integrity_check').get().integrity_check)
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  console.log(`  ${t.padEnd(8)} ${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`)
}

db.close()
