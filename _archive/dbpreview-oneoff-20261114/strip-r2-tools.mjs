/**
 * 第 2 轮：删除 toolsEnabled 死配置。
 *
 * 判断依据：代码自己注释写着「保留仅为兼容旧配置，不再生效」，
 * 而本版本**永久不注册工具**。留一个永远为 false 的配置项只会误导读者。
 *
 * 保留的是**行为**：如果有人还在配置里写 toolsEnabled=true，仍然警告一次
 * （因为老用户的配置文件里可能还有），只是不再从 DEFAULT_CONFIG 里读默认值。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const EDITS = [
  // ① DEFAULT_CONFIG 里的默认值
  [
    `  logMonths: 3,
  /** ⚠️ 默认关闭工具。本版本实际不注册任何工具，见下方说明。 */
  toolsEnabled: false,
}`,
    `  logMonths: 3,
}`,
    1,
  ],

  // ② apply-start 诊断日志
  [
    `diag('apply-start', { rawRoot: config.root, toolsEnabled: config.toolsEnabled })`,
    `diag('apply-start', { rawRoot: config.root })`,
    1,
  ],

  // ③ 工具注册段的判断：改成读原始传入值（兼容老配置），不读 DEFAULT_CONFIG
  [
    `  // 因此这里永久不注册。config.toolsEnabled 保留仅为兼容旧配置，不再生效。
  if (config.toolsEnabled === true) {
    diag('tools-refused', '配置里写了 toolsEnabled=true，但本版本不注册任何工具（反代通道会 400）')
    logger.warn?.(
      '[dsh-memory] toolsEnabled 已忽略：本版本不注册工具。' +
        '记忆读写请用 write/read/grep，注入层已经告诉模型怎么用了。',
    )
  } else {
    diag('tools-none', '不注册工具（记忆靠注入 + 现有工具）')
  }`,
    `  // 因此这里永久不注册。DEFAULT_CONFIG 里已不再有 toolsEnabled ——
  // 唯一还认它的场合是「老用户配置文件里残留着这个键」，用来发一次提醒。
  if (rawConfig && typeof rawConfig === 'object' && rawConfig.toolsEnabled === true) {
    diag('tools-refused', '配置里还写着 toolsEnabled=true，但本版本不注册任何工具（反代通道会 400）')
    logger.warn?.(
      '[dsh-memory] toolsEnabled 已忽略，可以从配置里删掉这一行了。本版本不注册工具。',
    )
  } else {
    diag('tools-none', '不注册工具（记忆靠注入 + 现有工具）')
  }`,
    1,
  ],

  // ④ state 路由返回体
  [
    `              toolsEnabled: config.toolsEnabled === true,`,
    `              // toolsEnabled 字段已移除：插件永久不注册工具。`,
    1,
  ],

  // ⑤ apply-complete 日志
  [
    `diag('apply-complete', { toolsEnabled: config.toolsEnabled === true })`,
    `diag('apply-complete', { tools: 'none' })`,
    1,
  ],

  // ⑥ 文件头注释同步
  [
    ` *   2. 配置里遗留的 \`toolsEnabled\` 会被忽略并留一条诊断日志。`,
    ` *   2. 配置里若还留着 \`toolsEnabled\`（旧版本字段），会被忽略并留一条诊断日志。`,
    1,
  ],
]

let bad = 0
for (const [from, to, expect] of EDITS) {
  const n = text.split(from).length - 1
  if (n !== expect) {
    console.log(`❌ 期望 ${expect} 次，实际 ${n} 次:`)
    console.log('   ' + JSON.stringify(from.slice(0, 100)))
    bad++
    continue
  }
  text = text.split(from).join(to)
  console.log(`✅ ${JSON.stringify(from.slice(0, 60).replace(/\n/g, '⏎'))}`)
}

if (bad > 0) {
  console.log(`\n中止：${bad} 处对不上，未写入`)
  process.exit(1)
}

fs.writeFileSync(FILE, text, 'utf8')
console.log('\n已写入')
