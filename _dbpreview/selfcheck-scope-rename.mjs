/**
 * 回归测试：工作区改名（scope 迁移）+ 迁前/迁后数据量比对。
 *
 * 背景（2026-11-15 用户要求）：
 *   「迁移前先整理待迁移区域的数据量，迁移后报告与迁移前是否一致。」
 *
 * 本脚本锁定四件事：
 *   1. snapshotScope 的口径正确（all / active / minId / maxId）
 *   2. 正常改名：三表条数守恒、旧区归零、行集合未变
 *   3. 异常路径：事务回滚、目标占用、__global__、同名、空名、空工作区
 *   4. 只改记忆名时，resolveProjectKey 仍指向新 scope（不会「下次开会话又变回去」）
 *
 * 用自建临时库，不碰真实记忆。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'

let pass = 0
let fail = 0
const bad = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
  } else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}  ← ${detail}`)
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scope-rename-'))
const dbPath = path.join(tmpDir, 'memory.db')

function freshStore() {
  for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(f, { force: true }) } catch {}
  }
  return createDbStore(dbPath, {}, () => {})
}

// ============================================================
console.log('=== 1. snapshotScope 口径 ===\n')

let store = freshStore()

// 造数据：A 工作区，三张表都有；其中 rules 留一条停用的
store.appendLog('A', '流水一', { topic: '开发日志', summary: 's1', keywords: 'k1' })
store.appendLog('A', '流水二', { topic: '开发日志', summary: 's2', keywords: 'k2' })
store.appendProjectNote('A', 'A 的规则一', 'pref')
store.appendProjectNote('A', 'A 的规则二', 'pref')
store.appendArchive({ scope: 'A', role: 'user', text: '原文一' })
store.appendArchive({ scope: 'A', role: 'assistant', text: '原文二' })

const snap = store.snapshotScope('A')
check('rules.all = 2', snap.tables.rules.all === 2, JSON.stringify(snap.tables.rules))
check('logs.all = 2', snap.tables.logs.all === 2, JSON.stringify(snap.tables.logs))
check('archive.all = 2', snap.tables.archive.all === 2, JSON.stringify(snap.tables.archive))
check('total.all = 6', snap.total.all === 6, String(snap.total.all))
check(
  'archive 的 all === active（该表无 status 列）',
  snap.tables.archive.all === snap.tables.archive.active,
  `all=${snap.tables.archive.all} active=${snap.tables.archive.active}`,
)
check('有数据时 minId/maxId 是数字', typeof snap.tables.logs.minId === 'number' && typeof snap.tables.logs.maxId === 'number')

// 停用一条规则，active 应少一条而 all 不变
const ruleId = store.listEntries('rules', { scope: 'A' }).rows[0].id
store.setStatus('rules', ruleId, 'stale')
const snap2 = store.snapshotScope('A')
check('停用后 rules.all 仍为 2', snap2.tables.rules.all === 2, String(snap2.tables.rules.all))
check('停用后 rules.active 降为 1', snap2.tables.rules.active === 1, String(snap2.tables.rules.active))
check('停用不影响 total.active 之外的口径', snap2.total.all === 6, String(snap2.total.all))

// 不存在的 scope
const emptySnap = store.snapshotScope('不存在的名字')
check('空 scope 的 total.all = 0', emptySnap.total.all === 0)
check('空 scope 的 minId 为 null', emptySnap.tables.rules.minId === null, String(emptySnap.tables.rules.minId))

// ============================================================
console.log('\n=== 2. 正常改名：迁前迁后必须一致 ===\n')

const before = store.snapshotScope('A')
const result = store.renameScope('A', 'B')

check('renameScope 返回 ok', result.ok === true)
check('返回里带 before 快照', result.before !== undefined && result.before.scope === 'A')
check('返回里带 after 快照（新名 + 旧名）', result.after?.to?.scope === 'B' && result.after?.from?.scope === 'A')
check('verify.ok = true', result.verify?.ok === true, JSON.stringify(result.verify))

// ① 条数守恒
for (const t of ['rules', 'logs', 'archive']) {
  check(
    `① ${t} 条数守恒：${before.tables[t].all} → ${result.after.to.tables[t].all}`,
    result.after.to.tables[t].all === before.tables[t].all,
    `${before.tables[t].all} vs ${result.after.to.tables[t].all}`,
  )
}

// ② 旧区归零
for (const t of ['rules', 'logs', 'archive']) {
  check(`② ${t} 旧区归零`, result.after.from.tables[t].all === 0, String(result.after.from.tables[t].all))
}

// ③ 行集合未变
for (const t of ['rules', 'logs', 'archive']) {
  const w = before.tables[t]
  const g = result.after.to.tables[t]
  check(
    `③ ${t} 行集合未变（${w.minId}-${w.maxId} → ${g.minId}-${g.maxId}）`,
    g.minId === w.minId && g.maxId === w.maxId,
  )
}

// 数据真的能在新名下读到
const logsB = store.listEntries('logs', { scope: 'B' })
check('新 scope B 能读到流水', logsB.total === 2, String(logsB.total))
const logsA = store.listEntries('logs', { scope: 'A' })
check('旧 scope A 读不到流水', logsA.total === 0, String(logsA.total))

// ============================================================
console.log('\n=== 3. 异常路径 ===\n')

// 3.1 目标占用 → 拒绝
store.appendLog('C', 'C 的流水')
const beforeOccupy = store.snapshotScope('B')
let occupyErr = ''
try {
  store.renameScope('B', 'C')
} catch (e) {
  occupyErr = String(e?.message ?? e)
}
check('目标已被占用时拒绝', occupyErr.includes('已有') && occupyErr.includes('数据'), occupyErr)
const afterOccupy = store.snapshotScope('B')
check('拒绝后 B 的数据一点没动', afterOccupy.total.all === beforeOccupy.total.all,
  `${beforeOccupy.total.all} vs ${afterOccupy.total.all}`)
check('拒绝后 C 也没被动', store.snapshotScope('C').total.all === 1, String(store.snapshotScope('C').total.all))

// 3.2 __global__
let globalErr = ''
try { store.renameScope('__global__', 'X') } catch (e) { globalErr = String(e?.message ?? e) }
check('__global__ 不能改名', globalErr.includes('保留值'), globalErr)

let globalErr2 = ''
try { store.renameScope('B', '__global__') } catch (e) { globalErr2 = String(e?.message ?? e) }
check('不能改名为 __global__', globalErr2.includes('保留值'), globalErr2)

// 3.3 新旧同名
let sameErr = ''
try { store.renameScope('B', 'B') } catch (e) { sameErr = String(e?.message ?? e) }
check('新旧同名被拒', sameErr.includes('相同'), sameErr)

// 3.4 空名
let emptyErr = ''
try { store.renameScope('', 'X') } catch (e) { emptyErr = String(e?.message ?? e) }
check('空名被拒', emptyErr.includes('需要'), emptyErr)

let emptyErr2 = ''
try { store.renameScope('B', '   ') } catch (e) { emptyErr2 = String(e?.message ?? e) }
check('目标名为空白被拒', emptyErr2.includes('需要'), emptyErr2)

// 3.5 空工作区（防写错名字时的「迁移成功」假象）
let ghostErr = ''
try { store.renameScope('完全不存在的名字', 'X') } catch (e) { ghostErr = String(e?.message ?? e) }
check('源工作区无数据时拒绝（防手滑）', ghostErr.includes('没有任何数据'), ghostErr)

store.close()

// ============================================================
console.log('\n=== 4. 事务回滚：中途失败必须整体回滚 ===\n')

// 直接在 SQLite 层模拟「第二张表写入失败」：给 logs 表加一个会抛错的触发器
const rawDb = store.open()
const stateBeforeRollback = store.snapshotScope('B')

rawDb.exec(`
  CREATE TRIGGER IF NOT EXISTS block_logs_scope_change
  BEFORE UPDATE OF scope ON logs
  WHEN OLD.scope='B' AND NEW.scope='Z'
  BEGIN
    SELECT RAISE(ABORT, '模拟中途失败');
  END
`)

let rollbackErr = ''
try {
  store.renameScope('B', 'Z')
} catch (e) {
  rollbackErr = String(e?.message ?? e)
}
check('中途失败会抛错', rollbackErr.includes('回滚') || rollbackErr.includes('模拟中途失败'), rollbackErr)

rawDb.exec('DROP TRIGGER IF EXISTS block_logs_scope_change')

const stateAfterRollback = store.snapshotScope('B')
// rules 是循环里的第一张表。若没有事务，它会先被改成 Z，回滚后必须还在 B。
check(
  '回滚后 rules 仍在 B（若没事务，它会被改走）',
  stateAfterRollback.tables.rules.all === stateBeforeRollback.tables.rules.all,
  `${stateBeforeRollback.tables.rules.all} vs ${stateAfterRollback.tables.rules.all}`,
)
check('回滚后 logs 仍在 B', stateAfterRollback.tables.logs.all === stateBeforeRollback.tables.logs.all)
check('回滚后 archive 仍在 B', stateAfterRollback.tables.archive.all === stateBeforeRollback.tables.archive.all)
check('回滚后 Z 一条数据都没有', store.snapshotScope('Z').total.all === 0, String(store.snapshotScope('Z').total.all))

// 回滚后还能正常改名（证明事务没把连接搞坏）
const okAfterRollback = store.renameScope('B', 'Z')
check('回滚后仍能正常改名', okAfterRollback.ok === true && store.snapshotScope('Z').total.all === 6,
  String(store.snapshotScope('Z').total.all))

// ============================================================
console.log('\n=== 5. countScope 的 activeOnly ===\n')

const allCount = store.countScope('rules', 'Z')
const activeCount = store.countScope('rules', 'Z', { activeOnly: true })
check('countScope 默认数全部行', allCount === 2, String(allCount))
check('activeOnly=true 只数 active', activeCount === 1, String(activeCount))
check('archive 的 activeOnly 与 all 相同（无 status 列）',
  store.countScope('archive', 'Z', { activeOnly: true }) === store.countScope('archive', 'Z'),
  `${store.countScope('archive', 'Z', { activeOnly: true })} vs ${store.countScope('archive', 'Z')}`)

let badTableErr = ''
try { store.countScope('profile', 'Z') } catch (e) { badTableErr = String(e?.message ?? e) }
check('无 scope 列的表被拒', badTableErr.includes('没有 scope 列'), badTableErr)

// ============================================================
console.log('\n=== 5.1 listScopesWithData：必须包含「全是停用条目」的工作区 ===\n')

// 造一个「只有停用条目」的工作区 —— 2026-11-15 实测 design 就是这样，
// 它因此不在 /state 的 byScope 里，GUI 下拉框曾漏掉它。
store.appendProjectNote('OnlyStale', '一条会被停用的规则', 'pref')
const staleId = store.listEntries('rules', { scope: 'OnlyStale' }).rows[0].id
store.setStatus('rules', staleId, 'stale')

const withData = store.listScopesWithData()
const names = withData.map((x) => x.scope)
check('列表包含有 active 数据的工作区', names.includes('Z'), names.join(','))
check(
  '列表包含「全是停用条目」的工作区（byScope 会漏的那种）',
  names.includes('OnlyStale'),
  names.join(','),
)
const onlyStale = withData.find((x) => x.scope === 'OnlyStale')
check('OnlyStale 的 total = 1（停用也算）', onlyStale?.total === 1, JSON.stringify(onlyStale))
check('OnlyStale 的 rules 计数 = 1', onlyStale?.tables?.rules === 1, JSON.stringify(onlyStale?.tables))
check(
  '列表按 total 降序',
  withData.every((x, i) => i === 0 || withData[i - 1].total >= x.total),
  withData.map((x) => `${x.scope}:${x.total}`).join(' '),
)
check(
  '列表里的 total 与 snapshotScope 同口径',
  withData.every((x) => store.snapshotScope(x.scope).total.all === x.total),
  '有工作区的 total 与 snapshotScope 不一致',
)
check('total=0 的工作区不会出现在列表里', !names.includes('完全不存在的名字'))

// __global__ 是保留值，不能改名 —— 列在「选择要改名的工作区」下拉里只会误导，
// 因为点下去必然被后端拒绝（2026-11-15）。
store.appendFact('一条全局偏好，制造 __global__ 的数据')
const withData2 = store.listScopesWithData()
check(
  '默认排除 __global__（它不能改名，不该出现在下拉框）',
  !withData2.some((x) => x.scope === '__global__'),
  withData2.map((x) => x.scope).join(','),
)
check(
  'includeGlobal:true 时能看到 __global__（给统计用）',
  store.listScopesWithData({ includeGlobal: true }).some((x) => x.scope === '__global__'),
  '传了 includeGlobal 却还是没看到',
)

store.close()
fs.rmSync(tmpDir, { recursive: true, force: true })

// ============================================================
console.log('\n=== 6. 源码级：resolveProjectKey 读 scope 字段 ===\n')

const idx = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')

check(
  'resolveProjectKey 返回 scope 字段',
  /const scope\s*=\s*typeof entry\?\.scope\s*===\s*'string'/.test(idx),
  '没找到读取 entry.scope 的逻辑',
)
check(
  'resolveProjectKey 返回体含 scope',
  /return\s*\{\s*key,\s*name,\s*scope,/.test(idx),
  '返回值里没有 scope',
)
check(
  '注入层用 scope 而不是 key',
  /const projectName\s*=\s*resolved\?\.scope/.test(idx),
  '注入层仍在用 resolved?.key',
)
// 注意：resolveProjectKey 的参数里有嵌套括号（readStateSync(store)），
// 所以不能用 [^)]* 匹配 —— 2026-11-15 这条断言自己踩过一次。
check(
  '归档写入用 scope（不是目录名 key）',
  /const projKey\s*=\s*store\.resolveProjectKey\([\s\S]{0,80}?\?\.scope/.test(idx),
  '归档仍在用 ?.key',
)
check(
  '改名后 state.json 写 scope 字段',
  /entry\.scope\s*=\s*to/.test(idx),
  '没找到写入 scope 字段的语句',
)
check(
  '死代码 store.projectDir 已删除',
  !/store\.projectDir\s*\?/.test(idx),
  '仍然存在 store.projectDir 恒真回退',
)

// 旧 bug 的形状是「要求 to 不存在才清理旧键」。
// 断言要排除注释与 ! 前缀，否则会把 bug 说明文字和 `!== undefined` 都算成命中
// （2026-11-15 这条断言自己误报过一次）。
const codeLines = idx
  .split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
check(
  '旧的条件 bug 已修（不再要求 to 不存在才清理）',
  !codeLines.some((l) => /st\.projects\[to\]\s*===?\s*undefined/.test(l) && !/!==/.test(l)),
  '仍然存在「to 必须不存在才清理旧键」的条件',
)

// 「源键不一定是 from」——2026-11-15 实测踩到：SoftTest→SoftTestX 再改回来时，
// 源键 SoftTestX 不存在，整段同步被跳过，scope 字段残留旧值。
check(
  '同步逻辑会按 .scope 反查源条目（键===from 找不到时）',
  /v\.scope\s*===\s*from/.test(idx),
  '没有按 .scope 反查的逻辑，改回旧名时会残留 mapping',
)
check(
  '同步逻辑也会尝试 键===to',
  /else if \(projects\[to\] !== undefined\) key = to/.test(idx),
  '没有尝试键===to 的分支',
)
check(
  '记忆名回到目录名时删除 scope 字段（缺省=跟随）',
  /delete entry\.scope/.test(idx),
  '没有 delete entry.scope',
)

// ============================================================
console.log('\n=== 7. 合并：目标已有数据时（用户 2026-11-15 追加要求）===\n')

// 用户原话：「这里允许合并 新建工作区然后再去迁移记忆的情况是很常见的」。
// 场景：先建了工作区 T、在里面聊了几句（有 archive），再把旧工作区 S 的记忆并进来。
// 所以这里用**独立的临时库**，不打断前面小节的状态链。
{
  const mergeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-merge-'))
  const mergePath = path.join(mergeDir, 'memory.db')
  const ms = createDbStore(mergePath, {}, () => {})

  // 源 S：三表各 2 行
  ms.appendLog('S', '源流水一', { topic: '开发日志', summary: 's1', keywords: 'k1' })
  ms.appendLog('S', '源流水二', { topic: '开发日志', summary: 's2', keywords: 'k2' })
  ms.appendProjectNote('S', '源规则一', 'pref')
  ms.appendProjectNote('S', '源规则二', 'pref')
  ms.appendArchive({ scope: 'S', role: 'user', text: '源原文一' })
  ms.appendArchive({ scope: 'S', role: 'assistant', text: '源原文二' })

  // 目标 T：也已经产生数据（模拟「新建工作区后聊过几句」）
  ms.appendLog('T', '目标已有流水', { topic: '开发日志', summary: 'target', keywords: 'kt' })
  ms.appendArchive({ scope: 'T', role: 'user', text: '目标已有原文一' })
  ms.appendArchive({ scope: 'T', role: 'assistant', text: '目标已有原文二' })

  const sBefore = ms.snapshotScope('S')
  const tBefore = ms.snapshotScope('T')

  // --- 默认（不传 allowMerge）应当拒绝，并提示可以合并 ---
  let mergeErr = ''
  try {
    ms.renameScope('S', 'T')
  } catch (e) {
    mergeErr = String(e?.message ?? e)
  }
  check(
    '默认拒绝合并，且提示可以勾选合并',
    mergeErr.includes('已有数据') && mergeErr.includes('合并'),
    mergeErr,
  )
  check(
    '拒绝后 S 的数据一点没动',
    ms.snapshotScope('S').total.all === sBefore.total.all,
    `${sBefore.total.all} vs ${ms.snapshotScope('S').total.all}`,
  )
  check(
    '拒绝后 T 的数据也一点没动',
    ms.snapshotScope('T').total.all === tBefore.total.all,
    `${tBefore.total.all} vs ${ms.snapshotScope('T').total.all}`,
  )

  // --- allowMerge: true 应当合并 ---
  const m = ms.renameScope('S', 'T', { allowMerge: true })
  check('合并返回 merged=true', m.merged === true, String(m.merged))
  check('合并返回带 targetBefore 快照', m.targetBefore !== undefined)
  check('合并后 verify.ok=true', m.verify?.ok === true, JSON.stringify(m.verify))

  // ① 条数：迁后 = 源 + 目标原有（逐表）
  for (const t of ['rules', 'logs', 'archive']) {
    const want = sBefore.tables[t].all + tBefore.tables[t].all
    const got = m.after.to.tables[t].all
    check(
      `合并后 ${t} 条数 = 源+目标（${sBefore.tables[t].all}+${tBefore.tables[t].all}=${want}）`,
      got === want,
      `实际 ${got}`,
    )
  }

  // ② 源区归零
  for (const t of ['rules', 'logs', 'archive']) {
    check(
      `合并后 ${t} 源区归零`,
      m.after.from.tables[t].all === 0,
      String(m.after.from.tables[t].all),
    )
  }

  // ③ 行集合 = 两者并集（这是合并最容易写错的一条）
  for (const t of ['rules', 'logs', 'archive']) {
    const spans = [sBefore.tables[t], tBefore.tables[t]].filter((x) => x.all > 0)
    if (spans.length === 0) continue
    const wantMin = Math.min(...spans.map((x) => x.minId))
    const wantMax = Math.max(...spans.map((x) => x.maxId))
    const got = m.after.to.tables[t]
    check(
      `合并后 ${t} 行集合 = 两者并集（${wantMin}-${wantMax}）`,
      got.minId === wantMin && got.maxId === wantMax,
      `实际 ${got.minId}-${got.maxId}`,
    )
  }

  // 两批数据真的能一起读到
  check(
    '合并后 T 的流水 = 3 条（源 2 + 目标 1）',
    ms.listEntries('logs', { scope: 'T' }).total === 3,
    String(ms.listEntries('logs', { scope: 'T' }).total),
  )
  check(
    '合并后 T 的原文 = 4 条（源 2 + 目标 2）',
    ms.listArchive({ scope: 'T' }).total === 4,
    String(ms.listArchive({ scope: 'T' }).total),
  )
  check(
    '合并后 T 的规则 = 2 条（源的全部）',
    ms.listEntries('rules', { scope: 'T' }).total === 2,
    String(ms.listEntries('rules', { scope: 'T' }).total),
  )
  check(
    '合并后源工作区 S 从列表里消失',
    !ms.listScopesWithData().some((x) => x.scope === 'S'),
    ms.listScopesWithData().map((x) => x.scope).join(','),
  )

  // --- 目标为空时不该被当成「合并」---
  ms.appendLog('EmptyTarget', 'x') // 只为让它存在，随后删掉
  const emptyResult = ms.renameScope('EmptyTarget', 'BrandNew', { allowMerge: true })
  check('目标为空时 merged=false（走的是改名语义）', emptyResult.merged === false, String(emptyResult.merged))

  ms.close()
  fs.rmSync(mergeDir, { recursive: true, force: true })
}

// ============================================================
console.log(`\n${'─'.repeat(40)}`)
console.log(
  fail === 0
    ? `✅ 全部通过：${pass} 通过 / 0 失败`
    : `❌ ${pass} 通过 / ${fail} 失败\n${bad.map((b) => '   ' + b).join('\n')}`,
)
process.exit(fail === 0 ? 0 : 1)
