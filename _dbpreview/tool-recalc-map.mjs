/**
 * 按符号名重算 docs/项目地图.md 里的行号（不是机械平移）。
 *
 * 为什么不用「全部 +2」：AGENTS.md 明确记过 —— 机械平移在
 * 「倒序区间」「跨文件引用」「字节预算」这几种形态上会改错。
 * 而且只要有一次改动不是纯插入，平移就会全错。
 *
 * 做法：
 *   ① 从 verify-map-forms 的输出里取出「地图 L<行> [形态X] <符号> 声称 L<a> → 实际 L<b>」
 *   ② 只改**那一行**里那个**具体的 L<a>**，不碰同行的其它数字
 *   ③ 改完重新跑校验，必须 0 FAIL
 *
 * 用法：node _dbpreview/_recalc-map.mjs [--write]
 *   不加 --write 只打印计划（默认，安全）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const MAP = path.join(REPO, 'docs/项目地图.md')
const WRITE = process.argv.includes('--write')

const r = runCaptured([path.join(HERE, 'verify-map-forms.mjs')], { cwd: REPO, timeout: 180000 })
if (r.status === null) {
  console.error('子进程没跑起来（管道被拒？）—— 这不是测试失败，是环境问题')
  process.exit(2)
}

const out = r.stdout || ''
const lines = out.split(/\r?\n/)

// 形如：地图 L226 [形态B] `WRITE_TOOLS` 声称 L3979 → 实际 L3981（index.mjs/js）
const RE = /地图 L(\d+) \[形态(\w+)\] (.+?) 声称 L(\d+) → 实际 L(\d+)/

const fixes = []
for (const line of lines) {
  const m = line.match(RE)
  if (!m) continue
  fixes.push({
    mapLine: Number(m[1]),
    form: m[2],
    symbol: m[3].trim(),
    claimed: Number(m[4]),
    actual: Number(m[5]),
  })
}

// ⚠️ 2026-11-17：**两个校验脚本各有盲区，必须一起喂**。
//   verify-map-forms 覆盖 9 种形态（含 H 路由表、C 裸数字表）；
//   verify-symbol-lines 专门守 §3.1 表格里的 `符号`(数字) 内联写法。
//   只跑前者时后者仍有 34 处报错 —— 这正是 AGENTS.md 记的
//   「校验脚本也有看不见的地方，而且它不会告诉你」。
//   格式：`❌ map#148 `systemDriveLetter` 写 L205，实际 L221  ← 差 16 行`
const RE_SYM = /map#(\d+) `([^`]+)` 写 L(\d+)，实际 L(\d+)/
const symRun = runCaptured([path.join(HERE, 'verify-symbol-lines.mjs')], { cwd: REPO, timeout: 180000 })
for (const line of (symRun.stdout || '').split(/\r?\n/)) {
  const m = line.match(RE_SYM)
  if (!m) continue
  const dup = fixes.find((f) => f.mapLine === Number(m[1]) && f.claimed === Number(m[3]))
  if (dup) continue
  fixes.push({
    mapLine: Number(m[1]),
    form: 'S', // symbol-lines 专用形态
    symbol: '`' + m[2] + '`',
    claimed: Number(m[3]),
    actual: Number(m[4]),
  })
}

if (fixes.length === 0) {
  console.log('没有需要修的行号（verify-map-forms 没有报出「声称/实际」差异）。')
  console.log(`verify-map-forms exit=${r.status}`)
  process.exit(r.status ?? 0)
}

const text = fs.readFileSync(MAP, 'utf8')
const mapLines = text.split('\n')

console.log(`共 ${fixes.length} 处要改：\n`)

let applied = 0
let skipped = 0
for (const f of fixes) {
  const idx = f.mapLine - 1
  const original = mapLines[idx]
  if (original === undefined) {
    console.log(`  ⚠️ 地图 L${f.mapLine} 不存在，跳过`)
    skipped++
    continue
  }

  // 按形态决定「要改的那段文本」长什么样。
  //
  //   A/B/D 形如 `L2978`（符号紧跟括号、`符号`（L####）等）
  //   H     形如 `| 4653 |`（§11 路由表，**裸数字**，AGENTS.md 记过：
  //         给路由行错加 L 前缀 → 22 条一条都匹配不上）
  //   C     形如 `| 315 |`（§3.1 裸数字表，**也是裸数字**）
  //
  // ⚠️ 裸数字形态**必须带表格分隔符**再匹配。只匹配数字 `315` 会命中
  //    任何含 315 的地方（`L3150`、`0.315`、日期…），那是静默改错。
  let needle
  let replacement
  // S = verify-symbol-lines 报的形态（§3.1 表格内联 `符号`(数字)）
  if (f.form === 'S') {
    const sym = f.symbol.replace(/^`|`$/g, '').trim()
    const inlineNeedle = `\`${sym}\`(${f.claimed})`
    if (original.includes(inlineNeedle)) {
      needle = inlineNeedle
      replacement = `\`${sym}\`(${f.actual})`
    } else {
      const parenNeedle = `(${f.claimed})`
      const parenCount = original.split(parenNeedle).length - 1
      if (parenCount >= 1) {
        needle = parenNeedle
        replacement = `(${f.actual})`
      } else {
        console.log(`  ⚠️ 地图 L${f.mapLine} [S] 找不到 ${inlineNeedle} 或 (${f.claimed})，跳过`)
        skipped++
        continue
      }
    }
  } else if (f.form === 'H' || f.form === 'C') {
    // 表格单元格：`| 315 |`
    needle = `| ${f.claimed} |`
    replacement = `| ${f.actual} |`
    if (!original.includes(needle)) {
      // §3.1 的「区间 + 内联括号」写法：
      //   | 1329–1337 | `looksIronic`(1329) / `stripNoise`(1353) / … |
      //   | 413–421 | `localDay`(413) / `daysBetween`(417) / … |
      // 这时数字在反引号后面的括号里，**紧跟着地图里给的符号名**。
      // 用「符号名 + (数字)」整体锚定，比只认数字可靠得多。
      const sym = f.symbol.replace(/^`|`$/g, '').trim()
      const inlineNeedle = `\`${sym}\`(${f.claimed})`
      if (original.includes(inlineNeedle)) {
        needle = inlineNeedle
        replacement = `\`${sym}\`(${f.actual})`
      } else {
        // 退一步：只要这个数字在括号里且唯一
        const parenNeedle = `(${f.claimed})`
        const parenCount = original.split(parenNeedle).length - 1
        if (parenCount === 1) {
          needle = parenNeedle
          replacement = `(${f.actual})`
        } else {
          const re = new RegExp(`(?<![\\dL])${f.claimed}(?![\\d])`, 'g')
          const hits = original.match(re)
          if (hits && hits.length === 1) {
            needle = hits[0]
            replacement = `${f.actual}`
          } else {
            console.log(`  ⚠️ 地图 L${f.mapLine} 符号 ${sym} 的数字 ${f.claimed} 无法唯一定位（括号命中 ${parenCount} 次），跳过`)
            skipped++
            continue
          }
        }
      }
    }
  } else {
    needle = `L${f.claimed}`
    replacement = `L${f.actual}`
  }
  const count = original.split(needle).length - 1
  if (count === 0) {
    console.log(`  ⚠️ 地图 L${f.mapLine} 里找不到 ${needle}，跳过`)
    skipped++
    continue
  }
  if (count > 1) {
    // 非右边界检查：L4584 也会匹配 L45840。用词边界收窄一次再试。
    console.log(`  ⚠️ 地图 L${f.mapLine} 里 ${needle} 出现 ${count} 次，跳过（需人工）`)
    skipped++
    continue
  }

  const replaced = original.replace(needle, replacement)
  if (replaced === original) {
    console.log(`  ⚠️ 地图 L${f.mapLine} 替换后无变化（${needle} 已是 ${replacement}），跳过`)
    skipped++
    continue
  }

  mapLines[idx] = replaced
  applied++
  console.log(`  ${f.form} ${f.symbol.slice(0, 40)}  ${needle} → ${replacement}`)
}

console.log(`\n可改 ${applied} 处，跳过 ${skipped} 处。`)

if (!WRITE) {
  console.log('（未加 --write，只打印计划，文件未改动）')
  process.exit(skipped > 0 ? 1 : 0)
}

if (skipped > 0) {
  console.log('有跳过的项，为安全起见不写入。请先人工处理跳过的行。')
  process.exit(1)
}

fs.writeFileSync(MAP, mapLines.join('\n'), 'utf8')
console.log(`已写入 ${MAP}`)

// 写完立刻复验
const again = runCaptured([path.join(HERE, 'verify-map-forms.mjs')], { cwd: REPO, timeout: 180000 })
const tail = (again.stdout || '').split(/\r?\n/).filter(Boolean).slice(-3).join('\n')
console.log('\n复验：')
console.log(tail)
process.exit(again.status ?? 2)
