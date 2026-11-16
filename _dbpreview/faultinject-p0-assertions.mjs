/**
 * 故障注入验证：确认 P0 #5 / #6 两处修好的断言**真的会变红**。
 *
 * 为什么必须做：把恒真断言改成带顺序连接的断言，很容易改着改着又变成
 * 另一个恒真（AGENTS.md「断言里不许写字面量 true」那一节的近亲）。
 * 判据只有一个 —— **改错对应代码，它必须 exit 1**。
 *
 * 做法：临时改 index.js 的注入文案 → 跑脚本 → 恢复原文件 → 比对 sha256。
 * ⚠️ 与 meta-mutation-test 同样的纪律：跑的时候不要并行改代码。
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

/**
 * @param {string} label
 * @param {string} script
 * @param {{from: string, to: string}} mutation 在 index.js 上做的破坏
 * @param {boolean} expectRed 期望脚本是否失败
 */
function trial(label, script, mutation, expectRed) {
  const occurrences = original.split(mutation.from).length - 1
  if (occurrences !== 1) {
    // 锚点必须唯一，否则注入会打到别处 —— AGENTS.md 里踩过这个坑
    check(`${label} 锚点唯一`, false, `实际匹配 ${occurrences} 处`)
    return
  }
  try {
    fs.writeFileSync(INDEX, original.replace(mutation.from, mutation.to), 'utf8')
    const r = runCaptured([path.join(HERE, script)], { cwd: REPO, timeout: 120000 })
    const red = r.status !== 0 && r.status !== null
    check(
      `${label} → 期望${expectRed ? '红(exit≠0)' : '绿(exit=0)'}，实际 exit=${r.status}`,
      r.status !== null && red === expectRed,
      r.status === null ? '子进程没跑起来（管道被拒？）' : '',
    )
  } finally {
    fs.writeFileSync(INDEX, original, 'utf8')
  }
}

console.log('=== P0 #5：verify-injection-consistency 的「搜不到 ≠ 没发生过」 ===')

// ① 破坏它：把语义对照那句删掉，只留「没发生过」这个词
//    —— 旧断言 `/搜不到.*(≠|不等于)|没发生过/` 在这种情况下**会绿**（假绿）。
//    新断言要求「搜不到」后 40 字内出现 ≠/不等于，删掉就该红。
trial(
  '删掉「搜不到 ≠ 没发生过」整句',
  'verify-injection-consistency.mjs',
  {
    from: '搜不到 ≠ 没发生过',
    to: '搜不到就是没发生过',
  },
  true,
)

// ② 反向确认：不动它时必须绿（证明上面那条红不是环境问题）
trial(
  '对照组：只改一个无关字符',
  'verify-injection-consistency.mjs',
  { from: '搜不到 ≠ 没发生过', to: '搜不到 ≠ 没发生过 ' },
  false,
)

console.log('\n=== P0 #6：selfcheck-injection-wording 的「不猜 / 不编」 ===')

// 旧断言是 /没记住|不要猜|不要编/ —— 删掉「不要猜」它仍绿。
// 新断言拆成三条，删掉「不要猜」应该红。
//
// ⚠️ 锚点必须唯一（AGENTS.md：新增代码会「抢走」老锚点）。
//   单独搜「不要猜」匹配 5 处、「不要编」匹配 2 处；
//   连 `usageLines` 里那整句也匹配 2 处 —— 因为同一句话在
//   `POLICY_TEMPLATE`（L1066）和 `usageLines`（L3145）各有一份。
//   所以锚点带上半句「查不到就说」，实测全文件唯一（已用脚本核对）。
const USAGE_SENTENCE = '查不到就说「这段我没记住」；不要猜、不要编；'
const GUESS_ANCHOR = `${USAGE_SENTENCE}不要扩大到全库；`
const usageOcc = original.split(GUESS_ANCHOR).length - 1
if (usageOcc !== 1) {
  check('P0#6 锚点唯一', false, `实际匹配 ${usageOcc} 处`)
} else {
  trial(
    '删掉 usageLines 里的「不要猜」',
    'selfcheck-injection-wording.mjs',
    { from: GUESS_ANCHOR, to: `${USAGE_SENTENCE.replace('不要猜、', '别猜、')}不要扩大到全库；` },
    true,
  )
  trial(
    '删掉 usageLines 里的「不要编」',
    'selfcheck-injection-wording.mjs',
    { from: GUESS_ANCHOR, to: `${USAGE_SENTENCE.replace('、不要编', '、别编')}不要扩大到全库；` },
    true,
  )
  trial(
    '对照组：usageLines 原样不动',
    'selfcheck-injection-wording.mjs',
    { from: GUESS_ANCHOR, to: GUESS_ANCHOR },
    false,
  )
}

// 最终校验：文件必须逐字节还原
const afterHash = sha(fs.readFileSync(INDEX, 'utf8'))
check('index.js 已逐字节还原', afterHash === originalHash, `期望 ${originalHash.slice(0, 12)} 实际 ${afterHash.slice(0, 12)}`)

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
