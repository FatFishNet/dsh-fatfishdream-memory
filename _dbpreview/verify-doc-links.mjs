/**
 * 核对文档里引用的文件路径是否真实存在 —— 防止开源后断链。
 *
 * 只查「仓库内相对路径」，跳过 HTTP、绝对路径、代码块里的注释性引用。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 从脚本自身位置推仓库根，别写死绝对路径（2026-11-13 工作区改名踩过）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DOCS = [
  'README.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'docs/项目地图.md',
  'docs/维护手册.md',
  'docs/TESTING.md',
  'docs/DECISIONS.md',
  'docs/TODO.md',
  // 包内文档（2026-11-14 重写）：随 npm 分发，所以**链接只能指向包内文件**，
  // 不能引用 docs/ —— 那个目录不在 package.json 的 files 里，装了看不到。
  'dsh-fatfishdream-memory/README.md',
  'dsh-fatfishdream-memory/STORAGE.md',
]

/** 从 markdown 里抽反引号路径与 markdown 链接目标 */
function extractRefs(text) {
  const refs = new Set()

  // 1. 反引号里的仓库相对路径：`_dbpreview/xxx.mjs`、`docs/xxx.md`、`dsh-fatfishdream-memory/xxx.js`
  for (const m of text.matchAll(/`([A-Za-z0-9_.\-\/]+\.(?:mjs|js|md|json|yml|yaml|svg|db))`/g)) {
    refs.add(m[1])
  }

  // 2. markdown 链接 [text](path) —— 只取仓库相对路径
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const target = m[1].split('#')[0].trim()
    if (target === '') continue
    if (/^(https?:|mailto:|data:)/.test(target)) continue
    refs.add(target)
  }

  return [...refs]
}

/** 判断这个引用是否「应该存在于仓库里」 */
function shouldCheck(ref) {
  if (/^(https?:|mailto:|data:|\/|[A-Za-z]:)/.test(ref)) return false
  if (ref.startsWith('#')) return false
  // 只查带明确目录前缀的引用。
  // 不查裸文件名（`index.js`、`facts.md` 这类）—— 文档正文里常拿它当
  // 「某个文件」的口语指代，真身可能在 dsh-fatfishdream-memory/ 下或根本是已归档的概念，
  // 一律当断链会产生大量误报（2026-11-13 实测 27 处全是误报）。
  const prefixes = ['docs/', 'dsh-fatfishdream-memory/', '_dbpreview/', '_archive/', 'locale/']
  return prefixes.some((p) => ref.startsWith(p))
}

let checked = 0
let missing = []

for (const doc of DOCS) {
  const docPath = path.join(ROOT, doc)
  if (!fs.existsSync(docPath)) {
    console.log(`⚠️  文档本身不存在: ${doc}`)
    continue
  }
  const text = fs.readFileSync(docPath, 'utf8')
  const docDir = path.dirname(docPath)

  for (const ref of extractRefs(text)) {
    if (!shouldCheck(ref)) continue
    checked++
    // 引用可能是相对文档所在目录，也可能相对仓库根
    const a = path.resolve(docDir, ref)
    const b = path.resolve(ROOT, ref)
    if (!fs.existsSync(a) && !fs.existsSync(b)) {
      missing.push({ doc, ref })
    }
  }
}

console.log(`\n共核对 ${checked} 处引用`)
if (missing.length === 0) {
  console.log('✅ 全部存在，无断链')
} else {
  console.log(`❌ ${missing.length} 处断链：\n`)
  for (const m of missing) console.log(`  ${m.doc}  →  ${m.ref}`)
}

process.exit(missing.length === 0 ? 0 : 1)
