import { readFileSync, readdirSync } from 'node:fs'

const dir = 'D:/dsh-fatfishdream-memory/logs'
const files = readdirSync(dir).filter(f => f.endsWith('.log')).sort()

// 收集每条 assistant 消息：时间戳、turn、step、heartbeat、bytes
const msgs = []
for (const f of files) {
  const lines = readFileSync(`${dir}/${f}`, 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^(\S+) \[archive-assistant\] (.*)$/)
    if (!m) continue
    const [, iso, body] = m
    const turn = body.match(/"turn":(\d+)/)
    const step = body.match(/"step":(\d+)/)
    const hb = body.match(/"heartbeat":(\d+)/)
    const bytes = body.match(/"bytes":(\d+)/)
    if (!turn || !step || !hb) continue
    msgs.push({
      file: f,
      t: new Date(iso).getTime(),
      turn: Number(turn[1]),
      step: Number(step[1]),
      hb: Number(hb[1]),
      bytes: bytes ? Number(bytes[1]) : 0,
    })
  }
}

// 按 file+turn 分组，按 step 排序
const turns = new Map()
for (const m of msgs) {
  const key = `${m.file}:${m.turn}`
  if (!turns.has(key)) turns.set(key, [])
  turns.get(key).push(m)
}

// 关键指标：带收尾语的消息 -> 下一条消息 的间隔
// 这是「说完收尾语之后，又跑了一步」的直接代价
const afterHb = []   // 收尾语消息之后还有下一条
const afterNon = []  // 非收尾语消息之后还有下一条
const hbLast = []    // 收尾语是最后一条（正常结束）

for (const [, list] of turns) {
  list.sort((a, b) => a.step - b.step || a.t - b.t)
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]
    const nxt = list[i + 1]
    if (!nxt) {
      if (cur.hb > 0) hbLast.push(cur)
      continue
    }
    const gap = nxt.t - cur.t
    if (gap < 0 || gap > 600000) continue // 过滤异常间隔
    if (cur.hb > 0) afterHb.push({ gap, cur, nxt })
    else afterNon.push({ gap, cur, nxt })
  }
}

const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b.gap, 0) / arr.length) : 0

console.log('=== 「说完一条消息之后，还要再跑一步」的间隔 ===\n')
console.log(`收尾语消息之后又跑一步:  ${String(afterHb.length).padStart(3)} 次   平均间隔 ${String(avg(afterHb)).padStart(6)} ms`)
console.log(`普通消息之后又跑一步:    ${String(afterNon.length).padStart(3)} 次   平均间隔 ${String(avg(afterNon)).padStart(6)} ms`)

console.log('\n=== 收尾语之后又跑一步的样本（前 10）===')
afterHb.sort((a, b) => b.gap - a.gap).slice(0, 10).forEach(x => {
  console.log(`  turn=${x.cur.turn} step=${x.cur.step}->${x.nxt.step}  间隔=${x.gap}ms  收尾语消息=${x.cur.bytes}B  下一条=${x.nxt.bytes}B`)
})

// 统计：收尾语不是最后一条的比例
const totalHb = msgs.filter(m => m.hb > 0).length
console.log(`\n=== 收尾语位置统计 ===`)
console.log(`带收尾语的消息总数: ${totalHb}`)
console.log(`其中是所在轮最后一条: ${hbLast.length}`)
console.log(`其中后面还有更多消息: ${afterHb.length}  ← 这些是「多跑一步」的证据`)
