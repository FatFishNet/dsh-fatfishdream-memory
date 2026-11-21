/**
 * 一次性脚本：把当前 policy.md 写进 POLICY_TEMPLATE（2026-11-18）。
 *
 * 用户要求：「把我现在的 policy.md 当作默认值放在 POLICY_TEMPLATE，当作新用户的初始文件」。
 *
 * ## 为什么用脚本而不是手工 edit
 *
 * 模板是**模板字符串**，里面所有反引号都必须写成 `` \` ``。
 * 当前 policy.md 有 158 个反引号，手抄一定会漏，而漏一个就会让整个
 * `index.js` 语法错误（`node --check` 会红，但如果只看 diff 容易忽略）。
 *
 * ## 做了什么
 *
 *   1. 定位 `const POLICY_TEMPLATE = \`` 与**未被转义的**收尾反引号
 *   2. 读 policy.md 全文
 *   3. 把所有反引号转义成 \`
 *   4. 去掉 `<!-- policy-sync:2 -->` 哨兵（那是运行时文件才需要的，
 *      模板生成的文件由 `syncPolicyOnce` 自己追加）
 *   5. 替换模板体
 *
 * ## 不做什么
 *
 *   不碰 policy.md 本身，不动其它代码。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const IDX = 'D:/workspace/dsh-fatfishdream-memory/dsh-fatfishdream-memory/index.js'
const POL = 'D:/dsh-fatfishdream-memory/policy.md'

const src = readFileSync(IDX, 'utf8')
const policy = readFileSync(POL, 'utf8')

// ---- 1) 定位模板 ----
const marker = 'const POLICY_TEMPLATE = `'
const start = src.indexOf(marker)
if (start < 0) {
  console.error('❌ 找不到 `const POLICY_TEMPLATE = ` ` 起点')
  process.exit(1)
}
const bodyStart = start + marker.length

// 找**未被转义**的收尾反引号
let i = bodyStart
let end = -1
while (i < src.length) {
  const ch = src[i]
  if (ch === '\\') {
    i += 2 // 跳过转义序列（\` 或 \\）
    continue
  }
  if (ch === '`') {
    end = i
    break
  }
  i += 1
}
if (end < 0) {
  console.error('❌ 找不到模板收尾反引号')
  process.exit(1)
}

const oldBody = src.slice(bodyStart, end)
console.log(`旧模板体: ${Buffer.byteLength(oldBody, 'utf8')} 字节 / ${oldBody.split('\n').length} 行`)

// ---- 2) 构造新模板体 ----
//
// ⚠️ 两处转义，缺一不可（2026-11-18 第一版只做了第一处，踩了坑）：
//
//   ① 反引号 → \`  （否则模板字符串提前结束，整个文件语法错误）
//   ② **反斜杠 → \\**（否则 JS 会把 `\.` 解释成 `.`、`\l` 解释成 `l`，
//      路径 `.\.dsh-fatfishdream-memory\log.ps1` 变成
//      `..dsh-fatfishdream-memorylog.ps1` —— 新用户的 policy.md 里路径是坏的，
//      而 `node --check` 照样通过、模板断言也全绿，只有逐字比对才发现。）
//
// 顺序很重要：先处理反斜杠，再处理反引号。反过来的话，反引号转义产生的
// `\`` 里的反斜杠会被第二遍再转义一次，变成 `\\``（错误）。
let next = policy.replace(/\\/g, '\\\\').replace(/`/g, '\\`')
// 模板不需要运行时哨兵标记
next = next.replace(/\n?<!-- policy-sync:2 -->\n?/g, '\n')

console.log(`新模板体: ${Buffer.byteLength(next, 'utf8')} 字节 / ${next.split('\n').length} 行`)
console.log(`转义后反引号数: ${(next.match(/\\`/g) ?? []).length}`)

// ---- 3) 写回 ----
const out = src.slice(0, bodyStart) + next + src.slice(end)
writeFileSync(IDX, out, 'utf8')
console.log('✅ 已写入 index.js')
