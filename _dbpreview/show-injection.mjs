/**
 * 打印「每轮固定注入」的完整原文 + 分段字节账。
 *
 * 做法：直接调 db-store.mjs 的读接口（与 index.js 的 renderFromDb 用同一批方法、
 * 同样的预算参数），再按 finishInjection 的拼装顺序复现。
 * 不写库、不改库。
 */
import { createDbStore } from '../dsh-fatfishdream-memory/db-store.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// --- 配置：必须与 cordis.patch.yml 一致 ---
const CONF = { factsBytes: 8000, policyBytes: 8000, projectBytes: 4096 }

// index.js 源码，供下方各段抽取真实注入文案（避免脚本成为过期副本）
const idxSrc = readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')

const ptr = join(homedir(), '.dsh', 'memory-root.json')
const root = JSON.parse(readFileSync(ptr, 'utf8')).root
const project = 'dsh-fatfishdream-memory'

const store = createDbStore(join(root, 'memory.db'), CONF, () => {})
store.open()

const parts = []

// ① 全局结论
const facts = store.factsTextSync(CONF.factsBytes)
const factsUsed = Buffer.byteLength(facts.text, 'utf8')
if (facts.text.trim() !== '') {
  parts.push(
    facts.truncated
      ? `## 全局结论\n⚠️ 超预算已截断（${factsUsed}/${CONF.factsBytes} 字节），其余仍保留，不要重复补写。`
      : `## 全局结论<!-- 用量 ${factsUsed}/${CONF.factsBytes} 字节 -->`,
  )
  parts.push(facts.text.trim())
}

// ② 全局规则（policy.md 的「给模型的规则」小节）
//    policyTextSync 在 createStore 内部（index.js L1386），不是 db-store 方法，
//    这里按它的逻辑复现：切小节 → activeLines 过滤 → 按字节截断。
function policyTextSync(file, maxBytes) {
  if (!existsSync(file)) return { text: '', truncated: false }
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split('\n')
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,2}\s*.*给模型的规则/.test(lines[i])) { start = i + 1; break }
  }
  if (start === -1) return { text: '', truncated: false }
  const collected = []
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i])) break
    collected.push(lines[i])
  }
  // activeLines：去掉 [stale] 行与空标题行
  const active = collected
    .join('\n')
    .split('\n')
    .filter((l) => !/\[stale\]/.test(l))
    .join('\n')
    .trim()
  if (active === '') return { text: '', truncated: false }
  let text = active
  let truncated = false
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    while (Buffer.byteLength(text, 'utf8') > maxBytes) text = text.slice(0, -1)
    truncated = true
  }
  return { text, truncated }
}
const policy = policyTextSync(join(root, 'policy.md'), CONF.policyBytes)
const polUsed = Buffer.byteLength(policy.text, 'utf8')
if (policy.text.trim() !== '') {
  parts.push(
    policy.truncated
      ? `## 全局规则\n⚠️ 超预算已截断（${polUsed}/${CONF.policyBytes} 字节），其余仍在 policy.md，不要重复补写。`
      : `## 全局规则<!-- 用量 ${polUsed}/${CONF.policyBytes} 字节 -->`,
  )
  parts.push(policy.text.trim())
}

// ③ 项目结论
const proj = store.projectTextSync(project, CONF.projectBytes)
const projUsed = Buffer.byteLength(proj.text, 'utf8')
const pct = Math.round((projUsed / CONF.projectBytes) * 1000) / 10
if (proj.text.trim() !== '') {
  let header
  if (proj.truncated) {
    header = `## 项目结论（${project}）\n⚠️ 内容超预算已截断（${projUsed}/${CONF.projectBytes} 字节）。首尾都保留了，中间有省略 —— 不要重复补写。`
  } else if (pct >= 80) {
    header = `## 项目结论（${project}）<!-- 用量 ${projUsed}/${CONF.projectBytes} 字节 · ${pct}% -->\n⚠️ 已用 ${pct}%，接近上限。再加可能被挤掉 —— 把经验迁到流水、或把过时条目标 stale。`
  } else {
    header = `## 项目结论（${project}）<!-- 用量 ${projUsed}/${CONF.projectBytes} 字节 · ${pct}% -->`
  }
  parts.push(`${header}\n${proj.text.trim()}`)
}

