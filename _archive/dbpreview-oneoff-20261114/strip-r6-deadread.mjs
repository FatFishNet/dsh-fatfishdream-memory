/**
 * 最后一轮清扫：删除 factsTextSync / projectTextSync。
 *
 * 依据：唯一调用者 renderFromFiles 已在第 3 轮删除，导出表里也没有它们，
 *       现在它们是**零调用**的死代码。
 *
 * ⚠️ 但它们依赖的辅助函数不能一起删 —— 已核实仍有使用者：
 *   - readCached        → policyTextSync / readStateSync 等
 *   - activeLines       → policyTextSync / measureInjection / overview
 *   - splitMemoryLines  → overview（统计 emotion 条数）
 *   - projectMemoryPath → registerProject / migrateRoot / overview
 * 所以只删这两个函数体本身。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const BLOCK = `  function factsTextSync(maxBytes) {
    const { facts } = splitMemoryLines(activeLines(readCached(paths.facts)))
    if (facts.length === 0) return { text: '', truncated: false }
    return truncateBytes(facts.join('\\n'), maxBytes)
  }

  function projectTextSync(key, state, maxBytes) {
    if (!isSafeSlug(key)) return { text: '', truncated: false }
    const lines = activeLines(readCached(projectMemoryPath(key, state)))
    if (lines.length === 0) return { text: '', truncated: false }
    return truncateBytes(lines.join('\\n'), maxBytes)
  }

`

const n = text.split(BLOCK).length - 1
if (n !== 1) {
  console.log(`❌ 期望 1 次，实际 ${n} 次，中止`)
  process.exit(1)
}
console.log(`将删除 ${BLOCK.split('\n').length} 行 / ${Buffer.byteLength(BLOCK, 'utf8')} 字节`)
text = text.split(BLOCK).join('')

// 导出表里的两条
for (const line of ['    factsTextSync,\n', '    projectTextSync,\n']) {
  const c = text.split(line).length - 1
  if (c !== 1) {
    console.log(`❌ 导出项 ${JSON.stringify(line.trim())} 期望 1 次，实际 ${c} 次，中止`)
    process.exit(1)
  }
  text = text.split(line).join('')
  console.log(`✅ 移除导出 ${line.trim()}`)
}

fs.writeFileSync(FILE, text, 'utf8')
console.log('已写入')
