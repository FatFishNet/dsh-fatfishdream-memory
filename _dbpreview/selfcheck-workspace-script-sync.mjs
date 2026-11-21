/**
 * 回归测试：工作区脚本 `log.ps1` 的自愈与版本同步（2026-11-20 补）。
 *
 * ## 为什么必须有这个脚本
 *
 * 2026-11-19 夜里，`log.ps1` 的新版本（带 `turnWrites` 输出）**一次都没跑起来** ——
 * 三个工作区的文件全都停在 11-18 那版（718 字节 vs 模板 1599 字节）。
 *
 * 根因不在模板，在判据：
 *
 *     if (await exists(scriptPath)) return false     ← 只看「文件在不在」
 *
 * 文件在 → 直接 return，**模板改了什么都不会同步**。而且失败是静默的：
 * 函数返回 `false` 兼作「没新建」，上层只在该值为 `true` 时打
 * `workspace-script-installed`，所以「跳过了旧版本」在日志里一个字都没有。
 *
 * 这是 AGENTS.md 记过的「改了代码，但跑的不是这版」在**派生文件**上的形态：
 * 源码改了、插件重载了，可工作区里那份副本是旧版本。
 *
 * ## 为什么它值得进回归，而不是一次性脚本
 *
 * 当晚我是用临时脚本验证的（13 条断言 + 故障注入），**跑完就删了**。
 * 于是回归里这个函数零覆盖 —— `grep ensureWorkspaceScripts _dbpreview/` 是 0 命中。
 * 只要有人「顺手简化」把判据改回 `exists()`，版本漂流立刻复发，
 * 而**全套回归仍然全绿**。
 *
 * ## 测的是真实源码，不是抄一份
 *
 * 用 `extract()` 从 `index.js` 抽出 `ensureWorkspaceScripts` 的**完整函数体**
 * 求值（连同它依赖的模板常量）。源码改了测试跟着变；源码改坏了测试变红。
 *
 * ## 不碰真实工作区
 *
 * 全部在系统临时目录里建 `mkdtempSync` 沙箱，跑完即删。
 * 绝不读写用户的 `.dsh-fatfishdream-memory/`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const INDEX = path.join(ROOT, 'dsh-fatfishdream-memory', 'index.js')

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

const SRC = fs.readFileSync(INDEX, 'utf8')

/** 从源码抽一个顶层 async function 的完整定义（大括号配对，不靠正则贪婪）。 */
function extractAsyncFn(name, source = SRC) {
  const re = new RegExp(`^async function ${name}\\(`, 'm')
  const m = re.exec(source)
  if (!m) throw new Error(`源码里找不到 async function ${name}`)
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
  throw new Error(`async function ${name} 的大括号不配对`)
}

/** 从源码取一个 const 模板字面量/字符串常量的**运行时真实值**。 */
function extractConstValue(name, source = SRC) {
  // 用「从 const NAME = 开始，到后续某个独立行 `}\n` 或空行」不可靠，
  // 改为：找到赋值起点后，按模板字面量的反引号配对取。
  const re = new RegExp(`^const ${name} = \``, 'm')
  const m = re.exec(source)
  if (!m) throw new Error(`源码里找不到 const ${name} 的模板字面量`)
  const start = m.index + m[0].length - 1 // 指向第一个反引号
  let i = start + 1
  for (; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue }
    if (source[i] === '`') break
  }
  if (i >= source.length) throw new Error(`const ${name} 的反引号不配对`)
  const raw = source.slice(start, i + 1)
  // ⚠️ 必须求值，不能直接截源码文本 —— 源码里 `\`` 是转义写法，
  // 真实值里是裸反引号。2026-11-19 手动同步脚本时踩过这个坑：
  // 按源码文本写出去，得到的是带 `\`` 的坏文件。
  // eslint-disable-next-line no-new-func
  return new Function(`return ${raw}`)()
}

const WORKSPACE_LOG_PS1 = extractConstValue('WORKSPACE_LOG_PS1')
const WORKSPACE_README_TXT = extractConstValue('WORKSPACE_README_TXT')
const WORKSPACE_DIR_NAME_M = SRC.match(/^const WORKSPACE_DIR_NAME = '([^']+)'/m)
if (!WORKSPACE_DIR_NAME_M) throw new Error('源码里找不到 WORKSPACE_DIR_NAME')
const WORKSPACE_DIR_NAME = WORKSPACE_DIR_NAME_M[1]

// 组装可执行函数：把闭包外的依赖作为参数注入
const fnSrc = extractAsyncFn('ensureWorkspaceScripts')
// eslint-disable-next-line no-new-func
const ensureWorkspaceScripts = new Function(
  'join', 'mkdir', 'readFile', 'writeFile', 'createHash',
  'WORKSPACE_DIR_NAME', 'WORKSPACE_LOG_PS1', 'WORKSPACE_README_TXT',
  `return ${fnSrc}`,
)(path.join, mkdir, readFile, writeFile, createHash,
  WORKSPACE_DIR_NAME, WORKSPACE_LOG_PS1, WORKSPACE_README_TXT)

const scriptOf = (d) => path.join(d, WORKSPACE_DIR_NAME, 'log.ps1')
const readmeOf = (d) => path.join(d, WORKSPACE_DIR_NAME, 'README.txt')
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-wsscript-'))

