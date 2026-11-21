/**
 * 校验：POLICY_TEMPLATE 是否等于当前 policy.md（2026-11-18）。
 *
 * 用途：用户把 policy.md 定为新用户默认值后，确认模板真的被写进去了。
 *
 * 断言都写成**可失败的表达式**，不写 `=== true` 之类恒真判断。
 */

import { readFileSync } from 'node:fs'

const IDX = 'D:/workspace/dsh-fatfishdream-memory/dsh-fatfishdream-memory/index.js'
const POL = 'D:/dsh-fatfishdream-memory/policy.md'

let pass = 0
let fail = 0
const failures = []

function check(name, ok, note = '') {
  if (ok) {
    pass += 1
    console.log(`  ✅ ${name}`)
  } else {
    fail += 1
    failures.push(`${name}${note ? ` — ${note}` : ''}`)
    console.log(`  ❌ ${name}${note ? ` — ${note}` : ''}`)
  }
}

const src = readFileSync(IDX, 'utf8')
const policy = readFileSync(POL, 'utf8')

// ---- 抽出模板并求值 ----
const marker = 'const POLICY_TEMPLATE = '
const at = src.indexOf(marker)
check('源码里能找到 POLICY_TEMPLATE 定义', at >= 0)

const bodyStart = at + marker.length
// ⚠️ marker 不带反引号，所以 bodyStart 指向的**正是模板的开引号**。
//    从 bodyStart + 1 开始扫，否则第一轮就匹配到开引号、close === bodyStart，
//    模板体会被读成空字符串 —— 那是本脚本第一版的真实 bug
//    （误报「模板写坏了」，而源码其实是好的）。
let i = bodyStart + 1
let close = -1
while (i < src.length) {
  if (src[i] === '\\') {
    i += 2 // 跳过 `\` 和它后面的一个字符（\` 或是 \\）
    continue
  }
  if (src[i] === '`') {
    close = i
    break
  }
  i += 1
}
const tplSrc = src.slice(bodyStart, close + 1)
check('能找到模板的收尾反引号', close > bodyStart, `bodyStart=${bodyStart} close=${close}`)

// 用 eval 求值（只读，模板里只有字符串）
const expr = src.slice(bodyStart, close + 1)
let tpl = ''
try {
  tpl = eval(expr)
} catch (e) {
  check('模板能被求值（转义正确）', false, String(e?.message ?? e))
}

console.log(`\n模板: ${Buffer.byteLength(tpl, 'utf8')} 字节 / ${tpl.split('\n').length} 行`)
console.log(`policy.md: ${Buffer.byteLength(policy, 'utf8')} 字节 / ${policy.split('\n').length} 行\n`)

// ---- 内容一致性 ----
// 模板去掉了运行时哨兵，所以比对时也要去掉
const policyNoMark = policy.replace(/\n?<!-- policy-sync:\d+ -->\n?/g, '\n')
check(
  '模板内容与 policy.md 一致（忽略哨兵标记）',
  tpl.trim() === policyNoMark.trim(),
  `模板 ${tpl.trim().length} 字符 vs 政策 ${policyNoMark.trim().length} 字符`,
)

// ---- verify-injection-consistency 的模板断言 ----
console.log('\n--- 模板断言（对应 verify-injection-consistency L549-613）---')
check('含空行规则「擦掉后每个空行会留一个空段」', tpl.includes('擦掉后每个空行会留一个空段'))
check('说明了空行后果 /空行..空段/', /空行[^\n]{0,60}空段/.test(tpl))
check('含「一律记流水」', tpl.includes('一律记流水'))
check('说明了两个通道独立 /独立的通道/', /独立的通道/.test(tpl))
check('不含私人称呼「大肥鱼」', !tpl.includes('大肥鱼'), '模板会发给所有新用户')
check('不含默认收尾语句子', !tpl.includes('每轮回复的结尾，加固定一句'), '收尾语只能由用户自己定')

// ---- 其它关键内容 ----
console.log('\n--- 其它关键内容 ---')
check('含 mem-log 标记语法', tpl.includes('mem-log'))
check('含 memory.db 禁令', tpl.includes('memory.db'))
check('含 13 类 topic', tpl.includes('开发日志 / 技术讨论'))
check('含 scope 必带', tpl.includes('scope'))
check('含 log.ps1 命令', tpl.includes('log.ps1'))

console.log(`\n────────────────────────────`)
console.log(`结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  · ${f}`)
  process.exit(1)
}
