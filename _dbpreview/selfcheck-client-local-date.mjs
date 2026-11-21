/**
 * 回归：`client.js` 的日期筛选必须用**本地日期**，不能用 `toISOString()` 取 UTC。
 *
 * ## 为什么单独一个脚本（2026-11-20 用户实报）
 *
 * 用户原话：**「你还是把服务器时间和本地时间算成两天」**。
 *
 * 实测（本地 05:23，UTC 还是前一天 21:23）：
 *
 *     「今天」按钮    → 2026-11-19   应为 2026-11-20
 *     「近 7 天」to   → 2026-11-19   应为 2026-11-20
 *     「近 7 天」from → 2026-11-12   应为 2026-11-13
 *
 * 表现不是「差 8 小时」，是**点「今天」筛出昨天** —— 当天写的流水一条都看不见，
 * 反而看到昨天的 520 条（实测 total：11-19 是 520，11-20 是 411）。
 *
 * ## 为什么它躲过了所有既有测试
 *
 * 那个 bug 在 `client.js`，而**回归里没有任何东西执行 `client.js`**
 * （它是浏览器模块，Node 里跑不了 `window.__ModuleLoader__`）。
 * 既有测试全在测后端：`nowIso()` / `localDay()` / `diagTimestamp()` 早就是本地时间了
 * —— **后端一直是对的，断在前端**。这是「两端各自的测试都绿、接缝是断的」的又一例
 * （和 `selfcheck-show-inactive-wire` 同型）。
 *
 * ## 怎么测（以及为什么不能只 grep）
 *
 * 从源码抽出 `localDayStr` 的**真实函数体**执行 —— 不抄一份判据
 * （抄的话源码改坏了它照样绿）。
 *
 * 关键是**假造一个「本地与 UTC 不同日」的时刻**，而不是拿现在的时间跑：
 * 现在跑若不在 00:00–08:00，本地与 UTC 同一天，bug 与修复**表现完全一样**，
 * 那种断言会绿，却证明不了任何事（「断言在，被测的差异不在」）。
 *
 * 做法：`new Date('2026-11-20T05:23:54')` 在本地时区解析 → 本地 11-20 05:23，
 * 而 `toISOString()` 给出 `2026-11-19T21:23:54Z` → 取 UTC 日期得 11-19。
 * **同一时刻，两种算法必然给出不同日期** —— 这个差异是构造出来的，不依赖跑测试的钟点。
 *
 * ## 它守的边界
 *
 * ✅ 守：`client.js` 里取日期**不许**走 `toISOString`
 * ✅ 守：`localDayStr` 与 `index.js` 的 `localDay()` **同口径**（都只用三个 getter）
 * ❌ 不守：真实浏览器里点按钮的效果（Node 驱动不了 GUI，那要靠人工点一次）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const CLIENT = path.join(REPO, 'dsh-fatfishdream-memory', 'client.js')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory', 'index.js')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}  ← ${detail}`)
  }
}

const SRC = fs.readFileSync(CLIENT, 'utf8')

/**
 * 剥掉行注释与块注释。
 *
 * ⚠️ 2026-11-20 踩过两次：「注释里的代码不算代码」。
 *    这次的修复**故意把旧写法留在注释里作对照**（说明「不要写回它」），
 *    直接对原文做 `includes('toISOString')` 会**假红** ——
 *    而且注释里出现的 `toISOString` 比真代码还多。
 *    所以下面所有「不许出现 X」的断言，一律在剥过注释的文本上跑。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      // 只剥「整行注释」和「行尾 // 注释」；不处理字符串里的 //（本文件用不到那种写法）
      const t = line.trimStart()
      if (t.startsWith('//')) return ''
      const i = line.indexOf('//')
      return i >= 0 ? line.slice(0, i) : line
    })
    .join('\n')
}

const CODE = stripComments(SRC)

// ============================================================
console.log('=== ① 源码事实：取日期不许走 toISOString ===\n')

check('client.js 里已无 `toISOString().slice(0, 10)` 这种取日期写法（注释已剥离）',
  !/toISOString\s*\(\s*\)\s*\.\s*slice\s*\(\s*0\s*,\s*10\s*\)/.test(CODE),
  '这是 UTC 日期，本地 00:00–08:00 会差一整天')

check('client.js 里完全没有 `toISOString` 参与日期筛选',
  !/toISOString/.test(CODE),
  '即使不是 slice(0,10)，toISOString 在日期筛选里一律是 UTC，不该出现')

// 证明上面的断言不是恒真：未经剥注释的原文里**确实**有 toISOString 字样（在注释里）
check('自证：原文（含注释）里仍有 toISOString 字样 —— 证明①真的剥了注释才生效',
  /toISOString/.test(SRC),
  '若原文也没有，说明这条自证失去意义（修复没用注释作对照）')

check('localDayStr 已定义',
  /const localDayStr = \(/.test(CODE),
  '缺它 → 三处调用会 ReferenceError')

// ★ 同口径：与 index.js 的 localDay 用同一组 getter
check('localDayStr 用本地 getter（getFullYear/getMonth/getDate），不用 UTC getter',
  /getFullYear\(\)[\s\S]{0,120}?getMonth\(\)\s*\+\s*1[\s\S]{0,120}?getDate\(\)/.test(
    CODE.slice(CODE.indexOf('const localDayStr ='), CODE.indexOf('const localDayStr =') + 400),
  ),
  '改用 getUTCFullYear 之类会重新引入差一天')

check('localDayStr 不用 toLocaleDateString（会随 locale 输出 2026/11/20，不满足 input[type=date]）',
  !/localDayStr[\s\S]{0,300}?toLocaleDateString/.test(CODE),
  'locale 依赖会让某些环境筛不出数据')

// 三处调用点都必须改掉
const callSites = [...CODE.matchAll(/localDayStr\(/g)].length
check(`localDayStr 至少被调用 3 处（实际 ${callSites} 处：定义 1 + 调用 ≥3）`,
  callSites >= 3,
  `实际 ${callSites} 处 —— 三处筛选按钮（今天 / 近7天 from / 近7天 to）都该走它`)

// ============================================================
console.log('\n=== ② 行为：抽出真实函数体，喂一个「本地与 UTC 不同日」的时刻 ===\n')

/**
 * 从源码抽出 `localDayStr` 的函数体，用 new Function 执行。
 *
 * ⚠️ 不抄一份实现 —— 抄的话源码改坏了这里照样绿。
 */
