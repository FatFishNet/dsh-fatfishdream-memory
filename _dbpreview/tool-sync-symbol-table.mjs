/**
 * 同步 docs/项目地图.md §3.1 裸数字表里的行号（2026-11-18）。
 *
 * 为什么单独写：§3.1 那张表是 `| 1629 | \`SYMBOL\` | 说明 |` 形式，
 * 一行里可能嵌多个 `符号`(数字)。上一版用正则批量替换失败了（表格形态太多）。
 *
 * 做法：从校验脚本的输出里拿「符号 → 实际行号」，
 * 然后在**那一行里**按 `符号` 定位紧邻的数字并替换。
 * 改完必须复核（本脚本最后会自己跑一遍 verify-symbol-lines）。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const REPO = 'D:/workspace/dsh-fatfishdream-memory'
const MAP = `${REPO}/docs/项目地图.md`
const NODE = process.execPath

/** 跑校验脚本并拿输出（失败也返回输出，因为它 exit 1 仍有诊断信息） */
function runVerifier() {
  try {
    return execFileSync(NODE, [`${REPO}/_dbpreview/verify-symbol-lines.mjs`], {
      encoding: 'utf8',
      cwd: REPO,
    })
  } catch (e) {
    // ⚠️ 校验脚本发现问题时会 exit 1，execFileSync 抛异常。
    //    stdout 挂在 error.stdout 上 —— 那是我们要的诊断信息，不能丢。
    return String(e?.stdout ?? '')
  }
}

// ---- 1) 拿到所有「符号 声称 Lx 实际 Ly」----
const out = runVerifier()
const pairs = []
for (const m of out.matchAll(/map#(\d+) `(\w+)` 写 L(\d+)，实际 L(\d+)/g)) {
  pairs.push({ mapLine: Number(m[1]), symbol: m[2], claimed: m[3], actual: m[4] })
}
console.log(`待修: ${pairs.length} 处`)

const lines = readFileSync(MAP, 'utf8').split('\n')
let changed = 0

for (const p of pairs) {
  const i = p.mapLine - 1
  if (i < 0 || i >= lines.length) continue
  const before = lines[i]
  // 在该行里找 `符号` 后紧跟的 (数字) 或 | 数字 | 形态
  // 两种写法都覆盖：
  //   | 1629 | `SYM` | ...            ← 行首裸数字
  //   `SYM`(1610)                     ← 括号数字
  let after = before

  // 形态 1：`SYM`(1234)
  const re1 = new RegExp('(`' + p.symbol + '`\\()' + p.claimed + '(\\))')
  if (re1.test(after)) {
    after = after.replace(re1, `$1${p.actual}$2`)
  } else {
    // 形态 2：| 1234 | `SYM` |
    const re2 = new RegExp('(\\|\\s*)' + p.claimed + '(\\s*\\|\\s*`' + p.symbol + '`\\s*\\|)')
    if (re2.test(after)) {
      after = after.replace(re2, `$1${p.actual}$2`)
    } else {
      // 形态 3：`SYM`(1234–5678) 区间 —— 只改区间起点
      const re3 = new RegExp('(`' + p.symbol + '`\\()' + p.claimed + '()')
      if (re3.test(after)) {
        after = after.replace(re3, `$1${p.actual}$2`)
      } else {
        console.log(`  ⚠ map#${p.mapLine} 找不到 \`${p.symbol}\` 的 ${p.claimed} 形式`)
        continue
      }
    }
  }

  if (after !== before) {
    lines[i] = after
    changed += 1
  }
}

writeFileSync(MAP, lines.join('\n'), 'utf8')
console.log(`已改 ${changed} 行`)

// ---- 2) 复核 ----
const recheck = runVerifier()
const tail = recheck.trim().split('\n').slice(-2).join('\n')
console.log('\n复核：')
console.log(tail)
