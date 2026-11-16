/**
 * 故障注入：确认 selfcheck-posix-paths 的断言真的会变红。
 *
 * 为什么必须做：这组断言是「在 Windows 上模拟 POSIX」，
 * 很容易写成「假环境里怎么跑都绿」—— 因为假环境是测试自己搭的，
 * 搭错了也看不出来。
 *
 * 判据：把平台分支逐个改坏，每一条都必须让脚本 exit 1。
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

function trial(label, mutation, expectRed) {
  const n = original.split(mutation.from).length - 1
  if (n !== 1) {
    check(`${label} 锚点唯一`, false, `实际匹配 ${n} 处`)
    return
  }
  try {
    fs.writeFileSync(INDEX, original.replace(mutation.from, mutation.to), 'utf8')
    const r = runCaptured([path.join(HERE, 'selfcheck-posix-paths.mjs')], { cwd: REPO, timeout: 120000 })
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

console.log('=== 破坏 macOS 分支，测试必须变红 ===\n')

// ① 把 expandRoot 的平台分支拿掉 —— 这正是 2026-11-17 之前的老行为
trial('expandRoot 去掉 POSIX 分支（回到 D:\\ 硬编码）', {
  from: '    if (!IS_WINDOWS) return posixFallbackRoot()\n    return resolve(DEFAULT_CONFIG.root',
  to: '    return resolve(DEFAULT_CONFIG.root',
}, true)

// ② 让 listCandidateDrives 丢掉早退（POSIX 下会去试 D:\ 等盘符）
trial('listCandidateDrives 去掉非 Windows 早退', {
  from: 'function listCandidateDrives() {\n  if (!IS_WINDOWS) return []\n',
  to: 'function listCandidateDrives() {\n',
}, true)

// ③ 让 systemFallbackRoot 回到 ~/Documents（TCC + iCloud 风险）
trial('systemFallbackRoot 去掉 POSIX 分支', {
  from: '  if (!IS_WINDOWS) return posixFallbackRoot()\n  const home = homedir()',
  to: '  const home = homedir()',
}, true)

// ④ 让 posixFallbackRoot 落错地方（回到 Documents 下）
trial('posixFallbackRoot 改落 ~/Documents', {
  from: "  if (dshHome !== '') return join(dshHome, MEMORY_DIR_NAME)\n  return join(homedir(), '.dsh', MEMORY_DIR_NAME)",
  to: "  if (dshHome !== '') return join(homedir(), 'Documents', MEMORY_DIR_NAME)\n  return join(homedir(), 'Documents', MEMORY_DIR_NAME)",
}, true)

// ⑤ 破坏 Windows 分支 —— 必须也红（这条守「别改坏现有用户」）
trial('Windows 默认根改成 C 盘', {
  from: "join(`${PREFERRED_DRIVE}:\\\\`, MEMORY_DIR_NAME)",
  to: "join(`C:\\\\`, MEMORY_DIR_NAME)",
}, true)

// ⑥ 去掉「盘符路径 + 非 Windows」防护
//
// ⚠️ 2026-11-17：判据从黑名单（looksLikeWindowsDrivePath）改成了白名单
//    （非 Windows 时必须 isAbsolute 或以 ~ 开头）。所以锚点也跟着变了。
//    这里破坏的是「正向判据」本身 —— 让它恒为 true（= 永不拒绝）。
trial('去掉绝对路径正向判据（isPosixAcceptable 恒真）', {
  from: '  const isPosixAcceptable =\n    process.platform !== \'win32\'\n      ? isAbsolute(explicit) || explicit.startsWith(\'~\')',
  to: '  const isPosixAcceptable = true\n  const _unusedIsAbsolute =\n    process.platform !== \'win32\'\n      ? isAbsolute(explicit) || explicit.startsWith(\'~\')',
}, true)

const afterHash = sha(fs.readFileSync(INDEX, 'utf8'))
check('index.js 已逐字节还原', afterHash === originalHash, `期望 ${originalHash.slice(0, 12)} 实际 ${afterHash.slice(0, 12)}`)

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
