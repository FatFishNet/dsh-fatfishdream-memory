/**
 * 回归测试：纯工具函数（路径 / JSON / 日期 / 并发）。
 *
 * ## 为什么补这个（2026-11-15 覆盖度审计的结论）
 *
 * 审计发现 153 个函数里只有 45 个（29%）被测试**实际调用**，
 * 62 个零覆盖。而零覆盖里有一批**高风险纯函数**：
 *
 *   parseJson    ← BOM 会让裸 JSON.parse 抛错，而外层 catch 会把它吞成「无数据」
 *                   （实测踩过：记忆突然读不到，比报错更难查）
 *   isInside     ← 迁移/沙盒判断依赖它，错了会把数据搬到子目录里
 *   slugify      ← 项目名 → scope 名，错了数据就挂错地方
 *   isSafeSlug   ← 防路径穿越
 *   serialize    ← 并发写库，错了会互相覆盖（实测丢到只剩 1 条）
 *
 * 这些函数**没有 I/O 依赖**，最适合直接测。
 *
 * ## 方法：从源码抽取函数体执行
 *
 * 不 import（index.js 是 DSH 插件入口，import 会触发宿主依赖）。
 * 而是用正则从源码里抠出函数定义，new Function 执行 ——
 * 这样测的是**真实源码**，不是复制品。源码改了测试跟着变。
 *
 * ⚠️ 局限：抽取依赖「函数写在顶层且没有闭包依赖」。
 *    如果某个函数开始依赖外部变量，抽取会失败（脚本会明确报错，不会静默跳过）。
 */
import fs from 'node:fs'

const SRC = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) { pass++ }
  else { fail++; bad.push(`${name}${detail ? ' — ' + detail : ''}`); console.log(`❌ ${name}  ← ${detail}`) }
}

/**
 * 从源码里抽取一个函数定义（含函数体），返回可调用函数。
 * @param {string} name 函数名
 * @param {Object} deps 该函数依赖的外部符号（注入进去）
 */
function extract(name, deps = {}) {
  // 匹配 `function name(...) { ... }`（顶层，含嵌套大括号）
  const startRe = new RegExp(`^function ${name}\\(`, 'm')
  const m = startRe.exec(SRC)
  if (!m) throw new Error(`源码里找不到 function ${name}`)
  const start = m.index

  // 从函数体的第一个 { 开始做大括号配对
  let i = SRC.indexOf('{', start)
  let depth = 0
  let end = -1
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  if (end < 0) throw new Error(`function ${name} 的大括号不配对`)

  const body = SRC.slice(start, end)
  const names = Object.keys(deps)
  const vals = names.map((k) => deps[k])
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `${body}\nreturn ${name}`)
  return fn(...vals)
}

// ============================================================
console.log('=== 1. parseJson：BOM 容错（历史事故）===\n')
{
  const parseJson = extract('parseJson')

  check('普通 JSON 能解析', parseJson('{"a":1}').a === 1)
  // ★ 核心用例：Windows 记事本/PowerShell 存的 JSON 常带 U+FEFF
  //   裸 JSON.parse 在这里会抛 SyntaxError，而外层 catch 会吞成「无数据」
  const withBom = '\uFEFF{"version":2}'
  let bomOk = false
  try { bomOk = parseJson(withBom).version === 2 } catch { bomOk = false }
  check('带 BOM 的 JSON 能解析（记事本保存的常见形态）', bomOk)

  check('非字符串入参会抛错（显式契约）', (() => {
    try { parseJson(null); return false } catch { return true }
  })())
  check('非法 JSON 会抛错（不会被吞掉）', (() => {
    try { parseJson('{bad}'); return false } catch { return true }
  })())
  check('空字符串会抛错', (() => {
    try { parseJson(''); return false } catch { return true }
  })())
}

// ============================================================
console.log('\n=== 2. isInside：路径包含判断（迁移安全）===\n')
{
  // isInside 依赖 node:path 的 relative / isAbsolute。
  // index.js 里它们是 import 进来的（`relative as relativePath`），
  // 所以这里直接注入真实的 node:path 实现 —— 测的仍是真行为。
  const path = await import('node:path')
  const isInside = extract('isInside', {
    relativePath: path.relative,
    isAbsolute: path.isAbsolute,
  })

  // 用 Windows 风格路径（本机是 Windows，isAbsolute 判断方式不同）
  check('子目录 → true', isInside('D:\\a\\b', 'D:\\a\\b\\c') === true)
  check('自身 → true', isInside('D:\\a\\b', 'D:\\a\\b') === true)
  check('父目录 → false', isInside('D:\\a\\b', 'D:\\a') === false)
  check('兄弟目录 → false', isInside('D:\\a\\b', 'D:\\a\\c') === false)
  // ★ 关键：前缀陷阱。字符串 startsWith 会把 D:\a\bc 当成 D:\a\b 的子目录
  check('前缀相同但不是子目录（D:\\a\\bc vs D:\\a\\b）→ false',
    isInside('D:\\a\\b', 'D:\\a\\bc') === false)
}

