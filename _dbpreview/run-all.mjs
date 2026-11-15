/**
 * 全量回归 runner —— 一条命令跑完所有脚本，输出 FAIL=N 汇总行。
 *
 * ## 为什么单独抽出来（2026-11-15）
 *
 * 以前是每次手写一个 foreach 循环贴进 pwsh。问题：
 *   1. 变异测试需要用代码调用（execSync），不能依赖 PowerShell
 *   2. 手写循环容易漏脚本（我从 30 数到 31 时手动加过好几次）
 *   3. 汇总格式不一致，没法用正则稳定解析
 *
 * 现在脚本清单只有这一处定义。新增脚本加进 SCRIPTS 即可，
 * 文档里的清单也引用它（`docs/TESTING.md` 别再手抄一份）。
 *
 * ## 捕获输出必须走 runCaptured（2026-11-15 修）
 *
 * 受限沙箱（`workspace-write` / `read-only`）不允许程序开命名管道，
 * 而 `spawnSync(..., { encoding: 'utf8' })` 默认 `stdio: 'pipe'` →
 * 每个子进程都拿回 `EPERM`、`status = null`。
 *
 * 旧代码写的是 `const code = r.status ?? -1`，于是
 * **「一个都没跑起来」被算成「32 个全部失败」**，报出
 * `TOTAL=32 FAIL=32` —— 而同一时刻用 pwsh 循环跑是 32/32 全绿。
 * 那条假红会让下一个会话误判「插件全崩」，然后去修一个不存在的问题。
 *
 * 现在改用 `lib-spawn-capture.mjs`：先试管道，被拒就退回临时文件捕获。
 *
 * ## 三种结果必须分开，不能混
 *
 *   PASS    exit=0
 *   FAIL    真的跑了，且 exit≠0          ← 计入 `FAIL=`
 *   ERROR   压根没跑起来（status=null）  ← **不计入 FAIL**，但整体 exit≠0
 *
 * ERROR 不进 FAIL 计数是有意的：否则变异测试会把
 * 「runner 自己崩了」误读成「测试抓到了 bug」（假绿）。
 * exit≠0 且 FAIL=0 时，`meta-mutation-test.mjs` 会判 ERROR —— 那正是我们要的。
 *
 * 用法：
 *   node _dbpreview/run-all.mjs            # 跑全部
 *   node _dbpreview/run-all.mjs --verbose  # 打印每个脚本的 exit
 *   node _dbpreview/run-all.mjs --only a,b # 只跑指定
 *
 * 输出最后一行固定为：
 *   TOTAL=32 FAIL=2 scriptA,scriptB
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

// ---- 脚本清单（唯一真相）----
export const SCRIPTS = [
  'verify-functions',
  'verify-map',
  'verify-map-content',
  'selfcheck-full',
  'selfcheck-cap',
  'selfcheck-isolation',
  'selfcheck-paging',
  'selfcheck-marker-hardened',
  'selfcheck-dom-strip',
  'selfcheck-scrubber-loop',
  'selfcheck-collapse-guard',
  'selfcheck-ts-sort',
  'selfcheck-migrate-order',
  'selfcheck-migrate-db',
  'selfcheck-copytree-empty',
  'selfcheck-topic-clean',
  'selfcheck-injection-wording',
  'verify-injection-consistency',
  'selfcheck-pure-utils',
  'selfcheck-emotion-guard',
  'selfcheck-emotion-lexicon',
  'selfcheck-emotion-limiter',
  'selfcheck-entry-by-id',
  'selfcheck-archive',
  'selfcheck-breakdown',
  'selfcheck-dir-name',
  'verify-no-self-trigger',
  'verify-final',
  'verify-doc-links',
  'verify-v3-schema',
  'test-marker-forms',
  'selfcheck-search-tier',
  'selfcheck-scope-rename',
]

// ---- 参数 ----
const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const onlyIdx = argv.indexOf('--only')
const only = onlyIdx >= 0 && argv[onlyIdx + 1]
  ? new Set(argv[onlyIdx + 1].split(',').map((s) => s.trim()))
  : null

const list = only ? SCRIPTS.filter((s) => only.has(s)) : SCRIPTS

// ---- 逐个跑 ----
const failed = []   // 真的跑了且 exit≠0
const errored = []  // 压根没跑起来
const details = []
const captureModes = new Set()

for (const name of list) {
  const file = path.join(HERE, `${name}.mjs`)
  if (!fs.existsSync(file)) {
    errored.push(name)
    details.push({ name, kind: 'ERROR', note: `脚本不存在：${path.relative(REPO, file)}` })
    if (verbose) console.log(`  ?? ${name} 脚本不存在`)
    continue
  }

  const r = runCaptured([file], {
    cwd: REPO,
    timeout: 120000,
    env: { ...process.env, DSH_BASE: process.env.DSH_BASE || process.env.DSH_WEB_URL || '' },
  })
  captureModes.add(r.captureMode)

  const out = `${r.stdout || ''}${r.stderr || ''}`

  if (r.status === null) {
    // 连临时文件退路都失败了 —— 这是基础设施问题，不是测试结论
    errored.push(name)
    details.push({
      name,
      kind: 'ERROR',
      note: `无法启动：${r.error ? (r.error.code || '') + ' ' + r.error.message : '未知原因'}`.slice(0, 200),
    })
    continue
  }

  if (r.status !== 0) {
    failed.push(name)
    details.push({
      name,
      kind: 'FAIL',
      note: out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200),
    })
  } else if (verbose) {
    console.log(`  ✅ ${name}`)
  }
}

// ---- 汇总 ----
// 兼容既有解析：最后一行必须仍是 `TOTAL=n FAIL=k [names]`。
// ERROR 单独打印在它前面，且**不进 FAIL 计数**（见文件头说明）。
if (verbose) console.log('')
for (const d of details) {
  console.log(`  ${d.kind === 'FAIL' ? '❌' : '💥'} ${d.name} (${d.kind}) ${d.note}`)
}

if (errored.length > 0) {
  console.log('')
  console.log(`⚠️ ${errored.length} 个脚本没跑起来（ERROR，不是测试失败）—— 本次结果不可信`)
  console.log(`   ERROR=${errored.length} ${errored.join(',')}`)
}

if (failed.length > 0 || errored.length > 0) {
  // 只在真走临时文件退路时提示，避免每次都说一句噪音
  if (captureModes.has('file')) {
    console.log('   （输出经临时文件捕获：受限沙箱不允许命名管道，属正常降级）')
  }
}

console.log(`TOTAL=${list.length} FAIL=${failed.length}${failed.length ? ' ' + failed.join(',') : ''}`)

// ERROR 也要让整体失败：不能把「没测成」当成「通过」
process.exit(failed.length === 0 && errored.length === 0 ? 0 : 1)
