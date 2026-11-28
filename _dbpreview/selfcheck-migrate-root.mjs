/**
 * `migrateRoot` 的**真执行**回归（2026-11-28 新增，待办 C / B2 的护栏）。
 *
 * ## 为什么必须新写一个（而不是加进现有迁移测试）
 *
 * 现有 4 个迁移相关脚本（`selfcheck-migrate-order` / `selfcheck-migrate-db` /
 * `selfcheck-copytree-empty` / `verify-copytree-failure`）**没有一个真的调用
 * `migrateRoot`** —— 它们要么只做源码文本断言，要么把 `backupDbFile` /
 * `copyTree` 抄一份单独测。于是这个「最危险的写函数」至今零行为覆盖。
 *
 * 本项目记过一条判据：**「测试全绿」和「有测试守着」是两件事，而且报告里
 * 长得一样。** 本脚本就是补这个洞。
 *
 * ## 守什么
 *
 * ① **源目录绝不被删** —— 这是失败提示里那句「你的记忆没有动」的依据。
 *    判据是**字节级**：跑之前记下源目录每个文件的 sha256 与条数，跑完再比。
 *    ⚠️ 不能只断言「文件还在」—— 内容被改写同样算坏。
 * ② **成功路径真的搬过去** —— 库、policy.md、state.json、logs 都要在新根。
 * ③ **失败路径：源完好、目标留残骸** —— 后者是**刻意的取舍**（见 migrateRoot
 *    的 docstring：宁留垃圾也不递归删用户指定的目录）。这条断言是**反向**的：
 *    如果哪天有人给 migrateRoot 加了失败清理，这里会变红 —— 那时应该
 *    先回来读 docstring 并同步更新 B2 的结论，而不是直接改绿。
 * ④ **报错文案指向正确的下一步** —— 「目标目录非空」必须告诉用户
 *    「可能是上次失败留下的、删掉可重试」，且必须说源目录没动。
 *    判据同 `/log` 的 topic 白名单那次教训：提示写错方向 = 照做仍失败。
 *
 * ⚠️ 全部在临时目录里跑，**不碰真实记忆根**。
 * `writePointer` 会写 `~/.dsh/memory-root.json` —— 所以先把 `USERPROFILE`
 * 指向临时目录，再动态 import 插件（实测 `homedir()` 每次调用都读 env）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

let pass = 0
let fail = 0
const bad = []
function check(label, ok, detail = '') {
  if (ok) pass++
  else { fail++; bad.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${label}  ← ${detail}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-migroot-'))

// ⚠️ 必须在 import 插件之前改：指针文件路径由 homedir() 现算。
// 不改的话这个脚本会**覆盖用户真实的 ~/.dsh/memory-root.json**，
// 把记忆根指到临时目录 —— 那正是待办 D 要修的那种灾难。
process.env.USERPROFILE = path.join(TMP, 'home')
process.env.HOME = process.env.USERPROFILE
fs.mkdirSync(process.env.USERPROFILE, { recursive: true })

const { createStore } = await import('../dsh-fatfishdream-memory/index.js')
const { openMemoryDb } = await import('../dsh-fatfishdream-memory/db-schema.mjs')
const { DatabaseSync } = await import('node:sqlite')

/** 递归列出目录下每个文件的 相对路径 → sha256 */
function fingerprint(dir) {
  const out = new Map()
  const walk = (cur) => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile()) {
        out.set(path.relative(dir, full), crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'))
      }
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

/** 造一个「像真的」记忆根：policy.md + state.json + 真 SQLite 库 + logs */
function makeRoot(dir) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'policy.md'), '## 给模型的规则\n- 测试用规则\n', 'utf8')
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({ version: 2, lastConsolidate: null, projects: {} }, null, 2) + '\n',
    'utf8',
  )
  const db = openMemoryDb(DatabaseSync, path.join(dir, 'memory.db'))
  db.prepare(
    `INSERT INTO logs(scope,ts,topic,text,status,writer) VALUES(?,?,?,?,?,?)`,
  ).run('seed', '2026-11-28T00:00:00.000Z', '开发日志', '种子流水', 'active', 'model')
  db.close()
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'logs', '2026-11-28.log'), '[x] 一行日志\n', 'utf8')
  return dir
}

