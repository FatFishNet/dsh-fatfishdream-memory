/**
 * 回归：`/entries` 接口的参数约定不得回退。
 *
 * 背景（2026-11-13）：
 *   该路由原来写 `q.get('table') || 'rules'`，缺省时默默查 rules。
 *   外部调用方（新学会查记忆的模型）传 `?kind=logs` 时就会落到这里 ——
 *   以为在查流水，实际查了 rules 并附加 kind='logs' 过滤，返回 0 条 + ok:true。
 *   属于「错了也看不出来」的静默失效。
 *
 * 本测试锁两件事：
 *   A. 源码层面：table 不得有缺省回落
 *   B. 行为层面（需要 DSH 在跑）：table 缺省必须 400；显式 table 必须能取到数据
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IDX = fs.readFileSync(path.join(REPO, 'dsh-memory/index.js'), 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}${!ok && detail ? '  ← ' + detail : ''}`)
}

console.log('=== A. 源码：table 不得静默回落 ===\n')

// 抽 entries 路由的处理体
const start = IDX.indexOf("path: '/api/dsh-memory/entries'")
if (start < 0) {
  console.log('❌ 找不到 entries 路由')
  process.exit(1)
}
const nextRoute = IDX.indexOf("path: '/api/dsh-memory/", start + 30)
const RAW = IDX.slice(start, nextRoute > start ? nextRoute : start + 2000)
// ⚠️ 检查前必须剥掉注释：这次的修复注释里原样引用了旧写法
//    `q.get('table') || 'rules'`，不剥注释会把它误判成现役代码（实测踩过）。
//    教训与注入文案检查同源：判「代码做了什么」时，注释不是证据。
const BODY = RAW.split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

check(
  'table 无 `|| ` 缺省回落',
  !/q\.get\(['"]table['"]\)\s*\|\|/.test(BODY),
  '写成 q.get(\'table\') || \'rules\' 会让缺省时静默查 rules',
)
check(
  'table 缺失时返回 400',
  /if\s*\(\s*!table\s*\)[\s\S]{0,200}?json\(res,\s*400/.test(BODY),
  '缺少「table 为空 → 400」的短路',
)
check(
  '仍校验 table 白名单',
  /\['profile',\s*'rules',\s*'emotion',\s*'logs'\]\.includes\(table\)/.test(BODY),
)

console.log('\n=== B. 注释：不得再宣称「默认 rules」 ===\n')
check(
  '无「默认 rules（GUI 最常用）」这类说明',
  !/默认\s*rules/.test(IDX),
  '注释仍写着默认 rules，与现行为矛盾',
)

console.log('\n=== C. 注入里不得教模型用 /entries ===\n')
// 模型只该用 /search；entries 是 GUI 翻页接口，四张表列不同、容易传错
const injStart = IDX.indexOf('const usageLines = dbMode')
const injEnd = IDX.indexOf('      : [', injStart)
const USAGE = injStart >= 0 ? IDX.slice(injStart, injEnd) : ''
check('usageLines 不提 dsh-memory/entries', !USAGE.includes('dsh-memory/entries'))
check('usageLines 指向 search 接口', /api\/dsh-memory\/search/.test(USAGE))

console.log('\n=== D. 行为（需 DSH 在跑，未跑则跳过）===\n')
const BASE = process.env.DSH_WEB_URL || process.env.DSH_BASE
if (!BASE) {
  console.log('  （DSH_WEB_URL 不可用，跳过行为断言）')
} else {
  try {
    const noTable = await fetch(`${BASE}/api/dsh-memory/entries?limit=1`)
    const j1 = await noTable.json()
    check('不传 table → 400', noTable.status === 400,
      `实际 ${noTable.status}，ok=${j1.ok}${j1.table ? '，回落到了 ' + j1.table : ''}`)

    const withTable = await fetch(`${BASE}/api/dsh-memory/entries?table=logs&limit=1`)
    const j2 = await withTable.json()
    check('传 table=logs → 200 且有数据', withTable.status === 200 && j2.ok === true && j2.table === 'logs',
      `实际 ${withTable.status}，table=${j2.table}`)

    // 关键回归：kind 用错表时不能静默返回 ok:true 的空集
    const badKind = await fetch(`${BASE}/api/dsh-memory/entries?kind=logs&limit=1`)
    const j3 = await badKind.json()
    check('kind 单独传（不传 table）→ 不当成 rules 查询', badKind.status === 400,
      `实际 ${badKind.status}，table=${j3.table}，total=${j3.total}`)
  } catch (e) {
    console.log(`  （请求失败，跳过：${e.message}）`)
  }
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
