/**
 * 端到端验证：闸门是否真的在运行时生效？
 *
 * 单测只证明了「逻辑正确」，不能证明「装进了运行中的插件」。
 * 这里通过插件 HTTP 接口无法直接触发情绪判定（它由 session/event 驱动），
 * 所以改为**核对运行中的源码**：确认插件加载的是带闸门的版本。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 记忆根目录从指针文件读，不要写死 —— 迁移根目录后脚本会全崩。
// 指针由插件自己维护（~/.dsh/memory-root.json）。
const resolveMemoryRoot = () => {
  const cands = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'memory-root.json'),
  ]
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      if (j && typeof j.root === 'string' && j.root !== '') return j.root
    } catch {
      /* 下一个候选 */
    }
  }
  return 'D:\\dsh-fatfishdream-memory'
}
const MEM_ROOT = resolveMemoryRoot().replace(/\\/g, '/')

const LIVE = 'D:/workspace/dsh-fatfishdream-memory/dsh-memory/index.js'

console.log('=== 1. 运行中的源码是否含闸门 ===\n')
const src = fs.readFileSync(LIVE, 'utf8')
const checks = [
  ['EMOTION_MAX_CHARS 常量', /const EMOTION_MAX_CHARS = 1000/],
  ['EMOTION_MAX_LINES 常量', /const EMOTION_MAX_LINES = 20/],
  ['PROMPT_LIKE 特征词表', /const PROMPT_LIKE = \[/],
  ['emotion-skip 日志', /diag\('emotion-skip'/],
  ['闸门在 analyzeEmotion 之前', /skipReason[\s\S]{0,400}const analysis = analyzeEmotion\(analyzable\)/],
]
let allOk = true
for (const [name, re] of checks) {
  const ok = re.test(src)
  if (!ok) allOk = false
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
}

console.log('\n=== 2. 闸门位置是否在正确的地方 ===\n')
const gateIdx = src.indexOf("diag('emotion-skip'")
const analyzeIdx = src.indexOf('const analysis = analyzeEmotion(analyzable)')
const stripIdx = src.indexOf('store.stripPolicyPhrases(text)')
console.log(`  stripPolicyPhrases  @ ${stripIdx}`)
console.log(`  闸门                @ ${gateIdx}`)
console.log(`  analyzeEmotion      @ ${analyzeIdx}`)
const orderOk = stripIdx < gateIdx && gateIdx < analyzeIdx
console.log(`  ${orderOk ? '✅' : '❌'} 顺序正确：剥离策略文本 → 闸门 → 情绪分析`)

console.log('\n=== 3. 5 条特征词是否都在源码里 ===\n')
for (const m of [
  'untrusted-data boundaries',
  'private chain of thought',
  'original reasoning',
  'assistant text from this step',
  'never copy',
]) {
  console.log(`  ${src.includes(m) ? '✅' : '❌'} ${m}`)
}

console.log('\n=== 4. 插件日志确认加载时间 ===\n')
const log = fs.readFileSync(`${MEM_ROOT}/logs/2026-11-13.log`, 'utf8').split('\n')
const lastApply = log.filter((l) => l.includes('[apply-start]')).pop()
const lastHealth = log.filter((l) => l.includes('[health-check-verdict]')).pop()
console.log('  ' + (lastApply ?? '(无)'))
console.log('  ' + (lastHealth ?? '(无)'))

console.log('\n=== 5. 当前情绪表状态 ===\n')
const db = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })
const rows = db.prepare("SELECT id, cls, length(quote) q FROM emotion WHERE status='active' ORDER BY id").all()
console.log(`  active 共 ${rows.length} 条：`)
for (const r of rows) {
  const flag = r.q > 1000 ? '  ← 超长（#12 这条等你自己删）' : ''
  console.log(`    #${String(r.id).padEnd(3)} ${String(r.cls ?? '-').padEnd(5)} ${String(r.q).padStart(6)} 字${flag}`)
}
db.close()

console.log('\n=== 结论 ===')
console.log(allOk && orderOk ? '  ✅ 闸门已装进运行中的代码，位置正确' : '  ❌ 有问题，需检查')
console.log('  端到端触发验证需要真实注入，无法在此脚本内构造。')
console.log('  但下一轮若出现超长 user/message，日志会出现 emotion-skip 而非 emotion-recorded。')
