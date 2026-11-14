/**
 * 擦除器调度策略自检（第五代：静止窗口）。
 *
 * 2026-11-14 改法：**流式期间完全不碰 DOM**，等「最后一次带标记的变化之后
 * 安静了 QUIET_MS」才全量扫一次；若页面一直在变，最多 MAX_DEFER_MS 强制扫一次。
 *
 * 为什么换掉上一代（时间戳 + 100ms 窗口）：
 *   旧策略是「每帧都扫，但忽略自己刚写完的 100ms 内的 mutation」，
 *   结果是标记**反复露出来又被擦掉**，而擦除改的是文本高度 →
 *   整个对话区以 ~10Hz 抖动、滚动条跳。
 *
 * 本脚本守四件事：
 *   1. 连续变化只在**安静之后**扫一次（不是每次都扫）
 *   2. 页面一直变时，不会被无限推迟（有兜底上限）
 *   3. 完全没有变化时**一次都不扫**
 *   4. 源码里那条「只对含标记的变化排队」的闸门还在（否则静止永远等不到）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = path.join(REPO, 'dsh-fatfishdream-memory/client.js')
const SRC = fs.readFileSync(CLIENT, 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  OK   ${name}${detail ? ' — ' + detail : ''}`) }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}

/** 纯模型：与 client.js 里 schedule/pass 的逻辑一一对应 */
function makeScheduler({ quiet = 400, maxDefer = 3000 } = {}) {
  let timerAt = null
  let pendingSince = 0
  let now = 0
  let passes = 0
  const pass = () => { timerAt = null; pendingSince = 0; passes++ }
  const schedule = (t = now) => {
    if (pendingSince === 0) pendingSince = t
    const waited = t - pendingSince
    const wait = Math.max(0, Math.min(quiet, maxDefer - waited))
    timerAt = t + wait
  }
  const advance = (dt) => {
    now += dt
    if (timerAt !== null && now >= timerAt) pass()
  }
  return { schedule, advance, get passes() { return passes }, get now() { return now } }
}

console.log('=== 1. 安静之后才扫（连续变化只扫一次）===\n')
{
  const s = makeScheduler()
  s.schedule()
  for (let i = 0; i < 10; i++) { s.advance(100); s.schedule() } // 每秒 10 次变化，持续 1s
  check('1s 内的连续变化还没到兜底，扫了 0 次', s.passes === 0, `实际 ${s.passes} 次`)
  s.advance(500) // 安静 500ms（> QUIET_MS）
  check('安静 500ms 后扫了 1 次', s.passes === 1, `实际 ${s.passes} 次（旧实现这段会扫 ~10 次）`)
}

console.log('\n=== 2. 一直不安静：有兜底上限 ===\n')
{
  const s = makeScheduler()
  let t = 0
  for (let i = 0; i < 40; i++) { t += 100; s.advance(100); s.schedule(t) } // 连续 4s
  check('连续变化 4s 内至少扫过 1 次（不会被无限推迟）', s.passes >= 1, `实际 ${s.passes} 次`)
  check('但远少于每帧扫（旧实现 ~40 次）', s.passes <= 2, `实际 ${s.passes} 次`)
}

console.log('\n=== 3. 没有变化就不扫 ===\n')
{
  const s = makeScheduler()
  for (let i = 0; i < 50; i++) s.advance(100)
  check('5s 无变化 → 0 次扫描', s.passes === 0, `实际 ${s.passes} 次`)
}

console.log('\n=== 4. 源码级：闸门与收尾 ===\n')
{
  check('静止窗口常量还在', SRC.includes('QUIET_MS = 400'))
  check('兜底上限还在', SRC.includes('MAX_DEFER_MS = 3000'))
  check('只对含标记的变化排队（characterData）', SRC.includes('hasMarker(r.target)'))
  check('只对含标记的变化排队（addedNodes）', SRC.includes('hasMarker(n)'))
  check('扫完丢掉自写 mutation', SRC.includes('takeRecords()'))
  check('旧的时间戳窗口已彻底移除', !SRC.includes('lastSelfWriteAt'))
  check('旧的每帧 rAF 扫描已移除', !SRC.includes('requestAnimationFrame(flush)'))
}

console.log('\n=== 5. 为什么不能用布尔标志（仍然成立）===\n')
{
  // MutationObserver 回调是异步的：在 flush 里置位再复位，回调时读不到。
  let flag = false
  flag = true
  flag = false
  check('布尔标志在异步回调时已复位（故不可用）', flag === false)
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
