/**
 * macOS（POSIX）路径行为回归 —— 在 Windows 上模拟验证。
 *
 * ## 为什么需要它
 *
 * 插件原有选址逻辑全部假设 Windows 盘符体系。在 macOS 上**不会崩**，
 * 但会静默走到错误位置 —— 这种 bug 比崩溃更难发现：
 *
 *   - 崩溃：用户立刻知道，会报上来；
 *   - 静默：记忆写进了工作区，用户以为「记忆丢了」，
 *           而实际是**建到了仓库里**，还违反硬约束 11b（安全边界）。
 *
 * ## 为什么能在 Windows 上测 POSIX 行为
 *
 * 被测的是**纯函数**（`expandRoot` / `listCandidateDrives` / `systemFallbackRoot`），
 * 它们的平台分支只读 `process.platform`。所以从源码抽出函数体、注入
 * 一个假的 `platform` 与假的 `join/resolve/homedir`，就能在 Windows 上
 * 精确复现 POSIX 语义 —— 不需要真 Mac。
 *
 * ⚠️ 但这**不等于**在真 Mac 上验证过。本脚本证明的是「平台分支逻辑对」，
 *    不是「macOS 上端到端跑通了」（文件权限、APFS、TCC 都不在内）。
 *    所以对外说法只能是「已调整，未实机验证」。
 *
 * ## 判据（每条都必须能变红）
 *
 *   ① POSIX 下 `expandRoot('')` 不得产出含 `D:\` 的路径
 *   ② 且必须是**绝对路径**（否则会被建进工作区）
 *   ③ 且落点必须与工作区无关
 *   ④ POSIX 下 `listCandidateDrives()` 返回空数组（不做 23 次无效 statSync）
 *   ⑤ POSIX 下 `systemFallbackRoot()` 落 `~/.dsh`（不是 `~/Documents`）
 *   ⑥ Windows 行为必须**完全不变**（防止改坏现有用户）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { posix } from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory/index.js')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
  } else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}  ← ${detail}`)
  }
}

const SRC = fs.readFileSync(INDEX, 'utf8')

/**
 * 从源码里抽出指定函数的定义文本。
 * 用大括号配对找到函数体结束 —— 比正则可靠（函数体里有嵌套花括号）。
 */
function extractFunction(name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = SRC.match(re)
  if (!m) return null
  const start = m.index + m[0].length - 1 // 指向 '{'
  let depth = 0
  for (let i = start; i < SRC.length; i++) {
    const ch = SRC[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return SRC.slice(m.index, i + 1)
    }
  }
  return null
}

/**
 * 在一个可控的假环境里求值这些函数。
 * @param {boolean} isPosix  true = 模拟 macOS/Linux
 */
function buildEnv(isPosix) {
  const MEMORY_DIR_NAME = 'dsh-fatfishdream-memory'
  const PREFERRED_DRIVE = 'D'

  // POSIX 用 path.posix，Windows 用 path.win32 —— 这样 resolve/join 语义才对
  const P = isPosix ? posix : path.win32

  const fakeHome = isPosix ? '/Users/zc' : 'C:\\Users\\ZC'
  const fakeDshHome = isPosix ? '/Users/zc/.dsh' : 'C:\\Users\\ZC\\.dsh'

  const fnNames = ['systemDriveLetter', 'isSystemDriveTarget', 'posixFallbackRoot', 'expandRoot', 'listCandidateDrives', 'systemFallbackRoot']
  const bodies = []
  for (const n of fnNames) {
    const body = extractFunction(n)
    if (!body) {
      console.log(`  ⚠️ 无法从源码抽出函数 ${n}（已跳过该函数相关断言）`)
      continue
    }
    bodies.push(body)
  }

  const sandbox = {
    MEMORY_DIR_NAME,
    PREFERRED_DRIVE,
    IS_WINDOWS: !isPosix,
    // expandRoot 的 Windows 分支会读它（配置里没写 root 时为 undefined →
    // 走 `D:\<名称>` 兜底，这正是我们要断言的默认行为）
    DEFAULT_CONFIG: { root: undefined },
    process: { platform: isPosix ? 'darwin' : 'win32', env: isPosix ? { DSH_HOME: fakeDshHome } : { SystemDrive: 'C:' } },
    join: P.join,
    resolve: P.resolve,
    homedir: () => fakeHome,
    statSync: () => ({ isDirectory: () => false }), // 所有盘都不存在
    statfsSync: () => ({ bavail: 0, bsize: 0 }),
  }

  const code = `${bodies.join('\n')}\nreturn { ${fnNames.join(', ')} }`
  // eslint-disable-next-line no-new-func
  const factory = new Function(...Object.keys(sandbox), code)
  return factory(...Object.values(sandbox))
}

