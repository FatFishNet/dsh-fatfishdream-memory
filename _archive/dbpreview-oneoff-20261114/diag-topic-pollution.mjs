/**
 * 核实「另一个会话报告的 topic 污染 bug」。
 *
 * 反馈原文：
 *   1. topic 字段的值是「开发日志 -->」，`-->` 被一起吃进去了
 *   2. 注入里「记忆索引」显示「开发日志（4 条）」，但库里带这个 topic 的远不止 4 条
 *   3. 成因猜测：写标记时把 `-->` 写在 topic 同一行
 *
 * 本脚本只读，逐条验证。
 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('D:/dsh-fatfishdream-memory/memory.db', { readOnly: true })

const ALLOWED = [
  '开发日志', '技术讨论', '构建/编译', '注入/预算', '插件/装载', '路径/沙箱',
  '格式/编码', '文档/行号', '情绪判据', '用户画像', '数据清理', 'GUI/界面', 'Git',
]

console.log('=== 1. 全部 topic 取值（logs + rules）===\n')
const rows = db
  .prepare(
    `SELECT 'logs' AS t, topic, COUNT(*) c FROM logs WHERE status='active' GROUP BY topic
     UNION ALL
     SELECT 'rules', topic, COUNT(*) FROM rules WHERE status='active' GROUP BY topic
     ORDER BY c DESC`,
  )
  .all()
for (const r of rows) {
  const topic = r.topic ?? '(NULL)'
  const bad = r.topic !== null && !ALLOWED.includes(r.topic)
  console.log(`  ${r.t.padEnd(6)} ${String(r.c).padStart(3)} 条  ${bad ? '⚠️ ' : '   '}${JSON.stringify(topic)}`)
}

console.log('\n=== 2. 不合法 topic 的明细 ===\n')
const bad = rows.filter((r) => r.topic !== null && !ALLOWED.includes(r.topic))
if (bad.length === 0) {
  console.log('  ✓ 没有不合法的 topic')
} else {
  for (const b of bad) {
    console.log(`  ${b.t} / ${JSON.stringify(b.topic)} — ${b.c} 条`)
    const sample = db
      .prepare(`SELECT id, ts, text FROM ${b.t} WHERE status='active' AND topic=? LIMIT 3`)
      .all(b.topic)
    for (const s of sample) {
      console.log(`     #${s.id} ${s.ts}  ${String(s.text).slice(0, 56).replace(/\n/g, ' ')}`)
    }
  }
}

console.log('\n=== 3. 「开发日志」到底有多少条 ===\n')
for (const t of ['logs', 'rules']) {
  const exact = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE status='active' AND topic='开发日志'`).get().c
  const like = db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE status='active' AND topic LIKE '开发日志%'`).get().c
  console.log(`  ${t.padEnd(6)} topic='开发日志' 精确 ${exact} 条，LIKE '开发日志%' ${like} 条`)
}

console.log('\n=== 4. 注入里的「记忆索引」是怎么算的 ===\n')
// routeTable 的 SQL：topic IS NOT NULL AND (scope=? OR scope='__global__')
const routeRows = db
  .prepare(
    `SELECT topic, n FROM (
       SELECT topic, COUNT(*) n FROM logs
        WHERE status='active' AND topic IS NOT NULL AND (scope='dsh-fatfishdream-memory' OR scope='__global__')
        GROUP BY topic
       UNION ALL
       SELECT topic, COUNT(*) FROM rules
        WHERE status='active' AND topic IS NOT NULL AND (scope='dsh-fatfishdream-memory' OR scope='__global__')
        GROUP BY topic
     ) GROUP BY topic ORDER BY n DESC`,
  )
  .all()
console.log('  routeTable（当前项目 dsh-fatfishdream-memory）会产出的行：')
for (const r of routeRows) {
  const inWhite = ALLOWED.includes(r.topic)
  console.log(`    ${String(r.n).padStart(3)} 条  ${inWhite ? '✓' : '⚠️不在白名单'}  ${JSON.stringify(r.topic)}`)
}

console.log('\n=== 5. 找带「-->」的 topic ===\n')
const arrow = db
  .prepare(
    `SELECT 'logs' AS t, id, topic, ts FROM logs WHERE topic LIKE '%--%'
     UNION ALL SELECT 'rules', id, topic, ts FROM rules WHERE topic LIKE '%--%'`,
  )
  .all()
if (arrow.length === 0) {
  console.log('  ✓ 没有 topic 含 "--"')
} else {
  console.log(`  发现 ${arrow.length} 条：`)
  for (const a of arrow.slice(0, 20)) console.log(`    ${a.t} #${a.id} ${a.ts}  ${JSON.stringify(a.topic)}`)
}

db.close()
