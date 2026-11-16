/**
 * 代码完整自检（`audit-full`）—— 一条命令走完「上次逐行审查」的常规部分。
 *
 * ## 为什么不放进 run-all.mjs
 *
 * `run-all` 是**日常回归**（改几行就跑，30 秒~几分钟）。这个自检是**阶段性的**
 * 全面体检，成本高得多。两者混在一起会让日常回归变慢，然后大家都去跳过它。
 *
 * 所以：日常走 `run-all`，这个只在「准备动大手术」或「很久没体检」时手动跑。
 * **由人决定时机，脚本不自己触发。**
 *
 * ## 它与第 7 轮「9 个子代理逐行读 9736 行」的关系
 *
 * 直接说明白：**它不能替代逐行审阅。**
 *
 *   第 7 轮做法   成本 O(9736 行) × 每次重付，但能发现「方向写反」「加成顺序错」
 *                 这类**语义**问题 —— 那些靠人（或代理）真的理解代码才能看出。
 *
 *   这个脚本     成本 O(规则数) ≈ 秒级，只能发现**形态**类问题：
 *                 裸 JSON.parse、缺方法白名单、SQL 拼 table、去重键漏 session…
 *
 * 它的真正价值是**把「读全部代码」降级成「读可疑的那几处」**：
 *
 *   B 段 🔴 新增命中   → 这些必须看（以前没人看过）
 *   C 段 NEEDS_EYES    → 语义类，脚本判不了，但**给出确切行号与判据**
 *
 * 第 7 轮找到 55 条里，能固化成规则的是形态类；剩下的语义类集中在 6 处，
 * 脚本把它们直接指出来。**省的是「翻 9736 行找位置」，不是「思考」。**
 *
 * ## 四段
 *
 *   A  语法与一致性    node --check × 4 + 包名/版本/source.kind 三处一致
 *   B  规则扫描        先自检规则（防规则静默失效），再扫；与基线比对
 *   C  语义待看        只打印，不判定
 *   D  深度回归        调 run-all + 变异 --dry-run（可 --no-deep 跳过）
 *
 * ## 退出码约定（与项目里其他工具一致）
 *
 *   0  全部通过
 *   1  有真问题（规则失效 / 新增命中 / 语法错 / 回归红）
 *
 * ⚠️ **规则自检失败永远判 1**，绝不允许「规则坏了但输出看起来正常」——
 * 这正是本项目栽过两次的坑（`reportBudget` 静默失效、变异 SKIP 当通过）。
 *
 * 用法：
 *   node _dbpreview/audit-full.mjs                # 全跑
 *   node _dbpreview/audit-full.mjs --brief        # 只打结论（给模型读，省 token）
 *   node _dbpreview/audit-full.mjs --no-deep      # 跳过 D 段（快速）
 *   node _dbpreview/audit-full.mjs --adopt        # 把当前命中写进基线（需人工填 note）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'
import { RULES, NEEDS_EYES, runRules, FILES, REPO } from './audit-rules.mjs'
import { KNOWN } from './audit-baseline.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const BRIEF = argv.includes('--brief')
const NO_DEEP = argv.includes('--no-deep')
const ADOPT = argv.includes('--adopt')

const fails = []
const fail = (msg) => { fails.push(msg) }
const say = (s = '') => { if (!BRIEF) console.log(s) }
const always = (s = '') => console.log(s)

// ================================================================ A 段

say('══ A 段 · 语法与一致性 ══════════════════════════════════════')

const SYNTAX_TARGETS = Object.values(FILES)
let syntaxBad = 0
for (const rel of SYNTAX_TARGETS) {
  const abs = path.join(REPO, rel)
  if (!fs.existsSync(abs)) {
    fail(`A: 文件不存在 ${rel}`)
    say(`  ❌ ${rel} 不存在`)
    syntaxBad++
    continue
  }
  const r = runCaptured(['--check', abs], { cwd: REPO, timeout: 30000 })
  // status===null 表示压根没启动 —— 绝不能当成「通过」
  if (r.status === null) {
    fail(`A: node --check ${rel} 没跑起来（${r.error?.code ?? '未知'}）`)
    say(`  💥 ${rel} 语法检查没跑起来（环境问题，不是通过）`)
    syntaxBad++
  } else if (r.status !== 0) {
    fail(`A: 语法错误 ${rel}`)
    say(`  ❌ ${rel} 语法错误：${(r.stderr || r.stdout || '').split('\n').slice(0, 3).join(' ')}`)
    syntaxBad++
  }
}
if (syntaxBad === 0) say(`  ✅ ${SYNTAX_TARGETS.length} 个文件语法通过`)

// ---- 身份一致性：包名 / source.kind / 显示名三处必须一致 ----
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory/package.json'), 'utf8'))
  const idx = fs.readFileSync(path.join(REPO, FILES.index), 'utf8')

  const nameDecl = idx.match(/export\s+const\s+name\s*=\s*'([^']+)'/)
  if (!nameDecl) {
    fail('A: index.js 里找不到 export const name')
    say('  ❌ index.js 缺 `export const name`')
  } else if (nameDecl[1] !== pkg.name) {
    fail(`A: 包名不一致 package.json=${pkg.name} vs index.js=${nameDecl[1]}`)
    say(`  ❌ 包名不一致：package.json=${pkg.name} / index.js=${nameDecl[1]}`)
  } else {
    say(`  ✅ 包名一致：${pkg.name}`)
  }

  // source.kind 必须是 plugin:<包名>（硬约束 3：写裸 'plugin' 会让整个请求失败）
  const kindMatches = [...idx.matchAll(/kind:\s*`?plugin:?\$?\{?([^`',}\s]*)/g)]
  if (kindMatches.length === 0) {
    say('  · 未发现 source.kind 字面量（可能用了常量拼接，跳过此项）')
  } else {
    const bad = kindMatches.filter((m) => !String(m[1]).includes(pkg.name) && m[1] !== '')
    if (bad.length > 0) {
      fail(`A: source.kind 未使用包名（硬约束 3）`)
      say(`  ❌ source.kind 疑似未带包名：${bad.map((m) => m[0]).join(', ')}`)
    } else {
      say('  ✅ source.kind 带包名')
    }
  }
} catch (e) {
  fail(`A: 身份一致性检查抛错 ${e.message}`)
  say(`  ❌ 身份一致性检查抛错：${e.message}`)
}

// ---- 硬约束 1：不许注册任何工具 ----
const idxSrc = fs.readFileSync(path.join(REPO, FILES.index), 'utf8')
if (/ctx\.tools\s*[.\[]/.test(idxSrc) || /registerTool\s*\(/.test(idxSrc)) {
  fail('A: 疑似注册了工具（硬约束 1，会以「参数结构不符合要求」拒绝整个请求）')
  say('  ❌ 疑似注册了工具 —— 立刻停下检查（硬约束 1）')
} else {
  say('  ✅ 未注册工具（硬约束 1）')
}

// ================================================================ B 段

say('')
say('══ B 段 · 静态规则扫描 ══════════════════════════════════════')

const { hits, errors } = runRules({ selfTest: true })

// ★ 规则自检失败 = 整个自检不可信，必须最先报、直接判红
if (errors.length > 0) {
  say(`  💥 ${errors.length} 条规则本身失效 —— 本次扫描结果不可信`)
  for (const e of errors) {
    say(`     · ${e}`)
    fail(`B: ${e}`)
  }
} else {
  say(`  ✅ ${RULES.length} 条规则全部通过自检（mustCatch / mustMiss 双向验证）`)
}

// ---- 与基线比对 ----
const knownByHash = new Map()
for (const k of KNOWN) {
  if (!k.hash || k.hash === 'PENDING') continue
  knownByHash.set(k.hash, k)
}

const fresh = []
const knownHits = []
for (const h of hits) {
  if (knownByHash.has(h.hash)) knownHits.push(h)
  else fresh.push(h)
}

// 基线里有、但这次没命中 = 已修复
const hitHashes = new Set(hits.map((h) => h.hash))
const fixed = KNOWN.filter((k) => k.hash && k.hash !== 'PENDING' && !hitHashes.has(k.hash))

say('')
say(`  命中 ${hits.length} 处：🔴 新增 ${fresh.length} / 🟡 已知 ${knownHits.length} / 🟢 已修复 ${fixed.length}`)

if (fresh.length > 0) {
  say('')
  say('  🔴 新增命中（规则以前没见过，这些必须看）：')
  for (const h of fresh) {
    const loc = `${h.file}:${h.line}`
    say(`     [${h.sev}] ${loc}  ${h.ruleId}  (${h.ref})`)
    say(`             ${h.text}`)
    if (h.extra) say(`             ${h.extra}`)
  }
  // 新增命中才判红 —— 已登记的不判
  fail(`B: ${fresh.length} 处新增命中`)
}

if (fixed.length > 0) {
  say('')
  say('  🟢 以下基线条目本次没有命中（可能已修复，可以考虑从基线删掉）：')
  for (const k of fixed) say(`     ${k.ruleId}  ${k.file}  ${k.note ?? ''}`)
}

// 有 PENDING 且带 --adopt 提示
if (!ADOPT && KNOWN.some((k) => k.hash === 'PENDING')) {
  say('')
  say('  · 基线里有 PENDING 条目，跑 --adopt 可以把当前命中生成成正式条目')
}

// ---- --adopt：把当前命中写进基线 ----
if (ADOPT) {
  say('')
  always(`  ⚠️ --adopt 会把 ${hits.length} 处命中写入基线（全部标 TODO），请逐条填 note。`)
  const lines = []
  lines.push('/**')
  lines.push(' * 完整自检的**已知问题基线**。')
  lines.push(' *')
  lines.push(' * 登记在这里 = 已知，不判红；不在基线里 = 新增，判红。')
  lines.push(' * 基线里有、但本次没命中 = 已修复，可以删掉。')
  lines.push(' *')
  lines.push(' * ⚠️ 每一条的 note 必须能回答「为什么不修」或「什么时候修」。')
  lines.push(' *    答不出来的，说明该去修代码，而不是往这里塞。')
  lines.push(' */')
  lines.push('')
  lines.push('export const KNOWN = [')
  const byRule = new Map()
  for (const h of hits) {
    if (!byRule.has(h.ruleId)) byRule.set(h.ruleId, [])
    byRule.get(h.ruleId).push(h)
  }
  for (const [ruleId, list] of byRule) {
    lines.push(`  // ---- ${ruleId}（${list.length} 处）----`)
    for (const h of list) {
      lines.push('  {')
      lines.push(`    hash: '${h.hash}',`)
      lines.push(`    ruleId: '${h.ruleId}',`)
      lines.push(`    file: '${h.file}',`)
      lines.push(`    note: 'TODO: 待分类（${h.text.replace(/'/g, "\\'").slice(0, 60)}）',`)
      lines.push('  },')
    }
    lines.push('')
  }
  lines.push(']')
  lines.push('')
  lines.push('export default { KNOWN }')
  const out = lines.join('\n')
  fs.writeFileSync(path.join(HERE, 'audit-baseline.mjs'), out, 'utf8')

  // --adopt 是「我承认这些是新常态」的动作，不是「检查通过」。
  // 所以要说清楚下一步，而不是混在失败汇总里让人以为工具坏了。
  always('')
  always('  ✅ 已写入 audit-baseline.mjs。')
  always(`     下一步：逐条把 "TODO: 待分类" 改成【待修】/【设计】/【误报】＋理由。`)
  always(`     本轮退出码仍为 1（adopt 不是通过），改完 note 再跑一次应为 0。`)
  process.exit(0)
}

