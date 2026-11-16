/**
 * 回归测试：policy.md 一次性覆盖（syncPolicyOnce）的真实行为。
 *
 * 为什么这个脚本必须存在（2026-11-16 事故复盘）：
 *
 *   之前整个「升级时覆盖 policy.md」的代码**从来没有被真正执行过**。
 *   唯一的测试是 selfcheck-log-alive 里的三条正则，它们查的是「源码里有没有
 *   这两个哨兵、有没有回写 state」—— 查的是**代码的存在**，不是**代码的行为**。
 *
 *   于是 34/34 回归全绿、34/34 变异 KILLED，却漏掉一个真实 bug：
 *   老用户升级时，syncPolicyOnce 用 POLICY_TEMPLATE 覆盖 policy.md，
 *   而模板里**没有**「每轮收尾语」那一行（它是用户私人偏好，按硬约束 9
 *   不能夹带进模板），于是用户手写的收尾语、以及任何模板没有的手写段落，
 *   **在覆盖时全部丢失**，且当时根目录里没有任何备份可捞。
 *
 * 本脚本直接用 `import { createStore } from '../dsh-fatfishdream-memory/index.js'`
 * **执行真实代码**（不是复制一份逻辑、不是查源码文本），在临时目录造出
 * 各种用户状态，断言覆盖后的真实文件内容。这才是「测试」该有的样子。
 *
 * 与 selfcheck-emotion-limiter 同一个原则：不复刻逻辑，直接执行源码。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../dsh-fatfishdream-memory/index.js'

let pass = 0
let fail = 0
const bad = []

function check(name, ok, detail = '') {
  if (ok) {
    pass++
  } else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}  ← ${detail}`)
  }
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-policy-sync-'))
}

function mkStore(root) {
  return createStore({ root, factsBytes: 8000, projectBytes: 8000, policyBytes: 8000 })
}

function writeOldUser(root, { heartbeat = true, custom = true } = {}) {
  const lines = ['# 记忆规则', '', '## 给模型的规则', '', '- 旧规则：写记忆只能用正文标记。']
  if (heartbeat) {
    lines.push('- 每轮回复的结尾，加固定一句：你可爱的大肥鱼一直都在，等待下一轮任务！')
  }
  if (custom) {
    lines.push('', '## 其他', '用户手写的重要内容，绝不能被删。')
  }
  fs.writeFileSync(path.join(root, 'policy.md'), lines.join('\n') + '\n')
  // 老用户：state.json 里没有 policySyncVersion 字段
  fs.writeFileSync(path.join(root, 'state.json'),
    JSON.stringify({ version: 2, lastConsolidate: null, projects: {}, ambiguous: [] }, null, 2))
}

// ── 场景1：老用户升级（含收尾语 + 手写段落）────────────────────────
{
  const root = tmp()
  writeOldUser(root)
  const store = mkStore(root)
  const r = await store.ensureLayout()
  const t = fs.readFileSync(path.join(root, 'policy.md'), 'utf8')

  check('场景1：返回 written', r?.written === true, JSON.stringify(r))
  check('场景1：收尾语被写回', t.includes('你可爱的大肥鱼一直都在'), '收尾语随覆盖丢失，未写回')
  check('场景1：写入 sync 标记', t.includes('policy-sync'))
  check('场景1：旧规则已被新规则替换', !t.includes('写记忆只能用正文标记'))
  check('场景1：生成了备份文件', fs.existsSync(path.join(root, 'policy.md.pre-sync')))
  const bak = fs.readFileSync(path.join(root, 'policy.md.pre-sync'), 'utf8')
  check('场景1：备份含手写段落', bak.includes('绝不能被删'), '备份应是旧文件原样')
  check('场景1：备份含旧收尾语', bak.includes('大肥鱼'))
  check('场景1：heartbeatRestored 标记为 true', r?.heartbeatRestored === true)
  check('场景1：backedUp 标记为 true', r?.backedUp === true)
  fs.rmSync(root, { recursive: true, force: true })
}

// ── 场景2：第二次启动不再覆盖 ──────────────────────────────────────
{
  const root = tmp()
  writeOldUser(root)
  const store = mkStore(root)
  await store.ensureLayout()
  // 用户升级后又手写一条
  fs.appendFileSync(path.join(root, 'policy.md'), '\n- 升级后新增的规则，务必保住。\n')
  const sizeBefore = fs.statSync(path.join(root, 'policy.md')).size
  const r2 = await store.ensureLayout()
  const t2 = fs.readFileSync(path.join(root, 'policy.md'), 'utf8')
  check('场景2：第二次启动返回 null（已同步）', r2 === null, JSON.stringify(r2))
  check('场景2：未再覆盖', fs.statSync(path.join(root, 'policy.md')).size === sizeBefore)
  check('场景2：升级后规则还在', t2.includes('务必保住'))
  check('场景2：收尾语还在', t2.includes('大肥鱼'))
  fs.rmSync(root, { recursive: true, force: true })
}

// ── 场景3：state.json 丢了但文件有 sync 标记（换机器）────────────────
{
  const root = tmp()
  writeOldUser(root)
  const store = mkStore(root)
  await store.ensureLayout()
  fs.rmSync(path.join(root, 'state.json'), { force: true })
  const sizeBefore = fs.statSync(path.join(root, 'policy.md')).size
  const r3 = await store.ensureLayout()
  check('场景3：返回 skipped/marked 或 null', r3 === null || r3?.skipped, JSON.stringify(r3))
  check('场景3：未再覆盖', fs.statSync(path.join(root, 'policy.md')).size === sizeBefore)
  // state.json 应被补记（marked 分支会回写 state）
  // ⚠️ 2026-11-17：版本从 1 升到 2（方案 D），补记的值随之变为 2。
  // 这条断言**故意写死版本号** —— 改版本时必须显式改这里，
  // 否则「版本号悄悄变了、补记的还是旧值」这种错会被漏掉。
  check('场景3：state 已补记', JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).policySyncVersion === 2)
  fs.rmSync(root, { recursive: true, force: true })
}

// ── 场景4：无收尾语的老用户（不应写回空收尾语行）─────────────────────
{
  const root = tmp()
  writeOldUser(root, { heartbeat: false })
  const store = mkStore(root)
  const r = await store.ensureLayout()
  const t = fs.readFileSync(path.join(root, 'policy.md'), 'utf8')
  check('场景4：返回 written', r?.written === true)
  check('场景4：不产生空的收尾语行', !/加固定一句：\s*$/.test(t), '写回了空收尾语')
  check('场景4：heartbeatRestored 为 false', r?.heartbeatRestored === false)
  check('场景4：仍生成了备份', fs.existsSync(path.join(root, 'policy.md.pre-sync')))
  fs.rmSync(root, { recursive: true, force: true })
}

// ── 场景5：全新安装（policy.md 不存在，不应产生冗余备份）──────────────
{
  const root = tmp()
  const store = mkStore(root)
  const r = await store.ensureLayout()
  check('场景5：返回 written', r?.written === true)
  check('场景5：policy.md 存在', fs.existsSync(path.join(root, 'policy.md')))
  check('场景5：不产生冗余备份', !fs.existsSync(path.join(root, 'policy.md.pre-sync')), '全新安装不应备份模板本体')
  check('场景5：backedUp 为 false', r?.backedUp === false)
  fs.rmSync(root, { recursive: true, force: true })
}

// ── 场景6：覆盖后的 policy.md 能被收尾语读取函数正确读到 ──────────────
{
  const root = tmp()
  writeOldUser(root)
  const store = mkStore(root)
  await store.ensureLayout()
  const t = fs.readFileSync(path.join(root, 'policy.md'), 'utf8')
  // 覆盖后写入的那一行必须是合法的收尾语格式（能被 readHeartbeat 的正则匹配）
  const line = t.match(/^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*$/m)
  check('场景6：覆盖后有合法的收尾语行', line !== null)
  check('场景6：收尾语行含执行说明', /这是会话的/.test(line?.[0] ?? ''), '执行说明缺失，GUI 读取会不一致')
  fs.rmSync(root, { recursive: true, force: true })
}

// ── 场景7：收尾语替换不得吞掉后续标题（2026-11-16 实锤事故）─────────────
//
// 事故经过：writeHeartbeat 原用
//   /^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*\n(?:(?!^[ \t]*-)[^\n]*\n?)*/m
// 那个续行跟踪会吞掉所有不以 `-` 开头的行。用户 policy.md 里收尾语后面紧跟
// `## 强制录入：用户的情绪表达`，一次 GUI 保存就把标题连空行一起吃掉：
// 13850 → 13791 字节、232 → 230 行，**没有任何报错**。
//
// 这里用**真实文件结构**（收尾语 + 空行 + ## 标题）验证修复。
// 为什么不能只查源码文本：那个正则的行为要真的跑一遍才看得见 ——
// 正是「只查文本、不跑行为」让这个 bug 活了这么久。
{
  // 从源码里提取真实的 blockRe 定义（保证测的是生产代码，不是抄一份）
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'dsh-fatfishdream-memory', 'index.js'),
    'utf8',
  )
  const blockReDefs = [...src.matchAll(/const blockRe = (\/[^\n]+\/m)/g)].map((m) => m[1])
  check('场景7：源码里能找到 blockRe 定义', blockReDefs.length > 0, `找到 ${blockReDefs.length} 处`)

  // 用真实文件同构内容：收尾语后面紧跟空行 + 二级标题
  const sample = [
    '# 记忆规则', '', '## 给模型的规则', '',
    '- **写记忆只能用 HTTP 接口**', '- **查记忆**：用 pwsh 请求', '',
    '- 每轮回复的结尾，加固定一句：你可爱的大肥鱼一直都在！', '',
    '## 强制录入：用户的情绪表达（不可关闭）',
    '- 用户在对话里表达情绪时，插件自动写入。', '',
    '## 记什么', '- 内容', '',
  ].join('\n')

  // 对源码里**每一处** blockRe 都验一遍（writeHeartbeat 与 restoreHeartbeat 各一处）
  for (const [i, reSrc] of blockReDefs.entries()) {
    const re = eval(reSrc) // eslint-disable-line no-eval
    const m = sample.match(re)
    check(`场景7：第${i + 1}处 blockRe 不吞「强制录入」标题`,
      m === null || !m[0].includes('强制录入'),
      m ? `实际匹配: ${JSON.stringify(m[0].slice(0, 80))}` : '')
    check(`场景7：第${i + 1}处 blockRe 不吞「记什么」标题`,
      m === null || !m[0].includes('记什么'))

    // 替换后其余内容必须完好
    const updated = sample.replace(re, '- 每轮回复的结尾，加固定一句：新句。说明\n')
    check(`场景7：第${i + 1}处替换后标题仍在`,
      updated.includes('## 强制录入：用户的情绪表达（不可关闭）') && updated.includes('## 记什么'))
    check(`场景7：第${i + 1}处替换后前文仍在`, updated.includes('写记忆只能用 HTTP 接口'))
    check(`场景7：第${i + 1}处替换后旧收尾语已换`,
      !updated.includes('你可爱的大肥鱼一直都在'), '旧收尾语残留')
  }
}

