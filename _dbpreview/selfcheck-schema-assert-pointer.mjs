/**
 * 回归测试：`assertSupportedSchema` 与 `pointerPath`（2026-11-20 补）。
 *
 * ============================================================
 * 为什么这两个要单独补
 * ============================================================
 *
 * 覆盖扫描（`grep <函数名> _dbpreview/`）查出 62 个顶层函数里
 * **这两个从来没被任何回归脚本碰过**。逐个核实后发现性质完全不同：
 *
 * ## A. `assertSupportedSchema` —— 死代码（已登记白名单）
 *
 * 它是「注册工具前的 schema 自检」，而**硬约束 1 让本插件永久不注册工具**
 * （`tools-none`）。所以它从第一天起就没有调用点。
 *
 * **它是怎么躲过死代码检测的**：`usageOf` 原来只跳过定义行，
 * 而它在函数体内**递归调用自己两次** → 被算成「有引用」。
 * 2026-11-20 修了 `usageOf`（排除自递归）后才暴露。
 *
 * **为什么还要测一个死函数**：
 *   ① 它被**保留**在白名单里（换 adapter 后可能重启工具路线），
 *      所以要证明它**留着的时候是对的**，不是一段写坏的死代码；
 *   ② 它的行为（拒绝 `json` 简写、拒绝未知键、递归进 properties/items）
 *      是**宿主契约的知识样本**，测它等于把那份知识固化下来。
 *
 * ## B. `pointerPath` —— 有真实调用点，但从未被单独验证
 *
 * `readPointer` / `writePointer` 都靠它定位指针文件。
 * 它错位的后果：**指针读不到 → 每次启动回退到盘符探测 → 用户的自定义记忆根静默丢失**。
 * 这种失效不报错、不写日志，只是「下次启动位置变了」。
 *
 * 它还依赖 `homedir()`，所以**只能靠注入假 homedir 来测** —— 绝不能碰真实 home。
 */
import fs from 'node:fs'
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

/** 从源码抽一个顶层函数（大括号配对）。 */
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
// A. assertSupportedSchema
// ============================================================
console.log('=== A① 合法 schema：必须通过 ===\n')

// eslint-disable-next-line no-new-func
const assertSupportedSchema = new Function(
  `${extractFn('assertSupportedSchema')}\nreturn assertSupportedSchema`,
)()

{
  // 最小合法：空对象
  check('空 schema 通过', assertSupportedSchema({}) === true)

  // 七种合法 type（宿主的白名单）
  const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  for (const t of TYPES) {
    let ok = false
    try { ok = assertSupportedSchema({ type: t }) === true } catch { ok = false }
    check(`type: '${t}' 被接受`, ok)
  }

  // 带 annotation 与 constraint
  check('带 description 通过',
    assertSupportedSchema({ type: 'string', description: '说明' }) === true)
  check('带 enum 通过',
    assertSupportedSchema({ type: 'string', enum: ['a', 'b'] }) === true)
  check('带 required + properties 通过',
    assertSupportedSchema({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: false,
    }) === true)
}

console.log('\n=== A② 非法 schema：必须抛出（这是它存在的理由）===\n')

{
  // ★ 核心：'json' 简写 —— 宿主会拒绝，注释里点名的那个案例
  let threw = false
  let msg = ''
  try { assertSupportedSchema({ type: 'json' }) } catch (e) { threw = true; msg = e.message }
  check("type: 'json' 被拒绝（宿主不认这个简写）", threw === true, msg)
  check('错误信息里列出合法 type', msg.includes('object') && msg.includes('string'), msg)

  // 未知键
  threw = false
  try { assertSupportedSchema({ type: 'string', weird: 1 }) } catch (e) { threw = true }
  check('未知键被拒绝', threw === true)

  // type 拼错
  threw = false
  try { assertSupportedSchema({ type: 'str' }) } catch { threw = true }
  check("type: 'str' 被拒绝", threw === true)

  // additionalProperties 必须布尔
  threw = false
  try { assertSupportedSchema({ type: 'object', additionalProperties: 'yes' }) } catch { threw = true }
  check('additionalProperties 非布尔被拒绝', threw === true)

  // properties 必须是对象
  threw = false
  try { assertSupportedSchema({ type: 'object', properties: [] }) } catch { threw = true }
  check('properties 是数组被拒绝', threw === true)

  // 顶层不是对象
  for (const notObj of [null, [], 'str', 42, true]) {
    threw = false
    try { assertSupportedSchema(notObj) } catch { threw = true }
    check(`顶层是 ${JSON.stringify(notObj)} 被拒绝`, threw === true)
  }
}

