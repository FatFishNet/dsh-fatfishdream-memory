/**
 * C1 探针：确认 `session.append(...)` 在 `session/event` 监听器里能不能调。
 *
 * ## 为什么需要这个探针
 *
 * C1 的方案是：同一个 turn 里出现两条都带收尾语的 assistant 消息时，
 * 用官方的 `surfaceOp: { op:'replace' }` 把前一条里的收尾语去掉。
 *
 * 这条路的**前提**是：插件在 `session/event` 回调里能拿到 `session` 并调它的 `append`。
 * 这个前提我**没有验证过** —— 官方文档只写了 `append` 的签名，
 * 没写「在事件回调里调用它」是否合法、会不会递归触发自己。
 *
 * ## 这个探针**不改任何东西**
 *
 * 它只读：把每次 `session/event` 里能看到的 `session` 对象能力记进日志。
 * 具体记四件事：
 *   1. `typeof session.append` —— 有没有这个方法
 *   2. `session.surface` 的形状 —— 有没有 nodes / replaceGeneration
 *   3. `session.id` —— 确认不是 undefined
 *   4. 当前事件的 `seq` —— 后续 replace 要知道范围
 *
 * **不调用 append**，所以零风险。先知道有没有这个能力，再决定怎么用。
 *
 * ## 怎么用
 *
 * 1. 把本文件的内容作为一段监听器加进 index.js（或用下面的独立脚本模式）
 * 2. 重载插件，随便聊一轮
 * 3. 看日志里的 `[c1-probe]`
 * 4. 按结论决定要不要继续
 */
import fs from 'node:fs'

const SRC = process.argv[2] ?? 'D:\\workspace\\dsh-fatfishdream-memory\\dsh-fatfishdream-memory\\index.js'

// 这个脚本不执行源码，只报告「如果要插探针，应该插在哪、插什么」
const src = fs.readFileSync(SRC, 'utf8').split('\n')

console.log('=== C1 探针：静态核对 ===\n')

// 1) 找到 assistant/message 监听器
const at = src.findIndex((l) => l.includes("safeOn('session/event'"))
console.log(`第一个 session/event 监听器：L${at + 1}`)
console.log(`  签名：${src[at].trim()}`)
console.log('  → 回调参数里有 `session`，是能调用 append 的位置')

// 2) 现在代码用到 session 的哪些成员
const used = new Set()
for (const l of src) {
  for (const m of l.matchAll(/session\.([a-zA-Z_$][\w$]*)/g)) used.add(m[1])
}
console.log(`\n现在代码用到 session 的成员：${[...used].join(', ') || '(无)'}`)
console.log('  → 只有 id，其余能力一次都没试过')

// 3) 关键：确认没有人在事件回调里 append（那会递归）
const appends = src
  .map((l, i) => ({ l, i }))
  .filter(({ l }) => /session\.append\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l))
console.log(`\n代码里现有的 session.append 调用：${appends.length} 处`)
for (const { l, i } of appends) console.log(`  L${i + 1}: ${l.trim()}`)
if (appends.length === 0) {
  console.log('  → 目前 0 处，说明这条路完全没走过；插入时要自己防递归')
}

// 4) 官方契约里 append 的约束
const doc = 'D:\\workspace\\dsh-fatfishdream-memory\\docs-dsh-api\\official-session.md'
if (fs.existsSync(doc)) {
  const d = fs.readFileSync(doc, 'utf8').split('\n')
  console.log('\n=== 官方契约（append 相关）===')
  for (let i = 0; i < d.length; i++) {
    if (/append\(|surfaceOp controls|SurfaceOp|replaceGeneration/.test(d[i])) {
      console.log(`  L${i + 1}: ${d[i].trim().slice(0, 120)}`)
    }
  }
}

console.log('\n=== 结论 ===')
console.log('静态上看得到的三件事：')
console.log('  1. 监听器回调确实带 `session` 对象（签名里就有）')
console.log('  2. 但代码从没调用过它的 append —— 运行时行为未知')
console.log('  3. 官方文档给了 surfaceOp 的完整类型，没给「在事件回调里调」的说明')
console.log('\n所以必须先跑一次实测探针，不能只凭静态就设计。')
