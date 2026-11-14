/**
 * scope 迁移：FatFishDream → dsh-fatfishdream-memory
 *
 * 背景（2026-11-13）：工作区从 D:\workspace\FatFishDream 移到
 * D:\workspace\dsh-fatfishdream-memory。scope key 是由**目录名**推导的
 * （见 index.js 的 resolveProjectKey → projectNameOf + slugify），
 * 所以新会话写进来的记忆会落到新 key，而历史 32 条 rules + 191 条 logs
 * 还挂在旧 key 上 —— 表现就是注入里「项目结论」整段消失。
 *
 * 本脚本只改 scope 列，不动 text / ts / status / 任何别的东西。
 *
 * 用法：
 *   node _dbpreview/migrate-scope.mjs            # 预演，只打印
 *   node _dbpreview/migrate-scope.mjs --apply    # 真改
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

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

const DB = `${MEM_ROOT}/memory.db`
const OLD = 'FatFishDream'
const NEW = 'dsh-fatfishdream-memory'
const APPLY = process.argv.includes('--apply')

const db = new DatabaseSync(DB)

console.log(`模式：${APPLY ? '⚠️ 实际写入' : '预演（不改任何东西）'}`)
console.log(`scope：${OLD}  →  ${NEW}\n`)

// ---- 安全前置检查 ----
console.log('=== 1. 前置检查 ===')

// 1a. 旧 key 必须存在
const oldRules = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(OLD).c
const oldLogs = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(OLD).c
console.log(`  旧 scope：rules ${oldRules} 条 / logs ${oldLogs} 条`)
if (oldRules + oldLogs === 0) {
  console.log('  ✗ 旧 scope 没有数据，无事可做')
  db.close()
  process.exit(0)
}

// 1b. 新 key 必须为空，否则会混进别的记忆
const newRules = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(NEW).c
const newLogs = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(NEW).c
console.log(`  新 scope：rules ${newRules} 条 / logs ${newLogs} 条`)
if (newRules + newLogs > 0) {
  console.log('  ✗ 新 scope 已有数据，直接改名会混在一起 —— 必须先人工确认')
  db.close()
  process.exit(1)
}
console.log('  ✓ 新 scope 为空，不会冲突')

// 1c. 记下其它 scope，改完要核对它们没被动
const before = db.prepare('SELECT scope, COUNT(*) c FROM rules GROUP BY scope').all()
const beforeLogs = db.prepare('SELECT scope, COUNT(*) c FROM logs GROUP BY scope').all()

// ---- 2. 执行 ----
console.log('\n=== 2. 执行 ===')
if (APPLY) {
  db.exec('BEGIN')
  try {
    const r1 = db.prepare('UPDATE rules SET scope=? WHERE scope=?').run(NEW, OLD)
    const r2 = db.prepare('UPDATE logs SET scope=? WHERE scope=?').run(NEW, OLD)
    db.exec('COMMIT')
    console.log(`  ✓ rules 改了 ${r1.changes} 行`)
    console.log(`  ✓ logs  改了 ${r2.changes} 行`)
  } catch (e) {
    db.exec('ROLLBACK')
    console.log('  ✗ 出错已回滚：' + e.message)
    db.close()
    process.exit(1)
  }
} else {
  console.log('  （预演，未写入）')
}

// ---- 3. 校验 ----
console.log('\n=== 3. 校验 ===')
const afterRules = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(NEW).c
const afterLogs = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(NEW).c
const leftRules = db.prepare('SELECT COUNT(*) c FROM rules WHERE scope=?').get(OLD).c
const leftLogs = db.prepare('SELECT COUNT(*) c FROM logs WHERE scope=?').get(OLD).c

console.log(`  新 scope 现在：rules ${afterRules} / logs ${afterLogs}`)
console.log(`  旧 scope 残留：rules ${leftRules} / logs ${leftLogs}`)

if (APPLY) {
  if (afterRules === oldRules && afterLogs === oldLogs && leftRules === 0 && leftLogs === 0) {
    console.log('  ✓ 条数完全对上，旧 scope 已清空')
  } else {
    console.log('  ✗ 条数对不上！')
  }
}

// 其它 scope 必须原封不动
console.log('\n=== 4. 其它 scope 未受影响 ===')
const after = db.prepare('SELECT scope, COUNT(*) c FROM rules GROUP BY scope').all()
const afterLogs2 = db.prepare('SELECT scope, COUNT(*) c FROM logs GROUP BY scope').all()
let touched = 0
for (const t of ['rules', 'logs']) {
  const b = t === 'rules' ? before : beforeLogs
  const a = t === 'rules' ? after : afterLogs2
  for (const row of b) {
    if (row.scope === OLD) continue
    const now = a.find((x) => x.scope === row.scope)
    if (!now || now.c !== row.c) {
      console.log(`  ✗ ${t} / ${row.scope} 从 ${row.c} 变成 ${now ? now.c : '不存在'}`)
      touched++
    }
  }
}
console.log(touched === 0 ? '  ✓ 其它 scope 条数全部未变' : `  ✗ ${touched} 处异常`)

// ---- 5. 迁移后会注入什么 ----
if (APPLY) {
  console.log('\n=== 5. 注入预览（新 scope 的 active rules）===')
  const rows = db
    .prepare(
      `SELECT id, topic, kind, substr(text,1,64) t FROM rules
       WHERE scope=? AND status='active' AND review IS NOT 'retracted'
       ORDER BY CASE kind WHEN 'redline' THEN 0 WHEN 'pref' THEN 1 WHEN 'state' THEN 2 ELSE 3 END, id`,
    )
    .all(NEW)
  console.log(`  active 共 ${rows.length} 条：`)
  for (const r of rows) console.log(`    #${r.id} [${r.topic ?? '-'}] ${r.t}`)
}

db.close()
