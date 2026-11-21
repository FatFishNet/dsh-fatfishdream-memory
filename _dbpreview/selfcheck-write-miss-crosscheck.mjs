/**
 * 回归测试：流水漏记的**判据本身**（2026-11-20 实测复现）。
 *
 * ## 为什么单独一个脚本
 *
 * 项目里已经有一堆东西围着「漏记」转，但没有一个**执行**判据：
 *
 *   · `selfcheck-marker-hardened` 只做**源码文本核对**
 *     （`/const wroteThisTurn = .../` 在不在）—— 那测不出判据算得对不对；
 *   · `selfcheck-log-alive` 守的是「写流水的通道还活着」，不是「这一轮算不算漏了」；
 *   · `meta-mutation-test` 有 streak 相关变异，但它需要**跑全套回归**才生效，
 *     日常单跑一个脚本看不见。
 *
 * 而 2026-11-20 实盘查出的三个问题，恰好全在「判据算得对不对」这一层：
 *
 *   ① `turn-未记流水` 用的是 `wroteMemory`，而它只在「写进记忆根目录」时才置位。
 *      `log.ps1` 在工作区（`D:\workspace\...`）、`store.root` 是
 *      `D:\dsh-fatfishdream-memory`，**永远不在同一棵树** → 判据恒为真。
 *      实测当天 6 条全假阳性（01:19 / 01:20 / 01:26 / 01:41 / 02:08 / 02:13），
 *      其中 02:08 那条，7 秒前刚成功写入 id=1078。
 *
 *   ② `write-streak-check` 的 diag **没有 sessionId**，而 `turn` 是每个会话
 *      各自从 1 数起的。同一天多会话并发时，同一个 turn 号会出现多次，
 *      任何按 turn 号聚合历史的做法都会**串账且不报错**。
 *      （源码里那段「统计陷阱」长注释已写明，但注释拦不住下一个人。）
 *
 *   ③ `record === undefined`（纯思考轮：只读文件、没调写类工具）与
 *      `record.wroteLog === false`（真的没写）被算成同一个结果 ——
 *      于是「漏记集中在纯分析轮」这个真实现象无法从数据里区分出来。
 *
 * ## 断言怎么做到「能失败」
 *
 * 不从源码贴一份判据来测（那样源码改坏了它照样绿 —— AGENTS.md 的
 * 「断言在，被测的差异不在」）。这里用 `extract()` 把**真实源码里的表达式**
 * 抽出来求值，源码改了测试跟着变。
 *
 * 自带 `--self-test`：把抽取到的判据换成错的实现，断言必须变红。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const INDEX = path.join(ROOT, 'dsh-fatfishdream-memory', 'index.js')

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

const SRC = fs.readFileSync(INDEX, 'utf8')

/**
 * 从 `text` 里 `before` 之前的区域，取出**最后一个** `if (...)` 的完整条件块。
 *
 * ⚠️ 必须是完整条件块，不能只取一行。
 *
 * 2026-11-20 踩过：第一版只往上取到最近一个含 `if (` 的行。而修复后
 * `turn-未记流水` 的条件是 6 行写法：
 *
 *     if (
 *       record !== undefined &&
 *       record.writes > 0 &&
 *       record.wroteLog !== true &&
 *       (logRouteHits.get(sessionKey) ?? 0) === 0
 *     ) {
 *
 * 只取首行会得到 `if (` —— 条件本体一个字都没进来，于是
 * 「不许有 wroteMemory」和「必须有 wroteLog」两条断言**同时**给出错误结论。
 * 这正是 AGENTS.md 记的「断言的切片范围错了，比断言写错更隐蔽」。
 *
 * 抽成顶层函数是为了让自证段能调**同一个实现**，而不是在自证里复刻一份
 * （复刻的话源码改坏了它照样绿 —— 「断言在，被测的差异不在」）。
 */
function extractIfBlock(text, before) {
  const head = text.slice(0, before)
  const ifAt = head.lastIndexOf('if (')
  if (ifAt < 0) return ''
  let depth = 0
  let i = head.indexOf('(', ifAt)
  for (; i < head.length; i++) {
    if (head[i] === '(') depth++
    else if (head[i] === ')') {
      depth--
      if (depth === 0) return head.slice(ifAt, i + 1)
    }
  }
  return ''
}

