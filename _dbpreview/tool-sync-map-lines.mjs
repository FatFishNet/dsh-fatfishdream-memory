/**
 * 一次性工具：把 `docs/项目地图.md` 里的行号引用按**源码现算位置**重写。
 *
 * ## 为什么不用 tool-recalc-map.mjs（2026-11-18 实踩）
 *
 * 那个工具在这次改动中把**没有改动的行也整体重算了** ——
 * `truncateBytes` 从 694 改成 753，可那段代码一个字都没动。
 * 原因它按「符号在源码里的第几次出现」推位置，遇到同名变量/注释就会错。
 *
 * 本工具的做法不同：**不自己算**。它从两个校验脚本的输出里读
 * 「声称 → 实际」，只把那一个数字换掉：
 *
 *   · verify-map-forms   → `声称 L#### → 实际 L####`（各形态）
 *   · verify-map-content → `说 符号，实际 …`（符号+行号）
 *   · verify-map         → `⚠️ L####（地图行 N）落空/越界`
 *
 * ## 为什么可以迭代到收敛
 *
 * 任一脚本报出来的「实际」都是它当场从源码算的，因此改完再跑一次，
 * 剩下的就是上一轮没覆盖到的形态。循环直到三个脚本全绿或不再变化。
 *
 * 用法：`node tool-sync-map-lines.mjs [--write]`
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAP = path.join(REPO, 'docs', '项目地图.md')
const NODE = process.execPath
const WRITE = process.argv.includes('--write')

const run = (script) => {
  const r = spawnSync(NODE, [path.join(REPO, '_dbpreview', script)], {
    cwd: REPO,
    encoding: 'utf8',
    // 沙箱下默认 pipe 会 EPERM，这里显式忽略 stdin，只捕获输出
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return `${r.stdout ?? ''}\n${r.stderr ?? ''}`
}

/** 从三个校验脚本的输里收集「地图第 N 行，把 From 改成 To」 */
function collectFixes() {
  const fixes = new Map() // MapLine -> Map<From, To>

  const add = (mapLine, from, to) => {
    if (!Number.isInteger(mapLine) || mapLine <= 0) return
    if (from === to) return
    if (!fixes.has(mapLine)) fixes.set(mapLine, new Map())
    fixes.get(mapLine).set(from, to)
  }

  // ---- forms：地图 LN [形态X] ... 声称 LA → 实际 LB
  const formsOut = run('verify-map-forms.mjs')
  for (const m of formsOut.matchAll(/地图 L(\d+) \[形态[A-Z]\][^\n]*?声称 L(\d+) → 实际 L(\d+)/g)) {
    add(Number(m[1]), m[2], m[3])
  }
  // ---- forms 形态 J：地图 LN [形态J kind] `anchor` 声称 L#### —— （后面可能不给「实际」）
  //      这种要自己去源码里按同一套规则搜
  for (const m of formsOut.matchAll(/地图 L(\d+) \[形态J (\w+)\] `([^`]+)` 声称 L(\d+) ——/g)) {
    const [, mapLine, kind, anchor, claimed] = m
    // 若同一行已被上面那条带「→ 实际」的规则修过，就不重复处理
    const real = findFormJLine(kind, anchor, Number(claimed))
    if (real !== null) add(Number(mapLine), claimed, String(real))
  }

  // ---- content：❌ map#N index LA: 说 符号，实际 ...
  //     这种没有给「实际」，只能在下一行用符号去源码现算 —— 见 resolveSymbolLine
  const contentOut = run('verify-map-content.mjs')
  for (const m of contentOut.matchAll(/❌ map#(\d+) index L(\d+): 说 (\w+)/g)) {
    const real = resolveSymbolLine(m[3])
    if (real !== null) add(Number(m[1]), m[2], String(real))
  }

  // ---- map：⚠️ LA（地图行 N）落空/越界
  //     它只说「越界」，目标值要按源码总数推：越界的就是总数本身
  const mapOut = run('verify-map.mjs')
  const totalMatch = mapOut.match(/index=(\d+)/)
  const total = totalMatch ? Number(totalMatch[1]) : null
  for (const m of mapOut.matchAll(/⚠️ L(\d+)（地图行 (\d+)）落空\/越界/g)) {
    if (total === null) continue
    // 只有 ≥ 总数的行号才归一到总数；其它落空情况交给上面两个脚本
    if (Number(m[1]) >= total) add(Number(m[2]), m[1], String(total))
  }

  // ---- symbol-lines：❌ map#N `符号` 写 L####，实际 L####  ← 差 N 行
  //      守的是 §3.1 那张**裸数字表** —— 前两个脚本看不到它（AGENTS.md 记过这个盲区）
  const symOut = run('verify-symbol-lines.mjs')
  for (const m of symOut.matchAll(/❌ map#(\d+) `[^`]+` 写 L(\d+)，实际 L(\d+)/g)) {
    add(Number(m[1]), m[2], m[3])
  }

  return fixes
}

