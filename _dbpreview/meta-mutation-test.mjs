/**
 * 变异测试（mutation testing）：真的能抓到 bug 吗？
 *
 * ## 为什么需要它，而不是看「覆盖率」
 *
 * 覆盖率只说明「这行代码被执行过」，不说明「改坏它测试会不会红」。
 * 2026-11-15 的教训：`reportBudget` 从 1.0.0 起就没有调用点，
 * 而 `verify-functions` 的 112 条断言**一直全绿** —— 它测的是「符号还在文件里」。
 *
 * 变异测试直接回答那个问题：**把代码改坏，测试会红吗？**
 *
 * ## 做法
 *
 * 对每个变异点：备份原文件 → 注入一处语义改变 → 跑全量回归 → 恢复。
 *   - 测试红了  = 这个变异被「杀死」（测试有效）
 *   - 测试全绿  = 变异「存活」← **测试盲区**
 *
 * ## 安全性
 *
 * 每轮都从备份恢复，**并用 sha256 校验恢复后的文件与原文逐字节一致**
 * （2026-11-15 加：此前注释这么写、代码里却没有校验，是一句没有兑现的承诺）。
 * 中途异常也会在 finally 里恢复。
 *
 * 启动时先查 `.mutbak` 残留：上一轮若被 kill，恢复语句可能没执行，
 * 残留文件说明**磁盘上的生产文件可能还是被改坏的状态** —— 直接拒绝运行并提示。
 *
 * 跑完即删（备份文件）。
 *
 * ⚠️ 破坏性工具：只能在 `git status` 干净时跑。见 HANDOFF ⑦ / ⑩ §三.⑦。
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { runCaptured } from './lib-spawn-capture.mjs'

// ⚠️ 不要用 'node' 字面量。
//
// 2026-11-15 首版踩到：本机 node **不在 PATH**（AGENTS.md 记过），
// execSync('node ...') 必然抛错，于是每个变异都被当成「KILLED」——
// 报出 100% 杀伤率，而实际上**一个测试都没跑**。
// 那是本轮最危险的一次假绿：结论看起来完美，证据是空的。
//
// process.execPath 是当前正在运行的 node 可执行文件的绝对路径，
// 不依赖 PATH，也不会因为换 shell 而失效。
// （2026-11-15 起实际由 lib-spawn-capture.mjs 的 runCaptured 负责，
//  它默认就用 process.execPath。这里保留说明，避免有人改回字面量 'node'。）

/** 文件内容的 sha256，用于校验「恢复后是否逐字节等于原文」 */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

// ---- 启动自检：上一轮若被 kill，finally 可能没执行 ----
//
// 残留的 .mutbak 是**危险信号**：说明磁盘上的生产文件可能仍是被改坏的状态。
// 此时跑变异测试只会让「坏文件」被当成「原文」备份一次，把问题固化。
const leftover = []
;(function scanLeftovers() {
  const dir = 'dsh-fatfishdream-memory'
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.mutbak')) leftover.push(`${dir}/${f}`)
  }
})()

if (leftover.length > 0) {
  console.log('💥 检测到上一轮残留的备份文件，拒绝运行：')
  for (const f of leftover) console.log(`   - ${f}`)
  console.log('')
  console.log('这说明上一次运行被中断（进程被 kill），生产文件可能还停在被改坏的状态。')
  console.log('处理顺序：')
  console.log('  1. 检查该生产文件是否异常（git diff 看差异）')
  console.log('  2. 需要恢复就 `git checkout -- <文件>`（工作区必须干净才安全）')
  console.log('  3. 确认无误后删除 .mutbak，再重跑本脚本')
  process.exit(1)
}