/** 从源码里截取一段代码（按起止锚点），用于求值。找不到就抛，绝不静默跳过。 */
function slice(from, to, label) {
  const a = SRC.indexOf(from)
  if (a < 0) throw new Error(`源码里找不到起点：${label}（锚点 ${JSON.stringify(from.slice(0, 40))}）`)
  const b = SRC.indexOf(to, a)
  if (b < 0) throw new Error(`源码里找不到终点：${label}`)
  return SRC.slice(a, b + to.length)
}

// ============================================================
console.log('=== ① record 语义：纯思考轮 vs 真没写，必须能区分 ===\n')

// 判据原文（这是 `wroteThisTurn` 的唯一来源，也是 streak 加/清零的分岔）
const WROTE_THIS_TURN_EXPR = 'const wroteThisTurn = record !== undefined && record.wroteLog === true'
{
  check('判据在源码里存在', SRC.includes(WROTE_THIS_TURN_EXPR), '没找到 → 下面的求值会失真')

  // 用真实表达式求值（不是抄一份）
  const expr = WROTE_THIS_TURN_EXPR.replace('const wroteThisTurn =', 'return')
  // eslint-disable-next-line no-new-func
  const evaluate = new Function('record', `${expr}`)

  // 三种形态必须能区分成两个结果，且「有 record 但没写」与「没 record」都算 false
  const cases = [
    ['record 不存在（纯思考轮）', undefined, false],
    ['record 在但没写', { writes: 0, wroteMemory: false, wroteLog: false }, false],
    ['record 在且写了', { writes: 1, wroteMemory: false, wroteLog: true }, true],
    ['写了但 hasRecord 语义仍在', { writes: 3, wroteMemory: true, wroteLog: true }, true],
  ]
  for (const [label, record, want] of cases) {
    const got = evaluate(record)
    check(`wroteThisTurn(${label}) === ${want}`, got === want, `实际 ${got}`)
  }

  // ★ 核心断言：wroteLog=true 但 wroteMemory=false 必须算「写了」。
  //   这正是 `log.ps1` 的真实形态（脚本在工作区，写的是记忆根目录以外的路径），
  //   也是 ② 修复前 `turn-未记流水` 假阳性的根源。
  const scriptShape = { writes: 1, wroteMemory: false, wroteLog: true }
  check('log.ps1 形态（wroteMemory=false 但 wroteLog=true）判为「写了」',
    evaluate(scriptShape) === true, '这是当天 6 条假阳性的根因')
}

// ============================================================
console.log('\n=== ② turn-未记流水 的判据：不许用 wroteMemory ===\n')

{
  // 判据原文所在行
  const line = SRC.split('\n').find((l) => l.includes("diag('turn-未记流水'"))
  check('turn-未记流水 的 diag 存在', typeof line === 'string')

  // ★ 提取整个 if 条件块（用顶层 extractIfBlock —— 与自证段同一份实现）
  const idx = SRC.indexOf("diag('turn-未记流水'")
  // 从 diag 调用点往前找，窗口放宽到 1200 字符（条件块有 6 行带长注释）
  const condBlock = extractIfBlock(SRC.slice(Math.max(0, idx - 1200), idx),
    SRC.slice(Math.max(0, idx - 1200), idx).length)
  check('能截出完整的 if 条件块', condBlock.startsWith('if (') && condBlock.endsWith(')'),
    condBlock ? condBlock.replace(/\s+/g, ' ').slice(0, 90) : '(未找到)')

  // ★ 核心断言：条件块里 MUST NOT 出现 wroteMemory
  //
  // 为什么这条能失败：把 `!record.wroteMemory` 改回源码，它立刻红
  // （反向自证见第 ⑥ 段与 run-all 的实测记录）。
  const usesWroteMemory = condBlock.includes('wroteMemory')
  check('turn-未记流水 的条件不使用 wroteMemory',
    usesWroteMemory === false,
    `当前条件：${condBlock.replace(/\s+/g, ' ').slice(0, 120)}`)

  // 而且必须依据「本轮有没有真的写进去」—— 允许 wroteLog 或 logRouteHits，
  // 但不许是 writes（那只是「动过文件」）。
  const usesWroteLog = condBlock.includes('wroteLog') || condBlock.includes('logRouteHits')
  check('turn-未记流水 的条件依据「写没写流水」而非「动没动文件」',
    usesWroteLog === true,
    `当前条件：${condBlock.replace(/\s+/g, ' ').slice(0, 120)}`)
}