// ── 场景8：收尾语被手动折行时，替换不得留下孤儿续行（2026-11-16 二次修正）──
//
// 这个场景是修场景7 时**自己引入的回归**，必须一起钉死：
//   ① 旧正则吞标题（场景7 守）
//   ② 我第一步修复把续行跟踪整个删掉 → 用户若手写成两行，
//      替换后留下孤立的缩进续行（本场景守）
//   ③ 最终形态：只跟踪「缩进续行」`(?:\n[ \t]+[^\n]*)*\n?`，两个都不得发生
{
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'dsh-fatfishdream-memory', 'index.js'),
    'utf8',
  )
  const blockReDefs = [...src.matchAll(/const blockRe = (\/[^\n]+\/m)/g)].map((m) => m[1])

  // 用户手写折行：收尾语第一行 + 缩进续行，后面紧跟空行 + 标题
  const wrapped = [
    '# 记忆规则', '', '## 给模型的规则', '',
    '- 每轮回复的结尾，加固定一句：你可爱的大肥鱼一直都在！',
    '  这是会话的「心跳」，用来确认本轮执行完整。', '',
    '## 强制录入：用户的情绪表达（不可关闭）',
    '- 用户在对话里表达情绪时，插件自动写入。', '',
  ].join('\n')

  for (const [i, reSrc] of blockReDefs.entries()) {
    const re = eval(reSrc) // eslint-disable-line no-eval
    const updated = wrapped.replace(re, '- 每轮回复的结尾，加固定一句：新句。说明\n')

    check(`场景8：第${i + 1}处 折行续行被一并替换（不留孤儿）`,
      !updated.includes('这是会话的「心跳」，用来确认本轮执行完整。'),
      '留下孤立的缩进续行 —— 说明正则又退回「不跟踪续行」的老毛病')
    check(`场景8：第${i + 1}处 折行场景下标题仍在`,
      updated.includes('## 强制录入：用户的情绪表达（不可关闭）'),
      '折行场景下又吞了标题')
    check(`场景8：第${i + 1}处 折行场景下旧收尾语已换`,
      !updated.includes('你可爱的大肥鱼一直都在'))
    check(`场景8：第${i + 1}处 折行场景下前文仍在`,
      updated.includes('- **写记忆只能用 HTTP 接口**') || updated.includes('## 给模型的规则'))
    // 新句只出现一次（不能因为匹配多行而重复插入）
    const count = (updated.match(/新句。说明/g) || []).length
    check(`场景8：第${i + 1}处 新句只插入一次`, count === 1, `实际 ${count} 次`)
  }
}

