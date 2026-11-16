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
    // ⚠️ 2026-11-16 修锚点：原来只写 `    d.exec('BEGIN')\n    try {`。
    //
    // 新增 `purgeByStatus`（L516）之后，`d.exec('BEGIN')` 在文件里出现了 **3 处**
    // （purgeByStatus / renameScope / removeGlobalByRegex），
    // 而 `String.replace` **只换第一处** → 变异打到了 purge 身上，
    // `renameScope` 的事务原封不动，于是 selfcheck-scope-rename 全绿 →
    // 变异 SURVIVED（32 个里唯一的存活项，就是这个假象）。
    //
    // 这正是 AGENTS.md 里「变异锚点必须唯一且包含完整上下文」那条。
    // 修法：把 renameScope 独有的那句上下文（`const tables = {}` + 循环头）带进锚点。
    from: "    const tables = {}\n    let total = 0\n    d.exec('BEGIN')\n    try {",
    to: '    const tables = {}\n    let total = 0\n    try {',
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
    // ⚠️ 2026-11-17 更新锚点：这句话在「同工作区多会话」修正时被重写过。
    //    旧锚点（`assistant 那侧就是你自己说的`）已不存在 → 变异会 SKIP，
    //    而 SKIP 在新规则下计入失败（所以不更新的话回归会红）。
    //    锚点改成新文案里唯一的开头片段，`to` 用等长的替代串避免移位。
    from:
      "'`rows` 每行带 `role`（user / assistant）和 `session_id`：**assistant 那侧是 AI 说的，但不是用户说的**，别当成「我们讨论过」；'",
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
    // 2026-11-16 更新：isInside 已修成「只在 .. 独立成段时算上跳」，
    // 锚点随之改成新实现。旧的 from 仍写 startsWith，永远匹配不上 → SKIP，
    // 而 SKIP 不计入 KILLED，等于这条防线悄悄消失了（见 AGENTS.md 变异章节）。
    from: "  return rel === '' || (!/^\\.\\.($|[\\\\/])/.test(rel) && !isAbsolute(rel))",
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
    // ⚠️ 2026-11-16 更新：写入通道改成 HTTP 后，注入里那条独立的空行规则
    // 被并进了「退化到标记时」那一行（正文里不再有标记，主路径用不到它，
    // 但退化路径仍然需要）。锚点跟着换成新措辞。
    // 守的东西没变：删掉后界面底部会重新空一大块，且**没有任何报错**。
    from: '**正文不要写空行**（擦掉后每个空行留下一个空段，界面底部会空一块）。',
    to: '',
  },
  {
    id: 'policy-no-blank-line',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'POLICY_TEMPLATE 里的空行规则被删（新装用户收不到）',
    from: '**正文不要写空行** —— 擦掉后每个空行会留一个空段，界面底部会空一块。',
    to: '  （已删除）',
  },
  // ---- 2026-11-16：验证「情绪不豁免」规则真的被守着 ----
  //
  // 这条规则防的是「用户说了重要的话，下一个会话的我却不知道」。
  // 用户实报过三次（情绪 #26/#27/#29），同一个坑 2026-11-14 也踩过。
  {
    id: 'injection-emotion-not-exempt',
    // 2026-11-16 更新：注入规则从「情绪不豁免（带判据）」改成「每轮都要记（不跳轮）」，
    // 变异锚点同步更新。它守的内容没变 —— 删掉这条规则，模型就会回到
    // 「这轮没什么可记」的自我说服，当天实测因此漏记 12+ 轮。
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '删掉注入里的「每轮都要记」规则（模型会重新按感觉跳过记录）',
    // ⚠️ 2026-11-16 四次更新：措辞「写一条 mem-log」→「发一次 POST」，
    // 整节移到注入末尾，且把完整命令写进了本节（不再用「上面那条」指代）。
    // 锚点跟着换，守的东西没变：删掉标题 + 那条硬规则，
    // 「每轮都要记」的硬要求就没了，模型会回到按感觉跳过记录。
    //
    // 只锚「标题行 + 规则行」两行 —— 中间夹着 6 行改措辞的注释，
    // 用纯字符串锚点跨不过去（工具不支持正则），所以把两行分别拼进来。
    from:
      "          '## 每轮都要记（和心跳同一级）',\n" +
      '          // ⚠️ 2026-11-16 第四次改：**把完整命令写在这一节里，不用「上面那条」指代。**\n' +
      '          //\n' +
      '          // 原来这里写「用 pwsh 发一次 POST（上面那条命令）」——\n' +
      '          // 而那条命令在注入上方 200 多字处。模型快速扫读时，\n' +
      '          // 「上面那条」是一个需要回头找的空引用，容易滑过去。\n' +
      '          // 现在直接给完整可粘贴的命令，**不需要往回看**。\n' +
      "          '每轮回复结尾、心跳之前发一次（**必做，不跳轮**），整行照抄即可：',\n",
    to: '',
  },
  {
    id: 'policy-emotion-not-exempt',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'POLICY_TEMPLATE 里的「情绪不豁免」被删（新装用户收不到）',
    // ⚠️ 行首的 `- ` 必须带上。2026-11-16 第一次写漏了它，
    // dry-run 报「变异点未匹配」才发现 —— 这正是 dry-run 存在的价值：
    // 若直接真跑，它会 SKIP，而 SKIP 不算 KILLED，容易被误读成「测试没问题」。
    from: '用户指出的问题、提出的需求、讲的做事偏好，**一律记流水**，即便那条消息同时',
    to: '- （已删除）',
  },
  {
    id: 'policy-template-private-closing',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '给 POLICY_TEMPLATE 塞回一条默认收尾语（新装用户被塞本机偏好）',
    // ★ 2026-11-16 加。守硬约束 9：「模板里不能夹带本机个人偏好」。
    //
    // 实际踩过：把用户整份 policy.md 同步成模板时，他的私人收尾语
    // 「你可爱的大肥鱼一直都在，等待下一轮任务！」被一起搬进模板，
    // 于是所有新装用户的默认收尾语都成了这句话。**是用户自己发现的**，
    // 原有的 66 条断言一条都没红 —— 那时没有任何断言管「模板里的私货」。
    //
    // 判据取 verify-injection-consistency 段 10 的两条：
    // 「模板不含『大肥鱼』」与「模板不含任何默认收尾语行」。
    // 这里塞一条不带「大肥鱼」的收尾语，专门验**第二条**（是否留了默认收尾语位）。
    //
    // 锚点是模板里唯一的二级标题（实测 count=1），不会打到别处。
    from: '## 强制录入：用户的情绪表达（不可关闭）',
    to: '- 每轮回复的结尾，加固定一句：测试收尾语！\n\n## 强制录入：用户的情绪表达（不可关闭）',
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
    desc: '写过流水也不清零（提醒一次后永远卡在阈值）',
    from: "      const wroteThisTurn = record !== undefined && record.wroteLog === true\n      if (wroteThisTurn) {\n        if ((writeFailStreak.get(sessionKey) ?? 0) !== 0) {\n          writeFailStreak.set(sessionKey, 0)\n        }\n      } else {",
    to: "      const wroteThisTurn = record !== undefined && record.wroteLog === true\n      if (false) {\n        if ((writeFailStreak.get(sessionKey) ?? 0) !== 0) {\n          writeFailStreak.set(sessionKey, 0)\n        }\n      } else {",
  },
  {
    id: 'write-fail-safe-push-removed',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '提醒不再走 safePushMessage（turn-stopping 异常会中断会话）',
    from: "        const delivered = safePushMessage(\n          agent,\n          `[dsh-memory] 已连续 ${failStreak} 轮没有把记忆写进流水。",
    to: "        const delivered = agent?.steer({\n          id: 'x',\n          role: 'user',\n          content: [{ type: 'text', text: `[dsh-memory] 已连续 ${failStreak} 轮没有把记忆写进流水。",
  },
  // ---- 2026-11-16 v2：验证「忘写也要计数」这一半真的被守着 ----
  //
  // v1 的漏洞就在这半边：hasMarker === false 时显式不计数，
  // 于是「连续 10 轮压根没写标记」零检测（用户实报）。
  {
    id: 'write-fail-skip-when-no-marker',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '退回 v1 行为：没写标记时不计入 streak（忘写将再次零检测）',
    from: "      } else {\n        const prev = writeFailStreak.get(sessionKey) ?? 0\n        writeFailStreak.set(sessionKey, prev + 1)\n      }",
    to: "      } else {\n        // 退回 v1：不做任何事\n      }",
  },
  {
    id: 'write-fail-count-per-message',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '把计数挪回 assistant/message（按条计数，一轮会顶穿阈值）',
    from: "      const wroteThisTurn = record !== undefined && record.wroteLog === true",
    to: "      const wroteThisTurn = (writeFailStreak.set(sKey, (writeFailStreak.get(sKey) ?? 0) + 1), record !== undefined && record.wroteLog === true)",
  },
  // ---- 2026-11-16：验证新脚本 selfcheck-log-alive 真的守住了写入链路 ----
  //
  // 这个脚本是用户要求加的「哪怕随便发一条消息证实能正常写流水」的可测版本。
  // 它做两件事：① 检查最近 N 分钟有没有流水；② 源码级断言写入链路完整。
  //
  // 下面两个变异分别打断这两条防线：
  {
    id: 'log-alive-write-broken',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '标记解析后不再写入 appendLog（流水全丢，但无报错）',
    // ⚠️ 2026-11-16 修锚点：`cleaned` 已改名为 `finalText`
    //   （空正文/清理后为空改降级写入时引入的中间变量）。
    //   锚点失配时真跑是 SKIP，而 SKIP 不算 KILLED —— 表面上「没红」，
    //   实际是这条防线没了。以 --dry-run 的「已匹配」为准。
    from: 'const r = dbStore.appendLog(projectKey, finalText, { topic, summary, keywords })',
    to: 'const r = { project: projectKey, written: false }',
  },
  {
    id: 'log-alive-diag-removed',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '删掉 mem-写流水诊断（写入成功也无从观察）',
    from: "          diag('mem-写流水', {",
    to: "          void ({",
  },
  // ---- 2026-11-16：HTTP 写入通道（主通道）的三条防线 ----
  //
  // 这条通道是「标记不进正文」的实现。它一旦静默失效，模型会以为写进去了，
  // 而库里一条没有 —— 与「忘了写」完全无法区分（都是「没有发生」）。
  {
    id: 'log-http-cwd-guard-removed',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '去掉 cwd 存在性检查（传错目录会凭空造出假工作区）',
    // ⚠️ 2026-11-16 实测过：这个变异确实能让 selfcheck-log-alive 段 5 变红。
    from: '              if (!(await exists(cwd))) {',
    to: '              if (false) {',
  },
  {
    id: 'log-http-skip-topic-clean',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'HTTP 通道不再走 sanitizeTopic（两条通道行为开始分叉）',
    // 这条最容易写错锚点：sanitizeTopic 在标记通道里也有一处调用。
    // 所以锚点带上 `body.topic` —— 那是 HTTP 通道独有的入参形态。
    from: "            const topic = sanitizeTopic(topicRaw)",
    to: "            const topic = topicRaw || null",
  },
  {
    id: 'log-http-no-streak-mark',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'HTTP 写完不置 wroteLog（turn-stopping 会误报「你忘了写流水」）',
    from: '              rec.wroteLog = true\n              turnActivity.set(sid, rec)',
    to: '              turnActivity.set(sid, rec)',
  },
  // ---- 2026-11-16 第六代：切会话闪烁（完整标记同步快擦）----
  //
  // 这条防线守的是「切会话不闪」。它一旦失效，标记会在那一帧露出原文 ——
  // **没有任何报错**，只有用户肉眼看得见。所以必须靠变异测试兜住。
  {
    id: 'scrubber-faststrip-disabled',
    file: 'dsh-fatfishdream-memory/client.js',
    desc: '退回第五代：完整标记也只排队等 400ms（切会话必闪）',
    from: 'if (hasCompleteMarker(n)) fastStrip(n)',
    to: 'if (false) fastStrip(n)',
  },
  {
    id: 'scrubber-faststrip-partial',
    file: 'dsh-fatfishdream-memory/client.js',
    desc: '快擦也处理未闭合标记（流式抖动会回来）',
    from: 'skipPartial: true',
    to: 'skipPartial: false',
  },
  // ---- 2026-11-16：policy.md 一次性覆盖的「只一次」保证 ----
  //
  // 用户明确授权**一次**覆盖。若这道哨兵失效，就变成「每次启动都覆盖」，
  // 用户的 policy.md 会被反复重置 —— 比不覆盖严重得多。
  {
    id: 'policy-sync-always-overwrites',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'readState 丢掉 policySyncVersion（每次启动都覆盖 policy.md）',
    from:
      'policySyncVersion: Number.isInteger(parsed.policySyncVersion)\n' +
      '          ? parsed.policySyncVersion\n' +
      '          : null,',
    to: 'policySyncVersion: null,',
  },
  // ---- 2026-11-16：守「覆盖丢收尾语」的修复 ----
  //
  // 这次踩的坑正是「覆盖 policy.md 时收尾语随旧文件一起丢失」。
  // 修复是在 syncPolicyOnce 里先 extractHeartbeat 提取、覆盖后 restoreHeartbeat 写回。
  // 下面这个变异把「提取」那行删掉 → 收尾语不再写回 → selfcheck-policy-sync 必须红。
  {
    id: 'policy-sync-heartbeat-lost',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '覆盖 policy.md 前不再提取收尾语（升级后收尾语永久丢失）',
    from: "    const oldHeartbeat = current === undefined ? '' : extractHeartbeat(current)",
    to: "    const oldHeartbeat = ''",
  },
  // ---- 2026-11-16：守「收尾语正则」的两次修正 ----
  //
  // 这条线经过三个版本，两个都是错的，都不能退回去：
  //
  //   ① 吞标题版（原始 bug）：
  //      吞掉所有不以 `-` 开头的行 → 空行 + `##` 标题一起没。
  //      用户 policy.md 从 13850 → 13791 字节、232 → 230 行，**零报错**。
  //
  //   ② 不跟踪续行版（我修 ① 时矫枉过正）：
  //      用户手写折行时会留下**孤立的缩进续行**。
  //
  //   ③ 正确形态（当前）：只跟踪「缩进续行」。
  // 下面两条变异分别退回 ① 和 ②，场景 7 / 场景 8 各抓一个。
  {
    id: 'heartbeat-regex-eats-heading',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '收尾语正则退回「吞标题」版（保存一次就吞掉后面的 ## 标题）',
    from: '    const blockRe = /^[ \\t]*-[ \\t]*每轮(?:回复)?的?结尾[^\\n]*(?:\\n[ \\t]+[^\\n]*)*\\n?/m',
    to: '    const blockRe = /^[ \\t]*-[ \\t]*每轮(?:回复)?的?结尾[^\\n]*\\n(?:(?!^[ \\t]*-)[^\\n]*\\n?)*/m',
  },
  {
    id: 'heartbeat-regex-orphan-continuation',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '收尾语正则退回「不跟踪续行」版（用户折行时留下孤儿续行）',
    from: '    const blockRe = /^[ \\t]*-[ \\t]*每轮(?:回复)?的?结尾[^\\n]*(?:\\n[ \\t]+[^\\n]*)*\\n?/m',
    to: '    const blockRe = /^[ \\t]*-[ \\t]*每轮(?:回复)?的?结尾[^\\n]*\\n?/m',
  },
  // ---- 2026-11-16：删除分支不得内联另一个正则 ----
  //
  // 这条守的是**测试本身的盲区**，不是产品 bug。实测发现：
  // 行为测试测的是「blockRe 这个变量里的正则对不对」，如果调用处被改成
  // 内联正则（不用 blockRe 了），blockRe 本身没变 → 所有正则层面的断言全绿，
  // 而真正执行的代码已经坏了。变异实测确认那会 SURVIVED。
  // 修法是补一条源码级断言：「删除分支必须 current.replace(blockRe, '')」。
  {
    id: 'heartbeat-delete-inlines-regex',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '删除分支内联另一个正则（正则层测试全部无法感知）',
    from: "      updated = current.replace(blockRe, '')",
    to: "      updated = current.replace(/^[ \\t]*-[ \\t]*每轮(?:回复)?的?结尾[^\\n]*\\n?/m, '')",
  },
  // 注：2026-11-16 曾加过两条 `dup-guard-*` 变异，守的是「本轮已用 HTTP 写过
  // 则忽略正文标记」的防呆。该防呆已移除（它只能挡入库、挡不住渲染，
  // 真正的解法是把约束写进 policy.md 源头），所以对应变异一并删除 ——
  // 变异锚点指向已不存在的代码，留着只会变成 SKIP。
  {
    id: 'message-key-no-session',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: '去重键去掉 sessionId（跨会话撞键 → 被撞那条原文永久丢失）',
    // ⚠️ 锚点必须带 makeMessageKey 独有的 `return `${sid}:` 前缀。
    //    只写 `${turn ?? '?'}:${step ?? '?'}` 会匹配到别处（模板字符串形态在
    //    index.js 里不唯一），变异会静默打到错误的行上 —— 见 AGENTS.md
    //    「变异锚点必须唯一」。
    from: '  return `${sid}:${turn ?? \'?\'}:${step ?? \'?\'}`',
    to: '  return `${turn ?? \'?\'}:${step ?? \'?\'}`',
  },
  {
    id: 'message-key-uses-or',
    file: 'dsh-fatfishdream-memory/index.js',
    desc: 'sid 判定从 `=== undefined || === null` 改成 `||`（id=0 被当成缺失）',
    from: "  const sid = id === undefined || id === null ? '?' : String(id)",
    to: "  const sid = id ? String(id) : '?'",
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
  // ⚠️ 2026-11-16 改：原来无条件 exit(0)，于是「锚点失配」在自动检查里看不见。
  //
  // 它虽然不改文件，但**它就是这条防线是否存在的判据**：
  // 未匹配的变异在真跑时是 SKIP（= 没验证），与「通过了」完全相反。
  // 所以让它也能当把关用：全匹配才 0。
  if (matchedAll !== MUTATIONS.length) {
    const bad = MUTATIONS.length - matchedAll
    console.log(`\n❌ ${bad} 个变异点未匹配 —— 这些变异真跑会是 SKIP（防线不存在），先修锚点。`)
    process.exit(1)
  }
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
if (skipped > 0) {
  console.log('\n⏭️  SKIP = 这条防线不存在（不是「通过」）：')
  for (const r of results.filter((x) => x.status === 'SKIP')) {
    console.log(`  - ${r.id}: ${r.note}`)
  }
  console.log('   修法：把该变异的 \`from\` 片段更新成当前源码。')
}
if (errored > 0) {
  console.log('\n💥 ERROR = 这次结果不可信，先修 runner：')
  for (const r of results.filter((x) => x.status === 'ERROR')) {
    console.log(`  - ${r.id}: ${r.note}`)
  }
}

// ⚠️ 2026-11-16 改：SKIP 也算失败。
//
// 原逻辑只把 ERROR / SURVIVED 计入失败，**SKIP 不进任何计数** ——
// 于是锚点失配时输出「KILLED 26 / SURVIVED 0 / SKIP 1」并 exit 0，
// 看上去一切正常，而那条防线其实根本没被验证过。
// 实际踩过：`log-alive-write-broken` 的锚点因 `cleaned` → `finalText` 改名而失配，
// 流水写入链路的守护被静默移除，连续几轮回归全绿。
//
// SKIP 与 SURVIVED 的语义差别只在「原因」，相同的是**这一项没被验证**。
// 所以：没验证 = 不通过。
process.exit(errored === 0 && survived === 0 && skipped === 0 ? 0 : 1)