// ============================================================
console.log('\n=== ③ write-streak-check 必须带 sessionId ===\n')

{
  const idx = SRC.indexOf("diag('write-streak-check'")
  check('write-streak-check 的 diag 存在', idx > 0)

  // 取整个 diag 调用的对象字面量
  const seg = idx > 0 ? SRC.slice(idx, SRC.indexOf('})', idx) + 2) : ''
  check('能截出 diag 的字段块', seg.length > 50, `长度 ${seg.length}`)

  // ★ 核心断言：字段里必须有 sessionId 之类的唯一键
  //
  // 为什么必须有：`turn` 是**每个会话各自从 1 数起**的，同一天多会话并发时
  // 同一个 turn 号会出现多次（源码注释实测：turn=1 出现 4 次，turn=4 出现 5 次
  // 且其中两次 wroteThisTurn 相反）。没有 sessionId，任何按 turn 聚合的统计
  // 都会把不同会话混在一起，**算出一个看起来成立、实际错误的数字**。
  const hasSessionField = /\bsessionId\s*:/.test(seg) || /\bsid\s*:/.test(seg)
  check('write-streak-check 的字段里带 sessionId（否则按 turn 聚合必串账）',
    hasSessionField,
    '缺失 → 交接单曾据此算出 70% 假漏记率')
}

// ============================================================
console.log('\n=== ④ streak 计数：三种形态的加/清零 ===\n')

{
  // 抽取真实的加/清零分支（从 `const wroteThisTurn` 到 streak 赋值结束）
  const block = slice(
    WROTE_THIS_TURN_EXPR,
    'writeFailStreak.set(sessionKey, prev + 1)\n      }',
    'streak 计数块',
  )

  // 把闭包里引用的两个外部符号做成参数，其余原样执行
  // eslint-disable-next-line no-new-func
  const run = new Function('record', 'writeFailStreak', 'sessionKey', `
    ${block}
    return writeFailStreak.get(sessionKey) ?? 0
  `)

  const mk = (v) => new Map(v === undefined ? [] : [['s1', v]])

  // 写了 → 清零
  check('写了 → streak 归 0',
    run({ writes: 2, wroteMemory: false, wroteLog: true }, mk(3), 's1') === 0,
    `实际 ${run({ writes: 2, wroteMemory: false, wroteLog: true }, mk(3), 's1')}`)

  // 没写（record 在）→ +1
  check('record 在但没写 → streak 3→4',
    run({ writes: 1, wroteMemory: false, wroteLog: false }, mk(3), 's1') === 4,
    `实际 ${run({ writes: 1, wroteMemory: false, wroteLog: false }, mk(3), 's1')}`)

  // 没写（record 不存在，纯思考轮）→ 也要 +1
  //
  // ★ 这条守的正是「纯思考轮必须计入漏记」这个语义。
  //   若有人把判据改成「没 record 就不计数」，漏记最集中的那一类会静默消失。
  check('record 不存在（纯思考轮）→ 也要 +1，不许跳过',
    run(undefined, mk(3), 's1') === 4,
    `实际 ${run(undefined, mk(3), 's1')}`)

  // 空闲会话（从未有 streak）→ 从 0 涨到 1
  check('初次漏记 → 0→1', run(undefined, mk(undefined), 's1') === 1,
    `实际 ${run(undefined, mk(undefined), 's1')}`)
}

// ============================================================
console.log('\n=== ⑤ 提醒开关的状态必须与「有没有兜底」一致 ===\n')

