#!/usr/bin/env node
/**
 * 提交前守卫：拦住「不该进 git 的东西」。
 *
 * ## 为什么需要这个
 *
 * 2026-11-21 发现仓库里躺着一个 **12.4 MB 的 `_cold-snapshot.db`** ——
 * 是 11-17 的 `memory.db` 快照，已经推到**公开**仓库（`FatFishNet/dsh-fatfishdream-memory`）。
 * 它把 `.git` 目录撑到 12.2 MB，而其余最大的正常源码才 375 KB。
 *
 * `.gitignore` 挡不住它，因为**提交时它还没被忽略**（`.gitignore` 只影响
 * 「untracked 文件要不要显示」，**已经 `git add` 的东西照样能提交**）。
 *
 * 所以需要第二道防线：**在 `git commit` 真正落库之前，看一遍暂存区**。
 *
 * ## 拦什么（三类，判据各不相同）
 *
 * | 类别 | 判据 | 为什么 |
 * |---|---|---|
 * | ① 数据库 / 备份 | 扩展名白名单式匹配 | 用户的真实记忆，且体积大 |
 * | ② 超大文件 | **单文件 > 1 MB** | 二进制/生成物混入的通用信号 |
 * | ③ 本机路径泄露 | 内容含「用户目录 + 真实账号名」 | 公开仓库，账号名不该外泄 |
 *
 * ## 为什么不拦 `D:\...`
 *
 * `AGENTS.md` / `docs/` 里**本来就写着** `D:\dsh-fatfishdream-memory` 这类路径，
 * 那是**说明性**的（"记忆默认放哪"），不是泄露 —— 换成任何用户装到 D 盘都是这个路径。
 * 真正敏感的是「用户目录 + 真实账号名」那种，那个才含身份。
 *
 * ## 用法
 *
 * ```powershell
 * # 手动查（不阻断）
 * & $node _dbpreview\tool-check-staged.mjs
 *
 * # 允许放行（知道自己在干什么）
 * & $node _dbpreview\tool-check-staged.mjs --allow
 * ```
 *
 * 退出码：0 = 放行，1 = 拦住。
 *
 * ## 为什么读 `git config` 而不是硬编码阈值
 *
 * 仓库的大小基线会变（现在最大源码 375 KB）。所以 1 MB 这个数是**当前的判断**，
 * 不是宇宙真理 —— 哪天 `index.js` 涨到 1.2 MB，把它改大即可，别为了绕守卫而 `--allow`。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 单文件超过这个大小就要求人工确认（字节） */
const MAX_BYTES = 1024 * 1024 // 1 MB

/**
 * 按扩展名拦。
 *
 * ⚠️ **不要用「白名单反选」**（"除了这些扩展名都拦"）——
 * 那样每加一种新文件类型（`.mjs` / `.yml` / `.svg`）都要改一次守卫，
 * 而漏改的表现是「守卫悄悄不拦了」。**黑名单漏一种只是少拦一种，方向是安全的。**
 */
const BLOCKED_EXT = [
  // 记忆库 / SQLite（用户的真实数据，绝不能公开）
  '.db', '.db-wal', '.db-shm', '.sqlite', '.sqlite3',
  // 压缩包（容易被塞进一堆东西）
  '.tgz', '.tar', '.gz', '.zip', '.7z', '.rar',
  // 备份 / 编辑器残留
  '.bak', '.atk-bak', '.pre-sync', '.orig', '.rej', '.swp',
  // 日志（含本机路径与运行时信息）
  '.log',
]

/** 允许放行的标记文件（不想每次提交都加 --allow 时） */
const ALLOW_ENV = 'DSH_SKIP_STAGED_CHECK'

/**
 * 找一个能用的 git。
 *
 * **为什么要探测**：本机 `git` 不在 PATH 里（AGENTS.md 记过这条 ——
 * 它装在 Visual Studio 自带的位置）。而 **hook 场景下 `git` 一定可用**
 * （hook 就是 git 启动的），所以 `'git'` 大概率能直接跑。
 * 探测只是为了「脱离 hook 手动跑」时也不失败。
 */
function findGit() {
  if (process.env.DSH_GIT) return process.env.DSH_GIT

  // ① 先试裸名（hook 场景最常见）
  if (canRun('git')) return 'git'

  // ② 再试本机已知位置（VS 自带）
  const candidates = [
    'D:/Microsoft Visual Studio/18/Community/Common7/IDE/CommonExtensions/Microsoft/TeamFoundation/Team Explorer/Git/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
    'C:/Program Files (x86)/Git/cmd/git.exe',
  ]
  for (const c of candidates) if (existsSync(c) && canRun(c)) return c
  return null
}

function canRun(bin) {
  const r = spawnSync(bin, ['--version'], { stdio: 'ignore' })
  return r.status === 0
}

