/**
 * v2.1 迁移：合并 kind='fact' 到 'pref'。
 *
 * 背景（2026-11-13 用户决定）：
 *   「偏好」和「事实」在实际使用中区分不出来，用户原话是
 *   「目前的情况是我也分辨不出来，所以两种定义合并即可」。
 *
 * 为什么该合并：
 *   两者对系统行为没有任何不同影响 —— 注入排序、截断优先级、预算计算、
 *   升级为全局，全部一致。既然行为一样，区分只增加判断负担，没有收益。
 *   （实测 rules 表 72 条 pref 里装的大多是技术约定，
 *     而 2 条 fact 反而是用户偏好，说明这个分类在实操中是失败的。）
 *
 * 处理规则：
 *   1. scope='__global__' 的 fact → 属于用户画像，应进 profile 表；
 *      若 profile 里已有相同/更新版本则不重复插入，原条目标 stale
 *   2. 其余 fact → kind 改为 'pref'
 *
 * 用法：node db-merge-fact.mjs <db路径> [--dry-run]
 */
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const DB = process.argv[2]
const DRY = process.argv.includes('--dry-run')
if (!DB) {
  console.error('用法: node db-merge-fact.mjs <db路径> [--dry-run]')
  process.exit(1)
}

const db = new DatabaseSync(DB)
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')

const facts = db.prepare(`SELECT id,scope,status,text FROM rules WHERE kind='fact'`).all()
console.log(`找到 kind='fact' 的条目：${facts.length} 条`)

if (facts.length === 0) {
  console.log('无需处理')
  db.close()
  process.exit(0)
}

const profileRows = db.prepare(`SELECT id,text FROM profile`).all()
const profileTexts = profileRows.map((r) => r.text)

const plan = []
for (const f of facts) {
  const exactDup = profileTexts.includes(f.text)
  // 相似：前 20 字相同 —— 说明是同一条被改写过（用户可能编辑过更新版本）
  const fuzzy = profileRows.find((p) => p.text.slice(0, 20) === f.text.slice(0, 20))
  if (f.scope === '__global__') {
    if (exactDup) {
      plan.push({ action: 'stale', id: f.id, reason: 'profile 已有完全相同的条目' })
    } else if (fuzzy) {
      plan.push({
        action: 'stale',
        id: f.id,
        reason: `profile #${fuzzy.id} 是它的更新版本：${fuzzy.text.slice(0, 40)}…`,
      })
    } else {
      plan.push({ action: 'move-to-profile', id: f.id, reason: '用户偏好，profile 里还没有' })
    }
  } else {
    plan.push({ action: 'to-pref', id: f.id, reason: '项目级，合并为 pref' })
  }
}

console.log('\n=== 处理计划 ===')
for (const p of plan) {
  console.log(`  #${p.id}  ${p.action.padEnd(16)} ${p.reason}`)
}

if (DRY) {
  console.log('\n（dry-run，未改动）')
  db.close()
  process.exit(0)
}

// 备份
const backup = `${DB}.before-merge-fact`
if (!fs.existsSync(backup)) {
  fs.copyFileSync(DB, backup)
  console.log(`\n已备份 → ${backup.split(/[\\/]/).pop()}`)
}

const now = new Date().toISOString()
let moved = 0
let staled = 0
let converted = 0

db.exec('BEGIN')
try {
  for (const p of plan) {
    const row = facts.find((f) => f.id === p.id)

    if (p.action === 'stale') {
      // 不删数据，标 stale —— 记忆是历史，留痕可查
      db.prepare(`UPDATE rules SET status='stale' WHERE id=?`).run(p.id)
      staled++
    } else if (p.action === 'move-to-profile') {
      const res = db
        .prepare(`INSERT INTO profile(ts,topic,text,status,writer,updated) VALUES(?,?,?,?,?,?)`)
        .run(now, null, row.text, 'active', 'model', now)
      const newId = Number(res.lastInsertRowid)
      // 同步 profile 的 FTS
      const seg = String(row.text)
        .replace(/[\u4e00-\u9fa5]/g, (c) => ` ${c} `)
        .replace(/\s+/g, ' ')
        .trim()
      db.prepare(`INSERT INTO profile_fts(rowid,text,topic,seg) VALUES(?,?,?,?)`)
        .run(newId, row.text, '', seg)
      // 原条目在 rules 里标 stale
      db.prepare(`UPDATE rules SET status='stale' WHERE id=?`).run(p.id)
      moved++
    } else if (p.action === 'to-pref') {
      db.prepare(`UPDATE rules SET kind='pref' WHERE id=?`).run(p.id)
      converted++
    }
  }
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  console.error('失败，已回滚：', e.message)
  db.close()
  process.exit(1)
}

console.log('\n=== 完成 ===')
console.log(`  移入 profile：${moved}`)
console.log(`  标记 stale ：${staled}`)
console.log(`  转为 pref  ：${converted}`)

// 校验
console.log('\n=== 校验 ===')
const remainFact = db.prepare(`SELECT COUNT(*) c FROM rules WHERE kind='fact'`).get().c
console.log(`  rules 表剩余 kind='fact'：${remainFact} ${remainFact === 0 ? '✓' : '✗'}`)
const kinds = db.prepare(`SELECT kind,COUNT(*) n FROM rules WHERE status='active' GROUP BY kind ORDER BY n DESC`).all()
console.log(`  active 的 kind 分布：${kinds.map((k) => `${k.kind}=${k.n}`).join(' | ')}`)
const profCount = db.prepare(`SELECT COUNT(*) c FROM profile WHERE status='active'`).get().c
console.log(`  profile 表 active：${profCount} 条`)

db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.close()
console.log('\n✅ 合并完成')
