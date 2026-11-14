// 地图行号全量重校：把「落空/内容不符」的引用按函数名重新定位。
// 只打印，不写文件 —— 由人工确认后再改地图。
import fs from 'node:fs'

const idx = fs.readFileSync('dsh-memory/index.js', 'utf8').split('\n')
const map = fs.readFileSync('docs/项目地图.md', 'utf8')

// 地图里每个 L#### 应该指向什么 —— 用「该行附近出现的标识符」做锚
const anchors = [
  ['createStore', /^function createStore\(/],
  ['resolveProjectKey', /^\s*function resolveProjectKey/],
  ['stripPolicyPhrases', /^\s*function stripPolicyPhrases/],
  ['measureInjection', /^\s*function measureInjection/],
  ['WRITE_TOOLS', /^\s*const WRITE_TOOLS/],
  ['PWSH_WRITE_PATTERNS', /^\s*const PWSH_WRITE_PATTERNS/],
  ['isWriteLikeCall', /^\s*const isWriteLikeCall/],
  ['findTableById', /^\s*function findTableById/],
  ['readHeartbeat', /^\s*function readHeartbeat/],
  ['writeHeartbeat', /^\s*async function writeHeartbeat/],
  ['reportBudget', /^\s*function reportBudget/],
  ['looksLikeRedline', /^\s*function looksLikeRedline/],
  ['MEM_MARKER_RE', /^\s*const MEM_MARKER_RE/],
  ['TOPIC_WHITELIST', /^\s*const TOPIC_WHITELIST/],
  ['sanitizeTopic', /^\s*function sanitizeTopic/],
  ['systemPrompt.context', /^\s*const dispose = ctx\.systemPrompt\.context/],
  ['renderFromDb', /^\s*function renderFromDb/],
  ['renderFromFiles', /^\s*function renderFromFiles/],
  ['finishInjection', /^\s*function finishInjection/],
  ['usageLines', /^\s*const usageLines = dbMode/],
  ['initDbStore 定义', /^\s*function initDbStore/],
  ['initDbStore 调用', /^\s*initDbStore\(\)/],
  ['rebindDbStore', /^\s*function rebindDbStore/],
  ['getDbStore', /^\s*const getDbStore/],
  ['dbStoreExists', /^\s*const dbStoreExists/],
  ['dbPathOf', /^\s*const dbPathOf/],
  ['checkWritableRoot', /^\s*const checkWritableRoot/],
  ['checkWritableRoot 调度', /setTimeout\(checkWritableRoot/],
  ['safeOn 定义', /^\s*const safeOn/],
  ['apply', /^export function apply/],
  ['config 合并', /^\s*const config = \{ \.\.\.DEFAULT_CONFIG/],
  ['routes 数组', /^\s*const routes = \[/],
  ['webServer inject', /ctx\.inject\(\['webServer'\]/],
  ['webServer.register', /webServer\.register\(route\)/],
  ['commands inject', /ctx\.inject\(\['commands'\]/],
  ['runHealthCheck', /^\s*const runHealthCheck/],
  ['runHealthCheck 调度', /setTimeout\(runHealthCheck/],
  ['ensureLayout', /^async function ensureLayout/],
  ['overview', /^\s*async function overview/],
  ['backupDbFile', /async function backupDbFile/],
  ['ensureProject 调用', /store\.ensureProject\(resolved/],
  ['POLICY_TEMPLATE', /^const POLICY_TEMPLATE/],
  ['FACTS_TEMPLATE', /^const FACTS_TEMPLATE/],
  ['projectTemplate', /^function projectTemplate/],
  ['MEMORY_DIR_NAME', /^const MEMORY_DIR_NAME/],
  ['systemFallbackRoot', /^function systemFallbackRoot/],
  ['resolveRoot', /^function resolveRoot/],
]

console.log('锚点            真实行号')
console.log('-'.repeat(40))
for (const [name, re] of anchors) {
  const hits = []
  idx.forEach((l, i) => { if (re.test(l)) hits.push(i + 1) })
  console.log(name.padEnd(22), hits.map((h) => 'L' + h).join(', ') || '*** 找不到 ***')
}

// 地图里当前所有引用
console.log('\n=== 地图当前引用（按章节归属）===')
const SRC = {
  index: idx,
  schema: fs.readFileSync('dsh-memory/db-schema.mjs', 'utf8').split('\n'),
  store: fs.readFileSync('dsh-memory/db-store.mjs', 'utf8').split('\n'),
  client: fs.readFileSync('dsh-memory/client.js', 'utf8').split('\n'),
}
const mapLines = map.split('\n')
function ownerOf(n) {
  let h = ''
  for (let i = n - 1; i >= 0; i--) {
    const m = mapLines[i].match(/^##\s+(\S+.*)$/)
    if (m) { h = m[1].trim(); break }
  }
  if (h.startsWith('3.')) return 'index'
  if (h.startsWith('4.')) return 'schema'
  if (h.startsWith('5.')) return 'store'
  if (h.startsWith('6.')) return 'client'
  if (/^(7|8|9|10|11|12|13)\b/.test(h)) return 'index'
  return 'index'
}
mapLines.forEach((line, i) => {
  for (const m of line.matchAll(/\bL(\d{4})\b/g)) {
    const n = +m[1]
    const own = ownerOf(i + 1)
    const src = SRC[own]
    const actual = src[n - 1] === undefined ? '越界' : src[n - 1].trim()
    if (actual === '' || actual === '越界') {
      console.log(`  ⚠️ map#${i + 1} [${own}] L${n} → ${actual || '(空行)'}`)
    }
  }
})