/**
 * 跑 git 并拿回输出。
 *
 * ## 三条路都试过，记下来免得下一个人重走
 *
 * | 做法 | 结果 |
 * |---|---|
 * | `spawnSync(git, args, {encoding:'utf8'})` | **EPERM** —— 沙箱不许开命名管道 |
 * | `spawnSync(git, [...args, '--output=f'])` | **只有 `diff`/`log` 认**；`ls-files` 静默忽略 |
 * | `spawnSync('cmd', ['/c', 'git ... > f'])` | **status=1**，文件没生成（沙箱连 cmd 都拦） |
 *
 * 结论：**在受限沙箱里无法拿到 git 的 stdout**。所以采用双模式：
 *
 * - **模式 A（正常模式）**：`stdio: 'pipe'`。这是 hook 实际运行时的样子 ——
 *   `git commit` 由用户在自己的终端里跑，那里没有 DSH 的文件沙箱。
 * - **模式 B（受限模式）**：pipe 报 EPERM 时，降级为 `--output=` 再试一次，
 *   还不行就返回 `null`（**不是空串** —— 两者必须能区分，见 `main` 里的处理）。
 *
 * ⚠️ **`null` 和 `''` 的区别是本文件最容易写错的地方**：
 * 空串 = "git 说没有暂存文件"；`null` = "我没能问到 git"。
 * 把后者当后者处理会得到「未发现问题」，那正是最危险的假绿。
 */
