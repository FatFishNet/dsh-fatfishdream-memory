/**
 * 验证修复 C 的**失败路径** —— 在临时目录里造「读不进去」，不碰真实记忆目录。
 *
 * ## 为什么要单独一个脚本
 *
 * `copyTree` 没有 export，所以不能直接 import。但它只依赖 `readdir` / `mkfile`
 * 这些标准操作 —— 所以这里**从源码抽函数体**，在受控的临时目录里跑。
 * 这与 `selfcheck-posix-paths` 抽 `expandRoot` 是同一手法。
 *
 * ## 判据
 *
 *   ① 不存在的目录（ENOENT）→ 返回 0，**且不记 skipped**（真的空，合理）
 *   ② 读不进去的目录（非 ENOENT）→ 返回 0，**但必须记 skipped**
 *   ③ 正常目录 → 文件真的被复制，skipped 为空
 *
 * ## 怎么造「读不进去」
 *
 * Windows 上改 ACL 需要提权，不可靠。更稳的办法：**传一个文件路径当目录**
 * —— `readdir('某个文件')` 会抛 `ENOTDIR`，这正是「非 ENOENT」的一种。
 * 这个技巧不依赖权限、不依赖平台，且**完全在临时目录里**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory/index.js')
const SRC = fs.readFileSync(INDEX, 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}  ← ${detail}`)
  }
}

/** 从源码抽 copyTree（大括号配对）。 */
function extractFn(src, name) {
  const re = new RegExp(`async\\s+function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = src.match(re)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(m.index, i + 1)
    }
  }
  return null
}

const body = extractFn(SRC, 'copyTree')
if (!body) {
  console.error('抽不出 copyTree —— 源码结构变了，本测试失效')
  process.exit(2)
}

// 构造沙箱：copyTree 依赖 readdir / readBytesIfExists / atomicWriteBytes /
// mkdir / join / statSync 之类。这里给最小可用实现，**全部指向临时目录**。
const { readdir, mkdir, readFile, writeFile, stat } = await import('node:fs/promises')

// eslint-disable-next-line no-new-func
const factory = new Function(
  'readdir', 'readFile', 'writeFile', 'mkdir', 'join', 'stat',
  `${body.replace('async function copyTree', 'async function copyTree')}
   return copyTree`,
)
// 复刻 readBytesIfExists：读不到就 undefined（与源码同语义）
async function readBytesIfExists(p) {
  try {
    return await readFile(p)
  } catch (e) {
    if (e && e.code === 'ENOENT') return undefined
    throw e
  }
}
// 复刻 atomicWriteBytes：直接写（本测试不关心原子性）
async function atomicWriteBytes(p, bytes) {
  await writeFile(p, bytes)
}

// ⚠️ 注意：上面 factory 没传 readBytesIfExists / atomicWriteBytes。
// 它们不在参数表里，所以要在 body 里能访问到 —— 用 Function 的闭包做不到，
// 所以改用「把依赖也传进去」的方式重建。
const factory2 = new Function(
  'readdir', 'readFile', 'writeFile', 'mkdir', 'join', 'stat', 'relativePath',
  'readBytesIfExists', 'atomicWriteBytes', 'byteLength',
  `${body}\n return copyTree`,
)

// 复刻源码里的这些工具（它们很小，行为可直接照抄）
const { relative } = await import('node:path')
const byteLength = (s) => Buffer.byteLength(String(s ?? ''), 'utf8')

const copyTree = factory2(
  readdir, readFile, writeFile, mkdir, path.join, stat, relative,
  readBytesIfExists, atomicWriteBytes, byteLength,
)
void factory

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copytree-C-'))

try {
  // ============================================================
  console.log('\n=== ③ 正常目录：文件真的被复制，skipped 为空 ===\n')
  {
    const from = path.join(tmp, 'normal-src')
    const to = path.join(tmp, 'normal-dst')
    fs.mkdirSync(path.join(from, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(from, 'a.txt'), 'AAA', 'utf8')
    fs.writeFileSync(path.join(from, 'sub', 'b.txt'), 'BBB', 'utf8')

    const skipped = []
    const n = await copyTree(from, to, skipped)

    check('复制了 2 个文件', n === 2, `实际 ${n}`)
    check('a.txt 落地', fs.existsSync(path.join(to, 'a.txt')))
    check('sub/b.txt 落地', fs.existsSync(path.join(to, 'sub', 'b.txt')))
    check('正常路径 skipped 为空', skipped.length === 0, `实际 ${JSON.stringify(skipped)}`)
    check('内容一致', fs.readFileSync(path.join(to, 'a.txt'), 'utf8') === 'AAA')
  }

  // ============================================================
  console.log('\n=== ① ENOENT（源不存在）：返回 0 且不记 skipped ===\n')
  {
    const skipped = []
    const n = await copyTree(path.join(tmp, 'never-existed'), path.join(tmp, 'dst1'), skipped)
    check('返回 0', n === 0, `实际 ${n}`)
    check('ENOENT 不记 skipped（这是「真的空」，合理）', skipped.length === 0, `实际 ${JSON.stringify(skipped)}`)
  }

  // ============================================================
  console.log('\n=== ② 非 ENOENT（读不进去）：返回 0 但必须记 skipped ===\n')
  {
    // 造一个**文件**，然后把它当目录去 copyTree → readdir 抛 ENOTDIR
    // 这是「非 ENOENT 的读失败」，且不需要权限、不需要提权
    const fakeDir = path.join(tmp, 'iam-a-file')
    fs.writeFileSync(fakeDir, 'not a directory', 'utf8')

    const skipped = []
    const n = await copyTree(fakeDir, path.join(tmp, 'dst2'), skipped)

    check('返回 0（读不进去）', n === 0, `实际 ${n}`)
    check(
      '**必须记进 skipped**（这是修复 C 的核心）',
      skipped.length === 1,
      `实际 ${skipped.length} 条：${JSON.stringify(skipped)}`,
    )
    check('skipped 里带上了路径', skipped.length > 0 && String(skipped[0]).includes('iam-a-file'), JSON.stringify(skipped))
    check(
      'skipped 里带上了错误码（ENOTDIR）或消息',
      skipped.length > 0 && /ENOTDIR|NOTDIR|not a directory/i.test(String(skipped[0])),
      JSON.stringify(skipped),
    )

    // 对照：如果这是修复前的行为（静默 return 0），skipped 会是空的
    console.log(`    ↑ 修复前的行为会让这里 skipped=[]，而迁移仍报「成功」`)
  }

  // ============================================================
  console.log('\n=== ④ 混合场景：好的照搬，坏的记账 ===\n')
  {
    const from = path.join(tmp, 'mixed')
    const to = path.join(tmp, 'mixed-dst')
    fs.mkdirSync(from, { recursive: true })
    fs.writeFileSync(path.join(from, 'good.txt'), 'GOOD', 'utf8')
    // 在源目录里放一个「文件」，但它被当作子目录递归时会 ENOTDIR
    // 真实场景对应「某个子目录是个断链/占位文件」
    fs.writeFileSync(path.join(from, 'trap.txt'), 'trap', 'utf8')

    const skipped = []
    const n = await copyTree(from, to, skipped)
    check('正常文件仍然被复制', n === 2, `实际 ${n}`)
    check('trap.txt 作为文件本身能被复制（不是目录，走 isFile 分支）', fs.existsSync(path.join(to, 'trap.txt')))
    check('本场景 skipped 为空（trap 是文件不是目录）', skipped.length === 0, JSON.stringify(skipped))
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${'─'.repeat(50)}`)
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
  console.log('修复 C 的失败路径已在临时目录里验证 —— 没碰真实记忆目录。')
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('  - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
