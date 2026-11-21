/**
 * 回归测试：补记链的**隐性缺陷**（2026-11-20 排查出的五处）。
 *
 * 上一对脚本（`selfcheck-backfill-base-url` / `-accounting`）守的是
 * 「根地址怎么拿」与「记账污不污染」。本脚本守的是另外五处 ——
 * 它们共同的特征是：**没有症状**。
 *
 * | # | 缺陷 | 表现 |
 * |---|---|---|
 * | ① | `logRouteHits` 在 `turn-stopping` 里被提前删 → `backfill-check` 恒读 0 | 漏记判据少一半，已写过的轮次会被重复补 |
 * | ② | POST 无超时 → `backfillBusy` 永不释放 | 整个补记永久停摆，后续只有 enqueued 没有 done/failed |
 * | ③ | `backfillDone` 只增不减 + `retryable` 恒 false | 失败一次即永久放弃 |
 * | ④ | `retryable` 写了 5 处、读了 0 处 | 恒假分支（AGENTS.md 明令禁止） |
 * | ⑤ | `task.scope` 算了不用，只传 cwd | cwd 为 null 时静默写进 `desktop` |
 *
 * ## 断言的写法约束
 *
 * 全部是**源码结构断言**（关键顺序 / 关键字段是否被读），
 * 但每一条都配了「改坏了会红」的证明（第 ⑥ 段故障注入在外部跑，
 * 这里第 ⑦ 段放可自证的结构断言）。
 *
 * ⚠️ 一律 `stripComments()` 之后再断言 —— 本文件里大量注释引用了
 *    `logRouteHits.delete(sessionKey)` 这类**已经删掉的旧写法**做说明，
 *    不剥注释就会命中自己的说明（2026-11-20 在这个坑里栽过三次）。
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

/** 剥掉块注释与行注释，只留代码。 */
function stripComments(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//')
      return i >= 0 ? l.slice(0, i) : l
    })
    .join('\n')
}

const CODE = stripComments(SRC)

/** 取某个 diag/函数调用点所在的「区段」，用于判断先后顺序。 */
function indexOfCode(needle) {
  return CODE.indexOf(needle)
}

// ============================================================
console.log('=== ① logRouteHits 的清理必须在 turn/end，不能在 turn-stopping ===\n')

{
  // 关键：两个 `session/event` 回调里，哪个包含 delete
  const turnStoppingAt = indexOfCode("safeOn('agent/turn-stopping'")
  // ⚠️ 锚点必须用**代码**，不能用 `// ---- 接线：turn/end 触发 ----` 那行注释 ——
  //    剥注释后它是 -1（这条自己就踩了一次：第一版取到 -1，
  //    导致「turn/end 段」实际是空串，断言假红）。
  const backfillAt = indexOfCode('const routeHits = logRouteHits.get(sid)')

  check('能找到 turn-stopping 监听器', turnStoppingAt > 0, String(turnStoppingAt))
  check('能找到 turn/end 补记段（锚点是代码不是注释）', backfillAt > 0, String(backfillAt))

  if (turnStoppingAt > 0 && backfillAt > 0) {
    const stoppingSeg = CODE.slice(turnStoppingAt, backfillAt)
    const backfillSeg = CODE.slice(backfillAt)

    // ★ 核心断言：turn-stopping 段里**不许**有 logRouteHits.delete
    check('turn-stopping 段里没有 logRouteHits.delete（否则 turn/end 恒读 0）',
      !stoppingSeg.includes('logRouteHits.delete'),
      '有它 = ① 回归到修复前，实测 17/17 次 routeHits 恒为 0')

    // ★ 核心断言：turn/end 段里**必须**有它
    check('turn/end 段里有 logRouteHits.delete（清理不能丢，否则计数长住）',
      backfillSeg.includes('logRouteHits.delete'),
      '缺它 = Map 无限增长且下一轮读到上一轮计数')

    // ★ 顺序断言：delete 必须在「读 routeHits」之后
    const readAt = backfillSeg.indexOf('const routeHits = logRouteHits.get(sid)')
    const delAt = backfillSeg.indexOf('logRouteHits.delete(sid)')
    check('turn/end 里能读到 routeHits 取值', readAt >= 0, String(readAt))
    check('turn/end 里能读到 logRouteHits.delete', delAt >= 0, String(delAt))
    if (readAt >= 0 && delAt >= 0) {
      check('先读后清（read 在 delete 之前）', readAt < delAt,
        `read=${readAt} delete=${delAt}`)

      // ★ 清理必须在所有 return 之前 —— 也就是在第一个 `if (wroteCount` 之前
      const firstReturnAt = backfillSeg.indexOf('if (wroteCount > 0 || routeHits > 0)')
      check('清理早于「本轮写了」那个 return', delAt < firstReturnAt,
        `delete=${delAt} return=${firstReturnAt}（晚于它 → 写过的那轮把计数留给下一轮）`)
    }
  }
}