console.log('\n=== A③ 递归：嵌套的坏 schema 也要被抓到 ===\n')

{
  // ★ 这条守的是「递归进 properties」—— 只校验顶层就漏掉嵌套的坏定义
  let threw = false
  let msg = ''
  try {
    assertSupportedSchema({
      type: 'object',
      properties: { inner: { type: 'json' } },
    })
  } catch (e) { threw = true; msg = e.message }
  check('properties 里的坏 type 被抓到', threw === true, msg)
  check('错误路径带 properties.inner（能定位到哪一层）',
    msg.includes('properties') && msg.includes('inner'), msg)

  // ★ 同理，items
  threw = false
  msg = ''
  try {
    assertSupportedSchema({ type: 'array', items: { type: 'nope' } })
  } catch (e) { threw = true; msg = e.message }
  check('items 里的坏 type 被抓到', threw === true, msg)
  check('错误路径带 items', msg.includes('items'), msg)

  // 深层嵌套（三层）
  threw = false
  try {
    assertSupportedSchema({
      type: 'object',
      properties: {
        a: { type: 'object', properties: { b: { type: 'array', items: { type: 'bad' } } } },
      },
    })
  } catch { threw = true }
  check('三层嵌套的坏 type 被抓到', threw === true)
}

// ============================================================
// B. pointerPath
// ============================================================
console.log('\n=== B① pointerPath：路径形状 ===\n')

{
  // 注入假 homedir，绝不碰真实 home
  const FAKE_HOME = path.sep === '\\' ? 'C:\\Users\\__fake__' : '/home/__fake__'

  // eslint-disable-next-line no-new-func
  const pointerPath = new Function(
    'homedir', 'join',
    `${extractFn('pointerPath')}\nreturn pointerPath`,
  )(() => FAKE_HOME, path.join)

  const p = pointerPath()

  check('返回字符串', typeof p === 'string', String(p))
  check('落在 .dsh 子目录下', p.includes(`${path.sep}.dsh${path.sep}`), p)
  check('文件名是 memory-root.json', p.endsWith('memory-root.json'), p)
  check('以假 home 开头（用的是注入的 homedir，不是真实用户目录）',
    p.startsWith(FAKE_HOME), p)
  // 绝对路径（readPointer/writePointer 直接拿它做 IO）
  check('是绝对路径', path.isAbsolute(p), p)

  // 幂等：调两次必须一样（否则 read 和 write 会指向不同文件）
  check('两次调用结果一致（read/write 才指向同一个文件）',
    pointerPath() === pointerPath(), `${pointerPath()} vs ${pointerPath()}`)
}

console.log('\n=== B② pointerPath：homedir 抛错时返回 undefined ===\n')

{
  // 这是它唯一的错误分支。忘了它的话，某些环境下整个插件启动就会崩。
  // eslint-disable-next-line no-new-func
  const pointerPathBroken = new Function(
    'homedir', 'join',
    `${extractFn('pointerPath')}\nreturn pointerPath`,
  )(() => { throw new Error('no home') }, path.join)

  let got
  let threw = false
  try { got = pointerPathBroken() } catch { threw = true }

  check('homedir 抛错时不向外抛（自己吞掉）', threw === false)
  check('homedir 抛错时返回 undefined', got === undefined, String(got))
}

console.log('\n=== B③ 一致性：pointerPath 与文档/注释里写的路径一致 ===\n')

{
  // 源码注释与 AGENTS.md 都写 `~/.dsh/memory-root.json`。
  // 这条断言防的是「实现改了、文档没改」—— 那种不一致会让排障时看错文件。
  const FAKE_HOME = path.sep === '\\' ? 'C:\\Users\\__fake__' : '/home/__fake__'
  // eslint-disable-next-line no-new-func
  const pointerPath = new Function('homedir', 'join',
    `${extractFn('pointerPath')}\nreturn pointerPath`)(() => FAKE_HOME, path.join)

  const rel = pointerPath().slice(FAKE_HOME.length).split(path.sep).filter(Boolean)
  check('相对部分正好是 [".dsh", "memory-root.json"]',
    rel.length === 2 && rel[0] === '.dsh' && rel[1] === 'memory-root.json',
    JSON.stringify(rel))

  // 注释里承诺的文件名必须与实现一致
  const docMentions = (SRC.match(/memory-root\.json/g) ?? []).length
  check('源码注释里出现 memory-root.json（至少 2 处说明有文档化）',
    docMentions >= 2, `出现 ${docMentions} 次`)
}

