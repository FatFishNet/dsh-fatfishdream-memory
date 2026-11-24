/**
 * 回归守卫：**工作区行尾必须是 LF**，且 git 不许把它转成 CRLF。
 *
 * ## 为什么要有这个脚本（2026-11-21 实踩，代价是一整棵树 11 个假红）
 *
 * 本项目的回归大量用**字符串锚点**去 `index.js` 里找代码再注入变异，锚点里写死的是 `\n`：
 *
 *     src.replace("if (typeof v === 'string' && v !== '') {\n          return {...}", ...)
 *
 * 而宿主的 git 配置是 `core.autocrlf = true`、`.gitattributes` 又是 `* text=auto` ——
 * 于是 **index 里存 LF，检出到工作区变成 CRLF**，上面那句永远匹配不上。
 *
 * 实测（2026-11-21，干净 worktree 检出 4f8fb22，同一棵代码两种行尾）：
 *
 *     工作区 CRLF → TOTAL=77 FAIL=12
 *     全部归一 LF → TOTAL=77 FAIL=0
 *
 * 12 个失败的名字全是「锚点没匹配上 → 下面的自证无效」「切片 sha256 不一致」这种，
 * **看起来像代码坏了，实际是环境不对**。这种假红比不报还糟：
 * 它会让人去改一个没坏的东西（历史上有一次就这么把 CHANGELOG 切坏了）。
 *
 * ## 关于 `selfcheck-miss-audit` 那条特别值得记
 *
 * 它的夹具 `fixtures/turns-2026-11-20.expected.json` 里冻着源切片的 sha256，
 * 用来证明「夹具没被改过」。但 CRLF 化会改变字节 → sha 变了 → 它报
 * 「不一致说明切片被改过（不是数据变了）」—— **一条守「没被改过」的断言，
 * 被行尾转换本身改掉了。** 这正是「检测器有自己的盲区，而且不会告诉你」。
 * 所以本脚本第 ③ 项把这件事提前到第 1 个脚本就报出来。
 *
 * ## 为什么放在 SCRIPTS 最前面
 *
 * 后面 76 个脚本全部依赖「锚点能匹配上」。这是一个**前置条件检查**，
 * 不是并列的第 78 项 —— 行尾错了，后面的红全是噪音。
 *
 * ## 覆盖边界（必须写出来，见 AGENTS.md「检测器本身有盲区」）
 *
 *   - 只扫下列扩展名的文本文件；`.db` / 图片 / 二进制不扫（它们本来就可能含 \r\n）
 *   - 跳过 `.git/`、`node_modules/`、`back/`（备份是历史快照，行尾什么样都得留着）
 *   - **`ignored`（被 .gitignore 忽略）的文件不判红**：它们不进仓库、不参与 clone，
 *     对「别人 clone 下来能否跑通」没有影响。但会把它们的行尾当作信息打印出来，
 *     免得下一个人以为本脚本全查过了。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// ---- 断言工具（与其他回归脚本同形）----
let pass = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}`)
  } else {
    fails.push({ name, detail })
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ---- 扫描范围 ----
const EXTS = new Set(['.js', '.mjs', '.cjs', '.md', '.json', '.yml', '.yaml', '.txt', '.ts', '.sh', '.py', '.svg'])
const SKIP_DIRS = new Set(['.git', 'node_modules', 'back', '.vs', 'dist', 'build'])
// ⚠️ 不含 `.vs/` 到 EXTS 的语义里 —— 它单独在 SKIP_DIRS 里挡掉，理由见文件头「覆盖边界」

/** 递归收集候选文件（返回仓库相对路径，正斜杠） */
function walk(dir, out = []) {
  let ents
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(path.join(dir, e.name), out)
    } else if (e.isFile()) {
      if (EXTS.has(path.extname(e.name).toLowerCase())) out.push(path.join(dir, e.name))
    }
  }
  return out
}

/** 统计一段 Buffer 里的 LF / CRLF 数（按字节，不经解码，避免 BOM/编码干扰） */
function countEol(buf) {
  let lf = 0
  let crlf = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      lf++
      if (i > 0 && buf[i - 1] === 0x0d) crlf++
    }
  }
  return { lf, crlf }
}

/**
 * 找一个能用的 git。
 *
 * 本机 `git` **不在 PATH 里**（AGENTS.md 记过：它装在 Visual Studio 自带的位置）。
 * 这里刻意**照抄** `tool-check-staged.mjs` 的 findGit 思路而不是另发明一套 ——
 * 同一件事两套探测逻辑，改了一边另一边会静默失效。
 */
