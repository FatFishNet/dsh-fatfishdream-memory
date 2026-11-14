/**
 * 验证：检索结果的**跨表分层** + 「最近一条流水时间」。
 *
 * 背景（2026-11-14）：旧 search 把 profile / rules / logs 三张表的 bm25
 * 混在一起排序。bm25 是每张表各自语料算出来的（文档数、平均长度不同），
 * 跨表比大小没有意义，实测 q=大肥鱼 时 logs 会压在 profile 前面。
 * 现在改成「组内按 bm25、组间按 profile→rules→logs 轮流各取一条」。
 *
 * 本脚本锁死三件事：
 *   1. 第一段顺序固定 profile → rules → logs，与分数高低无关
 *   2. 结果条数不超过 limit，且小 limit 时三张表都能露面（不会被最多的表占满）
 *   3. lastLogTs() 取的是**最后插入**的那条（按 id，不按字符串 ts）
 *
 * 用自建临时库 + 固定种子，不依赖用户真实数据（同 selfcheck-isolation）。
 */
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { createDbStore } = await import(
  `file://${path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs').replace(/\\/g, '/')}`
)

const TMP = path.join(REPO, '_dbpreview', 'tmp')
fs.mkdirSync(TMP, { recursive: true })
const TMP_DB = path.join(TMP, 'search-tier.db')
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix) } catch {} }

let pass = 0
let fail = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    pass++
    console.log(`  OK   ${label}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`)
  }
}

// ---------------------------------------------------------------- 空库：lastLogTs
const empty = createDbStore(path.join(TMP, 'search-tier-empty.db'), {}, () => {})
check('空库 lastLogTs() 返回 null', empty.lastLogTs() === null, String(empty.lastLogTs()))
empty.close()
try { fs.unlinkSync(path.join(TMP, 'search-tier-empty.db')) } catch {}

// ---------------------------------------------------------------- 种子
const P = 'ProjectP'
const s = createDbStore(TMP_DB, {}, () => {})

// profile 只出现 1 次「沙箱」；logs 里出现 20 次 —— 旧实现下 logs 的 bm25
// 会显著更负（更靠前），这条断言就是用来复现并锁死那个 bug 的。
s.createEntry({ table: 'profile', text: '用户要求：涉及沙箱的判断先给方案' })
s.appendFact('通用：沙箱拒绝要当作策略而非 bug')
s.appendProjectNote(P, 'ProjectP 规则：沙箱下中文乱码不算问题')
for (let i = 0; i < 3; i++) {
  s.appendLog(P, `ProjectP 流水 #${i}：沙箱 沙箱 沙箱 沙箱 沙箱 沙箱 沙箱`, {
    topic: '技术讨论', summary: `沙箱记录 ${i}`, keywords: '沙箱',
  })
}

const Q = '沙箱'
const opts = { limit: 3, projectName: P }
const three = s.search(Q, opts)
check('三表齐全（limit=3 时各表都能露面）',
  three.length === 3 && new Set(three.map((r) => r.table)).size === 3,
  three.map((r) => r.table).join(','))
check('段序固定 profile → rules → logs（与分数高低无关）',
  three[0].table === 'profile' && three[1].table === 'rules' && three[2].table === 'logs',
  three.map((r) => `${r.table}:${(r.score ?? 0).toFixed(2)}`).join(' , '))

const five = s.search(Q, { limit: 5, projectName: P })
check('条数不超过 limit', five.length <= 5, `${five.length} 条`)
check('第二轮仍按同一顺序继续取',
  five.length === 5 && five[3].table === 'rules' && five[4].table === 'logs',
  five.map((r) => r.table).join(','))

// 组内必须仍按 bm25 升序（越小越相关）—— 分层不能把组内相关度搞丢。
const perTable = {}
for (const r of s.search(Q, { limit: 50, projectName: P })) (perTable[r.table] ??= []).push(r.score ?? 0)
let monotonic = true
for (const [t, scores] of Object.entries(perTable)) {
  for (let i = 1; i < scores.length; i++) if (scores[i] < scores[i - 1]) monotonic = false
}
check('组内仍按 bm25 升序', monotonic, JSON.stringify(perTable))

const one = s.search(Q, { limit: 1, projectName: P })
check('limit=1 时取分层里最高的那一段（profile）', one.length === 1 && one[0].table === 'profile',
  one.map((r) => r.table).join(','))

// ---------------------------------------------------------------- lastLogTs
const last = s.lastLogTs()
check('lastLogTs() 非空', typeof last === 'string' && last !== '', String(last))
const newest = s.listEntries('logs', { limit: 1, offset: 0 }).rows[0]
check('lastLogTs() 等于最后插入那条的 ts', last === newest.ts, `${last} vs ${newest.ts}`)

// ---------------------------------------------------------------- 整理提醒判据（源码级）
//
// 「距上次记忆整理已 N 天」的 gap 以前只看 state.lastConsolidate ——
// 那个字段只有手动 /memory consolidate 会写，模型写流水不更新它，
// 于是 gap 恒为 Infinity、每个新会话都提醒一次。
// 现在必须同时看最近一条流水（lastLogTs）。这条只能源码级断言：
// 真实行为要起一个会话才看得到。
const INDEX_SRC = fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory/index.js'), 'utf8')
check('整理提醒用 lastLogTs() 兜底', INDEX_SRC.includes('dbStore.lastLogTs()'))
check('不再只看 lastConsolidate 判 gap', !INDEX_SRC.includes('state.lastConsolidate === null ? Number.POSITIVE_INFINITY'))
check('/memory status 暴露最近写入', INDEX_SRC.includes('最近写入流水：'))

// ---------------------------------------------------------------- 清理
try { s.close() } catch {}
for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(TMP_DB + suffix) } catch {} }

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
