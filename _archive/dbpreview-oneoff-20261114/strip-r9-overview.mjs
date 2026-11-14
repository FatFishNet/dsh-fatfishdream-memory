/**
 * 第 9 轮：把 overview() 里的文件相关逻辑剔除，只留数据库模式真正需要的。
 *
 * 依据（本轮实测）：
 *   client.js 里 **没有任何一处** 使用 memoryBytes / memoryEntries / logBytes /
 *   logShards / exists / statsSource / facts / policy / totals。
 *   这些字段是文件时代给 GUI 用的，现在全是死数据。
 *
 * 保留：root / lastConsolidate / projects(基础字段) / ambiguous / dirName /
 *       health / statsSource（改成常量 'db'，因为文件口径已不存在）
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const OLD = `  async function overview(options = {}) {
    // 数据库模式下不读 facts.md：它已不再被生成，读它只会得到一个永久的 undefined。
    // 默认按文件模式处理，保持旧调用方（无参）行为不变。
    const includeFacts = options.includeFacts !== false
    const state = await readState()
    const facts = includeFacts ? await readIfExists(paths.facts) : undefined
    const policy = await readIfExists(paths.policy)

    const known = new Map()
    for (const [key, entry] of Object.entries(state.projects)) {
      known.set(key, { key, name: entry.name ?? key, dir: entry.dir ?? defaultProjectDir(key), cwd: entry.cwd })
    }
    let dirs = []
    try {
      dirs = await readdir(root, { withFileTypes: true })
    } catch {
      dirs = []
    }
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (known.has(entry.name)) continue
      const dir = join(root, entry.name)
      if (!(await exists(join(dir, 'PROJECT.md')))) continue
      known.set(entry.name, { key: entry.name, name: entry.name, dir, cwd: undefined })
    }

    const projects = []
    for (const item of [...known.values()].sort((l, r) => l.key.localeCompare(r.key))) {
      const memoryText = await readIfExists(join(item.dir, 'PROJECT.md'))
      const shards = await recentLogs(item.key, state, 240)
      projects.push({
        key: item.key,
        name: item.name,
        dir: item.dir,
        cwd: item.cwd ?? null,
        // ⚠️ exists「是文件口径」的：指的是 PROJECT.md 这个文件在不在，
        // 不是「这个项目有没有记忆」。数据库模式下所有项目都可能显示 false。
        // 配合 statsSource 一起读，别单独拿它下结论（2026-11-13 踩过：
        // 看到全是 exists:false / memoryEntries:0，差点误判成数据丢了）。
        exists: memoryText !== undefined,
        memoryBytes: memoryText === undefined ? 0 : byteLength(memoryText),
        memoryEntries: activeLines(memoryText).length,
        logShards: shards.map((s) => ({
          month: s.month,
          bytes: byteLength(s.text),
          entries: (s.text.match(/^## /gm) ?? []).length,
        })),
        logBytes: shards.reduce((sum, s) => sum + byteLength(s.text), 0),
        // 这一组统计的口径永远是「文件」，哪怕当前跑的是数据库模式。
        // 数据库模式的真实条数在 /api/dsh-memory/state 的 db.byTable / db.byScope 里。
        statsSource: 'files',
      })
    }

    const split = splitMemoryLines(activeLines(facts))
    return {
      root,
      lastConsolidate: state.lastConsolidate ?? null,
      facts: {
        bytes: facts === undefined ? 0 : byteLength(facts),
        entries: split.facts.length,
        emotions: split.emotions.length,
      },
      policy: { bytes: policy === undefined ? 0 : byteLength(policy) },
      projects,
      ambiguous: state.ambiguous.length,
      // 上面 projects[].memoryBytes / memoryEntries / logBytes 全是**文件口径**
      // （读 PROJECT.md 与 log/*.md）。数据库模式下这些文件早已不再写入，
      // 因此数值会普遍为 0 —— 那是正常状态，不是「记忆丢了」。
      statsSource: 'files',`

const NEW = `  async function overview() {
    // 2026-11-13 剥离后只保留数据库模式需要的字段。
    // 原实现会扫目录找 PROJECT.md、读 log/*.md 统计字节数 —— 那些文件不再生成，
    // 读到的永远是 undefined；而 client.js 从未使用过这些字段（本轮已核实）。
    // 真实条数在 /api/dsh-memory/state 的 db.byTable / db.byScope 里。
    const state = await readState()
    const policy = await readIfExists(paths.policy)

    const projects = []
    for (const [key, entry] of Object.entries(state.projects)) {
      projects.push({
        key,
        name: entry.name ?? key,
        dir: entry.dir ?? defaultProjectDir(key),
        cwd: entry.cwd ?? null,
      })
    }
    projects.sort((l, r) => l.key.localeCompare(r.key))

    return {
      root,
      lastConsolidate: state.lastConsolidate ?? null,
      policy: { bytes: policy === undefined ? 0 : byteLength(policy) },
      projects,
      ambiguous: state.ambiguous.length,
      statsSource: 'db',`

if (text.split(OLD).length - 1 !== 1) {
  console.log('❌ overview 原文不匹配，中止')
  process.exit(1)
}
text = text.split(OLD).join(NEW)
console.log('✅ overview 已精简')

// 尾部还有 totals（对应 projects 的文件统计），一并去掉
const OLD_TAIL = `      health: { ...healthState },
      totals: {
        projects: projects.length,
        logBytes: projects.reduce((sum, item) => sum + item.logBytes, 0),
      },
    }
  }`
const NEW_TAIL = `      health: { ...healthState },
      totals: { projects: projects.length },
    }
  }`
if (text.split(OLD_TAIL).length - 1 === 1) {
  text = text.split(OLD_TAIL).join(NEW_TAIL)
  console.log('✅ totals 去掉 logBytes')
} else {
  console.log('⚠️ totals 块未匹配')
}

fs.writeFileSync(FILE, text, 'utf8')
console.log('已写入')