// ================================================================ C 段

say('')
say('══ C 段 · 语义类待看（脚本判不了，只指出位置）════════════════')

say(`  共 ${NEEDS_EYES.length} 处。这些是「方向写反 / 顺序错 / 会不会吞掉下一段」`)
say('  这类问题，正则抓不到 —— 但这里给出确切位置与判据，省掉翻文件。')
say('')
for (const n of NEEDS_EYES) {
  // 找锚点实际行号，让下一个会话直接跳过去
  let where = n.at
  try {
    const src = fs.readFileSync(path.join(REPO, n.at), 'utf8')
    const lines = src.split('\n')
    const idxs = []
    lines.forEach((l, i) => { if (l.includes(n.anchor)) idxs.push(i + 1) })
    where = idxs.length > 0 ? `${n.at}:${idxs[0]}` : `${n.at}（锚点 "${n.anchor}" 没找到，可能已改名）`
  } catch { /* 文件读不到就只报文件名 */ }
  say(`  [${n.ref}] ${where}`)
  say(`       看什么：${n.what}`)
  say(`       怎么判：${n.how}`)
  say('')
}

// ================================================================ D 段

if (NO_DEEP) {
  say('══ D 段 · 已跳过（--no-deep）════════════════════════════════')
} else {
  say('══ D 段 · 深度回归 ═════════════════════════════════════════')
  say('  跑全量回归…（这一步最慢）')
  const rg = runCaptured([path.join(HERE, 'run-all.mjs')], {
    cwd: REPO,
    timeout: 600000,
    env: { ...process.env, DSH_BASE: process.env.DSH_BASE || process.env.DSH_WEB_URL || '' },
  })
  if (rg.status === null) {
    say('  💥 run-all 没跑起来（环境问题，不是测试通过）')
    fail('D: run-all 没跑起来')
  } else {
    const out = `${rg.stdout || ''}${rg.stderr || ''}`
    const summary = out.split('\n').filter((l) => /^TOTAL=/.test(l.trim())).pop() || '(没有汇总行)'
    if (rg.status === 0) {
      say(`  ✅ ${summary.trim()}`)
    } else {
      say(`  ❌ ${summary.trim()}`)
      const detail = out.split('\n').filter((l) => /❌|💥/.test(l)).slice(0, 6)
      for (const d of detail) say(`     ${d.trim()}`)
      fail(`D: 回归失败 ${summary.trim()}`)
    }
  }

  // 变异 --dry-run：只验锚点还匹配，不改文件（安全，且能抓「防线空了」）
  say('  跑变异锚点检查（--dry-run，不改文件）…')
  const mt = runCaptured([path.join(HERE, 'meta-mutation-test.mjs'), '--dry-run'], {
    cwd: REPO,
    timeout: 180000,
  })
  if (mt.status === null) {
    say('  💥 变异 --dry-run 没跑起来')
    fail('D: 变异 --dry-run 没跑起来')
  } else {
    const out = `${mt.stdout || ''}${mt.stderr || ''}`
    const line = out.split('\n').filter((l) => /匹配|KILLED|SURVIVED|SKIP/.test(l)).pop() || ''
    if (mt.status === 0) {
      say(`  ✅ 变异锚点：${line.trim() || '全部匹配'}`)
    } else {
      say(`  ❌ 变异锚点失配（防线可能空了）`)
      const warns = out.split('\n').filter((l) => /⚠️|SKIP|未匹配/.test(l)).slice(0, 6)
      for (const w of warns) say(`     ${w.trim()}`)
      fail('D: 变异锚点失配')
    }
  }
}

// ================================================================ 结论

say('')
say('══════════════════════════════════════════════════════════')
if (fails.length === 0) {
  always('✅ 完整自检通过')
  if (BRIEF) {
    always(`   规则 ${RULES.length} 条自检 OK；命中 ${hits.length}（新增 0 / 已知 ${knownHits.length} / 已修复 ${fixed.length}）`)
    always(`   语义待看 ${NEEDS_EYES.length} 处（C 段，非失败）`)
  }
  process.exit(0)
} else {
  always(`❌ 完整自检失败（${fails.length} 项）`)
  if (BRIEF) for (const f of fails) always(`   · ${f}`)
  process.exit(1)
}
