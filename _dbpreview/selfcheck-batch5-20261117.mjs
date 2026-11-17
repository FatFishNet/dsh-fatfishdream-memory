/**
 * 2026-11-17 第二批修复的回归（TODO 待办 L / A / C / P / O）。
 *
 * ## 为什么这五条要单独一个文件
 *
 * 它们的共同点：**正常路径下行为完全不变**，只有边界输入或故障路径才暴露。
 * 所以 48 个既有脚本全绿的情况下，它们能一直活着。
 *
 * 每条断言后面标了 `[回退验证]`，说明怎么让它变红。
 * 配套的故障注入是 `faultinject-batch5-20261117.mjs` ——
 * **没有那个文件，本文件的断言就只是「看起来对」**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory/index.js')
const STORE = path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs')
const SCHEMA = path.join(REPO, 'dsh-fatfishdream-memory/db-schema.mjs')

const SRC = fs.readFileSync(INDEX, 'utf8')
const STORE_SRC = fs.readFileSync(STORE, 'utf8')
const SCHEMA_SRC = fs.readFileSync(SCHEMA, 'utf8')

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

/** 从源码抽顶层函数（大括号配对）。 */
function extractFn(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = src.match(re)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(m.index, i + 1)
    }
  }
  return null
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch5-'))