// 变异清单：每项改一处特定的语义，看测试能不能抓到。
//
// 选取原则：**只挑「改坏了会真的出错」的点**，
// 不挑格式/注释（那些改了本来就不该让测试红）。
const MUTATIONS = [
  {
    id: 'scrubber-guard',
    file: 'dsh-fatfishdream-memory/client.js',
    desc: '移除 isSafeToCollapse 守卫（回到「除 body 外全能隐藏」）',
    from: '          isSafeToCollapse(el)\n        ) {',
    to: '          true\n        ) {',
  },
  {
    id: 'scrubber-scroll-check',
    file: 'dsh-fatfishdream-memory/client.js',
    desc: '守卫里去掉滚动祖先检查',
    from: "          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' ||\n              cs.overflow === 'auto' || cs.overflow === 'scroll') {\n            return false\n          }",
    to: '          // mutated: scroll check removed',
  },
  {
    id: 'scope-rename-transaction',
    file: 'dsh-fatfishdream-memory/db-store.mjs',
    desc: '去掉事务（BEGIN/COMMIT 变空操作）',
    from: "    d.exec('BEGIN')\n    try {",
    to: "    try {",
  },
  {
    id: 'scope-rename-merge-count',
    file: 'dsh-fatfishdream-memory/db-store.mjs',
    desc: '合并校验公式退回「迁后=源」',
    from: 'const wantCount = merged ? wantFrom.all + wantTarget.all : wantFrom.all',
    to: 'const wantCount = wantFrom.all',
  },
  {
    id: 'injection-role-warning',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '删掉注入里的 role 区分警告',
    from: "'`rows` 每行带 `role`（user / assistant）：**assistant 那侧就是你自己说的**，别当成「我们讨论过」；',",
    to: "'（mutated: role warning removed）',",
  },
  {
    id: 'marker-capture-groups',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '标记正则丢掉 kind 捕获组（会导致所有带标记回复静默丢弃）',
    from: "const MEM_MARKER_RE = /^<!--(mem-log)",
    to: "const MEM_MARKER_RE = /^<!--(?:mem-log)",
  },
  {
    id: 'archive-role-filter',
    file: 'dsh-fatfishdream-memory/db-store.mjs',
    desc: 'archive 的 role 过滤失效',
    from: 'if (role) { where.push(\'role=?\'); params.push(role) }',
    to: 'if (false) { where.push(\'role=?\'); params.push(role) }',
  },
  {
    id: 'fts-cjk-segment',
    file: 'dsh-fatfishdream-memory/db-schema.mjs',
    desc: 'CJK 分词不再逐字切分（中文检索会整体失效）',
    from: 'export function segmentCjk(',
    to: 'export function segmentCjkBroken(',
  },
  // ---- 下面三个用于验证 selfcheck-pure-utils.mjs 是否真的有效 ----
  {
    id: 'parseJson-bom',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'parseJson 不再剥离 BOM（会导致「记忆突然读不到」）',
    from: 'const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text',
    to: 'const cleaned = text',
  },
  {
    id: 'isInside-prefix',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'isInside 退回字符串 startsWith（/a/bc 会被当成 /a/b 的子目录）',
    from: "  const rel = relativePath(root, target)\n  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))",
    to: "  return String(target).startsWith(String(root))",
  },
  {
    id: 'isSafeSlug-dotdot',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'isSafeSlug 不再拦截 ".."（路径穿越）',
    from: "&& slug !== '.' && slug !== '..'",
    to: '',
  },
  // ---- 2026-11-15：验证「情绪后置限定词」真的有测试守着 ----
  {
    id: 'emotion-limiter-after',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '后置限定词失效（「成功了一半」会被判成高置信喜悦）',
    from: 'const limiter = limiterAfter(text, at + word.length)',
    to: 'const limiter = 1',
  },
  {
    id: 'emotion-limiter-wired',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'limiter 算出来了但没乘进分数（等于没改）',
    // ⚠️ 这里必须带上**前面那行 if 的开头**才能唯一定位。
    //
    // 踩过的坑（2026-11-15）：最初写的是
    //   from: 'record(entry.cls, capScore(entry.i, modifier * limiter), word)'
    // 而这一行在源码里出现 **2 次** —— 一次在 isFixedNegative 分支、一次在正常路径。
    // String.replace 只换第一处（isFixedNegative 分支），而测试用的是
    // 「成功了一半」这种**正常路径**，于是 limiter 依然生效、变异 SURVIVED。
    // 那次 SURVIVED 是变异选错了点，不是测试有盲区。
    from: "        if (negatedBefore(text, at)) {\n          record(entry.cls, Math.min(1, entry.i * modifier * limiter * 0.35), `不${word}`)\n          continue\n        }\n        record(entry.cls, capScore(entry.i, modifier * limiter), word)",
    to: "        if (negatedBefore(text, at)) {\n          record(entry.cls, Math.min(1, entry.i * modifier * limiter * 0.35), `不${word}`)\n          continue\n        }\n        record(entry.cls, capScore(entry.i, modifier), word)",
  },
  {
    id: 'emotion-partial-diminisher',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '去掉「部分/一半」这类完成度削弱词',
    from: "  { words: ['部分', '一半', '局部', '大半'], factor: 0.45 },",
    to: '',
  },
  // ---- 2026-11-16：验证「正文不要写空行」这条注入真的被守着 ----
  //
  // 为什么值得一个变异：它看起来像排版偏好，最容易被以后的会话
  // 当成「可选建议」删掉。而删掉后**没有任何报错**，只是界面底部
  // 又开始空出一大块 —— 正是这个 bug 最初的形态。
  {
    id: 'injection-no-blank-line',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '删掉「正文不要写空行」的注入（界面底部会重新空一大块）',
    from: "          '**正文不要写空行**（空行擦掉后会留下空段落，界面底部会空一块）；要分段就用一个换行。',",
    to: '',
  },
  {
    id: 'policy-no-blank-line',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'POLICY_TEMPLATE 里的空行规则被删（新装用户收不到）',
    from: '  **正文不要写空行**（2026-11-16）：标记在流式输出时会以原文短暂可见，擦除器擦掉文字后，',
    to: '  （已删除）',
  },
  // ---- 2026-11-16：验证「情绪不豁免」规则真的被守着 ----
  //
  // 这条规则防的是「用户说了重要的话，下一个会话的我却不知道」。
  // 用户实报过三次（情绪 #26/#27/#29），同一个坑 2026-11-14 也踩过。
  {
    id: 'injection-emotion-not-exempt',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '删掉注入里的「情绪不豁免」规则（技术反馈会重新只进情绪表）',
    from: "          '## 什么时候必须记（情绪不豁免）',\n          '用户指出问题、提需求、讲做事偏好 —— **一律记流水**，即使同时被判成情绪。',\n          '情绪表与流水表是两条独立通道：判成情绪不影响写 mem-log。',\n          '判据：**这条会让下一个会话的我少走一次弯路吗？** 会 → 记。',\n          '但纯寒暄、纯情绪交流不记；同一结论换个问法再问一遍也不记第二条。',",
    to: '',
  },
  {
    id: 'policy-emotion-not-exempt',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'POLICY_TEMPLATE 里的「情绪不豁免」被删（新装用户收不到）',
    // ⚠️ 行首的 `- ` 必须带上。2026-11-16 第一次写漏了它，
    // dry-run 报「变异点未匹配」才发现 —— 这正是 dry-run 存在的价值：
    // 若直接真跑，它会 SKIP，而 SKIP 不算 KILLED，容易被误读成「测试没问题」。
    from: '- **用户指出的问题、提出的需求、讲的做事偏好，一律记流水。**',
    to: '- （已删除）',
  },
  // ---- 2026-11-16：验证「提到标记」与「写错标记」真的被区分 ----
  //
  // 这条防的是排查被误导：模型引用正则/示例时正文含 `<!--mem-` 字样，
  // 旧代码只判 includes 就当成「想写标记」，连续刷 marker-unmatched，
  // 把「这轮真的忘了写流水」掩盖成「格式写错了」。
  {
    id: 'marker-mention-vs-unmatched',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '去掉行首判据（「只是提到标记」会重新刷 marker-unmatched）',
    from: 'const atLineStart = /^[ \\t]*<!--mem-/m.test(text)',
    to: 'const atLineStart = true',
  },
  {
    id: 'marker-mention-diag-removed',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'marker-mention-only 分支被删（「提到标记」不再有独立痕迹）',
    // 注意：不能只改注释 —— 注释不影响行为，变异会 SURVIVED，
    // 那种 SURVIVED 是「变异没改到语义」，不是测试盲区。
    from: "          diag('marker-mention-only', {",
    to: "          void ({" ,
  },
  // ---- 2026-11-16：验证「连续写入失败提醒」逻辑真的被守着 ----
  //
  // 用户要求：连续 4 轮「写了标记却 0 落库」就提醒一次。
  // 历史教训：每轮提醒两天 217 次太吵，所以阈值 + safePushMessage 是硬约束。
  // 若阈值被改成 1，就退回「每轮提醒」的老路。
  {
    id: 'write-fail-threshold-removed',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '连续失败阈值被改成 1（退回每轮提醒，217 次太吵）',
    from: 'const WRITE_FAIL_STREAK_LIMIT = 4',
    to: 'const WRITE_FAIL_STREAK_LIMIT = 1',
  },
  {
    id: 'write-fail-reset-removed',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '成功后清零被删（提醒一次后永远卡在阈值）',
    from: "        if (markerWritten > 0) {\n          // 成功写入 → 清零连续失败计数\n          if (writeFailStreak.get(sKey) !== 0) {\n            writeFailStreak.set(sKey, 0)\n          }\n        }",
    to: "        if (markerWritten > 0) {\n          // （已删除清零）\n        }",
  },
  {
    id: 'write-fail-safe-push-removed',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '提醒不再走 safePushMessage（turn-stopping 异常会中断会话）',
    from: "        const delivered = safePushMessage(\n          agent,\n          `[dsh-memory] 连续 ${failStreak} 轮尝试写记忆但都没成功落库。",
    to: "        const delivered = agent?.steer({\n          id: 'x',\n          role: 'user',\n          content: [{ type: 'text', text: `[dsh-memory] 连续 ${failStreak} 轮尝试写记忆但都没成功落库。",
  },
]

