// 断言式核对：地图里每个 L#### 引用必须指向预期的代码内容。
// 位置由脚本从源码**自动推导**（按函数名找），不手写行号 —— 手写行号每轮都要跟着漂移。
import fs from 'node:fs'

const idx = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8').split('\n')
const store = fs.readFileSync('dsh-fatfishdream-memory/db-store.mjs', 'utf8').split('\n')
const schema = fs.readFileSync('dsh-fatfishdream-memory/db-schema.mjs', 'utf8').split('\n')
const client = fs.readFileSync('dsh-fatfishdream-memory/client.js', 'utf8').split('\n')
const files = { idx, store, schema, client }

// 每组：源文件 + 正则 + 名称。脚本自己找行号，再断言那一行确实匹配。
const targets = [
  // ── index.js：模块级 ──
  ['idx', /^export const name/, 'name'],
  ['idx', /^export const inject/, 'inject'],
  ['idx', /^const PLUGIN_SOURCE_KIND/, 'PLUGIN_SOURCE_KIND'],
  ['idx', /^function safePushMessage/, 'safePushMessage'],
  ['idx', /^const healthState/, 'healthState'],
  ['idx', /^const DEFAULT_CONFIG/, 'DEFAULT_CONFIG'],
  ['idx', /^const MEMORY_DIR_NAME/, 'MEMORY_DIR_NAME'],
  ['idx', /^function resolveRoot/, 'resolveRoot'],
  ['idx', /^function truncateBytes/, 'truncateBytes'],
  ['idx', /^const POLICY_TEMPLATE/, 'POLICY_TEMPLATE'],
  // FACTS_TEMPLATE / projectTemplate 已于 2026-11-13 删除（.md 记忆已全部移除）
  ['idx', /^const STRONG_THRESHOLD/, 'STRONG_THRESHOLD'],
  ['idx', /^const LEXICON = /, 'LEXICON'],
  ['idx', /^function analyzeEmotion/, 'analyzeEmotion'],
  ['idx', /^function createStore/, 'createStore'],
  ['idx', /^function readStateSync/, 'readStateSync'],
  ['idx', /^export function apply/, 'apply'],
  ['idx', /^\s*const safeOn/, 'safeOn'],
  ['idx', /^\s*let dbStore/, 'let dbStore'],
  ['idx', /^\s*const getDbStore/, 'getDbStore'],
  ['idx', /^\s*const dbStoreExists/, 'dbStoreExists'],
  ['idx', /^\s*const dbPathOf/, 'dbPathOf'],
  ['idx', /^\s*const checkWritableRoot/, 'checkWritableRoot'],
  ['idx', /^\s*const dispose = ctx\.systemPrompt\.context/, 'systemPrompt.context'],
  ['idx', /^\s*function renderFromDb/, 'renderFromDb'],
  // renderFromFiles 已于 2026-11-13 移除（.md 回退路径不再存在），不再断言。
  ['idx', /^\s*function finishInjection/, 'finishInjection'],
  ['idx', /^\s*const usageLines/, 'usageLines'],
  ['idx', /^\s*const MEM_MARKER_RE/, 'MEM_MARKER_RE'],
  ['idx', /^\s*function findTableById/, 'findTableById'],
  ['idx', /^\s*function readHeartbeat/, 'readHeartbeat'],
  ['idx', /^\s*async function writeHeartbeat/, 'writeHeartbeat'],
  ['idx', /^\s*function reportBudget/, 'reportBudget'],
  ['idx', /^\s*function looksLikeRedline/, 'looksLikeRedline'],
  ['idx', /^\s*const WRITE_TOOLS/, 'WRITE_TOOLS'],
  ['idx', /^\s*const PWSH_WRITE_PATTERNS/, 'PWSH_WRITE_PATTERNS'],
  ['idx', /^\s*const isWriteLikeCall/, 'isWriteLikeCall'],
  ['idx', /^\s*const routes = \[/, 'routes'],
  ['idx', /^\s*const disposers = routes\.map/, '路由注册'],
  ['idx', /^\s*const healthLine/, 'healthLine'],
  ['idx', /^\s*const runHealthCheck/, 'runHealthCheck'],
  ['idx', /^\s*async function ensureLayout/, 'ensureLayout'],
  ['idx', /^\s*async function overview/, 'overview'],
  ['idx', /^\s*function measureInjection/, 'measureInjection'],
  ['idx', /^\s*function stripPolicyPhrases/, 'stripPolicyPhrases'],
  ['idx', /^\s*function resolveProjectKey/, 'resolveProjectKey'],
  ['idx', /^\s*const formatX/, 'formatX(占位，不存在则跳过)'],

  // ── index.js：事件与注册点 ──
  ['idx', /safeOn\('session\/event'/, 'session/event #1'],
  ['idx', /safeOn\('tools\/result'/, 'tools/result'],
  ['idx', /safeOn\('agent\/turn-stopping'/, 'turn-stopping'],
  ['idx', /safeOn\('agent\/created'/, 'agent/created'],
  ['idx', /ctx\.inject\(\['commands'\]/, 'commands inject'],
  ['idx', /ctx\.inject\(\['webServer'\]/, 'webServer inject'],
  ['idx', /webServer\.register\(route\)/, 'webServer.register'],
  ['idx', /setTimeout\(runHealthCheck/, 'health 调度'],
  // store.ensureProject / ensureMonthlyLog 的调用已于 2026-11-13 移除
  // （agent/created 不再预建任何 .md），改为断言「已确认删除」。
  ['idx', /^\s*async function ensureLayout/, 'ensureLayout'],
  // factsTextSync / projectTextSync（文件版）已于 2026-11-13 删除，
  // 它们读的 facts.md / PROJECT.md 不再生成。数据库版在 db-store.mjs 里，同名但不同实现。
  ['idx', /registeredCommand = true/, 'registeredCommand'],
  ['idx', /injectedPrompt = true/, 'injectedPrompt'],

  // ── index.js：13 条路由 ──
  ['idx', /path: '\/api\/dsh-memory\/state'/, '/state'],
  ['idx', /path: '\/api\/dsh-memory\/entries'/, '/entries'],
  ['idx', /path: '\/api\/dsh-memory\/entry\/update'/, '/entry/update'],
  ['idx', /path: '\/api\/dsh-memory\/entry\/create'/, '/entry/create'],
  ['idx', /path: '\/api\/dsh-memory\/heartbeat'/, '/heartbeat'],
  ['idx', /path: '\/api\/dsh-memory\/entry\/delete'/, '/entry/delete'],
  ['idx', /path: '\/api\/dsh-memory\/entry\/topic'/, '/entry/topic'],
  ['idx', /path: '\/api\/dsh-memory\/entry\/status'/, '/entry/status'],
  ['idx', /path: '\/api\/dsh-memory\/entry\/upgrade-global'/, '/upgrade-global'],
  ['idx', /path: '\/api\/dsh-memory\/persona-check'/, '/persona-check'],
  ['idx', /path: '\/api\/dsh-memory\/search'/, '/search'],
  ['idx', /path: '\/api\/dsh-memory\/root\/move'/, '/root/move'],
  ['idx', /path: '\/api\/dsh-memory\/project\/move'/, '/project/move'],

  // ── db-store.mjs ──
  ['store', /^export const PERSONA_FORBIDDEN/, 'PERSONA_FORBIDDEN'],
  ['store', /^export function checkPersona/, 'checkPersona'],
  ['store', /^export function createDbStore/, 'createDbStore'],
  ['store', /^\s*function joinWithBudget/, 'joinWithBudget'],
  ['store', /^\s*function factsTextSync/, 'factsTextSync'],
  ['store', /^\s*function projectTextSync/, 'projectTextSync'],
  ['store', /^\s*function routeTable/, 'routeTable'],
  ['store', /^\s*function appendLog/, 'appendLog'],
  ['store', /^\s*function appendFact/, 'appendFact'],
  ['store', /^\s*function appendProjectNote/, 'appendProjectNote'],
  ['store', /^\s*function recordEmotion/, 'recordEmotion'],
  ['store', /^\s*function createEntry/, 'createEntry'],
  ['store', /^\s*function updateText/, 'updateText'],
  ['store', /^\s*function setStatus/, 'setStatus'],
  ['store', /^\s*function setTopic/, 'setTopic'],
  ['store', /^\s*function setReview/, 'setReview'],
  ['store', /^\s*function upgradeToGlobal/, 'upgradeToGlobal'],
  ['store', /^\s*function removeGlobalByRegex/, 'removeGlobalByRegex'],
  ['store', /^\s*function search/, 'search'],
  ['store', /^\s*function listEntries/, 'listEntries'],
  ['store', /^\s*function getById/, 'getById'],
  ['store', /^\s*function stats/, 'stats'],
  ['store', /^\s*function listScopes/, 'listScopes'],
  ['store', /^\s*function scanPersona/, 'scanPersona'],

  // ── db-schema.mjs ──
  ['schema', /^export const SCHEMA_VERSION/, 'SCHEMA_VERSION'],
  ['schema', /^export function segmentCjk/, 'segmentCjk'],
  ['schema', /^export function buildMatchQuery/, 'buildMatchQuery'],
  ['schema', /CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts/, 'profile_fts'],
  ['schema', /^export function syncFts/, 'syncFts'],
  ['schema', /^export function removeFts/, 'removeFts'],
  ['schema', /^export function openMemoryDb/, 'openMemoryDb'],

  // ── client.js ──
  ['client', /^\s*const fmtTime/, 'fmtTime'],
  ['client', /^\s*const KIND_LABEL/, 'KIND_LABEL'],
  ['client', /^\s*const TAB_TABLE/, 'TAB_TABLE'],
  ['client', /^\s*function EntryRow/, 'EntryRow'],
  ['client', /^\s*function AddRuleForm/, 'AddRuleForm'],
  ['client', /^\s*function PersonaNormCard/, 'PersonaNormCard'],
  ['client', /^\s*function MemoryPanel/, 'MemoryPanel'],
  ['client', /^\s*function SidebarIcon/, 'SidebarIcon'],
  ['client', /^\s*const PAGE_SIZE/, 'PAGE_SIZE'],
  ['client', /^\s*const MAX_VIEWABLE/, 'MAX_VIEWABLE'],
  ['client', /^\s*const \[logScope/, 'logScope'],
  ['client', /sidebar\.panellist', id: 'dsh-memory'/, 'sidebar 注册'],
  ['client', /ctx\.slots\.register\(\{ name: 'main', key: 'dsh-memory' \}/, 'main 注册'],
]

let pass = 0
let fail = 0
let missing = 0

for (const [f, re, name] of targets) {
  const arr = files[f]
  let line = '--'
  arr.forEach((l, i) => {
    if (line === '--' && re.test(l)) line = i + 1
  })
  if (line === '--') {
    if (name.includes('占位')) continue
    missing++
    console.log(`  ??   ${f}：找不到「${name}」`)
    continue
  }
  // 断言：该行确实匹配这个正则（自反性检查，防止行号算错）
  if (re.test(arr[line - 1])) {
    pass++
  } else {
    fail++
    console.log(`  BAD  ${f}:${line} 期望 ${name}，实际: ${String(arr[line - 1]).trim().slice(0, 60)}`)
  }
}

const totals = {
  'index.js': idx[idx.length - 1] === '' ? idx.length - 1 : idx.length,
  'db-store.mjs': store[store.length - 1] === '' ? store.length - 1 : store.length,
  'db-schema.mjs': schema[schema.length - 1] === '' ? schema.length - 1 : schema.length,
  'client.js': client[client.length - 1] === '' ? client.length - 1 : client.length,
}
console.log('\n源码规模:', Object.entries(totals).map(([k, v]) => `${k}=${v}`).join('  '))
console.log(
  `${fail === 0 && missing === 0 ? '✅ 全部对上' : '❌ 有问题'}：${pass} 通过 / ${fail} 失败 / ${missing} 找不到`,
)
process.exit(fail === 0 && missing === 0 ? 0 : 1)