try {
  // ============================================================
  console.log('\n=== L：search 必须过滤 review=retracted ===\n')
  {
    // [回退验证] 删掉三处 `review IS NOT 'retracted'`，本段红。
    const occ = (STORE_SRC.match(/review IS NOT 'retracted'/g) ?? []).length
    check('search 的三条 SQL 都加了 review 过滤', occ >= 3, `实际 ${occ} 处`)

    // 关键：logs 表没有 review 列，绝不能加
    const logsHasReview = /CREATE TABLE IF NOT EXISTS logs \([\s\S]*?review/.test(SCHEMA_SRC)
    check('logs 表确实没有 review 列（所以 logs 那条不能加这个条件）', logsHasReview === false)

    // 行为验证：造一条 retracted 的规则，确认搜不到
    const { createDbStore } = await import(pathToFileURL(STORE).href)
    const dbPath = path.join(tmpRoot, 'retract.db')
    const s = createDbStore(dbPath, {}, () => {})
    s.open()

    // 写一条带「撤回标记词」的规则
    const r = s.createEntry({ table: 'rules', scope: 'proj', kind: 'pref', text: '撤回测试用规则甲' })
    const id = r.id ?? r
    s.setReview('rules', id, 'retracted')

    const hits = s.search('撤回测试用规则甲', { projectName: 'proj', limit: 10 })
    s.close()

    check(
      '被 retracted 的规则不再出现在 search 结果里',
      Array.isArray(hits) && hits.filter((h) => h.table === 'rules').length === 0,
      `实际命中 ${(hits ?? []).length} 条`,
    )
  }

  // ============================================================
  console.log('\n=== A：迁移失败必须关闭连接 ===\n')
  {
    // [回退验证] 把 catch 里的 db.close() 去掉，本段红。
    //
    // ⚠️ 判据不能写成 `schema 迁移到 v[\s\S]{0,600}?` —— 那个 catch 块现在
    //    带了大段注释，600 字符根本不够（第一版就是这么误报的）。
    //    改成：先定位到 `catch (e) {` 的**位置**，再取它之后 1500 字符作为块。
    const anchor = /} catch \(e\) \{/
    const m = anchor.exec(SCHEMA_SRC)
    check('能定位到迁移失败的 catch (e) 块', m !== null, m === null ? '源码结构变了' : '')
    if (m) {
      // 从 catch 开始往后取一段，直到遇到「下一个顶层 for/try/函数」都不算越界
      const block = SCHEMA_SRC.slice(m.index, m.index + 1500)
      check('catch 块里有 db.close()', /db\.close\(\)/.test(block), '缺它 → Windows 上锁库，备份/再迁移全失败')
      check('close 被 try 包住（不让它顶掉原始错误）', /try\s*\{\s*db\.close\(\)\s*\}\s*catch/.test(block))
      check('ROLLBACK 也被 try 包住', /try\s*\{\s*db\.exec\('ROLLBACK'\)\s*\}\s*catch/.test(block))
      check('close 在 throw 之前（顺序不可反）', block.indexOf('db.close()') < block.indexOf('throw new Error'))
    }
  }

  // ============================================================
  console.log('\n=== C：copyTree 读目录失败不能静默 ===\n')
  {
    // [回退验证] 把 `catch (error)` 块改回「只 return 0」，本段红。
    //
    // ⚠️ 第一版只查了「函数里有 skipped.push 和 ENOENT」——
    //    那两个字符串在**注释里**也有，所以把修复撤掉它照样绿。
    //    这是今晚第三次同一种病：断言在，被测的差异不在。
    //
    // 正确判据：**切出 catch 块本身**，在那个块里查。
    const fn = extractFn(SRC, 'copyTree')
    check('能抽出 copyTree', fn !== null)
    if (fn) {
      // 定位 `} catch (error) {` 到它配对的 `}` —— 用后面第一个 `\n  }` 近似
      const cm = /\} catch \(error\) \{/.exec(fn)
      check('catch 带 error 变量（原来是无参 catch）', cm !== null, '无参 catch 就吞掉了原因')
      if (cm) {
        const tail = fn.slice(cm.index)
        // catch 块的范围：从 { 到下一个同缩进的 }
        const braceStart = tail.indexOf('{')
        let depth = 0
        let end = -1
        for (let i = braceStart; i < tail.length; i++) {
          if (tail[i] === '{') depth++
          else if (tail[i] === '}') {
            depth--
            if (depth === 0) {
              end = i
              break
            }
          }
        }
        const block = end > 0 ? tail.slice(braceStart, end + 1) : ''
        check('能切出 catch 块', block.length > 0)

        // 关键：块里必须**先**判 ENOENT 再 push，且 push 在块内
        check('catch 块里区分 ENOENT（真的空目录才返回 0）', /ENOENT/.test(block), '不区分的话，权限不足也会被当成空目录')
        check('catch 块里把非 ENOENT 的错误记进 skipped', /skipped\.push/.test(block), '缺它 → 迁移报成功但少文件，零日志')
        check('skipped 里带上了错误码或消息', /error\?\.code|error\?\.message/.test(block))
        check(
          'push 之前有 ENOENT 的提前返回（顺序不可反）',
          block.indexOf('ENOENT') < block.indexOf('skipped.push'),
          block.indexOf('ENOENT') < 0 ? '块里没有 ENOENT' : '顺序反了：先 push 再判 ENOENT',
        )
      }
    }
  }

  // ============================================================
  console.log('\n=== P：id 必须是正整数，不接受 true / [7] ===\n')
  {
    // [回退验证] 把 parseId 换回 Number()，本段红。
    const fn = extractFn(SRC, 'parseId')
    check('parseId 存在', fn !== null)
    if (fn) {
      // eslint-disable-next-line no-new-func
      const parseId = new Function(`${fn}\nreturn parseId`)()

      // 必须拒绝的（Number() 会误接受的）
      check('拒绝 true（Number(true)===1 会误删 id=1）', parseId(true) === null)
      check('拒绝 false（Number(false)===0）', parseId(false) === null)
      check('拒绝 [7]（Number([7])===7）', parseId([7]) === null)
      check('拒绝 null（Number(null)===0）', parseId(null) === null)
      check('拒绝空串', parseId('') === null)
      check('拒绝负数', parseId(-1) === null)
      check('拒绝 0', parseId(0) === null)
      check('拒绝小数', parseId(2.5) === null)
      check('拒绝 "7abc"', parseId('7abc') === null)
      check('拒绝对象', parseId({ id: 7 }) === null)

      // 必须接受的
      check('接受 number 7', parseId(7) === 7)
      check('接受字符串 "7"', parseId('7') === 7)
      check('接受带空格的 " 7 "', parseId(' 7 ') === 7)
      check('接受大整数 999999', parseId(999999) === 999999)
    }

    // 所有调用点都换成了 parseId
    const left = (SRC.match(/const id = Number\((body|it)\.id\)/g) ?? []).length
    check('代码里没有残留 `const id = Number(body.id)`（注释不算）',
      // 注释行要排除
      (SRC.split('\n').filter((l) => !/^\s*\*/.test(l)).join('\n').match(/const id = Number\((body|it)\.id\)/g) ?? []).length === 0,
      `实际残留 ${left}`)
  }

  // ============================================================
  console.log('\n=== O：limit / offset 必须校验成合法整数 ===\n')
  {
    // [回退验证] 把 clampInt 换回 `Number(x) || def`，本段红。
    const fn = extractFn(SRC, 'clampInt')
    check('clampInt 存在', fn !== null)
    if (fn) {
      // eslint-disable-next-line no-new-func
      const clampInt = new Function(`${fn}\nreturn clampInt`)()

      // 关键反例：这些在 `Number(x) || 30` 下都会出错
      check('limit="-1" 被钳到 min（原来会静默返 0 条）', clampInt('-1', 30, { min: 1, max: 200 }) === 1)
      check('limit="2.5" 回默认（原来会 500）', clampInt('2.5', 30, { min: 1, max: 200 }) === 30)
      check('limit="1e21" 回默认（原来会 500）', clampInt('1e21', 30, { min: 1, max: 200 }) === 30)
      check('limit="0" 钳到 min（`|| 30` 会变成 30）', clampInt('0', 30, { min: 1, max: 200 }) === 1)
      check('offset="-5" 被钳到 0（原来会回到第一页）', clampInt('-5', 0, { min: 0 }) === 0)
      check('超上界被钳住', clampInt('9999', 30, { min: 1, max: 200 }) === 200)

      // 正常值必须原样通过
      check('limit="50" 原样通过', clampInt('50', 30, { min: 1, max: 200 }) === 50)
      check('参数缺失回默认', clampInt(null, 30, { min: 1, max: 200 }) === 30)
      check('非数字回默认', clampInt('abc', 30, { min: 1, max: 200 }) === 30)
    }

    // 三处调用点都已替换
    const bare = (SRC.split('\n').filter((l) => !/^\s*\*/.test(l)).join('\n')
      .match(/Number\((q|url\.searchParams)\.get\('(limit|offset)'\)\)/g) ?? []).length
    check('代码里没有残留裸 Number(...get(limit/offset))', bare === 0, `实际 ${bare} 处`)
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${'─'.repeat(50)}`)
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
  console.log('\n五项修复各有用例；[回退验证] 见 faultinject-batch5-20261117.mjs')
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('  - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