function gitCapture(git, args) {
  // 模式 A：正常 pipe（hook 真实运行环境）
  const r = spawnSync(git, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  if (r.error === undefined && typeof r.stdout === 'string') return r.stdout

  // 模式 B：受限环境下退一步，试 --output（只有部分子命令认）
  if (r.error && r.error.code === 'EPERM') {
    const outFile = join(tmpdir(), `dsh-staged-${process.pid}-${Date.now()}.txt`)
    try {
      spawnSync(git, [...args, `--output=${outFile}`], { stdio: 'ignore' })
      if (existsSync(outFile)) return readFileSync(outFile, 'utf8')
    } catch {
      /* 落到下面返回 null */
    } finally {
      try { if (existsSync(outFile)) unlinkSync(outFile) } catch { /* 算了 */ }
    }
  }
  return null
}

/** 取暂存区里的文件：**只取新增/修改，不取删除**。返回 null 表示没问到 git。 */
function stagedFiles(git) {
  const out = gitCapture(git, ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  if (out === null) return null
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * 暂存文件的大小（字节）。
 *
 * ## 三层回退，每层的取舍都写清楚
 *
 * **① 首选 `git cat-file -s <blob>`** —— 这是**唯一正确**的来源。
 *   暂存的是 blob；工作区文件可能已被改小、已删、或被 CRLF 转换过，
 *   所以「读工作区大小」在某些情形下会偏。
 *
 * **② 退到工作区 `statSync`** —— 只在 git 那条链拿不到时用。
 *   绝大多数情况下两者一致（本项目没配 `filter`/`textconv`）。
 *   代价是：若你 `git add` 后又把文件改小了，②会漏报 —— **方向是漏，不是误杀**。
 *
 * **③ 都拿不到 → 返回 `null`**（不是 0），由 `main` 打印「大小未知」。
 *
 * ## 为什么不用 `git ls-files -s -l`
 *
 * `-l` **不存在**于 `ls-files`（是 `ls-tree` 的选项），会报 usage 返回 0，
 * 于是**大小检查恒不触发**。开发时踩过：1.5 MB 文件暂存后报「未发现问题」。
 *
 * ## 为什么沙箱里 ① 会失败而 ② 能兜住
 *
 * 受限沙箱对 `git ls-files` 报 EPERM（`git diff` 反而正常），
 * 而 `--output=` 对 `ls-files` 无效。所以在受限环境里 ① 拿不到，
 * ② 成为实际生效的那层 —— 这也是为什么 ② 必须存在。
 */
function stagedSize(git, path) {
  // ① blob 大小（正确来源）
  const st = gitCapture(git, ['ls-files', '-s', '--', path])
  if (st !== null) {
    const m = /^\d+\s+([0-9a-f]{7,64})\s+\d+\t/m.exec(st)
    if (m) {
      const sz = gitCapture(git, ['cat-file', '-s', m[1]])
      if (sz !== null) {
        const n = Number(String(sz).trim())
        if (Number.isFinite(n)) return n
      }
    }
  }

  // ② 工作区大小（近似但可用）
  try {
    if (existsSync(path)) return statSync(path).size
  } catch {
    /* 落到 ③ */
  }

  // ③ 未知
  return null
}

function main() {
  // `--allow` 是给「我确实要提交这个」的人用的逃生门。
  // **必须真的生效** —— 声明了不用（或反过来：只在注释里承诺）就是死变量，
  // 而那类问题在本项目里已经踩过多次（`retryable` 写了 5 处读 0 处等）。
  if (process.argv.includes('--allow')) {
    console.log('[check-staged] 已由 --allow 跳过检查')
    return 0
  }

  if (process.env[ALLOW_ENV] === '1') {
    console.log(`[check-staged] 已由环境变量 ${ALLOW_ENV}=1 跳过`)
    return 0
  }

  const git = findGit()
  if (!git) {
    // ⚠️ **找不到 git 时放行，不拦。**
    //
    // 理由：守卫的职责是「多做一道检查」，不是「让提交变得依赖守卫能跑」。
    // 一个因为环境问题就阻断所有提交的守卫，会立刻被 `--no-verify` 绕过，
    // 然后就再也没人看它了 —— 那比没有守卫更糟。
    console.log('[check-staged] ⚠️ 找不到可用的 git，跳过检查（放行）')
    console.log('   若要强制检查，设置 DSH_GIT=<git 可执行文件路径> 后重试')
    return 0
  }

  const files = stagedFiles(git)
  if (files === null) {
    // ⚠️ **问不到 git 时给「警告 + 放行」，不假装检查过。**
    //
    // 为什么不是拦：守卫的职责是「多做一道检查」，不是「让提交依赖守卫能跑」。
    // 一个因为环境问题就阻断所有提交的守卫，会立刻被 `--no-verify` 绕过，
    // 然后就再也没人看它了 —— 那比没有守卫更糟。
    //
    // 为什么不是静默放行：**必须打印出来**。否则调用方会以为「检查过了、没问题」，
    // 这是本文件最危险的失败模式（假绿）。
    console.log('[check-staged] ⚠️ 无法读取暂存区（git 调用受限），本次检查未生效')
    console.log('   这不是「检查通过」，是「没查」。若在受限环境，请在本机终端手动跑一次：')
    console.log('     node _dbpreview/tool-check-staged.mjs')
    return 0
  }

  if (files.length === 0) {
    console.log('[check-staged] 暂存区为空，放行')
    return 0
  }

  const problems = []
  let sizeUnknown = 0

  for (const f of files) {
    const lower = f.toLowerCase()

    // ① 扩展名命中
    const hit = BLOCKED_EXT.find((ext) => lower.endsWith(ext))
    if (hit) {
      problems.push({
        file: f,
        reason: `命中禁止的扩展名 \`${hit}\``,
        hint: '这是记忆库 / 备份 / 压缩包 / 日志类文件，不应进公开仓库',
      })
      continue
    }

    // ② 超大文件
    const size = stagedSize(git, f)
    if (size === null) {
      sizeUnknown += 1
    } else if (size > MAX_BYTES) {
      problems.push({
        file: f,
        reason: `单文件 ${(size / 1024 / 1024).toFixed(2)} MB，超过 ${MAX_BYTES / 1024 / 1024} MB 上限`,
        hint: '大文件会让 clone 变慢且无法从历史里轻易移除；确需提交请临时调大 MAX_BYTES',
      })
      continue
    }

    // ③ 本机用户名泄露（只查文本类，二进制跳过）
    const isText = /\.(js|mjs|json|md|yml|yaml|txt|ps1|svg|patch)$/i.test(lower)
    if (isText && existsSync(f)) {
      try {
        const text = readFileSync(f, 'utf8')
        const m = /[A-Za-z]:\\Users\\([^\\/\s"'``]+)/.exec(text)
        if (m) {
          problems.push({
            file: f,
            reason: `含本机用户目录 \`...\\Users\\${m[1]}\``,
            hint: '公开仓库不应出现真实用户名；改用 <%USERPROFILE%> 之类占位',
          })
        }
      } catch {
        /* 读不了就跳过，不因为守卫自身出错而拦截 */
      }
    }
  }

  if (problems.length === 0) {
    // ⚠️ **大小未知时不能说「未发现问题」。**
    //
    // 那是本文件最危险的假绿：检查项压根没跑，却给出「通过」的结论。
    // 与 AGENTS.md 里「恒真断言」是同一类病 —— 断言在，测的东西不在。
    if (sizeUnknown > 0) {
      console.log(`[check-staged] ⚠️ 检查了 ${files.length} 个暂存文件，扩展名与用户名无问题，`)
      console.log(`   但有 ${sizeUnknown} 个文件的**大小未能确认**（git 调用受限）。`)
      console.log('   这不是完整的「通过」—— 大小检查那一项没有生效。')
      console.log('   请在本机终端（非受限沙箱）重跑一次以确认：')
      console.log('     node _dbpreview/tool-check-staged.mjs')
      return 0
    }
    console.log(`[check-staged] ✅ 检查 ${files.length} 个暂存文件，未发现问题`)
    return 0
  }

  console.error('')
  console.error('╔══════════════════════════════════════════════════════════════╗')
  console.error('║  ❌ 提交前守卫：暂存区里有不该进仓库的内容                   ║')
  console.error('╚══════════════════════════════════════════════════════════════╝')
  console.error('')
  for (const p of problems) {
    console.error(`  ● ${p.file}`)
    console.error(`    原因：${p.reason}`)
    console.error(`    处理：${p.hint}`)
    console.error('')
  }
  console.error('  这一切都没有提交。可选处理：')
  console.error('    1. 从暂存区撤掉：  git restore --staged <文件>')
  console.error('    2. 加进 .gitignore（如果是生成物）')
  console.error('    3. 确实要提交：    git commit --no-verify   ← 或设置上面那个环境变量')
  console.error('')
  return 1
}

process.exit(main())
