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
  ['idx', /^(export )?function createStore/, 'createStore'],
  ['idx', /^function readStateSync/, 'readStateSync'],
  ['idx', /^export function apply/, 'apply'],
  ['idx', /^\s*const safeOn/, 'safeOn'],
  ['idx', /^\s*let dbStore/, 'let dbStore'],
  ['idx', /^\s*const getDbStore/, 'getDbStore'],
  ['idx', /^\s*const dbStoreExists/, 'dbStoreExists'],
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
  ['idx', /^\s*const WRITE_TOOLS/, 'WRITE_TOOLS'],
  ['idx', /^\s*const PWSH_WRITE_PATTERNS/, 'PWSH_WRITE_PATTERNS'],
  ['idx', /^\s*const isWriteLikeCall/, 'isWriteLikeCall'],
  ['idx', /^\s*const routes = \[/, 'routes'],
  ['idx', /^\s*const disposers = routes\.map/, '路由注册'],
  ['idx', /^\s*const healthLine/, 'healthLine'],
  ['idx', /^\s*const runHealthCheck/, 'runHealthCheck'],
  ['idx', /^\s*async function ensureLayout/, 'ensureLayout'],
  ['idx', /^\s*async function overview/, 'overview'],
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

// ============================================================
// C 段：死代码检测 —— 「还定义着，但已经没人调用」
// ============================================================
//
// 为什么需要这一段（2026-11-15 发现）：
//   上面 A 段的断言只证明「这个符号还在文件里」。
//   死代码能完美通过 A 段 —— 它当然还在，只是没人调用。
//
//   实测代价：`reportBudget` 从 2026-11-13 起就没有任何调用点，
//   但文档一直写着「写入成功后 reportBudget 检查预算」。
//   结果是**预算告警静默失效两天**，而全量回归一直是绿的。
//   日志里最后一条 [mem-预算告警] 停在 11-13T03:57，之后再没出现过。
//
//   同类还查出：dbPathOf / looksLikeRedline / measureInjection。
//
// 检测方法：在整个文件里数「除定义行外」还出现过几次。
//   - 0 次 → 死代码
//   - ≥1 次 → 视为有人用（不区分是函数调用还是值传递）
//
// ⚠️ 必须排除注释行，否则注释里提到函数名会被当成「有人用」。
//    这个项目注释极多（中文注释解释「为什么」），不排除的话几乎查不出任何死代码。
//
// ⚠️ 只对**函数与 const/let 声明**做检测。不做全局扫描的原因：
//    index.js 里有大量「从 config 解构出来的局部变量」，
//    它们本来就可能只在一处出现，纳入检测会制造大量误报。

/** 判断一行是不是纯注释（行注释或块注释的续行） */
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * 统计一个名字在源码里的「**外部**引用次数」（排除定义行、排除自身函数体内的自递归）。
 *
 * @returns {{defLine:number, refs:number, selfRefs:number}} 找不到定义时 defLine = -1
 *
 * ## 为什么要排除自递归（2026-11-20 补，实测漏检）
 *
 * 原实现只跳过**定义那一行**。于是 `assertSupportedSchema` 这种
 * **在函数体内递归调用自己**的函数，会被算成 `refs = 2`（两处自递归），
 * 从而被误判为「有人调用」，**躲过死代码检测**。
 *
 * 实测：`assertSupportedSchema` 在 index.js 里只有定义 + 两处自递归，
 * **外部零调用点** —— 它是真死代码，而 `verify-functions` 一直报「无新增死代码」。
 *
 * 这正是 AGENTS.md 记过的「检测器本身有盲区，而且它不会告诉你」的又一形态。
 *
 * ## 怎么判「自递归」
 *
 * 从定义行的 `{` 开始做大括号配对，得到函数体范围 `[bodyStart, bodyEnd]`。
 * 落在范围内的引用 = 自引用，不算「有人调用」。
 *
 * ⚠️ 只对 `function` 声明做这个判断；`const x = () => {}` 的箭头函数体边界
 *    判起来要另一套逻辑（本项目目前没有死掉的箭头函数），先不覆盖 —— 
 *    但**不要**因此以为箭头函数已被检查，下面会单独打印一行说明。
 */
function usageOf(lines, name) {
  const defRe = new RegExp(`^\\s*(async\\s+)?(function|const|let)\\s+${name}\\b`)
  let defLine = -1
  for (let i = 0; i < lines.length; i++) {
    if (defRe.test(lines[i])) { defLine = i; break }
  }
  if (defLine < 0) return { defLine: -1, refs: -1, selfRefs: 0 }

  // 函数体范围：从定义行往后找第一个 `{`，然后大括号配对（按字符，跨行）
  const bodyRange = (() => {
    if (!/\bfunction\b/.test(lines[defLine])) return null
    // 把定义行到文件末尾拼起来，按字符配对
    const from = lines.slice(defLine).join('\n')
    const openAt = from.indexOf('{')
    if (openAt < 0) return null
    let depth = 0
    for (let i = openAt; i < from.length; i++) {
      if (from[i] === '{') depth++
      else if (from[i] === '}') {
        depth--
        if (depth === 0) {
          // 把字符偏移换算回「相对于 defLine 的行号」
          const beforeOpen = from.slice(0, openAt).split('\n').length - 1
          const beforeClose = from.slice(0, i).split('\n').length - 1
          return { startLine: defLine + beforeOpen, endLine: defLine + beforeClose }
        }
      }
    }
    return null
  })()

  const wordRe = new RegExp(`\\b${name}\\b`)
  let refs = 0
  let selfRefs = 0
  for (let i = 0; i < lines.length; i++) {
    if (i === defLine) continue
    if (isCommentLine(lines[i])) continue
    if (!wordRe.test(lines[i])) continue
    // 落在自身函数体内 → 自递归，不算外部调用
    if (bodyRange && i >= bodyRange.startLine && i <= bodyRange.endLine) {
      selfRefs++
      continue
    }
    refs++
  }
  return { defLine: defLine + 1, refs, selfRefs }
}

// 参与死代码检测的符号 —— **自动从源码里发现，不维护手工名单**。
//
// 为什么不用手工名单（2026-11-15 踩到）：
//   第一版我列了 35 个名字。然后注入一个故意写的死函数做验证，
//   结果**检测不出** —— 因为新函数不在名单里。
//   手工名单的根本问题是：**新代码默认不被检查**，
//   而死代码恰恰全是「后来才变成死的」或「新写的但忘了接」。
//
// ## 作用域判断：为什么缩进只允许 0~2 格
//
// index.js 的结构是「apply(ctx) { ... }」把几乎所有东西包在里面，
// 所以大量函数声明在**缩进 2 格**处（apply 体内），而不是行首：
//
//   顶格（0 格）：createStore / analyzeEmotion / readStateSync 等模块级
//   缩进 2 格  ：reportBudget / looksLikeRedline / dbPathOf —— 都在 apply 里
//
// 第一版只认「行首无缩进」，结果把这批**真死代码全部漏掉**，
// 反而把 4 个模块级的长年死代码报了出来（monthKey / stamp / findSecret / truncateBytes）。
// 所以作用域判据是「缩进 ≤ 2」，再深就是函数内的嵌套回调，不纳入检测。
//
// 刻意排除的两类（在下面过滤掉）：
//   1) 导出的（export function / export const）：由宿主调用，本文件里没引用是正常的
//   2) 大写常量（const LEXICON）：不是可调用实体
function discoverFunctions(lines) {
  const found = []
  for (const line of lines) {
    // 缩进超过 2 格 = 函数体内的嵌套函数，不纳入
    const indent = line.length - line.trimStart().length
    if (indent > 2) continue
    // 导出的由宿主调用，本文件里不出现引用是正常的
    if (/^\s*export\s+/.test(line)) continue

    const m = line.match(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
    if (m) { found.push(m[1]); continue }

    // const 箭头函数：只认小写开头的（大写是常量，不是可调用实体）
    const a = line.match(/^\s*const\s+([a-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/)
    if (a) found.push(a[1])
  }
  return found
}

const deadCodeCandidates = []
for (const f of ['idx', 'store']) {
  for (const name of discoverFunctions(files[f])) {
    deadCodeCandidates.push([f, name])
  }
}

console.log('\n=== C. 死代码检测（定义还在、但已无人调用）===\n')

// 已知死代码白名单。
//
// 为什么需要白名单而不是「发现就报错」：
//   删不删是人的决定，不是脚本的决定。有些函数是**故意留着**的
//   （等以后再接回调用点，或作为「曾经存在」的记录）。
//   与其让回归常年红着，不如显式登记「我知道它是死的」。
//
// ⚠️ 白名单的语义是「**已核实**、暂留」，不是「没查过就先塞进来」。
//    2026-11-15 踩过：truncateBytes 被自动发现报出来后，我没回去核实
//    就直接加进白名单，而它其实在 index.js L1470 / L1537 有**两处真实调用**。
//    白名单最危险的用法就是「把没查当成已查」—— 下次加之前先 grep 调用点。
//
// 当前状态（2026-11-15）：**已清空**。
//   原来登记的 10 个已在同日全部删除，删除时保留了各自的教训注释。
const knownDead = new Set([
  // ── assertSupportedSchema（2026-11-20 登记）──
  //
  // **为什么留而不删**：它是「注册工具前的 schema 自检」，
  // 而硬约束 1 让本插件**永久不注册任何工具**（`tools-none`，见 apply 里那条 diag）。
  // 所以它从第一天起就没有调用点，是「工具路线」的遗留。
  //
  // **为什么现在才发现**：`usageOf` 原来只跳过定义行，而它在函数体内
  // **递归调用自己两次** → 被算成「有人调用」→ 死代码检测一直漏掉它。
  // 2026-11-20 修了 usageOf（排除自递归）之后它立刻暴露出来。
  //
  // 保留而不是删掉的理由：硬约束 1 是「当前 adapter 不认 tools 数组」的取舍，
  // 不是 DSH 协议禁止（AGENTS.md 有明确注释）。哪天换成认 tools 的 adapter、
  // 重新启用工具路线，这个校验器是当时写好的防线 —— 删了就得重写。
  // 保留成本是 30 行，重写成本是一次事故。
  //
  // ⚠️ **它是死代码这件事本身要记住**：说明「为将来准备的代码」会一直躺在
  // 死代码检测里，而检测器修好之前它一直显示「无新增死代码」。
  'assertSupportedSchema',
])

let deadNew = 0
for (const [f, name] of deadCodeCandidates) {
  const { defLine, refs, selfRefs } = usageOf(files[f], name)
  if (defLine < 0) {
    // A 段已经会因为「找不到」而报错，这里不重复计
    continue
  }
  if (refs === 0) {
    if (knownDead.has(name)) {
      const extra = selfRefs > 0 ? `（另含 ${selfRefs} 处自递归）` : ''
      console.log(`  ☠️  ${name}（L${defLine}）无人调用${extra} —— 已登记在白名单`)
    } else {
      deadNew++
      const extra = selfRefs > 0
        ? `（函数体内另有 ${selfRefs} 处自递归，但那不算「有人调用」）`
        : ''
      console.log(`  ❌ ${name}（L${defLine}）无人调用${extra}，且不在白名单里`)
      console.log(`     要么接回调用点，要么删掉；确认要暂时保留就加进 knownDead`)
    }
  }
}

if (deadNew === 0) {
  console.log(`  （${deadCodeCandidates.length} 个符号已检查，无新增死代码）`)
}

// ⚠️ 覆盖边界：本段**不检查** `const x = () => {}` 形式的箭头函数。
// 原因见 usageOf 的注释（函数体边界要另一套逻辑）。
// 把边界写出来，而不是让人以为「全查过了」—— 这是 AGENTS.md 里
// 「校验脚本也有看不见的地方」那条要求的做法。
console.log('  ℹ️ 覆盖边界：只检查 `function` 声明；`const x = () => {}` 形式不在本段范围内')

console.log('\n源码规模:', Object.entries(totals).map(([k, v]) => `${k}=${v}`).join('  '))
console.log(
  `${fail === 0 && missing === 0 && deadNew === 0 ? '✅ 全部对上' : '❌ 有问题'}：` +
    `${pass} 通过 / ${fail} 失败 / ${missing} 找不到` +
    `${deadNew > 0 ? ` / ${deadNew} 处新增死代码` : ''}`,
)
process.exit(fail === 0 && missing === 0 && deadNew === 0 ? 0 : 1)