function findGit() {
  if (process.env.DSH_GIT) return process.env.DSH_GIT
  if (canRun('git')) return 'git'
  const candidates = [
    'D:/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/TeamFoundation/Team Explorer/Git/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
  ]
  for (const c of candidates) if (fs.existsSync(c) && canRun(c)) return c
  return null
}

function canRun(bin) {
  try {
    return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
  } catch {
    return false
  }
}

const GIT = findGit()

/**
 * 读一条 git 配置。
 *
 * ## 返回值三种，**必须能区分**（2026-11-24 实踩）
 *
 *   { state: 'value', value: 'lf' }    git 明确说了值
 *   { state: 'unset' }                 git 说「这个键没设」（退出码 1，无输出）
 *   { state: 'unknown', why: '...' }   **我没问到** git（EPERM / 起不来 / 超时）
 *
 * ⚠️ 旧实现把后两种混成 `ok: false` + `out: ''`，调用处再 `r.ok ? r.out : ''` ——
 * 于是「沙箱不让开管道、根本没跑起来」被渲染成「当前 = (未设)」。
 * 那是**把自己的失败栽赃给配置**：人会跑去 `git config core.eol lf` 改配置，
 * 而真正的问题是读不到 git。2026-11-24 实测：`git config --get core.eol`
 * 在 pwsh 里明明返回 `lf`，脚本却报未设 —— 就是这个 bug。
 *
 * 这就是 AGENTS.md 那条：**`null`（没问到）和 `''`（问到了、是空）必须能区分**。
 */
/**
 * 读一条 git 配置。
 *
 * ## 为什么不用 `git config --get`
 *
 * 因为它要**开子进程**，而受限沙箱（workspace-write / read-only）**不允许程序
 * 开命名管道** → `stdio:'pipe'` 拿回 `status = null`（EPERM）。实测：
 *
 * | 做法 | 结果 |
 * |---|---|
 * | `stdio:'pipe'`（`execFileSync` 默认） | ❌ EPERM，status=null |
 * | `stdio:'inherit'` | ✅ 能跑、退出码准，但**看不到输出** |
 * | `cmd /c "git ... > f"` | ❌ 沙箱连 cmd 都拦 |
 * | `git config --output=f` | ❌ `config` 不认这个参数（只有 diff/log 认） |
 *
 * **绕开子进程**才是干净的解法：git 的配置就是**纯文本 INI**，直接读文件即可。
 * 代价是要自己实现「多来源合并」，但那正好让我们把优先级写清楚。
 *
 * ## 优先级（与 git 一致，低 → 高）
 *
 *   `<git安装目录>/etc/gitconfig`  → system
 *   `~/.gitconfig`                 → global
 *   `<repo>/.git/config`           → local
 *
 * 高优先级的**后读**，覆盖前面的。
 *
 * ## 返回值三种，**必须能区分**
 *
 *   { state: 'value', value: 'lf' }    明确读到了值
 *   { state: 'unset' }                 三份配置里都没有这个键
 *   { state: 'unknown', why: '...' }   **我没读到**（文件不可读等）
 *
 * ⚠️ 旧实现（走子进程）把「没问到」渲染成「未设」，等于**把自己的失败栽赃给配置**。
 * 2026-11-24 实测：`git config --get core.eol` 在 pwsh 里明明返回 `lf`，
 * 脚本却报「当前 = (未设 → 回落到 native = CRLF)」。
 * 这就是 AGENTS.md 那条：**`null`（没问到）和 `''`（问到了、是空）必须能区分**。
 */
function readIniKey(file, key) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { found: false }
  }
  // [section] 标题 + `key = value` 配对。键名大小写不敏感（git 的规矩）。
  const [wantSection, wantKey] = key.includes('.')
    ? [key.slice(0, key.lastIndexOf('.')), key.slice(key.lastIndexOf('.') + 1)]
    : ['', key]
  let section = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const sec = line.match(/^\[([^\]]+)\]$/)
    if (sec) {
      section = sec[1].trim().toLowerCase()
      continue
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/)
    if (!kv) continue
    const k = kv[1].trim().toLowerCase()
    if (section === wantSection.toLowerCase() && k === wantKey.toLowerCase()) {
      return { found: true, value: kv[2].trim().replace(/^"(.*)"$/, '$1') }
    }
  }
  return { found: false }
}

