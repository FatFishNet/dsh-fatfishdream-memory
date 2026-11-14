/**
 * 清理 state.json 里已失效的项目条目。
 *
 * 背景（2026-11-13）：工作区 FatFishDream 被删除，改名为
 * dsh-fatfishdream-memory。state.json 里还留着旧条目，
 * 其 cwd 指向不存在的目录 —— 留着会让 GUI 存储设置页显示幽灵项目。
 *
 * 安全策略：
 *   - 只处理「cwd 指向不存在的目录」且「数据库里已无该 scope 数据」的条目
 *   - 有数据但目录不存在 → 只报告，不删（可能是临时移走的项目）
 *   - 全程只改 state.json，不碰 memory.db
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

const STATE = `${MEM_ROOT}/state.json`
const DB = `${MEM_ROOT}/memory.db`
const APPLY = process.argv.includes('--apply')

// Windows 记事本/PowerShell 保存的 JSON 常带 BOM，裸 JSON.parse 会抛错
function parseJson(text) {
  return JSON.parse(String(text).replace(/^\uFEFF/, ''))
}

const raw = fs.readFileSync(STATE, 'utf8')
const state = parseJson(raw)
const hadBom = raw.charCodeAt(0) === 0xfeff

const db = new DatabaseSync(DB, { readOnly: true })
const countOf = (scope) => {
  const r = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(scope).c
  const l = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(scope).c
  return { rules: r, logs: l }
}

console.log(`模式：${APPLY ? '⚠️ 实际写入' : '预演'}`)
console.log(`state.json 原文件${hadBom ? '带' : '不带'} BOM\n`)

console.log('=== 逐个检查已注册项目 ===\n')
const remove = []
for (const [key, p] of Object.entries(state.projects ?? {})) {
  const dirExists = p.cwd ? fs.existsSync(p.cwd) : false
  const data = countOf(key)
  const hasData = data.rules + data.logs > 0
  let verdict
  if (dirExists) {
    verdict = '保留（目录存在）'
  } else if (hasData) {
    verdict = `⚠️ 目录不存在但库里有数据（rules ${data.rules} / logs ${data.logs}）—— 不自动删`
  } else {
    verdict = '删除（目录不存在且库里无数据）'
    remove.push(key)
  }
  console.log(`  ${key}`)
  console.log(`     cwd      ${p.cwd ?? '(无)'}`)
  console.log(`     目录     ${dirExists ? '存在' : '不存在'}`)
  console.log(`     库里数据 rules ${data.rules} / logs ${data.logs}`)
  console.log(`     判定     ${verdict}\n`)
}

console.log(`待删除 ${remove.length} 个：${remove.join(', ') || '(无)'}`)

if (APPLY && remove.length > 0) {
  for (const k of remove) delete state.projects[k]
  // 保持与插件一致的写法：2 空格缩进 + 结尾换行
  const out = `${JSON.stringify(state, null, 2)}\n`
  fs.writeFileSync(STATE, out, 'utf8')
  console.log('\n✓ 已写回 state.json')
  console.log('  剩余项目：' + Object.keys(state.projects).join(', '))
} else if (APPLY) {
  console.log('\n无事可做')
}

db.close()
