/**
 * 故障注入：确认 selfcheck-archive-collision 的断言真的会变红。
 *
 * 判据：把 makeMessageKey 的 sid 去掉（= 修复前的写法），
 *       「两个会话的原文都在」那条必须变红。
 *
 * 这不是重复劳动 —— 上面那个脚本里的「反向验证」是**在同一进程里**
 * 换一个函数实现来对比；这里是把**真实源码**改坏，跑**真实脚本**，
 * 走的是完整链路。后者才能证明「回归真的会拦住回归」。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory/index.js')
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')

const original = fs.readFileSync(INDEX, 'utf8')
const originalHash = sha(original)

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fail++
    bad.push(name)
    console.log(`  ❌ ${name}${detail ? '  ← ' + detail : ''}`)
  }
}

function trial(label, from, to, expectRed) {
  const n = original.split(from).length - 1
  if (n !== 1) {
    check(`${label} 锚点唯一`, false, `实际匹配 ${n} 处`)
    return
  }
  try {
    fs.writeFileSync(INDEX, original.replace(from, to), 'utf8')
    const r = runCaptured([path.join(HERE, 'selfcheck-archive-collision.mjs')], { cwd: REPO, timeout: 120000 })
    const red = r.status !== 0 && r.status !== null
    check(
      `${label} → 期望${expectRed ? '红' : '绿'}，实际 exit=${r.status}`,
      r.status !== null && red === expectRed,
      r.status === null ? '子进程没跑起来' : '',
    )
  } finally {
    fs.writeFileSync(INDEX, original, 'utf8')
  }
}

console.log('=== 破坏 makeMessageKey，撞键测试必须变红 ===\n')

// ① 去掉 sid —— 这正是 2026-11-16 修复前的写法
trial(
  '键里去掉 sessionId（回到修复前）',
  "return `${sid}:${turn ?? '?'}:${step ?? '?'}`",
  "return `${turn ?? '?'}:${step ?? '?'}`",
  true,
)

// ② sid 恒为 '?'（等于没加前缀）
trial(
  "sid 恒为 '?'（等于没区分会话）",
  "const sid = id === undefined || id === null ? '?' : String(id)",
  "const sid = '?'",
  true,
)

// ③ 对照组：只改一个字符（不影响逻辑），必须仍然绿
trial(
  '对照组：键格式加一个分隔符但仍含 sid',
  "return `${sid}:${turn ?? '?'}:${step ?? '?'}`",
  "return `${sid}:${turn ?? '?'}:${step ?? '?'}` ",
  false,
)

const afterHash = sha(fs.readFileSync(INDEX, 'utf8'))
check('index.js 已逐字节还原', afterHash === originalHash, `期望 ${originalHash.slice(0, 12)} 实际 ${afterHash.slice(0, 12)}`)

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