function gitConfig(key) {
  // 三份配置，低 → 高优先级
  const sources = []
  if (GIT) {
    // <git>/cmd/git.exe → ../../etc/gitconfig
    sources.push(path.resolve(path.dirname(GIT), '..', '..', 'etc', 'gitconfig'))
  }
  sources.push(path.join(os.homedir(), '.gitconfig'))
  sources.push(path.join(ROOT, '.git', 'config'))

  let best = null
  let readAny = false
  for (const f of sources) {
    if (!fs.existsSync(f)) continue
    readAny = true
    const r = readIniKey(f, key)
    if (r.found) best = { value: r.value, from: f }
  }

  if (best) return { state: 'value', value: best.value, from: best.from }
  // 一份都读不到 → 真的没问到，不能谎称「未设」
  if (!readAny) return { state: 'unknown', why: '三份 gitconfig 都不存在或都不可读' }
  return { state: 'unset' }
}

/** git 是否可用（沙箱里可能起不来 —— 见 AGENTS.md「受限权限下捕获子进程输出会 EPERM」） */
const GIT_OK = GIT !== null

// ============================================================
console.log('=== ① git 配置：core.autocrlf 不能是 true ===\n')

if (!GIT_OK) {
  // 没有 git 就不产生断言，只说明。**不要**写 check(..., true) —— 那是恒真断言。
  console.log('  ℹ️ 本段不适用：git 不可用（沙箱或 PATH 限制），跳过 autocrlf 检查')
} else {
  const r = gitConfig('core.autocrlf')
  if (r.state === 'unknown') {
    // 「我没问到」**不是**「配置没问题」。不产生断言，只说明 —— 别拿它冒充通过。
    console.log(`  ⚠️ 读不到 core.autocrlf：${r.why}`)
    console.log('     这不是「配置正确」，是「没查成」—— 本条不产生通过结论')
  } else {
    const val = r.state === 'value' ? r.value.toLowerCase() : ''
    check(
      'core.autocrlf 不是 true（它会静默把 index 的 LF 转成工作区 CRLF）',
      val !== 'true',
      val === 'true'
        ? '当前 = true。修复：git config core.autocrlf false，然后对全仓做一次行尾归一'
        : `当前 = ${val || '(未设，等效 false)'}`,
    )
  }

  // 🔴 2026-11-21 补：**只设 autocrlf=false 是不够的**，实测过。
  //
  // `.gitattributes` 是 `* text=auto`。这种属性下，`autocrlf=false` 只是说
  // 「不自动转换」，但 checkout 时**仍会回落到 `core.eol`**，而它在 Windows 上
  // 默认是 `native` = **CRLF**。所以：
  //
  //   autocrlf=false               → 仍打印 "LF will be replaced by CRLF"（实测）
  //   autocrlf=false + eol=lf      → 警告消失（实测）
  //
  // 结论：**这两个都要设**。只检查 autocrlf 的守卫会报「通过」，而问题还在。
  const eolR = gitConfig('core.eol')
  if (eolR.state === 'unknown') {
    console.log(`  ⚠️ 读不到 core.eol：${eolR.why}`)
    console.log('     同上：这是「没查成」，不是「配对了」')
  } else {
    const eolVal = eolR.state === 'value' ? eolR.value.toLowerCase() : ''
    check(
      'core.eol 是 lf（text=auto 下 autocrlf=false 会回落到 core.eol，Windows 默认 native=CRLF）',
      eolVal === 'lf',
      eolVal === 'lf'
        ? ''
        : `当前 = ${eolVal || '(未设 → 回落到 native = CRLF)'}。修复：git config core.eol lf`,
    )
  }

  // 顺带把 .gitattributes 的 text=auto 也打出来：它是「autocrlf 关了也可能有影响」的来源
  const attrPath = path.join(ROOT, '.gitattributes')
  if (fs.existsSync(attrPath)) {
    const attr = fs.readFileSync(attrPath, 'utf8')
    const hasAuto = /^\s*\*\s+text\s*=\s*auto/m.test(attr)
    console.log(`  ℹ️ .gitattributes 含 \`* text=auto\`：${hasAuto ? '是' : '否'}` +
      `（所以必须靠 ① 的 eol=lf 压住，光关 autocrlf 不够）`)
  }
}

// ============================================================
console.log('\n=== ② 工作区文本文件行尾必须是 LF ===\n')

const files = walk(ROOT)
const crlfFiles = []
for (const abs of files) {
  let buf
  try {
    buf = fs.readFileSync(abs)
  } catch {
    continue
  }
  const { crlf } = countEol(buf)
  if (crlf > 0) crlfFiles.push({ abs, rel: path.relative(ROOT, abs).split(path.sep).join('/'), crlf })
}