// ---- --dry-run：只列出会改哪里，不动任何文件 ----
//
// 2026-11-15 加。这个工具是唯一会改生产文件的脚本，
// 需要一个「先看看会动什么」的开关。放在 MUTATIONS 之后是有意的：
// 引用 const 声明必须先声明后使用，否则 TDZ 报错。
if (process.argv.includes('--dry-run')) {
  console.log('=== 变异测试（DRY-RUN）：只列出会改哪里，不动任何文件 ===\n')
  let matchedAll = 0
  for (const m of MUTATIONS) {
    let matched = false
    try {
      matched = fs.readFileSync(m.file, 'utf8').includes(m.from)
    } catch {
      matched = false
    }
    if (matched) matchedAll += 1
    console.log(`  ${m.id.padEnd(26)} ${m.file}`)
    console.log(`    ${m.desc}`)
    console.log(`    变异点${matched ? '已匹配 ✅' : '未匹配 ⚠️（源码变了，真跑会是 SKIP）'}`)
  }
  console.log(`\n共 ${MUTATIONS.length} 个变异，${matchedAll} 个变异点已匹配。`)
  console.log('去掉 --dry-run 才会真的改文件。')
  process.exit(0)
}

const results = []

function backupAndRun(m) {
  const orig = fs.readFileSync(m.file, 'utf8')
  const backup = `${m.file}.mutbak`
  fs.writeFileSync(backup, orig)
  const origHash = sha256(orig)
  try {
    if (!orig.includes(m.from)) {
      return { id: m.id, desc: m.desc, status: 'SKIP', note: '变异点未匹配（源码已变）' }
    }
    const mutated = orig.replace(m.from, m.to)
    if (mutated === orig) {
      return { id: m.id, desc: m.desc, status: 'SKIP', note: '替换后无变化' }
    }
    fs.writeFileSync(m.file, mutated)

    // 跑全量回归
    //
    // ⚠️ 这里必须区分三种情况，不能把「runner 崩了」当成「测试抓到了」：
    //   exit=0          → 变异存活（测试全绿）
    //   exit≠0 + FAIL>0 → 变异被杀死（有测试红了）
    //   其它（超时/崩溃/脚本起不来）→ runner 自身出错，**这一轮结果无效**
    //
    // 2026-11-15 补：改走 runCaptured。受限沙箱下 spawnSync 的默认管道会 EPERM，
    // 旧写法只能靠 r.error 判 ERROR —— 虽然没被判成 KILLED，但 11 个变异会全变 ERROR，
    // 等于这个工具在 workspace-write 权限下完全没法用。
    let status
    let note
    const r = runCaptured(['_dbpreview/run-all.mjs'], {
      cwd: process.cwd(),
      timeout: 240000,
      env: { ...process.env, DSH_BASE: process.env.DSH_BASE || process.env.DSH_WEB_URL || '' },
    })

    if (r.error || r.status === null) {
      status = 'ERROR'
      note = `runner 无法启动：${r.error ? ((r.error.code || '') + ' ' + r.error.message).trim() : 'status=null'}`
    } else if (r.signal) {
      status = 'ERROR'
      note = `runner 被信号终止：${r.signal}`
    } else {
      const out = `${r.stdout || ''}\n${r.stderr || ''}`
      const m2 = out.match(/TOTAL=(\d+) FAIL=(\d+)(?: ([^\n]*))?/)
      if (!m2) {
        status = 'ERROR'
        note = `runner 输出无法解析（exit=${r.status}）：${out.trim().split('\n').slice(-2).join(' | ').slice(0, 160)}`
      } else if (Number(m2[2]) > 0) {
        status = 'KILLED'
        note = `被 ${m2[3] || '(?)'} 抓到`
      } else if (r.status === 0) {
        status = 'SURVIVED'
        note = '测试全绿 ← 盲区！'
      } else {
        // FAIL=0 但 exit≠0：runner 里那是「有脚本没跑起来」（ERROR）
        // 或「脚本不存在」。**这一轮结果无效**，不能算抓到。
        status = 'ERROR'
        note = `FAIL=0 但 exit=${r.status}：有脚本没跑起来，本轮结果无效`
      }
    }
    return { id: m.id, desc: m.desc, status, note }
  } finally {
    // 从备份恢复，并**真的校验**（此前注释声称校验、代码没有）
    fs.writeFileSync(m.file, fs.readFileSync(backup, 'utf8'))
    const restored = fs.readFileSync(m.file, 'utf8')
    const restoredHash = sha256(restored)
    try { fs.unlinkSync(backup) } catch { /* 已删 */ }
    if (restoredHash !== origHash) {
      // 大声报错：生产文件可能停留在被改坏的状态
      throw new Error(
        `恢复失败！${m.file} 与原文不一致（orig=${origHash.slice(0, 12)} restored=${restoredHash.slice(0, 12)}）。` +
        `请立即手动恢复：git checkout -- ${m.file}`,
      )
    }
  }
}