// ============================================================
console.log('\n=== ② POST 必须有超时，且 busy 必须无条件放开 ===\n')

{
  // ★ 核心断言：fetch 必须带 signal
  const fetchAt = indexOfCode('await fetch(`${base}/api/dsh-memory/log`')
  check('能找到 POST 的 fetch 调用', fetchAt > 0, String(fetchAt))
  if (fetchAt > 0) {
    const seg = CODE.slice(fetchAt, fetchAt + 500)
    check('POST fetch 带 signal（AbortSignal.timeout）',
      /signal:\s*AbortSignal\.timeout\(/.test(seg),
      '没有它 → fetch 可能永不返回，backfillBusy 永久卡死（已复现：queue=24 全卡）')
  }

  // 超时常量必须存在且是有限数
  const m = CODE.match(/const BACKFILL_POST_TIMEOUT_MS = (\d+)/)
  check('存在 BACKFILL_POST_TIMEOUT_MS 常量', m !== null)
  if (m) {
    const ms = Number(m[1])
    check('POST 超时是合理正整数（1s ~ 60s）', ms >= 1000 && ms <= 60000, `${ms}ms`)
  }

  // ★ 核心断言：pump 的 finally 里必须放开 busy
  const pumpAt = indexOfCode('const pumpBackfill = async () =>')
  check('能找到 pumpBackfill', pumpAt > 0, String(pumpAt))
  if (pumpAt > 0) {
    const seg = CODE.slice(pumpAt, pumpAt + 2600)
    check('pumpBackfill 的 finally 里放开了 backfillBusy',
      /finally\s*\{[\s\S]{0,300}?backfillBusy = false/.test(seg),
      '缺它 = 一次挂住就永久停摆')
  }
}

// ============================================================
console.log('\n=== ③ 失败必须可重试，且 backfillDone 有边界 ===\n')

{
  // ★ backfillDone 必须能 delete
  check('存在 releaseBackfillKey（把 key 放出来重试）',
    CODE.includes('const releaseBackfillKey ='), '缺它 = 失败一次永久放弃')

  // 它必须真的调用了 backfillDone.delete
  const relAt = indexOfCode('const releaseBackfillKey = ')
  if (relAt > 0) {
    const seg = CODE.slice(relAt, relAt + 300)
    check('releaseBackfillKey 真的 delete', /backfillDone\.delete\(/.test(seg), seg.slice(0, 120))
  }

  // pump 的失败分支必须调用它
  const pumpAt = indexOfCode('const pumpBackfill = async () =>')
  const pumpBoundary = indexOfCode('const enqueueBackfill =')
  if (pumpAt > 0) {
    // ⚠️ 窗口必须收敛到**函数体**（到下一个顶层函数为止），不能用固定的 2600。
    //    实测 `pumpBackfill` 段只有 964 字符，2600 会把 `enqueueBackfill` 里
    //    那处 `releaseBackfillKey(dropped.key)` 也算进来 → 计数变 3 处、基线假红。
    const pumpEnd = pumpBoundary > pumpAt ? pumpBoundary : pumpAt + 1200
    const seg = CODE.slice(pumpAt, pumpEnd)
    // ⚠️ 这里曾经写成「段里出现 releaseBackfillKey( 就算过」，结果是**弱断言**：
    //    `releaseBackfillKey` 在 catch 分支里还有一处，删掉「失败分支」那处后
    //    断言仍然绿（2026-11-20 故障注入实测：注入 ③ 仍绿）。
    //    现在必须**指名**那处：`if (!outcome.ok && outcome.retryable === true)` 之后
    //    紧跟一次调用 —— 少一处都红。
    check('pumpBackfill 在「可重试失败」时释放 key',
      /if \(!outcome\.ok && outcome\.retryable === true\) \{\s*\n\s*releaseBackfillKey\(/.test(seg),
      '缺它 = 可重试的失败仍然永久放弃（③ 未修）')
    check('pumpBackfill 在异常路径也释放 key',
      /catch[\s\S]{0,400}?releaseBackfillKey\(/.test(seg),
      '缺它 = 抛出来的错误永久放弃')
    // 两处必须都在（只留一处是弱修复）
    const calls = (seg.match(/releaseBackfillKey\(/g) ?? []).length
    check('pumpBackfill 里释放调用有 2 处（失败分支 + 异常分支）',
      calls === 2, `实际 ${calls} 处`)
  }

  // ★ 容量上限
  const lm = CODE.match(/const BACKFILL_DONE_LIMIT = (\d+)/)
  check('存在 BACKFILL_DONE_LIMIT', lm !== null, '缺它 = Set 只增不减')
  if (lm) {
    const n = Number(lm[1])
    check('BACKFILL_DONE_LIMIT 是合理正整数', n >= 10 && n <= 100000, String(n))
  }
  check('enqueueBackfill 里有修剪调用', CODE.includes('trimBackfillDone()'), '')

  // 被队列挤掉的也必须释放（否则队列一满最旧那条永久放弃）
  const enqAt = indexOfCode('const enqueueBackfill =')
  if (enqAt > 0) {
    const seg = CODE.slice(enqAt, enqAt + 1200)
    check('队列溢出时释放被挤掉的 key',
      /releaseBackfillKey\(dropped\.key\)/.test(seg),
      '缺它 = 队列一满，最旧那条永久放弃')
  }
}

// ============================================================
console.log('\n=== ④ retryable 必须真的被读（不许是恒假字段）===\n')

{
  const written = (CODE.match(/retryable:\s*(true|false|transient)/g) ?? []).length
  const read = (CODE.match(/\.retryable\b/g) ?? []).length
  // 注意：`read` 会统计到 `outcome.retryable` 这类读取
  const compare = (CODE.match(/outcome\.retryable\s*===\s*true/g) ?? []).length

  check('retryable 有写入', written > 0, `写入 ${written} 处`)
  check('retryable 真的被读取（不再是恒假字段）',
    read > 0, `读取 ${read} 处 —— 为 0 说明写死的字段没人用`)
  check('pump 用严格 === true 判定（不是真值判断）',
    compare > 0,
    '写成 `if (outcome.retryable)` 会让字符串 "false" 也通过')

  // ★ 5xx / 429 必须可重试，4xx 必须不可重试
  check('5xx 与 429 被判为可重试',
    /res\.status\s*>=\s*500\s*\|\|\s*res\.status\s*===\s*429/.test(CODE),
    '缺它 = 服务端短暂故障被当成永久失败')
  check('异常路径 retryable 为 true',
    /catch[\s\S]{0,400}?retryable:\s*true/.test(CODE.slice(indexOfCode('const runBackfillTask ='))),
    '缺它 = 网络抖一下升级成永久丢')
}

// ============================================================
console.log('\n=== ⑤ POST 必须显式传 scope，不依赖 cwd 反推 ===\n')

{
  const fetchAt = indexOfCode('await fetch(`${base}/api/dsh-memory/log`')
  if (fetchAt > 0) {
    const seg = CODE.slice(fetchAt, fetchAt + 1400)
    // ★ 核心断言：body 里必须有 scope 字段
    check('POST body 里显式传了 scope',
      /scope:\s*typeof task\.scope/.test(seg),
      '缺它 = cwd 为 null 时 /log 回落到 process.cwd()，静默写进 desktop（已实测）')

    // 并且仍然保留 cwd（作为兜底，不能只传 scope 把 cwd 丢了）
    check('POST body 里仍然带 cwd（兜底不改）', /cwd:\s*task\.cwd/.test(seg), '')
  }

  // 反向：/log 侧必须「有 scope 就优先用它」
  const scopeAt = indexOfCode("let scope = typeof body.scope === 'string'")
  check('/log 支持显式 scope', scopeAt > 0, '缺它 = 传了也没用')
  if (scopeAt > 0) {
    const seg = CODE.slice(scopeAt, scopeAt + 600)
    check('/log 在有 scope 时跳过 cwd 分支',
      /if \(scope === ''\)/.test(seg),
      '缺它 = 即使传了 scope 仍会被 cwd 覆盖')
  }
}

// ============================================================
console.log('\n=== ⑥ 自证：剥注释函数本身必须可靠 ===\n')

{
  // 本文件所有断言都建立在 stripComments 之上。它坏了，
  // 上面的断言会**一起**给出错误结论 —— 所以必须自证。
  const sample = [
    '/**',
    ' * 旧写法 logRouteHits.delete(sessionKey)',
    ' */',
    'const a = 1 // 注释里的 logRouteHits.delete',
    'const b = 2',
  ].join('\n')
  const out = stripComments(sample)
  check('自证：块注释被剥掉', !out.includes('旧写法'), out.replace(/\s+/g, ' ').slice(0, 60))
  check('自证：行注释被剥掉', !out.includes('注释里的'), out.replace(/\s+/g, ' ').slice(0, 60))
  check('自证：真实代码保留', out.includes('const a = 1') && out.includes('const b = 2'), '')
  check('自证：剥完后不含任何 logRouteHits.delete',
    !out.includes('logRouteHits.delete'), out)

  // ★ 关键自证：本文件的 ① 段断言「turn-stopping 段里没有 logRouteHits.delete」，
  //   而源码注释里**确实**有这句话（用来解释为什么挪走）。
  //   若不剥注释，那条断言会假红 —— 下面这条证明剥注释**确实起作用了**：
  check('自证：原文（不剥）含 logRouteHits.delete 的说明性引用',
    SRC.includes('logRouteHits.delete'), '源码注释里应有对旧写法的说明')
  const strippedCount = (CODE.match(/logRouteHits\.delete/g) ?? []).length
  const rawCount = (SRC.match(/logRouteHits\.delete/g) ?? []).length
  check('自证：剥注释后引用数严格少于原文（证明剥离有效）',
    strippedCount < rawCount,
    `剥后 ${strippedCount} 处 < 原文 ${rawCount} 处`)
  // 剥完后应当只剩 1 处真实调用
  check('剥注释后 logRouteHits.delete 只剩 1 处真实调用',
    strippedCount === 1, `实际 ${strippedCount} 处`)
}

// ============================================================
console.log('\n=== ⑦ 反向守卫：旧行为不许被「修过头」 ===\n')

{
  // 修 ① 时最容易修过头：把「本轮写了」那条分支整个删掉。
  check('「本轮写了就跳过」这个判断还在',
    CODE.includes('if (wroteCount > 0 || routeHits > 0)'),
    '缺它 = 每轮都会补记，包括已经写过的')

  // 修 ② 时最容易修过头：把 busy 判断删掉 → 并发跑多条抢配额。
  const pumpAt = indexOfCode('const pumpBackfill = async () =>')
  if (pumpAt > 0) {
    const seg = CODE.slice(pumpAt, pumpAt + 300)
    check('并发上限 1 的守卫还在（if (backfillBusy) return）',
      /if \(backfillBusy\) return/.test(seg),
      '缺它 = 补记与用户对话抢模型配额')
  }

  // 修 ③ 时最容易修过头：成功之后也释放 key → 同一轮会被重复补。
  const pumpSeg = pumpAt > 0 ? CODE.slice(pumpAt, pumpAt + 2600) : ''
  if (pumpSeg !== '') {
    // 释放必须挂在「失败」条件下，不能无条件调用
    check('成功路径不释放 key（否则同轮会被重复补）',
      /if \(!outcome\.ok && outcome\.retryable === true\)/.test(pumpSeg),
      '无条件释放 = 同一轮反复补，直到队列被自己挤爆')
  }

  // 修 ⑤ 时最容易修过头：只传 scope，把 cwd 丢了。
  check('cwd 仍在 body 里（兜底不能丢）',
    /cwd:\s*task\.cwd/.test(CODE), '')
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