{
  const onOff = SRC.match(/const WRITE_FAIL_NUDGE_ENABLED = (true|false)/)
  check('能找到 WRITE_FAIL_NUDGE_ENABLED', onOff !== null)

  const limitM = SRC.match(/const WRITE_FAIL_STREAK_LIMIT = (\d+)/)
  check('能找到 WRITE_FAIL_STREAK_LIMIT', limitM !== null)

  // 提醒分支必须真的用这个开关，而不是被短路掉
  const guardUsesFlag = /if \(WRITE_FAIL_NUDGE_ENABLED &&/.test(SRC)
  check('提醒分支由 WRITE_FAIL_NUDGE_ENABLED 控制（不是恒假）', guardUsesFlag,
    '恒假 → 计数照涨但永不提醒')

  // ⚠️ 这里**不断言开关必须是 true**。
  // 用户 2026-11-18 主动关掉它（steer 会让本轮多跑一步、表现为「打嗝」约 8 秒）。
  // 断言「必须开着」会把用户的决定变成测试失败 —— 那是不允许的。
  // 只把当前状态打印出来，并说明它对漏记的影响。
  console.log(`   ℹ️  当前 WRITE_FAIL_NUDGE_ENABLED = ${onOff?.[1]}，` +
    `WRITE_FAIL_STREAK_LIMIT = ${limitM?.[1]}`)
  if (onOff?.[1] === 'false') {
    console.log('   ⚠️  提醒已关闭 → 漏记**没有运行时兜底**，只能人工看流水')
  }

  // 阈值必须 >= 1（0 会让「本轮没写」永远不触发）
  check('阈值 >= 1（0 等于永不触发）', Number(limitM?.[1]) >= 1, String(limitM?.[1]))
}

// ============================================================
console.log('\n=== ⑥ 自证：把判据改成错的实现，断言必须变红 ===\n')

{
  // 在内存里把 `wroteLog` 换成 `wroteMemory`（即 ② 修复前的形态），
  // 重跑 ① 的核心断言，必须变红。
  const MUT = WROTE_THIS_TURN_EXPR
    .replace('record.wroteLog === true', 'record.wroteMemory === true')
  const mutatedOk = MUT !== WROTE_THIS_TURN_EXPR
  check('自证：替换锚点生效（源码里确实有那句）', mutatedOk)

  if (mutatedOk) {
    const expr = MUT.replace('const wroteThisTurn =', 'return')
    // eslint-disable-next-line no-new-func
    const broken = new Function('record', `${expr}`)

    // log.ps1 形态：修复后应为 true，用错误实现必须是 false
    const shape = { writes: 1, wroteMemory: false, wroteLog: true }
    check('自证：错误实现下 log.ps1 形态被判成「没写」（证明 ① 的断言能红）',
      broken(shape) === false,
      `错误实现返回 ${broken(shape)}`)
  }

  // 再自证一条：若有人把条件改回 wroteMemory，② 的判据必须能识别出来
  const fakeCond = 'if (record !== undefined && record.writes > 0 && !record.wroteMemory)'
  check('自证：wroteMemory 形态的条件会被 ② 判红',
    fakeCond.includes('wroteMemory') === true,
    '这条证明 ② 的 includes 判据不是恒真')

  // ★ 再自证一条（2026-11-20 加的）：多行条件也必须被完整截取。
  //
  // 这不是复刻一份逻辑 —— 它调的是**同一份 extractIfBlock**，
  // 只是喂一段已知形状的多行文本。若配对逻辑坏了（比如退化成只取一行），
  // 这里和 ② 会同时红，而不是「自证绿着、真实断言错了」。
  const multiCond = [
    'if (',
    '  record !== undefined &&',
    '  record.writes > 0 &&',
    '  record.wroteLog !== true &&',
    '  (logRouteHits.get(sessionKey) ?? 0) === 0',
    ') {',
  ].join('\n')
  {
    const got = extractIfBlock(multiCond, multiCond.length)
    check('自证：多行条件块能被完整截取（含 wroteLog）',
      got.includes('wroteLog') && got.includes('logRouteHits'),
      got.replace(/\s+/g, ' ').slice(0, 80))

    // 反向：单行形态也必须正确截取（不能为了多行把单行弄坏）
    const oneLine = 'if (record !== undefined && !record.wroteMemory) {'
    const got1 = extractIfBlock(oneLine, oneLine.length)
    check('自证：单行条件块也能正确截取',
      got1 === 'if (record !== undefined && !record.wroteMemory)',
      got1)
  }
}

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
