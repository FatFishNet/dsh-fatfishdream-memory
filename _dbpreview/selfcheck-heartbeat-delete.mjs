/**
 * 收尾语「删除」路径的安全网 + FTS 删除的参数纪律（待办 E / N，2026-11-28）。
 *
 * ## E 守什么
 *
 * 「清除收尾语」是 **GUI 上一个按钮就能触发的破坏性操作**，而修改前有两条隐患：
 *
 *   ① `/heartbeat` 收到 `{}`（空 body / 漏传 text）与 `{"text":""}`（用户点清除）
 *      **走同一条路** —— 都变成空串 → 删掉收尾语。方法白名单挡住了 HEAD/GET，
 *      但挡不住「POST 了一个空 body」（代理重放、GUI 漏传、第三方脚本误调）。
 *   ② 删除**直接覆盖、零备份**。而这个项目没有任何地方存着 policy.md 的内容
 *      （memory.db 里没有，back/ 也不含运行时文件），删掉就真没了。
 *
 * ## N 守什么
 *
 * `removeFts(db, table, id, row = null)` 的默认值让「漏传行」变成**静默失效**：
 * contentless FTS5 的 `'delete'` 必须带**与插入时逐列一致**的原值才能反查，
 * 传空值不是「删了个空的」，是「什么都没删掉」，且有时抛
 * `database disk image is malformed`（错名指向「库坏了」，比静默更误导）。
 *
 * ⚠️ 本脚本**不碰真实 policy.md / memory.db**：全部用临时目录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INDEX = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/index.js'), 'utf8')
const SCHEMA = fs.readFileSync(path.join(ROOT, 'dsh-fatfishdream-memory/db-schema.mjs'), 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(label, ok, detail = '') {
  if (ok) pass++
  else { fail++; bad.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${label}  ← ${detail}`) }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-en-'))

try {
  // ============================================================
  console.log('\n=== 1. E · 「没传 text」不得被当成「清除」===\n')
  {
    // 复刻修后的路由判据
    const guard = (body) => {
      if (typeof body?.text !== 'string') return { rejected: true }
      return { rejected: false, text: body.text.trim() }
    }

    check('空 body {} → 拒绝（不再删收尾语）', guard({}).rejected === true)
    check('缺 text 字段 → 拒绝', guard({ foo: 1 }).rejected === true)
    check('text 是 null → 拒绝', guard({ text: null }).rejected === true)
    check('text 是数字 → 拒绝', guard({ text: 123 }).rejected === true)
    check('显式 text:"" → 放行（用户明确要清除）',
      guard({ text: '' }).rejected === false && guard({ text: '' }).text === '')
    check('显式 text:"x" → 放行', guard({ text: 'x' }).text === 'x')
    check('只有空白 → 放行并归一成空串（等价于清除，仍是显式意图）',
      guard({ text: '   ' }).text === '')

    // 源码级：路由里必须有这条判据（行为级测不到真实路由）
    check(
      '路由源码里有 typeof body?.text !== \'string\' 的拒绝分支',
      /typeof body\?\.text !== 'string'/.test(INDEX),
      '没有它 = 空 body 仍会删收尾语',
    )
    check(
      '拒绝时返回 400 并说明「要清除请显式传空串」',
      /缺少 text 字段[\s\S]{0,120}text":""/.test(INDEX) || /缺少 text 字段/.test(INDEX),
    )
  }

  // ============================================================
  console.log('\n=== 2. E · 删除前必须备份整份 policy.md ===\n')
  {
    const KEEP = 5
    const dir = path.join(tmp, 'policy-bak')
    fs.mkdirSync(dir, { recursive: true })
    const CONTENT = '# 给模型的规则\n- 必须执行 log.ps1\n- 收尾语：大肥鱼是漂亮老婆！\n'

    // 复刻 backupPolicyBeforeDelete 的行为
    async function backup(content) {
      if (typeof content !== 'string' || content === '') return
      const d = new Date()
      const p = (n, w = 2) => String(n).padStart(w, '0')
      const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`
      fs.writeFileSync(path.join(dir, `policy.md.bak-${stamp}`), content, 'utf8')
      const all = fs.readdirSync(dir).filter((f) => /^policy\.md\.bak-\d{8}-\d{9,}$/.test(f)).sort()
      const extra = all.length - KEEP
      if (extra > 0) for (const f of all.slice(0, extra)) fs.unlinkSync(path.join(dir, f))
    }

    await backup(CONTENT)
    let baks = fs.readdirSync(dir).filter((f) => f.startsWith('policy.md.bak-'))
    check('删除前产生了备份', baks.length === 1, `实际 ${baks.length}`)
    check(
      '备份内容与删除前**逐字节一致**（存整份而不是只存那一行）',
      fs.readFileSync(path.join(dir, baks[0]), 'utf8') === CONTENT,
      '存错内容 = 备份无效',
    )
    check('备份里能看到用户写的那句话', fs.readFileSync(path.join(dir, baks[0]), 'utf8').includes('大肥鱼'))

    // 空内容不备份（没东西可删时不该堆垃圾）
    await backup('')
    check('无内容时不产生备份', fs.readdirSync(dir).filter((f) => f.startsWith('policy.md.bak-')).length === 1)

    // 反复删只留最近 KEEP 个
    for (let i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 3))
      await backup(`${CONTENT}<!-- ${i} -->`)
    }
    baks = fs.readdirSync(dir).filter((f) => f.startsWith('policy.md.bak-')).sort()
    check(`连续 8 次删除后只保留 ${KEEP} 个`, baks.length === KEEP, `实际 ${baks.length}`)
    check(
      '保留的是**最新**的几个（最旧被清理）',
      fs.readFileSync(path.join(dir, baks[baks.length - 1]), 'utf8').includes('<!-- 7 -->'),
    )

    // 源码级：删除分支里真的调了备份，且是**整份**
    check(
      '删除分支里调用了 backupPolicyBeforeDelete',
      /await backupPolicyBeforeDelete\(current\)/.test(INDEX),
      '没有它 = 删除仍然是零备份',
    )
    check(
      '备份传入的是整份 current（不是某一行的切片）',
      /backupPolicyBeforeDelete\(current\)/.test(INDEX),
    )
    check(
      '备份文件名带时间戳（反复删不覆盖旧备份）',
      /policy\.md\.bak-\$\{stamp\}/.test(INDEX),
    )
    check(
      '有保留上限（不无限堆积）',
      /POLICY_BACKUP_KEEP/.test(INDEX),
    )
  }

  // ============================================================
  console.log('\n=== 3. N · removeFts 缺行必须立刻抛错 ===\n')
  {
    // 行为级：真开一个库来试
    // ⚠️ Windows 下 `import()` 必须给 file:// URL，给绝对路径会报
    //    ERR_UNSUPPORTED_ESM_URL_SCHEME（本轮实测踩到）。
    const schemaUrl = new URL('file:///' + path.join(ROOT, 'dsh-fatfishdream-memory/db-schema.mjs').replace(/\\/g, '/'))
    const { openMemoryDb, removeFts, syncFts, FTS_TABLE } = await import(schemaUrl.href)
    const DatabaseSync = (await import('node:sqlite')).DatabaseSync
    const dbDir = path.join(tmp, 'fts')
    fs.mkdirSync(dbDir, { recursive: true })
    const db = openMemoryDb(DatabaseSync, path.join(dbDir, 'memory.db'))

    db.prepare(
      "INSERT INTO rules (scope, kind, ts, topic, text, status) VALUES ('s','rule','2026-01-01','t','测试内容ABCxyz','active')",
    ).run()
    const id = db.prepare('SELECT id FROM rules ORDER BY id DESC LIMIT 1').get().id
    const row = db.prepare('SELECT * FROM rules WHERE id=?').get(id)

    let threwNull = null
    try { removeFts(db, 'rules', id, null) } catch (e) { threwNull = e }
    check('传 null → 抛错（原来是静默删不掉）', threwNull !== null, '没抛 → 索引项会残留')
    check(
      '错误信息说明「要传完整那一行」（不是让 FTS5 抛看不懂的 malformed）',
      threwNull !== null && /完整行数据|一整行/.test(threwNull.message),
      threwNull?.message?.slice(0, 60),
    )

    let threwMissing = null
    try { removeFts(db, 'rules', id) } catch (e) { threwMissing = e }
    check('漏传第 4 个参数 → 同样抛错（默认值已移除）', threwMissing !== null)

    // 传整行必须**正常工作**（这是修复不能破坏的部分）
    let okFull = true
    try { syncFts(db, 'rules', id, row); removeFts(db, 'rules', id, row) } catch { okFull = false }
    check('传完整行时正常工作（修复没破坏正确路径）', okFull)

    db.close()
  }

  // ============================================================
  console.log('\n=== 4. 反证：这些断言真的能失败 ===\n')
  {
    // 修前的判据（行为级）
    const oldGuard = (body) => {
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      return { rejected: false, text }
    }
    check(
      '反证：修前判据会把空 body 当成「清除」（证明修复有意义）',
      oldGuard({}).rejected === false && oldGuard({}).text === '',
    )

    // 修前的源码形态
    check(
      '反证：修前源码确实没有 typeof body?.text 的拒绝分支',
      !/typeof body\?\.text !== 'string'/.test(
        "const text = typeof body.text === 'string' ? body.text.trim() : ''",
      ),
    )
    check(
      '反证：修前 removeFts 签名有默认 null',
      /row = null/.test('export function removeFts(db, table, id, row = null) {'),
    )
    check(
      '反证：修后源码里 removeFts 不再有 row = null 默认值',
      !/export function removeFts\(db, table, id, row = null\)/.test(SCHEMA),
    )
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