// ── 场景9：删除收尾语分支（前八轮从未测过）────────────────────────────
//
// writeHeartbeat 有两条分支：写入（text 非空）与**删除**（text 为空）。
// 前八轮的测试只覆盖了写入分支 —— 删除分支的 `current.replace(blockRe, '')`
// 从来没被执行过。这里用源码里的真实正则跑三种位置。
{
  const src = fs.readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')), '..', 'dsh-fatfishdream-memory', 'index.js'),
    'utf8',
  )
  const blockReDefs = [...src.matchAll(/const blockRe = (\/[^\n]+\/m)/g)].map((m) => m[1])

  // ★ 源码级断言：删除分支必须**复用 blockRe 变量**，不能自己内联一个正则。
  //
  // 为什么必须有这条：2026-11-16 实测发现盲区 —— 上面那些 replace 测的是
  // 「blockRe 这个正则对不对」，但如果有人把调用处改成内联正则
  // （`current.replace(/^...\n?/m, '')`），blockRe 本身没变、上面全绿，
  // 而**真正执行的代码已经坏了**。变异实测：这么改会 SURVIVED。
  // 所以行为测试必须配一条「调用点确实用 blockRe」的源码断言。
  const deleteUsesBlockRe = /if \(text === ''\)[\s\S]{0,120}?current\.replace\(blockRe, ''\)/.test(src)
  check('场景9：删除分支复用 blockRe（未内联另一个正则）', deleteUsesBlockRe,
    '删除分支改成内联正则时，正则层面的测试全部无法感知')
  const writeUsesBlockRe = /current\.replace\(blockRe, `\$\{newLine\}\\n`\)/.test(src)
  check('场景9：写入分支复用 blockRe（未内联另一个正则）', writeUsesBlockRe)

  for (const [i, reSrc] of blockReDefs.entries()) {
    const re = eval(reSrc) // eslint-disable-line no-eval

    // 9a：收尾语在中间，删掉后前后两条规则必须仍在、且不被空行切断
    const mid = '## 给模型的规则\n\n- 规则A\n- 每轮回复的结尾，加固定一句：X\n- 规则B\n'
    const midOut = mid.replace(re, '')
    check(`场景9：第${i + 1}处 删除中间项后规则A仍在`, midOut.includes('- 规则A'))
    check(`场景9：第${i + 1}处 删除中间项后规则B仍在`, midOut.includes('- 规则B'))
    check(`场景9：第${i + 1}处 删除不切断列表`,
      !/\n\n- 规则B/.test(midOut), '多出空行会把 markdown 列表切成两段')
    check(`场景9：第${i + 1}处 删除后无残留收尾语`, !midOut.includes('每轮回复的结尾'))

    // 9b：收尾语是最后一行，删掉后不留空行尾巴
    const last = '## 给模型的规则\n\n- 规则A\n- 每轮回复的结尾，加固定一句：X\n'
    const lastOut = last.replace(re, '')
    check(`场景9：第${i + 1}处 删除末行后规则A仍在`, lastOut.includes('- 规则A'))
    check(`场景9：第${i + 1}处 删除末行后不留空行`, !/\n\n$/.test(lastOut), '尾部多出空行')

    // 9c：折行收尾语，续行必须一起删掉
    const wrapped = '## 给模型的规则\n\n- 每轮回复的结尾，加固定一句：X\n  续行说明\n- 规则B\n'
    const wrappedOut = wrapped.replace(re, '')
    check(`场景9：第${i + 1}处 删除折行时续行一并删`, !wrappedOut.includes('续行说明'))
    check(`场景9：第${i + 1}处 删除折行后规则B仍在`, wrappedOut.includes('- 规则B'))
  }
}