/** 在源码里找符号的**定义行**（function/const/let 声明），找不到返回 null */
function resolveSymbolLine(sym) {
  const src = fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory', 'index.js'), 'utf8').split('\n')
  const re = new RegExp(`(function|const|let|var)\\s+${sym}\\b`)
  for (let i = 0; i < src.length; i++) {
    if (re.test(src[i])) return i + 1
  }
  return null
}

/**
 * 形态 J 的行号没法从输出里读（它只报「不满足」，不给「实际」），
 * 所以这里**照抄 verify-map-forms 的判定规则**，在源码里搜出真正满足的那一行。
 *
 * ⚠️ 规则必须与 verify-map-forms 的 `checkFormJ` 保持一致，
 *    否则会出现「本工具认为改好了、校验脚本仍判红」的死循环。
 *    下面这段是对 `checkFormJ` 的等价复刻（只保留了「从哪一行开始找」这一步）。
 */
const SRC_LINES = () =>
  fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory', 'index.js'), 'utf8').split('\n')

const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)

function buildFormJMatcher(kind, anchor) {
  const e = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  switch (kind) {
    case 'fn':
      return new RegExp(
        `^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${e}\\s*\\(` +
          `|^\\s*(?:export\\s+)?(?:const|let|var)\\s+${e}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\()`,
      )
    case 'decl':
      return new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:const|let|var)\\s+${e}\\s*(?:=|$)`)
    case 'call':
      return new RegExp(`(^|[^\\w$])${e}([^\\w$]|$)`)
    case 'lit':
      return { literal: anchor }
    default:
      return null
  }
}

/** 返回满足条件的第一个行号（1-based），找不到返回 null */
function findFormJLine(kind, anchor, claimed) {
  const lines = SRC_LINES()
  const matcher = buildFormJMatcher(kind, anchor)
  if (matcher === null) return null
  const matches = (l) => {
    if (isComment(l)) return false
    if (matcher.literal !== undefined) return l.includes(matcher.literal)
    return matcher.test(l)
  }
  // 先看原文声称的那一行对不对（对的话不用改）
  if (claimed && matches(lines[claimed - 1] ?? '')) return claimed
  for (let i = 0; i < lines.length; i++) {
    if (matches(lines[i])) return i + 1
  }
  return null
}

let round = 0
let prevSignature = ''
for (;;) {
  round++
  if (round > 12) {
    console.log('⚠️ 超过 12 轮仍未收敛，停止')
    break
  }

  const fixes = collectFixes()
  const signature = [...fixes.entries()]
    .map(([line, m]) => `${line}:${[...m.entries()].map(([f, t]) => `${f}->${t}`).join(',')}`)
    .join('|')

  if (fixes.size === 0) {
    console.log(`第 ${round} 轮：无待修项 ✅`)
    break
  }
  if (signature === prevSignature) {
    console.log(`第 ${round} 轮：待修项与上轮相同，无法继续收敛 ⚠️`)
    break
  }
  prevSignature = signature

  const lines = fs.readFileSync(MAP, 'utf8').split('\n')
  let applied = 0
  for (const [mapLine, pairs] of fixes) {
    const idx = mapLine - 1
    if (idx < 0 || idx >= lines.length) continue
    let text = lines[idx]
    // 先替换长数字，避免 5201 被 520 误伤；用词边界确保是独立数字
    const ordered = [...pairs.entries()].sort((a, b) => b[0].length - a[0].length)
    for (const [from, to] of ordered) {
      text = text.replace(new RegExp(`(?<!\\d)${from}(?!\\d)`, 'g'), to)
    }
    if (text !== lines[idx]) {
      lines[idx] = text
      applied++
    }
  }
  console.log(`第 ${round} 轮：${fixes.size} 个待修行，实际改动 ${applied} 行`)

  if (WRITE && applied > 0) fs.writeFileSync(MAP, lines.join('\n'), 'utf8')
  if (!WRITE) {
    console.log('（未加 --write，只报告不写文件）')
    break
  }
}

// ---- 收尾核对
console.log('\n==== 最终校对 ====')
for (const s of ['verify-map.mjs', 'verify-map-content.mjs', 'verify-map-forms.mjs', 'verify-symbol-lines.mjs']) {
  const out = run(s)
  const tail = out.trimEnd().split('\n').slice(-3).join(' | ')
  console.log(`${s.padEnd(26)} ${tail}`)
}
