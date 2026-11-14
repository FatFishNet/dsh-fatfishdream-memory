/**
 * 第 10 轮：标记从 3 个收窄为 1 个 —— 只保留 mem-log。
 *
 * 用户决定（2026-11-13）：项目规则与全局规则统一由用户在 GUI 手工管理，
 * 模型不再主动写规则。理由是注入预算极其紧张（项目段 4096 已用 92.6%），
 * 而模型自动写规则正是把它顶满的主因。
 *
 * 保留 mem-log：它是过程记录，不注入、无预算压力，是跨会话唯一的「做过什么」线索。
 *
 * 移除 mem-fact / mem-note / mem-fix：
 *   - fact / note 改为人工维护
 *   - fix（正则清理全局）也随之失去意义 —— 既然模型不写全局，就没有要它清理的
 *
 * 注意：db-store 的 appendFact / appendProjectNote / upgradeToGlobal 不能删 ——
 *       GUI 的「新增规则」「升级为全局」按钮还在用（createEntry / upgradeToGlobal）。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
let text = fs.readFileSync(FILE, 'utf8')

const EDITS = []

// ① 正则只认 log
EDITS.push([
  `  const MEM_MARKER_RE = /^<!--mem-(log|fact|note|fix)(?:[ \\t]+topic=([^\\n]*?))?[ \\t]*(?:\\n|-->)([\\s\\S]*?)-->/gm`,
  `  // 只认 mem-log。2026-11-13 起 fact / note / fix 全部移除 ——
  // 规则与画像改由用户在 GUI 手工维护，模型不再自动写。
  const MEM_MARKER_RE = /^<!--mem-log(?:[ \\t]+topic=([^\\n]*?))?[ \\t]*(?:\\n|-->)([\\s\\S]*?)-->/gm`,
  1,
])

// ② 处理分支：只留 log
EDITS.push([
  `          if (kind === 'log') {
            const cleaned = body
              .split('\\n')
              .filter((line) => !/^##\\s/.test(line.trim()))
              .join('\\n')
              .trim()
            if (cleaned === '') continue
            // topic 来自标记参数（\`<!--mem-log topic=xxx\`）；没写就是 NULL。
            // 传进去之后这条流水才会出现在注入的「记忆索引」里。
            const r = dbStore.appendLog(projectKey, cleaned, topic)
            diag('mem-写流水', { project: r.project, topic, db: true })
            logger.info?.(\`[dsh-memory] 已写入 \${r.project} 的流水（db\${topic ? ' · ' + topic : ''}）\`)
          } else if (kind === 'fact') {
            const r = dbStore.appendFact(body)
            diag('mem-写全局结论', { written: r.written, usage: r.usage, db: true })
            reportBudget('全局偏好', r.usage)
          } else if (kind === 'note') {
            // 默认记成项目级 —— 按讨论结论：误判成全局会在别的项目造成实际损害，
            // 而误判成项目只是多记几份。所以标记默认不升级。
            const noteKind = looksLikeRedline(body) ? 'redline' : 'pref'
            const r = dbStore.appendProjectNote(projectKey, body, noteKind)
            diag('mem-写项目结论', { project: r.project, written: r.written, kind: noteKind, usage: r.usage, db: true })
            reportBudget(\`\${r.project} 项目段\`, r.usage)
          } else if (kind === 'fix') {
            // 按正则把匹配的全局条目软删除
            const removed = dbStore.removeGlobalByRegex(body)
            diag('mem-清理全局结论', { removed: removed.removed, db: true })
          }`,
  `          // 唯一保留的标记是 mem-log。规则与画像由用户在 GUI 手工维护。
          const cleaned = body
            .split('\\n')
            .filter((line) => !/^##\\s/.test(line.trim()))
            .join('\\n')
            .trim()
          if (cleaned === '') continue
          // topic 来自标记参数（\`<!--mem-log topic=xxx\`）；没写就是 NULL。
          // 传进去之后这条流水才会出现在注入的「记忆索引」里。
          const r = dbStore.appendLog(projectKey, cleaned, topic)
          diag('mem-写流水', { project: r.project, topic, db: true })
          logger.info?.(\`[dsh-memory] 已写入 \${r.project} 的流水（db\${topic ? ' · ' + topic : ''}）\`)`,
  1,
])

// ③ 注入文案：三个标记 → 一个
EDITS.push([
  `          '\`<!--mem-log\` 做了什么 \`-->\` 流水 · \`<!--mem-note\` 项目规则 \`-->\` · \`<!--mem-fact\` 用户画像 \`-->\`',`,
  `          '\`<!--mem-log topic=开发日志\` 正文 \`-->\` 流水（唯一可写的记忆）',
          '规则与画像由用户在 GUI 手工维护，**不要自己写**。',`,
  1,
])

// ④ 第二个 usageLines 分支（文件模式）
EDITS.push([
  `          '\`<!--mem-log\` 内容 \`-->\` → 当月流水',
          '\`<!--mem-note\` 内容 \`-->\` → 本项目项目规则（rules 表）',
          '\`<!--mem-fact\` 内容 \`-->\` → 用户画像（profile 表，只装「关于用户本人」的事）',`,
  `          '\`<!--mem-log topic=开发日志\` 正文 \`-->\` → 流水',`,
  1,
])

// ⑤ hint 文案
EDITS.push([
  `      ? '<!-- 本段由插件注入。记忆存于 SQLite；写入只能用回复正文里的 mem 标记。 -->'`,
  `      ? '<!-- 本段由插件注入。记忆存于 SQLite；模型只能写 mem-log 流水。 -->'`,
  1,
])

let bad = 0
for (const [from, to, expect] of EDITS) {
  const n = text.split(from).length - 1
  if (n !== expect) {
    console.log(`❌ 期望 ${expect} 实际 ${n}: ${JSON.stringify(from.slice(0, 70))}`)
    bad++
    continue
  }
  text = text.split(from).join(to)
  console.log(`✅ 第 ${EDITS.findIndex((e) => e[0] === from) + 1} 处`)
}

if (bad > 0) {
  console.log(`\n中止：${bad} 处对不上，未写入`)
  process.exit(1)
}
fs.writeFileSync(FILE, text, 'utf8')
console.log('\n已写入')