// ④ 记忆索引
//    文案同样从源码抽取，避免脚本自己变成过期副本。
const routesRe = /`## 记忆索引[\s\S]*?`,\s*\n\s*\)/
const routesM = idxSrc.match(routesRe)
if (!routesM) {
  console.log('❌ 抽取记忆索引段失败，源码结构变了，请修脚本')
  process.exit(1)
}
const routesFrag = routesM[0].replace(/,\s*\n\s*\)$/, '')
const routes = store.routeTable(project)
if (routes) {
  const build = new Function('routes', 'project', 'projectName', `return ${routesFrag.replace(/^`/, '`')}`)
  // 该片段是若干模板字符串用 + 连接，直接整体求值（routes 已在形参里）
  parts.push(build(routes, project, project))
}

// ⑤ 记忆使用说明（usageLines）—— 从源码抽取，不硬编码
//
// ⚠️ 2026-11-14：原先用正则 `\[[\s\S]*?\]\s*\n\s*:` 提取数组字面量，
//    在加入 `...(projectName ? [...] : [...])` 这种嵌套数组后提前截断，
//    报 `SyntaxError: Unexpected token '}'`。
//    改成按**语句边界**切片：从 `const usageLines` 到 `parts.push('## 记忆使用说明`。
const usageStart = idxSrc.indexOf('const usageLines = dbMode')
const usageEnd = idxSrc.indexOf('parts.push(`## 记忆使用说明', usageStart)
if (usageStart < 0 || usageEnd < 0) {
  console.log('❌ 抽取 usageLines 失败，源码结构变了，请修脚本')
  process.exit(1)
}
const usageStmt = idxSrc.slice(usageStart, usageEnd)
// 用 dbMode 分支（本项目走数据库模式）
const dbPathForUsage = join(root, 'memory.db')
const usageLines = new Function(
  'dbMode', 'dbPathOf', 'config', 'store', 'projectName', 'scopeHint',
  `${usageStmt}; return usageLines`,
)(true, () => dbPathForUsage, CONF, { root }, project, project)
parts.push(`## 记忆使用说明\n${usageLines.join('\n')}`)

// 收尾（hint 同样从源码抽取，不硬编码）
const header = `# 记忆（dsh-fatfishdream-memory）`
const hintM = idxSrc.match(/const hint = dbMode\s*\n\s*\? ([\s\S]*?)\n\s*: /)
if (!hintM) {
  console.log('❌ 抽取 hint 失败，源码结构变了')
  process.exit(1)
}
const hint = new Function(`return ${hintM[1]}`)()
const full = `${header}\n\n${hint}\n\n${parts.join('\n\n')}\n`

// ================= 输出 =================
const B = (s) => Buffer.byteLength(s, 'utf8')

console.log('======== 分段字节账 ========')
// 按 part 的标题自动归组，**不要按固定下标取** —— 项目段为空时
// parts 会整体前移，按下标取会把「记忆索引」标成「项目结论」（2026-11-14 踩过）。
const groups = []
for (const p of parts) {
  const m = /^## ([^\n<（]+)/.exec(p)
  if (m) groups.push({ label: `## ${m[1].trim()}`, text: p })
  else if (groups.length > 0) groups[groups.length - 1].text += '\n\n' + p
  else groups.push({ label: '(前置)', text: p })
}
const rows = [
  ['标题 header', header],
  ['hint 说明', hint],
  ...groups.map((g) => [g.label, g.text]),
]
let sum = 0
for (const [name, t] of rows) {
  const b = B(t)
  sum += b
  console.log(`${name.padEnd(22)} ${String(b).padStart(6)} 字节`)
}
console.log('-'.repeat(32))
console.log(`${'合计'.padEnd(22)} ${String(sum).padStart(6)} 字节`)
console.log(`实际全文          ${String(B(full)).padStart(6)} 字节`)
console.log('')

// ---- token 估算 ----
// DeepSeek 官方口径：1 个中文字符 ≈ 0.6 token，1 个英文字符 ≈ 0.3 token。
// 只做量级估算，别当精确计费值。
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/
function estimateTokens(s) {
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return { cjk, other, tokens: Math.round(cjk * 0.6 + other * 0.3) }
}
const total = estimateTokens(full)
console.log('======== token 估算（每轮注入）========')
for (const [name, t] of rows) {
  const e = estimateTokens(t)
  console.log(`${name.padEnd(22)} 中文 ${String(e.cjk).padStart(4)} 字 / 其他 ${String(e.other).padStart(4)} → 约 ${String(e.tokens).padStart(4)} token`)
}
console.log('-'.repeat(32))
console.log(`合计：中文 ${total.cjk} 字 / 其他 ${total.other} → 约 ${total.tokens} token/次请求`)
console.log('')

console.log('======== 全文原文 ========')
console.log(full)