// 区分 tracked / ignored / untracked：只有前两者参与「能不能 clone 跑通」的判断。
// ignored 的不判红（理由见文件头覆盖边界），但打印出来。
let ignoredCrlf = []
if (GIT_OK && crlfFiles.length > 0) {
  const remain = []
  for (const f of crlfFiles) {
    const ig = git(['check-ignore', '-q', f.rel])
    if (ig.ok) ignoredCrlf.push(f)
    else remain.push(f)
  }
  crlfFiles.length = 0
  crlfFiles.push(...remain)
}

check(
  `工作区没有 CRLF 文本文件（扫了 ${files.length} 个）`,
  crlfFiles.length === 0,
  crlfFiles.length > 0
    ? `${crlfFiles.length} 个文件带 CRLF：${crlfFiles.slice(0, 8).map((f) => f.rel).join(', ')}` +
      `${crlfFiles.length > 8 ? ` …等 ${crlfFiles.length} 个` : ''} —— 修复：把行尾归一成 LF`
    : '',
)

if (crlfFiles.length > 0) {
  console.log('\n  带 CRLF 的文件明细（最多 30 个）：')
  for (const f of crlfFiles.slice(0, 30)) console.log(`    ${f.rel}  (CRLF=${f.crlf})`)
  if (crlfFiles.length > 30) console.log(`    …还有 ${crlfFiles.length - 30} 个`)
}

if (ignoredCrlf.length > 0) {
  console.log(`\n  ℹ️ 另有 ${ignoredCrlf.length} 个**被 .gitignore 忽略**的 CRLF 文件，不判红（不进仓库、不影响 clone）：`)
  for (const f of ignoredCrlf.slice(0, 10)) console.log(`    ${f.rel}`)
  if (ignoredCrlf.length > 10) console.log(`    …还有 ${ignoredCrlf.length - 10} 个`)
}

// ============================================================
console.log('\n=== ③ 冻结夹具的 sha256 必须与 expected.json 记录一致 ===\n')

// 为什么单列这一段：夹具守的是「这个文件没被改过」，而行尾转换恰好会改字节。
// 不在这里报，它会在 selfcheck-miss-audit 里变成一句「切片被改过」—— 把人引向死路。
const FIXTUTES_DIR = path.join(HERE, 'fixtures')
let fixtureChecked = 0
if (fs.existsSync(FIXTUTES_DIR)) {
  for (const name of fs.readdirSync(FIXTUTES_DIR)) {
    if (!name.endsWith('.expected.json')) continue
    const expPath = path.join(FIXTUTES_DIR, name)
    let exp
    try {
      exp = JSON.parse(fs.readFileSync(expPath, 'utf8'))
    } catch (e) {
      check(`${name} 能被解析`, false, String(e && e.message))
      continue
    }
    const srcName = exp && exp.source && exp.source.slice
    const wantSha = exp && exp.source && exp.source.sliceSha256
    if (!srcName || !wantSha) {
      // 没有 sha 记录的夹具不产生断言（没有可失败的表达式）
      console.log(`  ℹ️ ${name} 没有 source.sliceSha256 记录，跳过`)
      continue
    }
    const srcPath = path.join(FIXTUTES_DIR, srcName)
    if (!fs.existsSync(srcPath)) {
      check(`${name} 对应的夹具 ${srcName} 存在`, false, '文件不存在')
      continue
    }
    const got = crypto.createHash('sha256').update(fs.readFileSync(srcPath)).digest('hex')
    fixtureChecked++
    check(
      `${srcName} 的 sha256 与 ${name} 记录一致`,
      got === wantSha,
      got === wantSha
        ? ''
        : `实际 ${got.slice(0, 16)}…，记录 ${String(wantSha).slice(0, 16)}…。` +
          `若刚做过行尾转换，这就是原因：夹具是按字节冻的，CRLF 化会改字节。`,
    )
    // 顺带核字节数：比 sha 更早失败、更好定位
    if (typeof exp.source.sliceBytes === 'number') {
      const size = fs.statSync(srcPath).size
      check(
        `${srcName} 字节数 = ${exp.source.sliceBytes}`,
        size === exp.source.sliceBytes,
        size === exp.source.sliceBytes ? '' : `实际 ${size}`,
      )
    }
  }
}
if (fixtureChecked === 0 && !fs.existsSync(FIXTUTES_DIR)) {
  console.log('  ℹ️ 本段不适用：没有 fixtures 目录')
}

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fails.length} 失败`)
  for (const f of fails) console.log(`   - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
}
process.exit(fails.length === 0 ? 0 : 1)
