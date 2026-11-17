/**
 * 验证修复 A 的**失败路径** —— 迁移失败时是否真的关闭了连接。
 *
 * ## 关键点：不碰真实库
 *
 * `openMemoryDb(DatabaseSync, dbPath)` 接受路径参数，所以可以：
 *   ① 在临时目录建一个**旧版本**的库（user_version = SCHEMA_VERSION - 1）
 *   ② 人为让迁移失败（把表先建成迁移要建的样子 → ALTER 撞 duplicate column）
 *   ③ 调 openMemoryDb，观察它抛错
 *   ④ **判据**：抛错后立刻用可写方式重开同一个文件 —— 打不开就说明没释放
 *
 * ## 为什么这个判据能证明「没 close」
 *
 * Windows 上 SQLite 句柄不释放时，同一进程再以**可写**方式打开会失败；
 * 而如果已经 close，重开一定成功。这是进程内的句柄占用，不依赖外部工具。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SCHEMA = path.join(REPO, 'dsh-fatfishdream-memory/db-schema.mjs')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}  ← ${detail}`)
  }
}

const mod = await import(pathToFileURL(SCHEMA).href)
const { openMemoryDb, SCHEMA_VERSION, MIGRATIONS } = mod

console.log(`\n  当前 SCHEMA_VERSION = ${SCHEMA_VERSION}`)
console.log(`  MIGRATIONS 数量 = ${MIGRATIONS?.length ?? '?'}`)

const { DatabaseSync } = await import('node:sqlite')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'openmemdb-A-'))

try {
  // ============================================================
  console.log('\n=== ① 正常路径：全新空库能建起来 ===\n')
  {
    const p = path.join(tmp, 'fresh.db')
    const db = openMemoryDb(DatabaseSync, p)
    check('返回了连接', db !== null && db !== undefined)
    const v = db.prepare('PRAGMA user_version').get().user_version
    check(`user_version 升到 ${SCHEMA_VERSION}`, v === SCHEMA_VERSION, `实际 ${v}`)
    db.close()
  }

  // ============================================================
  console.log('\n=== ② 失败路径：迁移中途失败时，连接必须被关闭 ===\n')
  {
    const p = path.join(tmp, 'broken.db')

    // 造一个「版本落后、但结构已经是新的」的库 —— 这会让迁移必然失败。
    //
    // 做法：先用正常流程建到最新，再把 user_version 改回 0。
    // 于是 openMemoryDb 会认为「需要从 0 迁移到最新」，
    // 而表已经存在 → CREATE TABLE IF NOT EXISTS 空转、
    // 但 ALTER TABLE ADD COLUMN 会撞 `duplicate column name` → 抛错。
    {
      const seed = openMemoryDb(DatabaseSync, p)
      seed.close()
      const raw = new DatabaseSync(p)
      raw.exec('PRAGMA user_version = 0')
      raw.close()
    }

    let threw = null
    try {
      openMemoryDb(DatabaseSync, p)
    } catch (e) {
      threw = String(e?.message ?? e)
    }

    check('openMemoryDb 抛错（迁移失败）', threw !== null, threw === null ? '居然成功了' : '')
    if (threw) console.log(`    错误信息: ${threw.slice(0, 80)}`)

    // ★ 核心判据：抛错之后，能不能立刻以可写方式重开？
    //   如果修复 A 有效（失败时 close 了），这里应该成功。
    //   如果没 close，Windows 上会 EBUSY / SQLITE_BUSY。
    let reopenOk = false
    let reopenErr = null
    try {
      const again = new DatabaseSync(p)
      // 真写一次，确保不是「打开了但不可写」
      again.exec('BEGIN IMMEDIATE')
      again.exec('ROLLBACK')
      again.close()
      reopenOk = true
    } catch (e) {
      reopenErr = String(e?.message ?? e)
    }

    check(
      '迁移失败后能立刻重开并写入（= 连接已被释放）',
      reopenOk === true,
      reopenErr ?? '打不开 → 句柄没释放，Windows 上会锁库',
    )
  }

  // ============================================================
  console.log('\n=== ③ 版本比代码新时也要 close 并抛错（这条原来就是对的）===\n')
  {
    const p = path.join(tmp, 'future.db')
    {
      const seed = openMemoryDb(DatabaseSync, p)
      seed.close()
      const raw = new DatabaseSync(p)
      raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 99}`)
      raw.close()
    }

    let threw = null
    try {
      openMemoryDb(DatabaseSync, p)
    } catch (e) {
      threw = String(e?.message ?? e)
    }
    check('版本过新时抛错', threw !== null && /升级插件|版本/.test(threw), threw ?? '')

    let reopenOk = false
    try {
      const again = new DatabaseSync(p)
      again.close()
      reopenOk = true
    } catch {
      reopenOk = false
    }
    check('版本过新时也 close 了（能重开）', reopenOk === true)
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${'─'.repeat(50)}`)
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
  console.log('修复 A 的失败路径已在临时库里验证 —— 没碰真实记忆库。')
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('  - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
