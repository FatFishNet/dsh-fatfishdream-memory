import { readFileSync } from 'node:fs'

const src = readFileSync('D:/workspace/dsh-fatfishdream-memory/dsh-fatfishdream-memory/index.js', 'utf8')
const lines = src.split('\n')

// 1) steer 之后 return 的实际结构
console.log('=== 1. turn-stopping 里 steer 与 return 的关系 ===')
const steerAt = lines.findIndex(l => l.includes('本轮流水还没写。现在'))
console.log('  提醒文案行:', steerAt + 1)
for (let i = steerAt; i < steerAt + 20 && i < lines.length; i++) {
  const t = lines[i].trim()
  if (t.includes('return') || t.includes('shown.length') || t.includes('writeFailStreak.set')) {
    console.log(`  L${i + 1}: ${t}`)
  }
}

// 2) source.kind 常量的值
console.log('\n=== 2. PLUGIN_SOURCE_KIND 的值 ===')
lines.forEach((l, i) => {
  if (l.includes('PLUGIN_SOURCE_KIND =') || l.includes('const PLUGIN_SOURCE_KIND')) {
    console.log(`  L${i + 1}: ${l.trim()}`)
  }
})

// 3) 监听器是否用 agent.ctx
console.log('\n=== 3. 作用域使用情况 ===')
let globalOn = 0, agentCtx = 0
lines.forEach((l, i) => {
  if (/safeOn\('/.test(l)) globalOn++
  if (/agent\.ctx\./.test(l)) agentCtx++
})
console.log(`  全局 safeOn（ctx.on）: ${globalOn} 处`)
console.log(`  agent.ctx 使用: ${agentCtx} 处`)

// 4) countHeartbeat 是否只写日志
console.log('\n=== 4. countHeartbeat 的消费点 ===')
lines.forEach((l, i) => {
  if (l.includes('countHeartbeat(') && !l.includes('function countHeartbeat')) {
    console.log(`  L${i + 1}: ${l.trim()}`)
  }
})