console.log('=== 1. POSIX（macOS）分支：记忆不能落进工作区 ===\n')

const posixEnv = buildEnv(true)
const posixDefault = posixEnv.expandRoot('')

check('POSIX expandRoot("") 不是 undefined', typeof posixDefault === 'string' && posixDefault.length > 0)
check(
  'POSIX expandRoot("") 不含反斜杠盘符（否则会被当相对路径）',
  !/^[A-Za-z]:[\\/]/.test(posixDefault) && !posixDefault.includes('D:\\'),
  `实际 = ${posixDefault}`,
)
check('POSIX expandRoot("") 是绝对路径', posixDefault.startsWith('/'), `实际 = ${posixDefault}`)
check(
  'POSIX expandRoot("") 落在 ~/.dsh 下（与指针同处）',
  posixDefault.startsWith('/Users/zc/.dsh/'),
  `实际 = ${posixDefault}`,
)
check(
  'POSIX 默认落点与当前工作目录无关',
  !posixDefault.includes(process.cwd()) && !posixDefault.includes(REPO),
  `实际 = ${posixDefault}`,
)

console.log('\n=== 2. POSIX 分支：不做无效盘符探测 ===\n')
const posixDrives = posixEnv.listCandidateDrives()
check('POSIX listCandidateDrives() 返回空数组', Array.isArray(posixDrives) && posixDrives.length === 0, `实际 = ${JSON.stringify(posixDrives)}`)

check(
  'POSIX systemFallbackRoot() 落 ~/.dsh（不是 ~/Documents）',
  posixEnv.systemFallbackRoot().startsWith('/Users/zc/.dsh/'),
  `实际 = ${posixEnv.systemFallbackRoot()}`,
)
check(
  'POSIX systemFallbackRoot() 不含 Documents（避开 TCC / iCloud）',
  !posixEnv.systemFallbackRoot().includes('Documents'),
  `实际 = ${posixEnv.systemFallbackRoot()}`,
)
check(
  'POSIX 一切路径都算「系统盘」→ 警告能触发',
  posixEnv.isSystemDriveTarget('/anything') === true,
)

console.log('\n=== 3. Windows 分支必须完全不变（防改坏现有用户）===\n')
const winEnv = buildEnv(false)
const winDefault = winEnv.expandRoot('')
check(
  'Windows expandRoot("") 仍是 D:\\dsh-fatfishdream-memory',
  winDefault === 'D:\\dsh-fatfishdream-memory',
  `实际 = ${winDefault}`,
)
check('Windows systemFallbackRoot() 不含 .dsh（仍是 Documents 兜底）', !winEnv.systemFallbackRoot().includes('\\.dsh\\'), `实际 = ${winEnv.systemFallbackRoot()}`)
check('Windows isSystemDriveTarget("C:\\x") === true', winEnv.isSystemDriveTarget('C:\\x') === true)
check('Windows isSystemDriveTarget("D:\\x") === false', winEnv.isSystemDriveTarget('D:\\x') === false)

