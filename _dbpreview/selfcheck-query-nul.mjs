/**
 * 回归测试：检索词里的控制字符（2026-11-19 实测复现的 500）。
 *
 * ## 抓的是什么
 *
 * FTS5 的 MATCH 表达式是**它自己的小语法**，用 C 字符串解析，
 * 于是 `\u0000` 被当成**字符串终止符**，整条查询报：
 *
 *     SQLITE_ERROR: unterminated string
 *
 * 实测（本机运行中的实例，修复前）：
 *
 *     GET /api/dsh-memory/search?q=a%00b&scope=...
 *     → 500 {"ok":false,"error":"unterminated string"}
 *
 * ## 为什么值得单独一个脚本
 *
 * 三个入口共用 `buildMatchQuery`：`/search`、`entries?q=`、`archive?q=`。
 * 修在那一处就等于三个一起修好 —— 但**反过来也一样**：那一处坏了，
 * 三个入口同时坏，而其中两个的失败形态是「静默返回 0 条」。
 *
 * ## 第二类危害（比 500 更隐蔽）
 *
 * `\u0001` 这类控制符**不会**让 FTS5 报错，它会被当成一个真实 token：
 *
 *     buildMatchQuery('词\u0001控制符') → "词" AND "\u0001" AND "控" ...
 *
 * 而库里没有任何一条文档含 `\u0001` 这个 token → **永远 0 条**。
 * 用户搜的是「词控制符」，本该有结果，却得到空 —— 不报错、无日志。
 * 这条修复之前，这种形态没有任何断言守着。
 *
 * ## 断言必须能失败
 *
 * 本脚本自带 `--self-test`：把 `buildMatchQuery` 的清洗行临时去掉，
 * 重跑同一批断言，**必须变红**。做不到就说明断言是恒真的。
 * 做法见 `_dbpreview/faultinject-batch5-20261117.mjs` 的同款思路，
 * 但这里不碰磁盘上的源文件 —— 改为在内存里对抽出的函数体做替换，
 * 所以不需要 sha256 还原，也不会和其他脚本抢文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const SCHEMA_PATH = path.join(ROOT, 'dsh-fatfishdream-memory', 'db-schema.mjs')

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

// ---------------------------------------------------------------- 抽取真实源码
//
// ⚠️ 不 import：`db-schema.mjs` 顶层没有副作用，import 本身没问题，
//    但 `--self-test` 需要**改一版函数体再跑**，import 拿不到这种控制权。
//    所以照 `selfcheck-pure-utils.mjs` 的办法从源码抽取，测的仍是真实代码。

const SRC = fs.readFileSync(SCHEMA_PATH, 'utf8')

function extractFn(name, source = SRC) {
  const startRe = new RegExp(`^export function ${name}\\(`, 'm')
  const m = startRe.exec(source)
  if (!m) throw new Error(`源码里找不到 export function ${name}`)
  const start = m.index
  let i = source.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) throw new Error(`export function ${name} 的大括号不配对`)
  return source.slice(start, end).replace(/^export /, '')
}

const segmentCjkSrc = extractFn('segmentCjk')
const buildMatchQuerySrc = extractFn('buildMatchQuery')

function makeBuilders(source = SRC) {
  const segSrc = extractFn('segmentCjk', source)
  const bmqSrc = extractFn('buildMatchQuery', source)
  // eslint-disable-next-line no-new-func
  const mk = new Function(
    `${segSrc}\n${bmqSrc}\nreturn { segmentCjk, buildMatchQuery }`,
  )
  return mk()
}

const { buildMatchQuery } = makeBuilders()

// ---------------------------------------------------------------- ① 纯函数层

console.log('=== ① buildMatchQuery：控制字符清洗 ===\n')

// NUL：修复前会让 FTS5 报 unterminated string
{
  const mq = buildMatchQuery('a\u0000b')
  check('NUL 被剔除（不留在表达式里）', mq !== null && !mq.includes('\u0000'), JSON.stringify(mq))
  // 修复后 a 与 b 应各自成词，用 AND 连接
  check('NUL 两侧的碎片都保留下来', mq === '"a" AND "b"', JSON.stringify(mq))
}

// 纯 NUL / 纯控制符：清洗后无词可查 → null（调用方返回 0 条，不是 500）
{
  check('纯 NUL → null（不是抛错、也不是空表达式）', buildMatchQuery('\u0000') === null)
  check('纯 C0 控制符 → null', buildMatchQuery('\u0000\u0001\u001f') === null)
  // \u007F 是 DEL，同样属于 C0 家族，这里一并清掉
  check('纯 DEL → null', buildMatchQuery('\u007f') === null)
}

// 中文 + 尾随 NUL：中文部分必须仍然可查
{
  const mq = buildMatchQuery('中文\u0000')
  check('中文+NUL 保留中文逐字', mq === '"中" AND "文"', JSON.stringify(mq))
}

// \u0001 这类「不报错但永远 0 条」的形态
{
  const mq = buildMatchQuery('词\u0001控制符')
  check('\\u0001 不残留（否则会产生永远匹配不到的 token）',
    mq !== null && !mq.includes('\u0001'), JSON.stringify(mq))
  check('\\u0001 两侧的字都在', mq === '"词" AND "控" AND "制" AND "符"', JSON.stringify(mq))
}

// 回归保护：正常查询词的输出必须**逐字节不变**
{
  check('中文查询不受影响', buildMatchQuery('沙箱') === '"沙" AND "箱"', JSON.stringify(buildMatchQuery('沙箱')))
  check('英文查询不受影响', buildMatchQuery('bm25') === '"bm25"', JSON.stringify(buildMatchQuery('bm25')))
  check('混合查询不受影响', buildMatchQuery('沙箱 write') === '"沙" AND "箱" AND "write"', JSON.stringify(buildMatchQuery('沙箱 write')))
  check('空串仍返回 null', buildMatchQuery('') === null)
  check('纯空白仍返回 null', buildMatchQuery('   ') === null)
  check('null 输入不抛错', buildMatchQuery(null) === null)
  check('undefined 输入不抛错', buildMatchQuery(undefined) === null)
}

// 引号转义这条既有行为不能被这次改动带坏
{
  check('查询词里的双引号被剥掉', buildMatchQuery('a"b') === '"ab"', JSON.stringify(buildMatchQuery('a"b')))
  check('FTS 关键字当普通词处理', buildMatchQuery('AND') === '"AND"', JSON.stringify(buildMatchQuery('AND')))
}

// ---------------------------------------------------------------- ② 真实 FTS 层
//
// 纯函数断言只能证明「表达式里没有控制符」。真正要证明的是
// **这条表达式拿去 MATCH 不会炸** —— 那必须交给真的 FTS5。
// 用临时库（`:memory:`），不碰用户数据。

console.log('\n=== ② 真实 FTS5：MATCH 不再抛错 ===\n')

{
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE VIRTUAL TABLE t USING fts5(body, content='', tokenize='unicode61')`)
  // contentless 表只能走 INSERT 指定 rowid
  db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)').run(1, '沙 箱 write bm25 文 档')

  const matchCount = (mq) => {
    if (mq === null) return 0
    try {
      return db.prepare('SELECT count(*) c FROM t WHERE t MATCH ?').get(mq).c
    } catch (e) {
      return `THROW:${e.message}`
    }
  }

  // 修复前这一条是 THROW:unterminated string
  const nulCase = matchCount(buildMatchQuery('a\u0000b'))
  check('含 NUL 的查询不抛错', typeof nulCase === 'number', String(nulCase))

  const c0Case = matchCount(buildMatchQuery('词\u0001控制符'))
  check('含 \\u0001 的查询不抛错', typeof c0Case === 'number', String(c0Case))

  // 关键：清洗之后，正常词的检索能力必须**还在**
  const normalCase = matchCount(buildMatchQuery('沙箱'))
  check('清洗逻辑没有破坏正常检索', typeof normalCase === 'number' && normalCase > 0, String(normalCase))

  // 「中文+NUL」应该仍能命中那条含「文」「档」的文档
  const mixedCase = matchCount(buildMatchQuery('文档\u0000'))
  check('中文+NUL 仍能命中正常文档', typeof mixedCase === 'number' && mixedCase > 0, String(mixedCase))

  db.close()
}

// ---------------------------------------------------------------- ③ 故障注入自证
//
// AGENTS.md 的硬规矩：新增断言必须能证明它会红。
//
// 做法：在内存里把清洗那一行替换成空操作，重跑上面同一批断言的核心三条。
// **不改磁盘文件** —— 所以不会与 meta-mutation-test / run-all 并发时互相踩，
// 也不需要 sha256 还原。

console.log('\n=== ③ 自证：撤掉清洗后断言必须变红 ===\n')

{
  const CLEAN_LINE = "  const cleaned = String(query ?? '').replace(/[\\u0000-\\u001F\\u007F]/g, ' ')"
  const hasAnchor = SRC.includes(CLEAN_LINE)
  // 锚点唯一性：这条断言本身就是防线，锚点失配时下面的自证会失效
  check('自证锚点在源码里存在且唯一',
    hasAnchor && SRC.split(CLEAN_LINE).length - 1 === 1,
    hasAnchor ? `出现 ${SRC.split(CLEAN_LINE).length - 1} 次` : '未找到')

  if (!hasAnchor) {
    console.log('   ⚠️ 锚点失配，本段自证不适用（上面的断言仍有效，但少了「会红」的证明）')
  } else {
    const mutated = SRC.replace(CLEAN_LINE, '  const cleaned = String(query ?? \'\')')
    const { buildMatchQuery: broken } = makeBuilders(mutated)

    // 用**和 ① 完全相同的断言**，期望它们全部失败
    const stillClean = broken('a\u0000b')
    const nulGone = stillClean !== null && !stillClean.includes('\u0000')
    check('撤掉清洗后 NUL 会残留（证明 ① 的清洗断言能红）', nulGone === false, JSON.stringify(stillClean))

    const c0 = broken('词\u0001控制符')
    const c0Gone = c0 !== null && !c0.includes('\u0001')
    check('撤掉清洗后 \\u0001 会残留（证明该断言能红）', c0Gone === false, JSON.stringify(c0))

    // 与 ② 对应：坏表达式拿去 MATCH 真的会炸
    const db2 = new DatabaseSync(':memory:')
    db2.exec(`CREATE VIRTUAL TABLE t2 USING fts5(body, content='', tokenize='unicode61')`)
    db2.prepare('INSERT INTO t2(rowid, body) VALUES (?, ?)').run(1, '沙 箱')
    let threw = false
    try {
      db2.prepare('SELECT count(*) c FROM t2 WHERE t2 MATCH ?').get(broken('a\u0000b'))
    } catch {
      threw = true
    }
    check('撤掉清洗后真实 FTS5 会抛错（证明 ② 的断言能红）', threw === true)
    db2.close()
  }
}

// ---------------------------------------------------------------- 汇总

console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
