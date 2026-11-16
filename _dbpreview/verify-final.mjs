// 最终核对：空 topic 是否清零、残留分类是否已消除
//
// ⚠️ 2026-11-17 修：这个脚本原来**只有 console.log，没有任何断言**，
//   退出码恒 0 —— 而它挂在 `run-all.mjs` 的 SCRIPTS 里，等于回归里
//   挂了一个永远不会红的条目（审计代理把它列为 P0 #1）。
//
//   现在补三类可失败断言：
//     ① 数据完整性 integrity_check 必须是 'ok'
//     ② 四张业务表必须都能查（表缺失/库损坏都会抛）
//     ③ 已废弃分类「测量/像素」「记忆机制」不得有残留
//
//   ⚠️ 不要断言「空 topic 必须为 0」：日志表里历史数据本来就有空 topic
//   （早期没强制），拿它当失败条件会立刻变红，而那不是当前要防的事。
//   这里只**打印**数量，不判定 —— 与 AGENTS.md「没有断言可写时就别产生断言」一致。
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

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

const d = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })

function stat(sql) {
  return d.prepare(sql).get().c
}

console.log('=== 空 topic 检查（仅打印，不判定）===')
for (const t of ['logs', 'rules']) {
  const total = stat(`SELECT COUNT(*) c FROM ${t} WHERE status='active'`)
  const empty = stat(`SELECT COUNT(*) c FROM ${t} WHERE status='active' AND (topic IS NULL OR topic='')`)
  console.log(`  ${t.padEnd(6)} active ${String(total).padStart(3)} · 空 topic ${empty}`)
}

console.log('\n=== 已废弃分类的残留 ===')
const DEPRECATED = ['测量/像素', '记忆机制']
for (const topic of DEPRECATED) {
  for (const t of ['logs', 'rules']) {
    // topic 用参数绑定，不要拼进 SQL
    const n = d.prepare(`SELECT COUNT(*) c FROM ${t} WHERE status='active' AND topic=?`).get(topic).c
    check(`已废弃分类「${topic}」不在 ${t} 里残留`, n === 0, n > 0 ? `仍有 ${n} 条` : '')
    if (n > 0) {
      for (const r of d
        .prepare(
          `SELECT id, scope, substr(replace(text, char(10), ' '), 1, 60) x FROM ${t} WHERE status='active' AND topic=? ORDER BY id`,
        )
        .all(topic)) {
        console.log(`      #${r.id} [${String(r.scope).slice(0, 14)}] ${r.x}`)
      }
    }
  }
}

console.log('\n=== 最终 topic 总览（两表合计）===')
const agg = {}
for (const t of ['logs', 'rules']) {
  for (const r of d
    .prepare(`SELECT topic, COUNT(*) n FROM ${t} WHERE status='active' AND topic IS NOT NULL AND topic!='' GROUP BY topic`)
    .all()) {
    agg[r.topic] = (agg[r.topic] ?? 0) + r.n
  }
}
for (const [t, n] of Object.entries(agg).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(14)} ${n}`)
}

console.log('\n=== 数据完整性 ===')
const integrity = d.prepare('PRAGMA integrity_check').get().integrity_check
check('PRAGMA integrity_check 为 ok', integrity === 'ok', String(integrity))

// 四张业务表都必须可查：表缺失或库损坏时会抛，抛了就红。
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  let n = -1
  try {
    n = stat(`SELECT COUNT(*) c FROM ${t}`)
  } catch (e) {
    check(`表 ${t} 可查询`, false, String(e?.message ?? e))
    continue
  }
  check(`表 ${t} 可查询`, n >= 0, `${n} 行`)
}

d.close()

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)

