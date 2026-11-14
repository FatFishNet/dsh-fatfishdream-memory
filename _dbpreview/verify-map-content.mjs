/**
 * 行号**内容级**验证（verify-map 的补位，不是替代）。
 *
 * 背景：verify-map 只判「L#### 指向的行存在且非空」。2026-11-13 实测：
 * 地图里 15 处锚点全指错位置，它照样报「102 处引用，0 处落空」全绿。
 * 所以行号正确性必须用**内容**来判 —— 那一行是不是地图说的那个东西。
 *
 * ⚠️ 本文件自身踩过两次坑，都源于「期望值是人手填的」：
 *   1. 初版 A 组期望值是照「错误映射后的行号」写的，脚本断言的对象本身是错的。
 *   2. 第二版仍把行号硬编码进 ANCHORS，改动 index.js 后表没跟着更新，
 *      于是整片误报 37 处失败 —— 一个需要人工同步的校验脚本本身就是新的漂移源。
 * 现在改为：**从源码现算真实位置**，ANCHORS 只声明「符号名 → 必须出现的片段」。
 * 这样 index.js 怎么改，校验脚本都不需要人工维护。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILES = {
  index: 'dsh-fatfishdream-memory/index.js',
  schema: 'dsh-fatfishdream-memory/db-schema.mjs',
  store: 'dsh-fatfishdream-memory/db-store.mjs',
  client: 'dsh-fatfishdream-memory/client.js',
}
const BUF = Object.fromEntries(
  Object.entries(FILES).map(([k, v]) => [k, fs.readFileSync(path.join(REPO, v), 'utf8').split('\n')]),
)

const locate = (sec, re, nth = 0) => {
  let n = 0
  for (let i = 0; i < BUF[sec].length; i++) {
    if (re.test(BUF[sec][i])) {
      if (n === nth) return i + 1
      n++
    }
  }
  return -1
}

/** 锚点：只有「名字 + 定位正则 + 该行必须出现的片段」。
 *  行号由 locate 现算，**不写死** —— 写死就是下一次误报的来源。 */