const INDEX = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../dsh-fatfishdream-memory/index.js'), 'utf8')

try {
  // ============================================================
  console.log('\n=== 1. 成功路径：真的搬过去，源一字节不动 ===\n')
  {
    const src = makeRoot(path.join(TMP, 'ok-src'))
    const dst = path.join(TMP, 'ok-dst')
    const before = fingerprint(src)

    const store = createStore({ root: src })
    const result = await store.migrateRoot(dst, () => {})

    check('返回的 root 就是目标目录', result.root === dst, result.root)
    check('store.root 已切到新位置', store.root === dst, store.root)
    check('新根有 memory.db', fs.existsSync(path.join(dst, 'memory.db')))
    check('新根有 policy.md', fs.existsSync(path.join(dst, 'policy.md')))
    check('新根有 state.json', fs.existsSync(path.join(dst, 'state.json')))
    check('新根有 logs/', fs.existsSync(path.join(dst, 'logs', '2026-11-28.log')))

    // ★ 最关键的一条：源目录**少了任何一个文件**都算失败
    const after = fingerprint(src)
    const lost = [...before.keys()].filter((k) => !after.has(k))
    check('源目录没少任何文件', lost.length === 0, lost.join(', '))

    let same = true
    for (const [k, v] of before) {
      if (after.get(k) !== v) { same = false; console.log('   变了：' + k) }
    }
    check('源目录原有文件 sha256 完全一致（没有被改写）', same)

    // ⚠️ 允许**新增**，但只允许 SQLite 的旁路文件。
    //
    // 实测（本脚本第一次跑就抓到）：`backupDbFile` 以 readOnly 打开源库时，
    // SQLite 会为 WAL 模式生成 `-wal` / `-shm` 两个附属文件 —— 即使它只是读。
    // 这是 SQLite 自己的行为，不是插件写的，且不影响数据。
    // 但它确实意味着「迁移后源目录会多两个文件」，所以断言要写清楚边界：
    // **新增的只能是这两个**，别的任何新文件都说明有东西在源侧落盘了。
    const added = [...after.keys()].filter((k) => !before.has(k))
    const allowedAdded = added.filter((k) => /[\\/]?memory\.db-(wal|shm)$/.test(k))
    check('源目录新增的只有 sqlite 旁路文件（-wal / -shm）',
      added.length === allowedAdded.length,
      added.filter((k) => !allowedAdded.includes(k)).join(', '))

    // 新库真的能打开、且数据在（证明是 VACUUM INTO 出来的有效库）
    const nd = openMemoryDb(DatabaseSync, path.join(dst, 'memory.db'))
    const row = nd.prepare(`SELECT text FROM logs WHERE scope='seed'`).get()
    check('新库能独立打开且种子数据在', row?.text === '种子流水', JSON.stringify(row))
    nd.close()

    // 指针也跟着走了（否则下次启动回退到盘符探测）
    const pointer = path.join(process.env.USERPROFILE, '.dsh', 'memory-root.json')
    check('指针文件已指向新根',
      fs.existsSync(pointer) && JSON.parse(fs.readFileSync(pointer, 'utf8')).root === dst.replace(/\//g, '\\'),
      fs.existsSync(pointer) ? fs.readFileSync(pointer, 'utf8').trim() : '指针不存在')
  }

  // ============================================================
  console.log('\n=== 2. 失败路径：源完好，目标留残骸（刻意不清理）===\n')
  {
    const src = makeRoot(path.join(TMP, 'bad-src'))
    // 用一个「不是 SQLite」的文件冒充库 → VACUUM INTO 必然抛错。
    // 注意根级 policy.md / state.json 在库之前就已经搬过去了，
    // 所以这次失败一定能造出「目标有半份数据」的现场。
    fs.writeFileSync(path.join(src, 'memory.db'), 'this is not a sqlite database at all', 'utf8')
    const dst = path.join(TMP, 'bad-dst')
    const before = fingerprint(src)

    const store = createStore({ root: src })
    let threw = null
    try {
      await store.migrateRoot(dst, () => {})
    } catch (e) {
      threw = e
    }

    check('坏库导致 migrateRoot 抛错（而不是假装成功）', threw !== null)
    check('抛错信息说明是数据库备份失败', /主数据库备份失败/.test(String(threw?.message ?? '')))

    const after = fingerprint(src)
    const lost = [...before.keys()].filter((k) => !after.has(k))
    check('失败后源目录没少任何文件', lost.length === 0, lost.join(', '))
    let same = true
    for (const [k, v] of before) if (after.get(k) !== v) same = false
    check('失败后源目录原有文件逐字节完好（含那个坏库本身）', same)

    // ★ 反向断言：目标**没有被清理**。
    // 这是刻意的取舍（见 migrateRoot docstring）。若有人加了失败清理，
    // 这条会红 —— 那时请先读 docstring 与待办 B2，不要直接把断言改成绿色。
    check('失败后目标目录仍存在（刻意不递归删除）', fs.existsSync(dst))
    check('失败后目标里留着半成品（policy.md 已搬过去）',
      fs.existsSync(path.join(dst, 'policy.md')),
      '如果这里为 false，说明实现已改成「失败清理」—— 请回来核对 B2 的结论')
  }

  // ============================================================
  console.log('\n=== 3. 「目标目录非空」的文案要指向正确的下一步 ===\n')
  {
    const src = makeRoot(path.join(TMP, 'busy-src'))
    const dst = path.join(TMP, 'busy-dst')
    fs.mkdirSync(dst, { recursive: true })
    fs.writeFileSync(path.join(dst, 'someone-else.txt'), 'keep me', 'utf8')

    const store = createStore({ root: src })
    let threw = null
    try {
      await store.migrateRoot(dst, () => {})
    } catch (e) {
      threw = e
    }
    const msg = String(threw?.message ?? '')

    check('非空目标被拒绝', threw !== null)
    check('文案说明「可能要删掉该目录后重试」', /删掉该目录后重试/.test(msg), msg)
    check('文案说明「源没有任何改动」', /没有任何改动/.test(msg), msg)
    check('用户原有文件没被碰', fs.readFileSync(path.join(dst, 'someone-else.txt'), 'utf8') === 'keep me')
    check('拒绝发生时没有把 policy.md 搬进去',
      !fs.existsSync(path.join(dst, 'policy.md')))
  }

  // ============================================================
  console.log('\n=== 4. 源码级：migrateRoot 体内不许有删除调用 ===\n')
  {
    const lines = INDEX.split('\n')
    const start = lines.findIndex((l) => l.includes('async function migrateRoot('))
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) {
      if (/^  \}/.test(lines[i])) { end = i; break }
    }
    check('能定位 migrateRoot 函数体', start >= 0 && end > start, `L${start + 1}–L${end + 1}`)

    const body = lines.slice(start, end + 1)
    const offenders = body
      .map((l, i) => ({ l, no: start + i + 1 }))
      // 排除注释行：docstring 里会提到 rm / unlink
      .filter((x) => !/^\s*(\*|\/\/)/.test(x.l))
      .filter((x) => /\brm\(|rmSync\(|\bunlink\(|unlinkSync\(|rmdir/.test(x.l))

    check('migrateRoot 体内没有 rm / unlink / rmdir（源侧只读）',
      offenders.length === 0,
      offenders.map((x) => `L${x.no}: ${x.l.trim()}`).join(' | '))
  }

  // ============================================================
  console.log('\n=== 5. 源码级：失败分支必须回答「记忆还在吗」 ===\n')
  {
    check('失败返回里有 sourceIntact 标记', /sourceIntact:\s*true/.test(INDEX))
    check('失败返回里带源目录路径字段', /sourceRoot,/.test(INDEX))
    check('失败文案里有「你的记忆没有动」', /你的记忆没有动/.test(INDEX))
    check(
      'sourceRoot 取的是 try 之前的快照（不是 catch 里现读 store.root）',
      /const sourceRoot = store\.root[\s\S]{0,400}?try \{/.test(INDEX),
      '失败可能发生在 setRoot() 之后，catch 里现读会指向新根',
    )
  }
} finally {
  // Windows 上库句柄未释放时删不掉，重试几次（与本项目其他脚本一致）
  try {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch (e) {
    console.log(`\n（临时目录清理失败，可手动删：${TMP}）`)
  }
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