// ── 场景10：异常输入不应崩溃（state 损坏 / 空文件 / 重复收尾语）────────
//
// 这三个是跑边界时才想到的：真实环境里 state.json 被记事本存坏、
// policy.md 被清空、用户手滑写了两遍收尾语 —— 都会碰到。
{
  // 10a：state.json 是非法 JSON → 应照常覆盖，且收尾语/标题都保住
  {
    const root = tmp()
    fs.writeFileSync(
      path.join(root, 'policy.md'),
      '# 记忆规则\n\n## 给模型的规则\n\n- 每轮回复的结尾，加固定一句：用户的话\n\n## 强制录入\n- 内容\n',
    )
    fs.writeFileSync(path.join(root, 'state.json'), '{ 这不是合法 JSON ')
    const store = mkStore(root)
    let threw = false
    let r = null
    try {
      r = await store.ensureLayout()
    } catch {
      threw = true
    }
    check('场景10a：state.json 损坏时不抛异常', !threw)
    check('场景10a：仍完成覆盖', r?.written === true, JSON.stringify(r))
    const t = fs.readFileSync(path.join(root, 'policy.md'), 'utf8')
    check('场景10a：收尾语保住', t.includes('用户的话'))
    check('场景10a：标题保住', t.includes('## 强制录入') || t.includes('给模型的规则'))
    fs.rmSync(root, { recursive: true, force: true })
  }

  // 10b：policy.md 是空文件 → 写入模板，不崩溃
  {
    const root = tmp()
    fs.writeFileSync(path.join(root, 'policy.md'), '')
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ version: 2 }))
    const store = mkStore(root)
    let threw = false
    try {
      await store.ensureLayout()
    } catch {
      threw = true
    }
    check('场景10b：空 policy.md 不抛异常', !threw)
    const t = fs.readFileSync(path.join(root, 'policy.md'), 'utf8')
    check('场景10b：空文件被填入模板', t.includes('给模型的规则'))
    fs.rmSync(root, { recursive: true, force: true })
  }

  // 10c：用户写了两行收尾语 → 取第一行，不崩溃
  {
    const root = tmp()
    fs.writeFileSync(
      path.join(root, 'policy.md'),
      '# 记忆规则\n\n## 给模型的规则\n\n- 每轮回复的结尾，加固定一句：第一句\n- 别的规则\n- 每轮回复的结尾，加固定一句：第二句\n',
    )
    fs.writeFileSync(path.join(root, 'state.json'), JSON.stringify({ version: 2 }))
    const store = mkStore(root)
    let threw = false
    let r = null
    try {
      r = await store.ensureLayout()
    } catch {
      threw = true
    }
    check('场景10c：重复收尾语不抛异常', !threw)
    check('场景10c：仍完成覆盖', r?.written === true)
    const t = fs.readFileSync(path.join(root, 'policy.md'), 'utf8')
    // 只应保留一句（覆盖后是模板 + 写回的那一句）
    const hits = (t.match(/每轮回复的结尾/g) || []).length
    check('场景10c：覆盖后只剩一行收尾语', hits === 1, `实际 ${hits} 行`)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
if (bad.length) {
  console.log('\n失败明细：')
  for (const b of bad) console.log('  - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
