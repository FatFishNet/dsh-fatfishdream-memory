/**
 * 回归测试：收尾语解析器与文件替换的**行为**（2026-11-20 补）。
 *
 * ============================================================
 * 为什么需要这个脚本（两段互不相干，各自都有真实事故）
 * ============================================================
 *
 * ## 段 A：`parseHeartbeatFromPolicy` —— 解析失败是静默的
 *
 * 这个函数 2026-11-19 刚被重构成「单一来源」（合并了原来 4 份重复实现）。
 * 而它的失效形态极其隐蔽：
 *
 *   · 解析不出来 → 返回 `''` → `countHeartbeat` 遇空串返回 `null` →
 *     `heartbeat-turn-verdict` 恒报 `missing`；
 *   · 看起来像「模型没加收尾语」，实际是**解析器坏了**；
 *   · 2026-11-19 当晚就因此排查了整整一轮，最后发现是
 *     **改好的代码根本没装载**（进程跑的还是旧解析器）。
 *
 * 所以这里必须逐条钉住四种形态：新句式 / 旧句式 / 行在但截不出 / 根本没有行。
 * 判据不是「函数没抛错」（它从不抛），而是**返回值的 found/value 对不对**。
 *
 * ## 段 B：`replaceFile` —— 写坏文件会丢用户的 policy.md
 *
 * 这是 `atomicWrite` 的底座。它的正常路径是 `rename` 一步到位，
 * 但 Windows 上目标文件被占用时会抛 `EPERM`/`EACCES`/`EEXIST`，
 * 于是走「先挪到 .bak，再写新的，失败就回滚」这条复杂路径。
 *
 * 这条路径**几乎从不在正常跑时执行**（只有文件被占用才走），
 * 所以它的正确性只能靠人造故障验证 —— 正是那种「写错了一百年都不会被发现、
 * 但一旦出事就丢用户规则文件」的代码。
 *
 * 断言的重点是：**任何失败分支都不许让目标文件消失**。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const INDEX = path.join(ROOT, 'dsh-fatfishdream-memory', 'index.js')
const SRC = fs.readFileSync(INDEX, 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}  ← ${detail}`)
  }
}

/** 从源码抽一个顶层函数（大括号配对）。找不到就抛，绝不静默跳过。 */
function extractFn(name, source = SRC) {
  const re = new RegExp(`^(?:async )?function ${name}\\(`, 'm')
  const m = re.exec(source)
  if (!m) throw new Error(`源码里找不到 function ${name}`)
  const start = m.index
  let depth = 0
  let i = source.indexOf('{', start)
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 的大括号不配对`)
}

// ============================================================
// 段 A：收尾语解析器
// ============================================================
console.log('=== A① 新句式（2026-11-19 起的主力）===\n')

const HEARTBEAT_START_M = SRC.match(/^const HEARTBEAT_START = '([^']*)'/m)
const HEARTBEAT_END_M = SRC.match(/^const HEARTBEAT_END = '([^']*)'/m)
const LEGACY_RE_LINE = SRC.match(/^const HEARTBEAT_LEGACY_RE = \/(.+)\/([a-z]*)$/m)
check('能取到 HEARTBEAT_START', HEARTBEAT_START_M !== null)
check('能取到 HEARTBEAT_END', HEARTBEAT_END_M !== null)
check('能取到 HEARTBEAT_LEGACY_RE', LEGACY_RE_LINE !== null)

const HEARTBEAT_START = HEARTBEAT_START_M?.[1] ?? ''
const HEARTBEAT_END = HEARTBEAT_END_M?.[1] ?? ''
const HEARTBEAT_LEGACY_RE = LEGACY_RE_LINE ? new RegExp(LEGACY_RE_LINE[1], LEGACY_RE_LINE[2]) : /$^/

// eslint-disable-next-line no-new-func
const parseHeartbeatFromPolicy = new Function(
  'HEARTBEAT_START', 'HEARTBEAT_END', 'HEARTBEAT_LEGACY_RE',
  `${extractFn('parseHeartbeatFromPolicy')}\nreturn parseHeartbeatFromPolicy`,
)(HEARTBEAT_START, HEARTBEAT_END, HEARTBEAT_LEGACY_RE)

{
  // 真实 policy.md 的新句式（从 buildHeartbeatLine 反向构造）
  const sample = `## 给模型的规则\n\n- 脚本执行成功**之后**，才允许在回复最后一行输出：大肥鱼是漂亮老婆！ 这句是**执行回执**，不是执行本身。\n\n## 简单用法\n`
  const r = parseHeartbeatFromPolicy(sample)
  check('新句式：found = true', r.found === true, JSON.stringify(r.found))
  check('新句式：解出句子且**保留句末标点**',
    r.value === '大肥鱼是漂亮老婆！', JSON.stringify(r.value))
  // 保留标点是刻意的：isHeartbeatLast 用 endsWith 判末行，去掉「！」会恒 false
  check('新句式：解析结果能被正文 endsWith 匹配',
    '正文\n\n大肥鱼是漂亮老婆！'.endsWith(r.value), '去掉标点会让末行判定失效')
}

