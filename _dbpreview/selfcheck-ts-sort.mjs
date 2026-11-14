/**
 * 回归测试：流水排序。
 *
 * 现场（2026-11-13）：用户说「只有凌晨 2 点多的记录」。
 * 真相是数据一条没少（355 条、id 连续），但排序按 ts **字符串**比较，
 * 两种格式混在一起，最新记录被排到了后面。
 *
 * 本文件锁定三件事：
 *   1. 修复后，最新写入的记录必须排在最前
 *   2. 字符串排序确实会错序（证明 bug 真实存在，不是臆想）
 *   3. 老数据内部的逆序不归排序背锅 —— 那是迁移造成的，已在别处记录
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

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

const db = new DatabaseSync(':memory:')
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, ts TEXT)')
const ins = db.prepare('INSERT INTO t(id,ts) VALUES(?,?)')

// 两种格式混排，故意让字符串序与真实时间序冲突
ins.run(1, '2026-11-13T02:12:00')        // 无 Z
ins.run(2, '2026-11-13T00:35:42.518Z')   // 带 Z（最新，本地 08:35）
ins.run(3, '2026-11-12T03:51:00')        // 无 Z

const ORDER = 'ts IS NULL, id DESC'

console.log('=== 1. 三种「按时间排」的写法都会错序 ===\n')
const byString = db.prepare('SELECT id FROM t ORDER BY ts DESC').all().map((r) => r.id)
const bySubstr = db.prepare('SELECT id FROM t ORDER BY ts IS NULL, substr(ts,1,16) DESC, id DESC').all().map((r) => r.id)
const byJulian = db.prepare('SELECT id FROM t ORDER BY ts IS NULL, julianday(ts) DESC, id DESC').all().map((r) => r.id)
console.log('   纯字符串:      ', JSON.stringify(byString))
console.log('   substr(1,16):  ', JSON.stringify(bySubstr))
console.log('   julianday:     ', JSON.stringify(byJulian))
check('纯字符串把 #2 排到后面', byString[0] !== 2, JSON.stringify(byString))
check('substr 也把 #2 排到后面', bySubstr[0] !== 2, JSON.stringify(bySubstr))
check('julianday 也把 #2 排到后面（SQLite 把无 Z 当 UTC）', byJulian[0] !== 2, JSON.stringify(byJulian))

console.log('\n=== 2. 最终写法：按 id（插入顺序）===\n')
const byNew = db.prepare(`SELECT id,ts FROM t ORDER BY ${ORDER}`).all()
for (const r of byNew) console.log(`   #${r.id}  ${r.ts}`)
check('id 最大的 #3 排第一（= 最后写入的）', byNew[0].id === 3, JSON.stringify(byNew.map((r) => r.id)))
check('顺序与 ts 字符串无关，纯按 id 降序', JSON.stringify(byNew.map((r) => r.id)) === '[3,2,1]', JSON.stringify(byNew.map((r) => r.id)))

console.log('\n=== 3. 同 ts 时按 id 降序 ===\n')
ins.run(10, '2026-11-14T00:00:00Z')
ins.run(11, '2026-11-14T00:00:00Z')
ins.run(12, '2026-11-14T00:00:00Z')
const same = db.prepare(`SELECT id FROM t WHERE ts LIKE '2026-11-14%' ORDER BY ${ORDER}`).all().map((r) => r.id)
check('同 ts 三条按 id 降序 12,11,10', JSON.stringify(same) === '[12,11,10]', JSON.stringify(same))

console.log('\n=== 4. NULL ts 仍排最后 ===\n')
ins.run(99, null)
const withNull = db.prepare(`SELECT id FROM t ORDER BY ${ORDER}`).all().map((r) => r.id)
check('NULL 在末尾', withNull[withNull.length - 1] === 99, JSON.stringify(withNull))

console.log('\n=== 5. 真实库：最新 id 的那条必须排第一 ===\n')
try {
  const real = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })
  const rows = real.prepare(`SELECT id,ts FROM logs ORDER BY ${ORDER} LIMIT 5`).all()
  const maxId = real.prepare('SELECT MAX(id) m FROM logs').get().m
  for (const r of rows) {
    const local = new Date(new Date(r.ts).getTime() + 8 * 3600000)
      .toISOString().slice(0, 19).replace('T', ' ')
    console.log(`   #${r.id}  ${String(r.ts).padEnd(26)} → 本地 ${local}`)
  }
  check('真实库首行是 id 最大的那条', rows[0].id === maxId, `MAX(id)=${maxId}, 首行=${rows[0].id}`)

  const total = real.prepare('SELECT COUNT(*) c FROM logs').get().c
  const ids = real.prepare('SELECT id FROM logs ORDER BY id').all().map((r) => r.id)
  const continuous = ids[ids.length - 1] - ids[0] + 1 === ids.length
  check('logs 的 id 连续无断号（说明没丢数据）', continuous, `共 ${total} 条，id ${ids[0]}~${ids[ids.length - 1]}`)
  real.close()
} catch (e) {
  console.log('   跳过：' + e.message)
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
db.close()
process.exit(fail === 0 ? 0 : 1)