console.log('\n=== 4. 盘符路径防护：配置写 D:\\ 但跑在 POSIX 上 ===\n')
// ⚠️ 这条必须**行为级**验证，不能只查源码里有没有 `looksLikeWindowsDrivePath`。
//   第一版就是只查源码 —— 把防护改成 `= false` 之后它照样绿（故障注入抓出来的）。
//   这类「常量改名了、逻辑没了」的退化，只有真跑一遍才看得见。
{
  // 把 resolveRoot 也抽出来跑。它依赖 writePointer / readPointer / log，
  // 这里给最小假实现：writePointer 记录调用、readPointer 返回 undefined、
  // syncPathExists 恒 false（避免命中任何老安装）。
  const resolveBody = extractFunction('resolveRoot')
  if (!resolveBody) {
    console.log('  （本段不适用：抽不出 resolveRoot 函数体）')
  } else {
    const written = []
    const logs = []
    const P = posix
    const sandbox = {
      MEMORY_DIR_NAME: 'dsh-fatfishdream-memory',
      PREFERRED_DRIVE: 'D',
      IS_WINDOWS: false,
      DEFAULT_CONFIG: { root: undefined },
      // ⚠️ 2026-11-17：resolveRoot 已改用「正向判据」——
      //   非 Windows 时要求 `isAbsolute(explicit) || startsWith('~')`，
      //   不再用 `looksLikeWindowsDrivePath` 黑名单。假环境必须提供 isAbsolute。
      isAbsolute: posix.isAbsolute,
      process: { platform: 'darwin', env: { DSH_HOME: '/Users/zc/.dsh' } },
      join: P.join,
      resolve: P.resolve,
      homedir: () => '/Users/zc',
      statSync: () => ({ isDirectory: () => false }),
      statfsSync: () => ({ bavail: 0, bsize: 0 }),
      writePointer: (p) => written.push(p),
      readPointer: () => undefined,
      syncPathExists: () => false,
      systemDriveLetter: posixEnv.systemDriveLetter,
      isSystemDriveTarget: posixEnv.isSystemDriveTarget,
      posixFallbackRoot: posixEnv.posixFallbackRoot,
      expandRoot: posixEnv.expandRoot,
      listCandidateDrives: posixEnv.listCandidateDrives,
      systemFallbackRoot: posixEnv.systemFallbackRoot,
    }
    // eslint-disable-next-line no-new-func
    const resolveRoot = new Function(...Object.keys(sandbox), `${resolveBody}\nreturn resolveRoot`)(...Object.values(sandbox))

    const result = resolveRoot('D:\\dsh-fatfishdream-memory', (m) => logs.push(m))

    check(
      '配置是 D:\\ 路径 + POSIX 系统 → 不采用该路径',
      result.root !== 'D:\\dsh-fatfishdream-memory' && !/^[A-Za-z]:[\\/]/.test(result.root),
      `实际 root = ${result.root}`,
    )
    check(
      '配置是 D:\\ 路径 + POSIX 系统 → 落点是绝对 POSIX 路径',
      typeof result.root === 'string' && result.root.startsWith('/'),
      `实际 root = ${result.root}`,
    )
    check(
      '配置是 D:\\ 路径 + POSIX 系统 → 打了警告',
      logs.some((l) => l.includes('盘符路径') || l.includes('不是 Windows')),
      `实际日志 = ${JSON.stringify(logs)}`,
    )
    check(
      '不静默返回 configured（那样会把记忆建进工作区）',
      result.reason !== 'configured',
      `实际 reason = ${result.reason}`,
    )
  }
}

console.log('\n=== 5. 源码事实：四处平台判断都在 ===\n')
check('源码含 IS_WINDOWS 常量定义', /const IS_WINDOWS = process\.platform === 'win32'/.test(SRC))
check('expandRoot 有非 Windows 分支', /if \(!IS_WINDOWS\) return posixFallbackRoot\(\)/.test(SRC))
check('listCandidateDrives 有非 Windows 早退', /function listCandidateDrives\(\) \{\s*\n\s*if \(!IS_WINDOWS\) return \[\]/.test(SRC))
check('systemFallbackRoot 有非 Windows 早退', /if \(!IS_WINDOWS\) return posixFallbackRoot\(\)/.test(SRC))
// ⚠️ 2026-11-17：判据从「黑名单盘符正则」换成「白名单绝对路径判据」了。
//    这里锁的是**新判据**存在，旧名字已不存在。
check('resolveRoot 有「POSIX 绝对路径」正向判据', /const isPosixAcceptable =/.test(SRC))
check('resolveRoot 的拒绝分支在（rejectOnPosix）', /const rejectOnPosix =/.test(SRC))
check('resolveRoot 的系统盘候选按平台分叉', /const systemCandidates = IS_WINDOWS/.test(SRC))

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
