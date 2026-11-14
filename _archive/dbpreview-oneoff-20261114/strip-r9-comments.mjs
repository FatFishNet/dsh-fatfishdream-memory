/**
 * 第 9 轮收尾：把所有 .md 记忆相关的注释与文案清理干净。
 * 只留 policy.md。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const EDITS = [
  // ── 文件头注释
  [
    ` * ⚠️ 不再生成 facts.md / PROJECT.md / log/*.md。
 *    那几个文件属于 SQLite 之前的存储方式，代码里的 createStore 保留着读取它们
 *    的能力仅为兜底，正常运行时**一个都不会创建**。判断某文件能否删的唯一标准
 *    是「代码里还有没有路径指向它且会写入」。`,
    ` * ⚠️ 除 policy.md 外，运行时**不创建、不读取任何 .md 文件**。
 *    旧的文件式记忆（facts.md / PROJECT.md / log/*.md）的读写代码已于 2026-11-13 全部移除。`,
    1,
  ],
  // ── 盘符探测：探测判据
  [
    ` *      降序探测，第一个含 state.json 或 facts.md 的胜出。`,
    ` *      降序探测，第一个含 state.json 或 memory.db 的胜出。`,
    1,
  ],
  // ── 三处探测判据（代码）
  [
    `if (syncPathExists(join(candidate, 'state.json')) || syncPathExists(join(candidate, 'facts.md'))) {`,
    `if (syncPathExists(join(candidate, 'state.json')) || syncPathExists(join(candidate, 'memory.db'))) {`,
    3,
  ],
  // ── U+FFFD 注释
  [
    ` * \`toString('utf8')\` 会把它变成 U+FFFD（\`\ufffd\`），写进 facts.md 就是乱码。`,
    ` * \`toString('utf8')\` 会把它变成 U+FFFD（\`\ufffd\`），写进记忆文件就是乱码。`,
    1,
  ],
  // ── 情绪分析的正则排除列表：把旧文件名换成当前存在的
  [
    `  'AGENTS.md', 'policy.md', 'PROJECT.md', 'facts.md', '标记', '注释',`,
    `  'AGENTS.md', 'policy.md', 'README.md', 'STORAGE.md', '标记', '注释',`,
    1,
  ],
  // ── facts.md 误判的注释
  [
    `  // 2026-11-11 实测误判：用户把 facts.md 里的几行贴出来讨论`,
    `  // 2026-11-11 实测误判：用户把记忆里的几行贴出来讨论`,
    1,
  ],
  // ── paths.facts 这个路径字段：彻底删除
  [
    `    facts: join(root, 'facts.md'),\n`,
    ``,
    1,
  ],
  // ── projectMemoryPath 辅助函数：已无调用者
  [
    `  const projectMemoryPath = (key, state) => join(projectDir(key, state), 'PROJECT.md')\n`,
    ``,
    1,
  ],
  // ── ensureLayout 上方的长注释
  [
    `   * 2026-11-13 起 \`facts.md\` 只在**文件模式**下创建：
   * 数据库模式下全局结论读的是 profile + 全局 rules，facts.md 无人读、
   * 也无人写 —— 再生成它只会让记忆根目录留一个 104 字节的空壳，
   * 让用户以为还有一份文件在参与工作。`,
    `   * 现在只预建 \`policy.md\`（行为规则，不进数据库）。
   * 别的记忆全部存在 memory.db 里，由数据库层自己创建。`,
    1,
  ],
  // ── 注入段文案（文件模式分支，现在不会执行到，但保持一致）
  [
    `          '\`<!--mem-note\` 内容 \`-->\` → 本项目 PROJECT.md',`,
    `          '\`<!--mem-note\` 内容 \`-->\` → 本项目项目规则（rules 表）',`,
    1,
  ],
  [
    `          '\`<!--mem-fact\` 内容 \`-->\` → 全局 facts.md（只装「关于用户本人」的事）',`,
    `          '\`<!--mem-fact\` 内容 \`-->\` → 用户画像（profile 表，只装「关于用户本人」的事）',`,
    1,
  ],
  // ── 预算说明里的旧文件名
  [
    `   *   另一个项目的 PROJECT.md 被写到预算之上，模型毫无察觉 ——`,
    `   *   另一个项目的规则被写到预算之上，模型毫无察觉 ——`,
    1,
  ],
  // ── 各种历史注释
  [
    `    // 双分支已移除 —— else 那半边写的是 facts.md / PROJECT.md / log/*.md，`,
    `    // 双分支已移除 —— else 那半边写的是文件，`,
    1,
  ],
  [
    `      // 建 <项目>/PROJECT.md + log/*.md 只会留下没有内容的模板壳，`,
    `      // 建项目目录只会留下没有内容的空壳，`,
    1,
  ],
  [
    `          // 既然 facts.md / PROJECT.md 不再生成，读它们只会得到空内容，`,
    `          // 既然文件式记忆已移除，读它们只会得到空内容，`,
    1,
  ],
  [
    `    for (const file of ['facts.md', 'policy.md', 'state.json']) {`,
    `    for (const file of ['policy.md', 'state.json', 'memory.db']) {`,
    1,
  ],
  [
    `    // 当时根级只有 facts.md / policy.md / state.json 三个文本文件。`,
    `    // 当时根级只有 policy.md / state.json 等几个文本文件。`,
    1,
  ],
]

let bad = 0
for (const [from, to, expect] of EDITS) {
  const n = text.split(from).length - 1
  if (n !== expect) {
    console.log(`❌ 期望 ${expect} 实际 ${n}: ${JSON.stringify(from.slice(0, 60))}`)
    bad++
    continue
  }
  text = text.split(from).join(to)
}

if (bad > 0) {
  console.log(`\n中止：${bad} 处对不上，未写入`)
  process.exit(1)
}
fs.writeFileSync(FILE, text, 'utf8')
console.log(`✅ 已应用 ${EDITS.length} 处`)