console.log('\n=== A② 旧句式（模板尚未迁移的老用户）===\n')

{
  const sample = `- 每轮回复的结尾，加固定一句：我是一条鱼。这是会话的「心跳」，用来确认本轮执行完整。\n`
  const r = parseHeartbeatFromPolicy(sample)
  check('旧句式：found = true', r.found === true, JSON.stringify(r.found))
  check('旧句式：切掉执行说明后只剩句子', r.value === '我是一条鱼', JSON.stringify(r.value))
}

console.log('\n=== A③ 行在、但截不出句子（必须 found=true 且 value=""）===\n')

{
  // 这是最关键的一条：它区分「用户清空了收尾语」与「格式坏了」。
  // 旧实现两者都返回 ''，于是 format 坏了整整一天无人知道。
  const noColon = `- 脚本执行成功之后才允许在回复最后一行输出大肥鱼是漂亮老婆\n`
  const r1 = parseHeartbeatFromPolicy(noColon)
  check('缺冒号：found = true 但 value 为空', r1.found === true && r1.value === '',
    JSON.stringify(r1))

  const noStart = `## 别的规则\n- 随便写点什么\n`
  const r2 = parseHeartbeatFromPolicy(noStart)
  check('完全没有收尾语行：found = false', r2.found === false, JSON.stringify(r2))

  const empty = ''
  const r3 = parseHeartbeatFromPolicy(empty)
  check('空文件：found = false', r3.found === false, JSON.stringify(r3))
}

console.log('\n=== A④ 与写入端互为逆运算 ===\n')

{
  // buildHeartbeatLine 写进去的，parseHeartbeatFromPolicy 必须读得回来。
  // 这条约束 2026-11-19 被违反过一次（写入用旧句式、读取用新锚点）。
  const buildHeartbeatLine = new Function(
    'HEARTBEAT_START', 'HEARTBEAT_END',
    `${extractFn('buildHeartbeatLine')}\nreturn buildHeartbeatLine`,
  )(HEARTBEAT_START, HEARTBEAT_END)

  const sentences = ['大肥鱼是漂亮老婆！', '我是一条鱼。', '今天也要开心']
  for (const s of sentences) {
    const line = buildHeartbeatLine(s)
    const back = parseHeartbeatFromPolicy(`## 给模型的规则\n${line}\n`)
    check(`往返一致：${JSON.stringify(s)}`,
      back.found === true && back.value === s,
      `写进去 ${JSON.stringify(s)} 读回来 ${JSON.stringify(back.value)}`)
  }
}

console.log('\n=== A⑤ hasHeartbeatLine 与解析器同源 ===\n')

{
  const hasHeartbeatLine = new Function(
    'HEARTBEAT_START', 'HEARTBEAT_LEGACY_RE',
    `${extractFn('hasHeartbeatLine')}\nreturn hasHeartbeatLine`,
  )(HEARTBEAT_START, HEARTBEAT_LEGACY_RE)

  // 新句式 / 旧句式 / 都没有 —— 三态必须与 parse 的 found 一致
  const cases = [
    ['新句式', `- 脚本执行成功之后，才允许在回复最后一行输出：X！ 这句是回执`, true],
    ['旧句式', `- 每轮回复的结尾，加固定一句：X`, true],
    ['都没有', `## 别的\n- 随便`, false],
  ]
  for (const [label, text, want] of cases) {
    check(`hasHeartbeatLine(${label}) === ${want}`, hasHeartbeatLine(text) === want,
      String(hasHeartbeatLine(text)))
  }

  // 一致性：hasLine 为 true 时 parse 的 found 也必须是 true
  const sameText = `- 每轮回复的结尾，加固定一句：X`
  const a = hasHeartbeatLine(sameText)
  const b = parseHeartbeatFromPolicy(sameText).found
  check('两个函数的判定一致（否则会出现「说有行却解析不出」）', a === b, `has=${a} parse.found=${b}`)
}