console.log('\n=== B④ POINTER_FILE 常量是遗留死常量（记录事实，不是断言正确性）===\n')

{
  // ⚠️ 本段**不断言它应该存在或应该删** —— 那是人的决定。
  // 只把事实摆出来：这个常量的值与实际使用的文件名**不一致**，
  // 且零引用。若哪天有人「顺手用它」，会把指针写到错误的文件名上。
  const m = SRC.match(/^const POINTER_FILE = '([^']+)'/m)
  check('POINTER_FILE 常量存在（记录现状）', m !== null, m?.[1] ?? '(未找到)')

  if (m) {
    // 它没有被 pointerPath 使用 —— 这是「值不一致却无人发现」的原因
    const usesInPointerPath = /function pointerPath\(\)[\s\S]{0,300}?POINTER_FILE/.test(SRC)
    check('pointerPath 不使用 POINTER_FILE（所以它错着也没人发现）',
      usesInPointerPath === false)

    // 记录它的值与实际文件名不同
    const actualName = 'memory-root.json'
    if (m[1] !== actualName) {
      console.log(`   ⚠️  POINTER_FILE='${m[1]}' 与实际文件名 '${actualName}' 不一致，`)
      console.log('       且全文件零引用 —— 这是「工具路线遗留」，不是 bug（不影响行为）')
    }
    // 断言：它确实是零引用（除定义行）
    const lines = SRC.split('\n')
    const defIdx = lines.findIndex((l) => /^const POINTER_FILE/.test(l))
    const refs = lines.filter((l, i) =>
      i !== defIdx && /\bPOINTER_FILE\b/.test(l) && !/^\s*(\/\/|\*)/.test(l)).length
    check('POINTER_FILE 零外部引用（确认是死常量）', refs === 0, `引用 ${refs} 处`)
  }
}

// ============================================================
console.log('\n=== C 自证：改坏实现，断言必须变红 ===\n')

{
  // 自证 1：把递归那两行去掉 → 嵌套坏 schema 不再被抓到
  const src = extractFn('assertSupportedSchema')
  const RECURSE_PROPS = '      assertSupportedSchema(child, `${path}.properties.${name}`)'
  const n1 = src.split(RECURSE_PROPS).length - 1
  check('自证锚点唯一（properties 递归）', n1 === 1, `实际 ${n1} 处`)

  if (n1 === 1) {
    // eslint-disable-next-line no-new-func
    const broken = new Function(
      `${src.replace(RECURSE_PROPS, '      // mutated: 不再递归进 properties')}\nreturn assertSupportedSchema`,
    )()
    let threw = false
    try {
      broken({ type: 'object', properties: { inner: { type: 'json' } } })
    } catch { threw = true }
    check('自证：去掉 properties 递归后，嵌套坏 schema 不再被拒绝（证明 A③ 的断言能红）',
      threw === false)
  }

  // 自证 2：把 pointerPath 的 join 改成写死路径 → 不听 homedir
  const pSrc = extractFn('pointerPath')
  const JOIN_CALL = "    return join(homedir(), '.dsh', 'memory-root.json')"
  const n2 = pSrc.split(JOIN_CALL).length - 1
  check('自证锚点唯一（pointerPath 的 return）', n2 === 1, `实际 ${n2} 处`)

  if (n2 === 1) {
    // eslint-disable-next-line no-new-func
    const broken = new Function('homedir', 'join',
      `${pSrc.replace(JOIN_CALL, "    return join('C:\\\\fixed', '.dsh', 'memory-root.json')")}\nreturn pointerPath`,
    )(() => '/home/u', path.join)
    check('自证：写死路径后不再依赖 homedir（证明 B① 的断言能红）',
      broken() !== path.join('/home/u', '.dsh', 'memory-root.json'),
      broken())
  }
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