console.log('=== 变异测试：改坏代码，看测试管不管用 ===\n')
for (const m of MUTATIONS) {
  process.stdout.write(`  ${m.id.padEnd(26)} `)
  const r = backupAndRun(m)
  results.push(r)
  const icon = r.status === 'KILLED' ? '✅' : r.status === 'SKIP' ? '⏭️ ' : r.status === 'ERROR' ? '💥' : '❌'
  console.log(`${icon} ${r.status.padEnd(10)} ${r.note}`)
}

const killed = results.filter((r) => r.status === 'KILLED').length
const survived = results.filter((r) => r.status === 'SURVIVED').length
const skipped = results.filter((r) => r.status === 'SKIP').length
const errored = results.filter((r) => r.status === 'ERROR').length

console.log(`\n${'='.repeat(56)}`)
console.log(`共 ${results.length} 个变异：KILLED ${killed} / SURVIVED ${survived} / SKIP ${skipped} / ERROR ${errored}`)
if (killed + survived > 0) {
  console.log(`变异杀伤率 = ${Math.round(killed / (killed + survived) * 100)}%`)
}
if (survived > 0) {
  console.log('\n⚠️ 存活的变异 = 测试盲区：')
  for (const r of results.filter((x) => x.status === 'SURVIVED')) {
    console.log(`  - ${r.id}: ${r.desc}`)
  }
}
if (errored > 0) {
  console.log('\n💥 ERROR = 这次结果不可信，先修 runner：')
  for (const r of results.filter((x) => x.status === 'ERROR')) {
    console.log(`  - ${r.id}: ${r.note}`)
  }
}

// ERROR 视为失败：不能把「没测成」当成「通过」
process.exit(errored === 0 && survived === 0 ? 0 : 1)
