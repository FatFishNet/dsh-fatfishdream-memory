/**
 * 一次性修复：把 _dbpreview 脚本里写死的记忆根路径改成「跟随指针文件」。
 *
 * 为什么必须修（2026-11-13）：
 * 用户把记忆根从 D:\FatFishDream-memory 迁到 D:\dsh-fatfishdream-memory 后，
 * 17 个脚本共 23 处硬编码路径全部失效 —— 4 个回归脚本直接崩。
 *
 * 治本做法：不再写死，改为读 ~/.dsh/memory-root.json（插件自己也在用它），
 * 读不到再退回默认值。这样以后无论怎么迁移，脚本都不用改。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 统一的解析片段（会插到每个改动的脚本顶部） */
const RESOLVER = `// 记忆根目录从指针文件读，不要写死 —— 迁移根目录后脚本会全崩。
// 指针由插件自己维护（~/.dsh/memory-root.json）。
const resolveMemoryRoot = () => {
  const cands = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'memory-root.json'),
  ]
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\\uFEFF/, ''))
      if (j && typeof j.root === 'string' && j.root !== '') return j.root
    } catch {
      /* 下一个候选 */
    }
  }
  return 'D:\\\\dsh-fatfishdream-memory'
}
const MEM_ROOT = resolveMemoryRoot().replace(/\\\\/g, '/')`

const OLD_ROOTS = ['D:/FatFishDream-memory', 'D:\\FatFishDream-memory']

let touched = 0
let replaced = 0
const report = []

for (const f of fs.readdirSync(HERE)) {
  if (!f.endsWith('.mjs')) continue
  if (f === path.basename(fileURLToPath(import.meta.url))) continue
  const full = path.join(HERE, f)
  let text = fs.readFileSync(full, 'utf8')
  const before = text
  let n = 0

  // 1) 字符串字面量里的 'D:/FatFishDream-memory/memory.db' 之类 → 模板串
  for (const old of OLD_ROOTS) {
    const esc = old.replace(/\\/g, '\\\\')
    // 'D:/FatFishDream-memory/xxx'  →  `${MEM_ROOT}/xxx`
    const re1 = new RegExp(`'${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[^']*)'`, 'g')
    text = text.replace(re1, (_m, rest) => {
      n++
      return '`${MEM_ROOT}' + rest + '`'
    })
    // "D:/FatFishDream-memory/xxx" → `${MEM_ROOT}/xxx`
    const re2 = new RegExp(`"${esc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/[^"]*)"`, 'g')
    text = text.replace(re2, (_m, rest) => {
      n++
      return '`${MEM_ROOT}' + rest + '`'
    })
  }

  if (text === before) continue

  // 2) 确保脚本里能用 fs / path（漏了才补，避免重复 import）
  const needsFs = !/import\s+fs\s+from\s+['"]node:fs['"]/.test(text)
  const needsPath = !/import\s+path\s+from\s+['"]node:path['"]/.test(text)
  if (needsFs || needsPath) {
    const inject = `${needsFs ? "import fs from 'node:fs'\n" : ''}${needsPath ? "import path from 'node:path'\n" : ''}`
    // 插到第一个 import 之后（没有 import 就插到文件头注释后）
    const firstImport = text.search(/^import\s/m)
    if (firstImport >= 0) {
      const eol = text.indexOf('\n', firstImport)
      text = text.slice(0, eol + 1) + inject + text.slice(eol + 1)
    } else {
      text = inject + text
    }
  }

  // 3) 在 import 区之后插入 resolver（只插一次）
  if (!text.includes('const MEM_ROOT = resolveMemoryRoot()')) {
    const lastImport = [...text.matchAll(/^import\s.*$/gm)].pop()
    const at = lastImport ? lastImport.index + lastImport[0].length : 0
    text = text.slice(0, at) + '\n\n' + RESOLVER + text.slice(at)
  }

  fs.writeFileSync(full, text, 'utf8')
  touched++
  replaced += n
  report.push(`  ${f.padEnd(34)} ${n} 处`)
}

console.log(`=== 修复结果：${touched} 个文件，共 ${replaced} 处 ===\n`)
for (const r of report) console.log(r)