const ANCHORS = [
  ['index', /^\s*function createStore\(/, 'createStore', 'createStore'],
  ['index', /^\s*function resolveProjectKey\(/, 'resolveProjectKey', 'resolveProjectKey'],
  ['index', /^\s*function stripPolicyPhrases\(/, 'stripPolicyPhrases', 'stripPolicyPhrases'],
  ['index', /^\s*function measureInjection\(/, 'measureInjection', 'measureInjection'],
  ['index', /^\s*export function apply\(/, 'export function apply(', 'apply 定义'],
  ['index', /^\s*const safeOn = \(/, 'const safeOn =', 'safeOn 定义'],
  ['index', /^\s*let dbPath = /, 'let dbPath', 'let dbPath'],
  ['index', /^\s*let dbStore$/, 'let dbStore', 'let dbStore'],
  ['index', /^\s*function initDbStore\(/, 'function initDbStore', 'initDbStore 定义'],
  ['index', /^\s*initDbStore\(\)$/, 'initDbStore()', 'initDbStore 首次调用'],
  ['index', /^\s*const checkWritableRoot = \(\) =>/, 'checkWritableRoot', 'checkWritableRoot 定义'],
  ['index', /^\s*setTimeout\(checkWritableRoot/, 'checkWritableRoot', 'checkWritableRoot 延迟'],
  ['index', /^\s*const dispose = ctx\.systemPrompt\.context\(\{/, 'systemPrompt.context', '注入层'],
  ['index', /^\s*function renderFromDb\(/, 'renderFromDb', 'renderFromDb'],
  ['index', /^\s*function finishInjection\(/, 'finishInjection', 'finishInjection'],
  ['index', /^\s*const usageLines = dbMode/, 'usageLines', 'usageLines'],
  ['index', /^\s*const MEM_MARKER_RE = /, 'MEM_MARKER_RE', 'MEM_MARKER_RE'],
  ['index', /^\s*function sanitizeTopic\(/, 'sanitizeTopic', 'sanitizeTopic'],
  ['index', /^\s*function findTableById\(/, 'findTableById', 'findTableById'],
  ['index', /^\s*function readHeartbeat\(/, 'readHeartbeat', 'readHeartbeat'],
  ['index', /^\s*async function writeHeartbeat\(/, 'writeHeartbeat', 'writeHeartbeat'],
  ['index', /^\s*function reportBudget\(/, 'reportBudget', 'reportBudget'],
  ['index', /^\s*function looksLikeRedline\(/, 'looksLikeRedline', 'looksLikeRedline'],
  ['index', /^\s*const WRITE_TOOLS = new Set/, 'WRITE_TOOLS', 'WRITE_TOOLS'],
  ['index', /^\s*const PWSH_WRITE_PATTERNS = \[/, 'PWSH_WRITE_PATTERNS', 'PWSH_WRITE_PATTERNS'],
  ['index', /^\s*const isWriteLikeCall = /, 'isWriteLikeCall', 'isWriteLikeCall'],
  ['index', /safeOn\('session\/event'/, 'session/event', '标记写入监听（第1个）'],
  ['index', /safeOn\('session\/event'/, 'session/event', '情绪录入监听（第2个）', 1],
  ['index', /safeOn\('tools\/result'/, 'tools/result', 'tools/result 监听'],
  ['index', /safeOn\('agent\/turn-stopping'/, 'turn-stopping', 'turn-stopping 监听'],
  ['index', /safeOn\('agent\/created'/, 'agent/created', 'agent/created 监听'],
  ['index', /^\s*return injected\.commands\.register\(\{/, 'commands.register', '/memory 命令注册'],
  ['index', /ctx\.inject\(\['webServer'\]/, 'webServer', 'HTTP 路由注入'],
  ['index', /^\s*const routes = \[/, 'const routes', 'routes 数组'],
  ['index', /webServer\.register\(route\)/, 'webServer.register', '路由注册'],
  ['index', /const runHealthCheck = \(\) =>/, 'runHealthCheck', 'runHealthCheck 定义'],
  ['index', /^\s*setTimeout\(runHealthCheck/, 'runHealthCheck', '健康检查调度'],
]

let pass = 0
const bad = []
function check(name, ok, detail) {
  if (ok) pass++
  else bad.push(`${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) console.log(`❌ ${name}${detail ? '  ← ' + detail : ''}`)
}

console.log('=== A. 锚点（现算位置，那一行必须含该符号）===\n')
for (const [sec, re, needle, label, nth] of ANCHORS) {
  const no = locate(sec, re, nth ?? 0)
  if (no < 0) { check(label, false, '源码里找不到这个符号'); continue }
  const src = BUF[sec][no - 1] ?? ''
  check(`${label} @ L${no}`, src.includes(needle), `实际: ${src.trim().slice(0, 70)}`)
}
console.log(`（${ANCHORS.length} 个锚点已按源码现算位置）`)

// ── B. 地图扫描：`符号（L####）` 必须落在含该符号的行 ───────────
console.log('\n=== B. 地图里「`符号`（L####）」逐条核对 ===\n')
const secFile = (heading) => {
  const m = heading.match(/^##\s+(\d+)/)
  if (!m) return 'index'
  return { 4: 'schema', 5: 'store', 6: 'client' }[Number(m[1])] ?? 'index'
}
// 收尾词如「监听」「定义」不是符号名，排除掉
const NOT_SYMBOL = /^(监听|定义|延迟|首次调用)$/

const mapLines = fs.readFileSync(path.join(REPO, 'docs/项目地图.md'), 'utf8').split('\n')
let sec = 'index'
let total = 0
let wrong = 0
for (let i = 0; i < mapLines.length; i++) {
  const line = mapLines[i]
  if (/^##\s+/.test(line)) sec = secFile(line)
  for (const m of line.matchAll(/`([A-Za-z_$][\w$]{2,}(?:\.[a-zA-Z]+)?)`\s*[（(]\s*\*{0,2}L(\d{3,4})/g)) {
    const sym = m[1]
    if (NOT_SYMBOL.test(sym)) continue
    const no = Number(m[2])
    const src = BUF[sec]?.[no - 1] ?? ''
    total++
    // 允许两种写法：完整名，或最后一段（如 `store.paths.policy` → policy）
    const tail = sym.split('.').pop()
    if (!src.includes(tail)) {
      wrong++
      console.log(`❌ map#${i + 1} ${sec} L${no}: 说 ${sym}，实际 ${src.trim().slice(0, 66) || '越界'}`)
    }
  }
}
check(`B. ${total} 处符号+行号组合`, wrong === 0, wrong ? `${wrong} 处对不上` : '')

console.log(`\n────────────────\n${pass} 通过 / ${bad.length} 失败`)
if (bad.length) {
  console.log('\n失败明细：')
  for (const b of bad) console.log('  - ' + b)
}
process.exit(bad.length === 0 ? 0 : 1)