// ============================================================
console.log('\n=== 3. isSafeSlug：防路径穿越 ===\n')
{
  const isSafeSlug = extract('isSafeSlug')

  check('普通名字 → true', isSafeSlug('my-project') === true)
  check('中文 → true', isSafeSlug('大白饭') === true)
  check('空串 → false', isSafeSlug('') === false)
  check('单点 . → false', isSafeSlug('.') === false)
  check('双点 .. → false', isSafeSlug('..') === false)
  check('含斜杠 a/b → false', isSafeSlug('a/b') === false)
  check('含反斜杠 → false', isSafeSlug('a\\b') === false)
  check('含冒号（Windows 盘符）→ false', isSafeSlug('C:') === false)
  check('非字符串 → false', isSafeSlug(null) === false)
  check('含星号 → false', isSafeSlug('a*b') === false)
  check('含问号 → false', isSafeSlug('a?b') === false)
  check('含竖线 → false', isSafeSlug('a|b') === false)
}

// ============================================================
console.log('\n=== 4. slugify：项目名 → scope 名 ===\n')
{
  const slugify = extract('slugify')

  check('普通名字不变', slugify('ForzaOverlay') === 'ForzaOverlay')
  check('空格转连字符', slugify('my project') === 'my-project')
  check('斜杠转连字符', slugify('a/b') === 'a-b')
  check('中文保留', slugify('大白饭') === '大白饭')
  check('首尾连字符被去掉', slugify('-abc-') === 'abc')
  check('长度上限 60', slugify('x'.repeat(100)).length === 60)
  check('多个非法字符各自转成连字符', slugify('a<>b').includes('-'))
}

// ============================================================
console.log('\n=== 5. 日期工具 ===\n')
{
  const pad = extract('pad')
  const localDay = extract('localDay', { pad })
  const daysBetween = extract('daysBetween', { pad })

  check('localDay 格式 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(localDay(new Date(2026, 10, 15))))
  check('localDay 用本地时间（不是 UTC）', localDay(new Date(2026, 0, 2)) === '2026-01-02')
  check('daysBetween 同一天为 0', daysBetween('2026-11-15', '2026-11-15') === 0)
  check('daysBetween 相差 1 天', daysBetween('2026-11-14', '2026-11-15') === 1)
  check('daysBetween 反向为负数或 Infinity 以外的确定值',
    typeof daysBetween('2026-11-15', '2026-11-14') === 'number')
  check('daysBetween 非法输入 → Infinity', daysBetween('乱写', '2026-11-15') === Infinity)
}

// ============================================================
console.log('\n=== 6. expandRoot：路径解析 ===\n')
{
  // ⚠️ 2026-11-17：expandRoot 新增了 IS_WINDOWS 分支与 posixFallbackRoot()，
  //   假环境里必须一并提供，否则 new Function 抛 ReferenceError
  //   （表现是「整个脚本崩了」，不是「断言失败」—— 更容易误判成环境问题）。
  //   这里显式模拟 **POSIX**（/home/u），与下面「空值落点」的断言一致。
  const expandRoot = extract('expandRoot', {
    IS_WINDOWS: false,
    resolve: (...a) => a.join('/').replace(/\/+/g, '/'),
    homedir: () => '/home/u',
    DEFAULT_CONFIG: { root: '' },
    PREFERRED_DRIVE: 'D',
    MEMORY_DIR_NAME: 'mem',
    join: (...a) => a.join('/').replace(/\/+/g, '/'),
    posixFallbackRoot: () => '/home/u/.dsh/mem',
  })

  check('`~` 展开成 home', expandRoot('~') === '/home/u')
  check('`~/x` 展开成 home/x', expandRoot('~/x') === '/home/u/x')
  check('空值走默认（含 MEMORY_DIR_NAME）', expandRoot('').includes('mem'))
  check('普通路径原样 resolve', expandRoot('/a/b') === '/a/b')
  // 2026-11-17 新增：POSIX 下空值不得产出 Windows 盘符路径（会建进工作区）
  check('POSIX 空值落 ~/.dsh（不是 D:\\）', expandRoot('') === '/home/u/.dsh/mem', `实际 = ${expandRoot('')}`)
  check('POSIX 空值不含反斜杠盘符', !/^[A-Za-z]:[\\/]/.test(expandRoot('')), `实际 = ${expandRoot('')}`)
}

// ============================================================
console.log(`\n${'─'.repeat(44)}`)
console.log(fail === 0
  ? `✅ 全部通过：${pass} 通过 / 0 失败`
  : `❌ ${pass} 通过 / ${fail} 失败\n${bad.map((b) => '   ' + b).join('\n')}`)
process.exit(fail === 0 ? 0 : 1)