try {
  // ============================================================
  console.log('=== ① 全新目录：应当创建 ===\n')

  {
    const d = path.join(TMP, 'fresh')
    fs.mkdirSync(d, { recursive: true })
    const created = await ensureWorkspaceScripts(d)
    check('返回 true（表示真的写了盘）', created === true)
    check('log.ps1 已生成', fs.existsSync(scriptOf(d)))
    check('README.txt 已生成', fs.existsSync(readmeOf(d)))
    check('log.ps1 内容与模板逐字节相等',
      fs.readFileSync(scriptOf(d), 'utf8') === WORKSPACE_LOG_PS1)

    // 模板本身必须含 turnWrites（2026-11-19 新加的那行输出）
    check('模板含 turnWrites 输出分支（版本特征）',
      WORKSPACE_LOG_PS1.includes('turnWrites'), '模板退化了？')
  }

  // ============================================================
  console.log('\n=== ② 内容已一致：应当跳过（不白写盘）===\n')

  {
    const d = path.join(TMP, 'same')
    fs.mkdirSync(d, { recursive: true })
    await ensureWorkspaceScripts(d)
    const before = fs.statSync(scriptOf(d)).mtimeMs
    // 让 mtime 有可分辨的间隔（某些文件系统 mtime 精度粗）
    await new Promise((r) => setTimeout(r, 20))
    const created = await ensureWorkspaceScripts(d)
    check('返回 false（没重写）', created === false)
    check('mtime 未变（确认没有多余写入）', fs.statSync(scriptOf(d)).mtimeMs === before)
  }

  // ============================================================
  console.log('\n=== ③ ★ 版本漂流：旧内容必须被覆盖 ===\n')

  {
    const d = path.join(TMP, 'drift')
    fs.mkdirSync(path.join(d, WORKSPACE_DIR_NAME), { recursive: true })
    // 模拟 11-18 那版旧脚本（718 字节的 stub）
    fs.writeFileSync(scriptOf(d), '# OLD VERSION 2026-11-18 stub\n', 'utf8')

    const created = await ensureWorkspaceScripts(d)
    check('旧版本 → 返回 true（说明真的重写了，不是跳过）', created === true)
    check('旧内容已被覆盖为最新模板',
      fs.readFileSync(scriptOf(d), 'utf8') === WORKSPACE_LOG_PS1)
    check('覆盖后含 turnWrites（旧版没有的那行）',
      fs.readFileSync(scriptOf(d), 'utf8').includes('turnWrites'))
  }

  // ============================================================
  console.log('\n=== ④ README 陈旧时不重写（用户 2026-11-19 定）===\n')

  {
    const d = path.join(TMP, 'readme')
    fs.mkdirSync(d, { recursive: true })
    await ensureWorkspaceScripts(d)
    fs.writeFileSync(readmeOf(d), 'I AM STALE', 'utf8')
    // 同时把脚本改坏，逼它走「覆写」分支
    fs.writeFileSync(scriptOf(d), 'BROKEN', 'utf8')
    const created = await ensureWorkspaceScripts(d)
    check('脚本被修复 → 返回 true', created === true)
    check('README 保持陈旧（不参与比较，不白写盘）',
      fs.readFileSync(readmeOf(d), 'utf8') === 'I AM STALE')
  }

  // ============================================================
  console.log('\n=== ⑤ 非法 cwd：返回 false 且不抛 ===\n')

  {
    check('空串 → false', (await ensureWorkspaceScripts('')) === false)
    check('undefined → false', (await ensureWorkspaceScripts(undefined)) === false)
    check('null → false', (await ensureWorkspaceScripts(null)) === false)
    check('纯空白 → false', (await ensureWorkspaceScripts('   ')) === false)
    check('数字 → false', (await ensureWorkspaceScripts(123)) === false)
  }

  // ============================================================
  console.log('\n=== ⑥ 反向自证：判据退回 exists() 必须变红 ===\n')

  {
    // 源码里的判据特征：必须比内容（createHash），不能只看存在
    const usesHash = fnSrc.includes('createHash')
    check('函数体里有内容比对（createHash）', usesHash === true,
      '没有 → 退化成只看存在，版本漂流会复发')

    // 反向：确认 exists() 形态会被识别为「不是内容比对」
    const existsOnly = /if \(await exists\(scriptPath\)\) return false/.test(fnSrc)
    check('不存在「只判 exists 就返回」的老写法', existsOnly === false,
      '这行还在 → 判据没改成功')

    // 把源码里的比对行换成恒等 TRUE（等于永远认为「内容一致」）→ 模拟版本漂流
    const CLEAN_LINE = "    const actual = createHash('sha256').update(current, 'utf8').digest('hex')"
    const n = fnSrc.split(CLEAN_LINE).length - 1
    check('自证锚点唯一', n === 1, `实际 ${n} 处`)

    if (n === 1) {
      const brokenSrc = fnSrc.replace(
        CLEAN_LINE,
        "    const actual = wanted // mutated: 永远认为内容一致",
      )
      // eslint-disable-next-line no-new-func
      const broken = new Function(
        'join', 'mkdir', 'readFile', 'writeFile', 'createHash',
        'WORKSPACE_DIR_NAME', 'WORKSPACE_LOG_PS1', 'WORKSPACE_README_TXT',
        `return ${brokenSrc}`,
      )(path.join, mkdir, readFile, writeFile, createHash,
        WORKSPACE_DIR_NAME, WORKSPACE_LOG_PS1, WORKSPACE_README_TXT)

      const d = path.join(TMP, 'selfproof')
      fs.mkdirSync(path.join(d, WORKSPACE_DIR_NAME), { recursive: true })
      fs.writeFileSync(scriptOf(d), '# STALE', 'utf8')
      const created = await broken(d)
      const stillStale = fs.readFileSync(scriptOf(d), 'utf8') === '# STALE'
      check('自证：判据坏掉后旧内容不会被覆盖（证明 ③ 的断言能红）',
        created === false && stillStale === true,
        `created=${created} stillStale=${stillStale}`)
    }
  }
} finally {
  // 无论如何都清掉临时目录（失败时也不留垃圾）
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
}

console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