function extractLocalDayStr() {
  const at = CODE.indexOf('const localDayStr = (')
  if (at < 0) throw new Error('源码里找不到 localDayStr 定义')
  const end = CODE.indexOf('\n    }', at)
  if (end < 0) throw new Error('找不到 localDayStr 的结束位置')
  const body = CODE.slice(at, end + 6)
  // 把 `const localDayStr = (date = new Date()) => { ... }` 变成可调用的函数
  const fnSrc = body.replace(/const localDayStr = \(date = new Date\(\)\) =>/, 'return (date = new Date()) =>')
  // eslint-disable-next-line no-new-func
  return new Function(fnSrc)()
}

const localDayStr = extractLocalDayStr()

// 构造「本地与 UTC 不同日」的时刻：
//   本地 2026-11-20 05:23 → UTC 2026-11-19 21:23
// 前提是运行环境在 UTC+8 左右；不在也没关系 —— 下面会**先断言这个前提成立**，
// 否则整段会自动说明「本段不适用」，而不是给出一个假通过。
const probe = new Date('2026-11-20T05:23:54')
const utcDay = probe.toISOString().slice(0, 10)

console.log(`   构造时刻：本地 ${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, '0')}-${String(probe.getDate()).padStart(2, '0')} ` +
  `${String(probe.getHours()).padStart(2, '0')}:${String(probe.getMinutes()).padStart(2, '0')}` +
  ` ｜ UTC ${probe.toISOString()}（UTC 日期 ${utcDay}）`)

const localDayOfProbe = `${probe.getFullYear()}-${String(probe.getMonth() + 1).padStart(2, '0')}-${String(probe.getDate()).padStart(2, '0')}`
const differ = localDayOfProbe !== utcDay