// ============================================================
// 段 B：replaceFile 的失败路径
// ============================================================
console.log('\n=== B① 正常路径：一步 rename 到位 ===\n')

const resetFileSrc = extractFn('replaceFile')
// eslint-disable-next-line no-new-func
const makeReplaceFile = (deps) => new Function(
  'rename', 'unlink',
  `${resetFileSrc}\nreturn replaceFile`,
)(deps.rename, deps.unlink)

const realRename = (a, b) => fs.promises.rename(a, b)
const realUnlink = (p) => fs.promises.unlink(p)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-replacefile-'))

try {
  {
    const dir = path.join(TMP, 'normal')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'policy.md')
    const temp = path.join(dir, 'policy.md.tmp')
    fs.writeFileSync(target, 'OLD', 'utf8')
    fs.writeFileSync(temp, 'NEW', 'utf8')

    const replaceFile = makeReplaceFile({ rename: realRename, unlink: realUnlink })
    await replaceFile(temp, target)

    check('正常路径：内容已换新', fs.readFileSync(target, 'utf8') === 'NEW')
    check('正常路径：临时文件已消失', !fs.existsSync(temp))
    const baks = fs.readdirSync(dir).filter((f) => f.endsWith('.bak'))
    check('正常路径：没有留下 .bak', baks.length === 0, baks.join(','))
  }

  console.log('\n=== B② 目标被占用（EPERM）→ 走 .bak 换手 ===\n')

  {
    const dir = path.join(TMP, 'ebusy')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'policy.md')
    const temp = path.join(dir, 'policy.md.tmp')
    fs.writeFileSync(target, 'OLD', 'utf8')
    fs.writeFileSync(temp, 'NEW', 'utf8')

    // 第一次 rename(temp→target) 抛 EPERM（模拟 Windows 文件被占用），
    // 之后放行 —— 这样能精确走到 .bak 分支。
    let call = 0
    const flakyRename = async (a, b) => {
      call++
      if (call === 1) {
        const e = new Error('EPERM: operation not permitted')
        e.code = 'EPERM'
        throw e
      }
      return realRename(a, b)
    }

    const replaceFile = makeReplaceFile({ rename: flakyRename, unlink: realUnlink })
    await replaceFile(temp, target)

    check('EPERM 后仍然写成功', fs.readFileSync(target, 'utf8') === 'NEW')
    check('EPERM 后临时文件已清理', !fs.existsSync(temp))
    const baks = fs.readdirSync(dir).filter((f) => f.endsWith('.bak'))
    check('成功后 .bak 被清理', baks.length === 0, baks.join(','))
  }

  console.log('\n=== B③ ★ 回滚：写新文件失败时，原文件必须还在 ===\n')

  {
    // 这是本段最重要的一条。若回滚写错，用户的 policy.md 会**凭空消失**。
    const dir = path.join(TMP, 'rollback')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'policy.md')
    const temp = path.join(dir, 'policy.md.tmp')
    fs.writeFileSync(target, 'ORIGINAL CONTENT', 'utf8')
    fs.writeFileSync(temp, 'NEW', 'utf8')

    // 序列：① temp→target 抛 EPERM → ② target→bak 成功 → ③ temp→target 失败
    let call = 0
    const failThird = async (a, b) => {
      call++
      if (call === 1) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
      if (call === 3) { const e = new Error('ENOSPC: no space left'); e.code = 'ENOSPC'; throw e }
      return realRename(a, b)
    }

    const replaceFile = makeReplaceFile({ rename: failThird, unlink: realUnlink })
    let threw = false
    let msg = ''
    try {
      await replaceFile(temp, target)
    } catch (e) {
      threw = true
      msg = e?.message ?? String(e)
    }

    check('写入失败时抛出（不静默成功）', threw === true, '没抛 → 调用方会以为写成功了')
    check('★ 原文件内容完好无损（回滚成功）',
      fs.existsSync(target) && fs.readFileSync(target, 'utf8') === 'ORIGINAL CONTENT',
      fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '(文件不见了！)')
    check('失败后临时文件已清理', !fs.existsSync(temp))
  }

  console.log('\n=== B④ 回滚也失败：必须把 .bak 路径告诉调用方 ===\n')

  {
    const dir = path.join(TMP, 'doublefail')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'policy.md')
    const temp = path.join(dir, 'policy.md.tmp')
    fs.writeFileSync(target, 'ORIGINAL', 'utf8')
    fs.writeFileSync(temp, 'NEW', 'utf8')

    // ① temp→target EPERM → ② target→bak 成功 → ③ temp→target 失败 → ④ bak→target 也失败
    let call = 0
    const failTwice = async (a, b) => {
      call++
      if (call === 1) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
      if (call === 3) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e }
      if (call === 4) { const e = new Error('EIO'); e.code = 'EIO'; throw e }
      return realRename(a, b)
    }

    const replaceFile = makeReplaceFile({ rename: failTwice, unlink: realUnlink })
    let msg = ''
    try {
      await replaceFile(temp, target)
    } catch (e) {
      msg = e?.message ?? String(e)
    }

    // 这条断言守的是「用户知不知道去哪里找自己的文件」
    check('双重失败时错误信息里带 .bak 路径',
      msg.includes('.bak'), msg || '(没有错误信息)')
    check('双重失败时错误信息说明了这是回滚失败',
      msg.includes('回滚失败'), msg)
    // 而且原内容必须真的还在那个 .bak 里
    const bakPath = fs.readdirSync(dir).find((f) => f.endsWith('.bak'))
    check('原内容确实保存在 .bak 里',
      bakPath !== undefined && fs.readFileSync(path.join(dir, bakPath), 'utf8') === 'ORIGINAL',
      bakPath ?? '(没有 .bak 文件)')
  }

  console.log('\n=== B⑤ 不可恢复的错误：不该走 .bak 分支 ===\n')

  {
    // ENOENT（源临时文件不存在）属于真错误，必须直接抛，不能去折腾目标文件。
    const dir = path.join(TMP, 'enoent')
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, 'policy.md')
    const temp = path.join(dir, 'nonexistent.tmp')
    fs.writeFileSync(target, 'ORIGINAL', 'utf8')

    const replaceFile = makeReplaceFile({ rename: realRename, unlink: realUnlink })
    let threw = false
    try {
      await replaceFile(temp, target)
    } catch {
      threw = true
    }

    check('ENOENT 被抛出（不当作可恢复错误）', threw === true)
    check('ENOENT 时目标文件未受影响',
      fs.readFileSync(target, 'utf8') === 'ORIGINAL')
    const baks = fs.readdirSync(dir).filter((f) => f.endsWith('.bak'))
    check('ENOENT 时没有产生 .bak', baks.length === 0, baks.join(','))
  }

  console.log('\n=== B⑥ 自证：去掉回滚，断言必须变红 ===\n')

  {
    // 把「回滚」那段（bak→target）换成空操作，重跑 B③ 的核心断言。
    const ROLLBACK_ANCHOR = '      await rename(backupPath, targetPath)'
    const n = resetFileSrc.split(ROLLBACK_ANCHOR).length - 1
    check('自证锚点唯一（回滚语句）', n === 1, `实际 ${n} 处`)

    if (n === 1) {
      const brokenSrc = resetFileSrc.replace(
        ROLLBACK_ANCHOR,
        '      // mutated: 回滚被移除',
      )

      const dir = path.join(TMP, 'selfproof')
      fs.mkdirSync(dir, { recursive: true })
      const target = path.join(dir, 'policy.md')
      const temp = path.join(dir, 'policy.md.tmp')
      fs.writeFileSync(target, 'ORIGINAL', 'utf8')
      fs.writeFileSync(temp, 'NEW', 'utf8')

      let call = 0
      const failThird = async (a, b) => {
        call++
        if (call === 1) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e }
        if (call === 3) { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e }
        return realRename(a, b)
      }
      // eslint-disable-next-line no-new-func
      const brokenReplace = new Function('rename', 'unlink',
        `${brokenSrc}\nreturn replaceFile`)(failThird, realUnlink)

      try { await brokenReplace(temp, target) } catch {}

      // 移除回滚后，目标文件应当消失了 —— 证明 B③ 的断言不是恒真
      const gone = !fs.existsSync(target)
      check('自证：去掉回滚后原文件确实消失（证明 B③ 的断言能红）', gone === true,
        gone ? '' : '文件居然还在 → B③ 的断言可能恒绿')
    }
  }
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
