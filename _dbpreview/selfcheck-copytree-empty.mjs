/**
 * 回归测试：copyTree 不应该为空目录创建空壳。
 *
 * 现场（2026-11-13）：用户迁移后新根里凭空多出 5 个空文件夹
 * （干杂活 / design / ForzaOverlay / dsh-skill-switch-main / dsh-fatfishdream-memory）。
 *
 * 根因：copyTree 一进来就 `mkdir(to)`，空目录于是被复制成空壳。
 * 数据库模式下项目目录早已没有文件（数据全在 memory.db 里），
 * 但迁移仍会为每个项目调一次 copyTree → 每个项目一个空文件夹。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

const TMP = path.join(os.tmpdir(), `copytree-${Date.now()}`)
fs.mkdirSync(TMP, { recursive: true })

/** 与 index.js 的 copyTree 相同实现（含 2026-11-13 修复） */
async function copyTree(from, to) {
  let entries
  try {
    entries = await fs.promises.readdir(from, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) {
      count += await copyTree(source, target)
    } else if (entry.isFile()) {
      const text = await fs.promises.readFile(source, 'utf8')
      await fs.promises.mkdir(to, { recursive: true })
      await fs.promises.writeFile(target, text, 'utf8')
      count += 1
    }
  }
  return count
}

console.log('=== 1. 空目录不应产生目标目录 ===\n')
const emptySrc = path.join(TMP, 'src-empty')
fs.mkdirSync(emptySrc, { recursive: true })
const emptyDst = path.join(TMP, 'dst-empty')
const n0 = await copyTree(emptySrc, emptyDst)
console.log(`  复制空目录返回 ${n0} 个文件`)
check('返回 0', n0 === 0)
check('目标目录未被创建（关键）', !fs.existsSync(emptyDst), emptyDst)

console.log('\n=== 2. 有文件的目录正常复制 ===\n')
const fullSrc = path.join(TMP, 'src-full')
fs.mkdirSync(fullSrc, { recursive: true })
fs.writeFileSync(path.join(fullSrc, 'a.txt'), 'AAA', 'utf8')
fs.mkdirSync(path.join(fullSrc, 'sub'), { recursive: true })
fs.writeFileSync(path.join(fullSrc, 'sub', 'b.txt'), 'BBB', 'utf8')
const fullDst = path.join(TMP, 'dst-full')
const n1 = await copyTree(fullSrc, fullDst)
console.log(`  复制 2 个文件，返回 ${n1}`)
check('返回 2', n1 === 2, String(n1))
check('a.txt 已复制', fs.existsSync(path.join(fullDst, 'a.txt')))
check('sub/b.txt 已复制', fs.existsSync(path.join(fullDst, 'sub', 'b.txt')))
check('内容正确', fs.readFileSync(path.join(fullDst, 'a.txt'), 'utf8') === 'AAA')

console.log('\n=== 3. 混合：空子目录不应被创建 ===\n')
const mixSrc = path.join(TMP, 'src-mix')
fs.mkdirSync(path.join(mixSrc, 'has-files'), { recursive: true })
fs.mkdirSync(path.join(mixSrc, 'empty-one'), { recursive: true })
fs.mkdirSync(path.join(mixSrc, 'empty-nested', 'deep'), { recursive: true })
fs.writeFileSync(path.join(mixSrc, 'has-files', 'x.txt'), 'X', 'utf8')
const mixDst = path.join(TMP, 'dst-mix')
const n2 = await copyTree(mixSrc, mixDst)
console.log(`  返回 ${n2} 个文件`)
check('返回 1', n2 === 1, String(n2))
check('has-files 被创建', fs.existsSync(path.join(mixDst, 'has-files')))
check('empty-one 未被创建', !fs.existsSync(path.join(mixDst, 'empty-one')), '不应存在')
check('empty-nested 未被创建', !fs.existsSync(path.join(mixDst, 'empty-nested')), '不应存在')

console.log('\n=== 4. 源目录不存在时安全返回 ===\n')
const n3 = await copyTree(path.join(TMP, 'nope'), path.join(TMP, 'dst-nope'))
check('返回 0 且不抛错', n3 === 0)
check('目标未被创建', !fs.existsSync(path.join(TMP, 'dst-nope')))

console.log('\n=== 5. 复刻真实场景：模拟迁移 ===\n')
// 模拟：根里有 memory.db、policy.md、logs/，以及 5 个空项目目录
const simRoot = path.join(TMP, 'sim-root')
fs.mkdirSync(simRoot, { recursive: true })
fs.writeFileSync(path.join(simRoot, 'policy.md'), '# policy', 'utf8')
fs.mkdirSync(path.join(simRoot, 'logs'), { recursive: true })
fs.writeFileSync(path.join(simRoot, 'logs', '2026-11-13.log'), 'log line', 'utf8')
for (const p of ['干杂活', 'design', 'ForzaOverlay', 'dsh-skill-switch-main', 'proj-x']) {
  fs.mkdirSync(path.join(simRoot, p), { recursive: true }) // 全是空目录
}

const simDst = path.join(TMP, 'sim-dst')
fs.mkdirSync(simDst, { recursive: true })
// 复刻迁移：只搬 policy + logs + 各项目目录
await copyTree(path.join(simRoot, 'logs'), path.join(simDst, 'logs'))
for (const p of ['干杂活', 'design', 'ForzaOverlay', 'dsh-skill-switch-main', 'proj-x']) {
  await copyTree(path.join(simRoot, p), path.join(simDst, p))
}

const dstEntries = fs.readdirSync(simDst)
console.log(`  目标目录内容: ${dstEntries.join(', ') || '(空)'}`)
check('只应有 logs', dstEntries.length === 1 && dstEntries[0] === 'logs', dstEntries.join(','))
check('5 个空项目目录都没被创建', !['干杂活', 'design', 'ForzaOverlay', 'dsh-skill-switch-main', 'proj-x'].some((p) => fs.existsSync(path.join(simDst, p))))

console.log('\n=== 清理 ===\n')
try {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  console.log('  临时目录已删除')
} catch {
  console.log('  ⚠️ 残留不影响结论')
}

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
