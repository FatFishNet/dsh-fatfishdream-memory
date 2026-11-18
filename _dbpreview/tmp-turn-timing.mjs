import { readFileSync, readdirSync } from 'node:fs'

const dir = 'D:/dsh-fatfishdream-memory/logs'
const files = readdirSync(dir).filter(f => f.endsWith('.log')).sort()

// 收集每轮的 assistant 消息时间戳与 heartbeat
const turns = new Map() // key: `${date}:${turn}` -> { hb, times[] }

for (const f of files) {
  const lines = readFileSync(`${dir}/${f}`, 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^(\S+) \[archive-assistant\] (.*)$/)
    if (!m) continue
    const [, iso, body] = m
    const turn = body.match(/"turn":(\d+)/)
    const hb = body.match(/"heartbeat":(\d+)/)
    if (!turn || !hb) continue
    const key = `${f}:${turn[1]}`
    if (!turns.has(key)) turns.set(key, { hb: 0, times: [] })
    const rec = turns.get(key)
    rec.times.push(new Date(iso).getTime())
    rec.hb += Number(hb[1])
  }
}

// 只取有 >=2 条消息的轮次（单条消息的轮次无法比较「多一步」）
const rows = []
for (const [key, rec] of turns) {
  if (rec.times.length < 2) continue
  rec.times.sort((a, b) => a - b)
  const spanMs = rec.times[rec.times.length - 1] - rec.times[0]
  rows.push({ key, hb: rec.hb, msgs: rec.times.length, spanMs })
}

const group = (pred) => {
  const g = rows.filter(pred)
  if (g.length === 0) return null
  const avg = g.reduce((a, b) => a + b.spanMs, 0) / g.length
  return { n: g.length, avgMs: Math.round(avg) }
}

console.log('=== 有 >=2 条 assistant 消息的轮次：按收尾语条数分组 ===\n')
const single = group(r => r.hb === 1)
const multi = group(r => r.hb >= 2)
const zero = group(r => r.hb === 0)

const fmt = (label, g) => {
  if (!g) return console.log(`${label.padEnd(28)} 无样本`)
  console.log(`${label.padEnd(28)} ${String(g.n).padStart(3)} 轮   平均跨度 ${String(g.avgMs).padStart(6)} ms`)
}
fmt('收尾语 = 0 条', zero)
fmt('收尾语 = 1 条', single)
fmt('收尾语 >= 2 条', multi)

if (single && multi) {
  const diff = multi.avgMs - single.avgMs
  console.log(`\n差値: ${diff > 0 ? '+' : ''}${diff} ms  （多收尾语轮次 vs 单收尾语）`)
}

console.log('\n=== 多收尾语轮次明细（前 10）===')
rows.filter(r => r.hb >= 2).slice(0, 10).forEach(r => {
  console.log(`  ${r.key.padEnd(24)} hb=${r.hb}  msgs=${r.msgs}  跨度=${r.spanMs}ms`)
})