if (!differ) {
  // 没有断言可写时就不要产生断言（AGENTS.md）。
  // 但这个前提**几乎恒成立**（本机 UTC+8，凌晨跑必分离），所以打清楚原因。
  console.log(`   ⚠️ 本段不适用：当前时区下 ${localDayOfProbe} 与 UTC 日期 ${utcDay} 相同，`)
  console.log(`      构造不出「本地与 UTC 不同日」的时刻 —— 不产生断言，避免假通过。`)
} else {
  check('前提：构造的时刻里，本地日期 ≠ UTC 日期（差异被造出来了）',
    differ, `${localDayOfProbe} vs ${utcDay}`)

  const got = localDayStr(probe)

  // ★ 核心断言
  check(`★ localDayStr 给出本地日期 ${localDayOfProbe}（不是 UTC 的 ${utcDay}）`,
    got === localDayOfProbe,
    `实际 ${got} —— 若等于 ${utcDay}，说明又退回 UTC 了，界面点「今天」会筛出昨天`)

  check('localDayStr 的输出形状是 YYYY-MM-DD（input[type=date] 要求）',
    /^\d{4}-\d{2}-\d{2}$/.test(got), `实际 ${JSON.stringify(got)}`)

  // 边界：本地 00:00 与 23:59 都必须归到本地的同一天
  const midnight = new Date('2026-11-20T00:00:00')
  check('本地 00:00 归到今天（这是最容易错的一天边界）',
    localDayStr(midnight) === '2026-11-20', `实际 ${localDayStr(midnight)}`)

  const lateNight = new Date('2026-11-20T23:59:00')
  check('本地 23:59 仍归今天', localDayStr(lateNight) === '2026-11-20', `实际 ${localDayStr(lateNight)}`)

  // 近 7 天的 from：setDate(-7) 之后必须是本地日期
  const sevenAgo = new Date('2026-11-20T05:23:54')
  sevenAgo.setDate(sevenAgo.getDate() - 7)
  check('「近 7 天」的 from = 本地 7 天前（用本地 getter 算）',
    localDayStr(sevenAgo) === '2026-11-13',
    `实际 ${localDayStr(sevenAgo)} —— 修复前是 2026-11-12（又差一天）`)

  // ---- 自证：把实现换回 toISOString，核心断言必须变红 ----
  const brokenSrc = [
    'return (date = new Date()) => date.toISOString().slice(0, 10)',
  ].join('\n')
  // eslint-disable-next-line no-new-func
  const broken = new Function(brokenSrc)()
  check('自证：换回 toISOString 实现后，同一时刻会给出 UTC 日期（证明核心断言能红）',
    broken(probe) === utcDay,
    `错误实现返回 ${broken(probe)}，期望 ${utcDay}`)
  check('自证：错误实现的结果 ≠ 正确结果（差异真实存在，不是巧合）',
    broken(probe) !== localDayStr(probe),
    `两者都是 ${broken(probe)} —— 那这个时区下测不出 bug`)
}

// ============================================================
console.log('\n=== ③ 与后端同口径（前端不再是孤岛）===\n')

const INDEX_SRC = fs.readFileSync(INDEX, 'utf8')
const localDayAt = INDEX_SRC.indexOf('function localDay(date = new Date())')
check('index.js 的 localDay 仍在（后端口径的锚点）', localDayAt > 0)

if (localDayAt > 0) {
  const backendBody = INDEX_SRC.slice(localDayAt, localDayAt + 260)
  check('后端 localDay 也用 getFullYear/getMonth/getDate（前后端同口径）',
    /getFullYear\(\)/.test(backendBody) && /getMonth\(\)\s*\+\s*1/.test(backendBody) && /getDate\(\)/.test(backendBody),
    backendBody.replace(/\s+/g, ' ').slice(0, 100))

  // ★ 前后端口径必须一致：同一时刻两边算出的日期要相同
  const p2 = (n) => String(n).padStart(2, '0')
  const backendLike = `${probe.getFullYear()}-${p2(probe.getMonth() + 1)}-${p2(probe.getDate())}`
  check('同一时刻，前端 localDayStr 与后端 localDay 口径一致',
    localDayStr(probe) === backendLike,
    `前端 ${localDayStr(probe)} vs 后端 ${backendLike}`)
}

// ============================================================
console.log('\n=== ④ client.js 仍然是合法模块（没被改坏）===\n')

check('仍然只有一个 __ModuleLoader__.load 入口',
  (SRC.match(/__ModuleLoader__\.load\(/g) ?? []).length === 1,
  '数量变了说明文件结构被破坏')
check('factory(require) 仍在', /factory\(require\)/.test(SRC))
check('localDayStr 定义在 factory 内部（不是顶层 —— 文件整体包在 load 里，顶层插不进去）',
  SRC.indexOf('const localDayStr =') > SRC.indexOf('factory(require)'),
  '若跑到 factory 外面会拿不到作用域')

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
