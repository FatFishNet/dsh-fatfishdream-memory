/**
 * 回归测试：迁移脚本的「全局按时间排序」。
 *
 * 背景（2026-11-13）：db-migrate.mjs 原先没有这一步，
 * 按 readdir 顺序逐项目写入 → 迁移出的流水时间线错乱
 * （实测 4 处逆序，最大差 44.6 小时）。
 *
 * 而流水页排序用的是 **id**（见 db-store.mjs 的 TS_ORDER），
 * 也就是「迁移时的插入顺序 = 将来看到的顺序」。
 * 所以排序逻辑一旦退化，用户会直接看到「最近的记录不见了」。
 *
 * 本文件把排序算法原样复刻下来做断言，不依赖 .md 源文件是否存在。
 */

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

/** 与 db-migrate.mjs 完全一致的实现 */
function timeKey(ts) {
  return ts === null || ts === undefined ? '\uffff' : String(ts)
}
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const ta = timeKey(a.ts)
    const tb = timeKey(b.ts)
    if (ta !== tb) return ta < tb ? -1 : 1
    const sa = String(a.scope ?? '')
    const sb = String(b.scope ?? '')
    if (sa !== sb) return sa < sb ? -1 : 1
    const fa = String(a.source ?? '')
    const fb = String(b.source ?? '')
    return fa < fb ? -1 : fa > fb ? 1 : 0
  })
}

console.log('=== 1. 跨项目时间线必须交叉正确 ===\n')
// 这正是原 bug 的形状：项目 A 的时间晚于项目 B，但 A 先被遍历
const buggy = [
  { scope: 'A', ts: '2026-11-12T17:30:00', source: 'A/log/11.md' },
  { scope: 'B', ts: '2026-11-11T13:15:00', source: 'B/log/11.md' },
  { scope: 'B', ts: '2026-11-12T18:00:00', source: 'B/log/11.md' },
]
const fixed = sortRows(buggy)
console.log('   排序后：')
for (const r of fixed) console.log(`     ${r.ts}  [${r.scope}]`)
check(
  '最晚的（11-12T18:00，项目 B）排最后',
  fixed[fixed.length - 1].ts === '2026-11-12T18:00:00',
  JSON.stringify(fixed.map((r) => r.ts)),
)
check('时间单调不减', fixed.every((r, i) => i === 0 || timeKey(fixed[i - 1].ts) <= timeKey(r.ts)))

console.log('\n=== 2. 无 ts 的沉到最后 ===\n')
const withNull = sortRows([
  { scope: 'A', ts: null, source: 'x' },
  { scope: 'A', ts: '2026-11-12T00:00:00', source: 'y' },
  { scope: 'A', ts: undefined, source: 'z' },
])
console.log('   ' + withNull.map((r) => r.ts ?? 'NULL').join(' → '))
check('两条 NULL 都在末尾', withNull[1].ts == null && withNull[2].ts == null, JSON.stringify(withNull.map((r) => r.ts)))

console.log('\n=== 3. 同一时刻按 scope / source 稳定 ===\n')
const ties = sortRows([
  { scope: 'B', ts: '2026-11-12T10:00:00', source: 'B/log/11.md' },
  { scope: 'A', ts: '2026-11-12T10:00:00', source: 'A/log/12.md' },
  { scope: 'A', ts: '2026-11-12T10:00:00', source: 'A/log/11.md' },
])
console.log('   ' + ties.map((r) => `${r.scope}/${r.source.split('/').pop()}`).join(' → '))
check('同刻先按 scope 再按 source', ties[0].scope === 'A' && ties[1].scope === 'A' && ties[2].scope === 'B')
check('同 scope 内按 source 排（11 在 12 前）', ties[0].source.includes('/11') && ties[1].source.includes('/12'))

console.log('\n=== 4. 排序结果可重复（同一输入两次一致）===\n')
const r1 = JSON.stringify(sortRows(buggy))
const r2 = JSON.stringify(sortRows(buggy))
check('两次排序结果完全相同', r1 === r2)

console.log('\n=== 5. 排序不改动原数组 ===\n')
const orig = [...buggy]
sortRows(buggy)
check('原数组顺序未变（返回副本）', JSON.stringify(buggy) === JSON.stringify(orig))

console.log('\n=== 6. 逆序计数（dry-run 报告用的判据）===\n')
function countInversions(rows) {
  let n = 0
  let prev = ''
  for (const r of rows) {
    const t = timeKey(r.ts)
    if (t !== '\uffff' && prev !== '' && t < prev) n++
    if (t !== '\uffff') prev = t
  }
  return n
}
check('排序后逆序为 0', countInversions(sortRows(buggy)) === 0, String(countInversions(sortRows(buggy))))
check('原始乱序能检出逆序', countInversions(buggy) > 0, String(countInversions(buggy)))
console.log(`   原始逆序 ${countInversions(buggy)} 处 → 排序后 ${countInversions(sortRows(buggy))} 处`)

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
