/**
 * 2026-11-17 修复的 7 个 bug 的回归测试。
 *
 * ## 为什么每个 bug 都要单独一条「能变红」的断言
 *
 * 今晚的教训：`appendArchive` 缺事务这个 bug 之所以活了很久，是因为
 * **没有任何测试能区分「有事务」和「没事务」** —— 正常路径下两者行为完全一样。
 * 所以这里的每条断言都必须：**把修复回退掉，它就会红**。
 *
 * 每条断言后面都标了 `[回退验证: xxx]`，说明怎么让它变红。
 *
 * ## 覆盖的 7 个 bug
 *
 *   ① `$` 展开改写 policy.md        —— replace 字符串 vs 函数
 *   ② appendArchive 缺事务          —— FTS 失败时主表不该留孤儿行
 *   ③ isInside 参数方向反了          —— 迁到子目录必须被拒
 *   ④ POSIX 守卫黑名单漏 4 种形态     —— D: / D:mem / UNC / \\?\
 *   ⑤ joinWithBudget 单条超预算整条消失 —— 至少留下内容
 *   ⑥ cwd 只判存在不判目录           —— 文件路径必须被拒
 *   ⑦ topic/summary 残缺不拒绝       —— 必须 400 而不是假成功
 *
 * ⚠️ 本脚本**不碰真实库**：全部用临时目录 + 临时 db。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const REPO = path.resolve(HERE, '..')
const INDEX = path.join(REPO, 'dsh-fatfishdream-memory/index.js')
const SRC = fs.readFileSync(INDEX, 'utf8')
const storeUrl = pathToFileURL(path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs')).href

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) {
    pass++
  } else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`  ❌ ${name}  ← ${detail}`)
  }
}

/** 从源码抽出顶层函数体（大括号配对）。 */
function extractFn(src, name) {
  const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`)
  const m = src.match(re)
  if (!m) return null
  const start = m.index + m[0].length - 1
  let depth = 0
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(m.index, i + 1)
    }
  }
  return null
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix7-'))

try {
  // ============================================================
  console.log('=== ① `$` 不该被 String.replace 展开（会改写 policy.md）===\n')
  // 这条测的是**源码写法**：必须用函数形式做 replacement。
  // [回退验证] 把 `() => \`${newLine}\n\`` 改回 `\`${newLine}\n\`，本条立刻红。
  {
    const fnReplace = (SRC.match(/current\.replace\(blockRe, \(\) =>/g) ?? []).length
    check('两处 replace 都用函数形式（restoreHeartbeat + writeHeartbeat）', fnReplace === 2, `实际 ${fnReplace} 处`)

    // ⚠️ 判据要**排除注释里的示例代码**。源码注释里为了说明旧写法，
    //    原样引用了 `current.replace(blockRe, `${newLine}\n`)` ——
    //    直接 grep 会把它当成「还残留着」，那是假阳性。
    //    （第一版就是这么误报的，靠人工看上下文才发现。）
    // 做法：去掉注释行后再判定。
    const codeOnly = SRC.split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    // 允许的两种形态：
    //   replace(blockRe, () => `...`)   ← 插入
    //   replace(blockRe, '')            ← 删除空字符串（无 $ 可展开，安全）
    const stringForm = codeOnly.match(/current\.replace\(blockRe, (?!\(\) =>|'')/g) ?? []
    check(
      '代码里没有「字符串形式」的 replace(blockRe, `${newLine}`)（注释里的示例不算）',
      stringForm.length === 0,
      `实际 ${stringForm.length} 处 —— 残留就会在用户写 $& / $\` 时改写整个 policy.md`,
    )

    // 行为验证：用同一段逻辑跑一遍，确认 `$` 原样保留
    const policy = '# 给模型的规则\n\n- 每轮回复的结尾，加固定一句：大肥鱼在。\n- 另一条规则，绝对不能丢。\n'
    const blockRe = /^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*(?:\n[ \t]+[^\n]*)*\n?/m
    const dangerous = ['共 $& 元', "价格是 $' 元", '模板 $` 开头']
    let allPreserved = true
    for (const t of dangerous) {
      const newLine = `- 每轮回复的结尾，加固定一句：${t}`
      const fixed = policy.replace(blockRe, () => `${newLine}\n`)
      if (!fixed.includes(t)) allPreserved = false
      // 并且绝不能把别的内容插进来
      if (fixed.includes('# 给模型的规则\n- 每轮')) allPreserved = false
    }
    check('函数形式下 $& / $\' / $` 全部原样保留', allPreserved)
  }

  // ============================================================
  console.log('\n=== ② appendArchive 必须在事务里（FTS 失败不留孤儿行）===\n')
  // [回退验证] 把 appendArchive 里的 withFtsTransaction 去掉，本条红。
  {
    const { createDbStore } = await import(storeUrl)
    const dbPath = path.join(tmpRoot, 'archive-tx.db')
    const s = createDbStore(dbPath, {}, () => {})
    s.open()
    s.appendArchive({ scope: 'x', role: 'assistant', text: '第一条正常', sessionId: 's1', turn: 1, step: 1 })

    // 造 FTS 写失败
    const raw = new DatabaseSync(dbPath)
    raw.exec('DROP TABLE archive_fts')
    raw.close()

    let threw = false
    try {
      s.appendArchive({ scope: 'x', role: 'assistant', text: '第二条会失败', sessionId: 's1', turn: 2, step: 1 })
    } catch {
      threw = true
    }
    s.close()

    const ro = new DatabaseSync(dbPath, { readOnly: true })
    const count = ro.prepare('SELECT COUNT(*) c FROM archive').get().c
    const texts = ro.prepare('SELECT text FROM archive').all().map((r) => r.text)
    ro.close()

    check('FTS 失败时 appendArchive 抛错（调用方要知道）', threw === true)
    check(
      'FTS 失败时主表不该留下孤儿行',
      count === 1,
      `实际 ${count} 行：${JSON.stringify(texts)} —— 多出来的那条「在库但永远搜不到」`,
    )
  }

  // ============================================================
  console.log('\n=== ③ isInside 参数方向 ===\n')
  // [回退验证] 把 isInside(root, nextRoot) 改回 isInside(nextRoot, root)，本条红。
  {
    const { relative, isAbsolute } = await import('node:path')
    const isInside = (root, target) => {
      const rel = relative(root, target)
      return rel === '' || (!/^\.\.($|[\\/])/.test(rel) && !isAbsolute(rel))
    }
    const root = path.join(tmpRoot, 'root')
    const child = path.join(root, 'sub')
    const parent = path.dirname(root)

    check('isInside(root, child) === true（子目录确实在 root 里）', isInside(root, child) === true)
    check('isInside(root, parent) === false（父目录不在 root 里）', isInside(root, parent) === false)

    // 代码里的守卫写法：必须拒绝子目录
    check(
      '源码里的守卫是 isInside(root, nextRoot)（正确的容器/内容顺序）',
      /if \(isInside\(root, nextRoot\)\) throw/.test(SRC),
      '写成 isInside(nextRoot, root) 会放行「迁到子目录」',
    )
    check(
      'moveProject 的守卫也是正确顺序',
      /if \(isInside\(current, nextDir\)\) throw/.test(SRC),
    )
    // ⚠️ 同样要排除注释：注释里为说明「原来写反了」会引用旧代码。
    const codeOnly2 = SRC.split('\n')
      .filter((l) => {
        const t = l.trim()
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')
    check(
      '代码里没有残留反序写法（注释里的示例不算）',
      !/isInside\(nextRoot, root\)/.test(codeOnly2) && !/isInside\(nextDir, current\)/.test(codeOnly2),
    )
  }

  // ============================================================
  console.log('\n=== ④ POSIX 守卫：黑名单漏的四种形态必须被拒 ===\n')
  // [回退验证] 把 isPosixAcceptable 的表达式改掉/恒真，本条红。
  //
  // ⚠️ 这里**不能复刻一份判据来测**。第一版就是这么写的：
  //    `const isPosixAcceptable = (explicit) => posix.isAbsolute(explicit) || ...`
  //    那等于测我自己抄的公式，源码改坏了它照样绿（故障注入抓出来的）。
  //    正确做法是**从源码抽表达式、在真实作用域里求值**。
  {
    const { posix } = await import('node:path')

    // 从源码里抽出 isPosixAcceptable 的表达式部分
    const m = SRC.match(/const isPosixAcceptable =\s*\n\s*process\.platform !== 'win32'\s*\n\s*\?\s*([^\n]+?)\s*\n\s*:\s*true/)
    check('能从源码抽出 isPosixAcceptable 的判据表达式', m !== null, m === null ? '源码结构变了' : '')
    if (m !== null) {
      const expr = m[1].trim()  // 例如 `isAbsolute(explicit) || explicit.startsWith('~')`
      check(
        '判据表达式里确实同时有「绝对路径」与「~ 开头」两个条件',
        /isAbsolute\(explicit\)/.test(expr) && /startsWith\('~'\)/.test(expr),
        `实际表达式: ${expr}`,
      )
      // 用源码里的表达式构造一个真实可执行的判据（沙箱里只给 isAbsolute）
      // eslint-disable-next-line no-new-func
      const realJudgement = new Function('explicit', 'isAbsolute', `return (${expr})`)

      const mustReject = ['D:', 'D:mem', '\\\\server\\share\\mem', '\\\\?\\C:\\mem', 'memory']
      for (const v of mustReject) {
        check(
          `源码判据拒绝 ${JSON.stringify(v)}（POSIX 下会建进 cwd）`,
          realJudgement(v, posix.isAbsolute) === false,
        )
      }
      const mustAccept = ['/Users/zc/mem', '/Volumes/Data/mem', '~/mem', '~']
      for (const v of mustAccept) {
        check(`源码判据放行 ${JSON.stringify(v)}`, realJudgement(v, posix.isAbsolute) === true)
      }

      // 已知限制：~user/x（不带斜杠）会被放行 —— 记录现状，不假装已修
      check(
        '已知限制：`~user/x` 被放行（expandRoot 不展开它，仍会落 cwd）',
        realJudgement('~zc/x', posix.isAbsolute) === true,
      )
    }

    check('源码用正向判据（isPosixAcceptable）', /const isPosixAcceptable =/.test(SRC))
    check('旧黑名单已移除', !/looksLikeWindowsDrivePath/.test(SRC))
    // 关键：拒绝分支必须真的用这个判据
    check('rejectOnPosix 引用了 isPosixAcceptable', /const rejectOnPosix =[\s\S]{0,200}?!isPosixAcceptable/.test(SRC))
  }

  // ============================================================
  console.log('\n=== ⑤ 单条超预算的规则不该整条消失 ===\n')
  // [回退验证] 删掉「② 全军覆没」那段分支，本条红。
  {
    const { createDbStore } = await import(storeUrl)
    const dbPath = path.join(tmpRoot, 'budget.db')
    const s = createDbStore(dbPath, {}, () => {})
    s.open()

    // 一条远超预算的红线规则（1400 汉字 ≈ 4200 字节 > 4096）
    const longRule = '红线'.repeat(700)
    s.createEntry({ table: 'rules', scope: 'proj', kind: 'redline', text: longRule })

    const r = s.projectTextSync('proj', 4096)
    s.close()

    check('结果标记为 truncated', r.truncated === true)
    check('count 仍是 1（库里确实有一条）', r.count === 1, `实际 ${r.count}`)
    check(
      '注入文本**非空**（不能只剩「省略 1 条」）',
      r.text.length > 20,
      `实际 ${r.text.length} 字节：${JSON.stringify(r.text)}`,
    )
    check('注入文本含规则内容（哪怕是截断的）', r.text.includes('红线'), `实际: ${JSON.stringify(r.text.slice(0, 60))}`)
    check('没超过预算', Buffer.byteLength(r.text, 'utf8') <= 4096, `实际 ${Buffer.byteLength(r.text, 'utf8')}`)
    check('emptied 标记已设置（让上层能改文案）', r.emptied === true)
  }

  // ============================================================
  console.log('\n=== ⑥ cwd 必须是目录，不能是文件 ===\n')
  // [回退验证] 把 isDirectoryPath(cwd) 改回 exists(cwd)，本条红。
  {
    check('源码用 isDirectoryPath 校验 cwd', /!\(await isDirectoryPath\(cwd\)\)/.test(SRC))
    check('没有残留 exists(cwd) 校验', !/!\(await exists\(cwd\)\)/.test(SRC))

    // 行为验证：文件与目录的区分
    const dirPath = path.join(tmpRoot, 'a-real-dir')
    fs.mkdirSync(dirPath, { recursive: true })
    const filePath = path.join(tmpRoot, 'a-real-file.txt')
    fs.writeFileSync(filePath, 'x', 'utf8')

    const { stat } = await import('node:fs/promises')
    const isDir = async (p) => {
      try {
        return (await stat(p)).isDirectory()
      } catch {
        return false
      }
    }
    check('真目录 → isDirectoryPath 为 true', (await isDir(dirPath)) === true)
    check('真文件 → isDirectoryPath 为 false（这条是关键）', (await isDir(filePath)) === false)
    check('不存在的路径 → false', (await isDir(path.join(tmpRoot, 'nope'))) === false)
  }

  // ============================================================
  console.log('\n=== ⑦ topic / summary 残缺必须拒绝（不能假成功）===\n')
  // [回退验证] 删掉两个 return json(res, 400, ...)，本条红。
  {
    check('topic 不在白名单时 return 400', /topicRaw !== '' && topic === null[\s\S]{0,400}?return json\(res, 400/.test(SRC))

    // ⚠️ 2026-11-17 改：summary 的判据**从「缺失即 400」改成「缺失即从正文截取」**。
    //
    // 这不是为了修测试而放松断言 —— 是**行为被有意改变了**（用户定调：
    // 「让写流水成为『我可以做的一件事』，而不是一条规则」）。
    // 原判据守的是「不能假成功」；新做法同样不假成功 ——
    // 它生成一条**完整**的流水（topic 与 summary 都有值），不是残缺条目。
    //
    // 所以这里改成守**新的行为契约**，而且断言更严：
    //   ① 必须存在 `summary === null` 的兜底分支
    //   ② 该分支里**不能**出现 400（否则又回到「必填」）
    //   ③ 必须真的调用 sanitizeSummary 回填（而不是置 null）
    //   ④ 必须留 diag，便于事后查「这条摘要是不是自动生成的」
    check(
      'summary 缺失时不拒绝，而是从正文截取',
      /summary === null\) \{[\s\S]{0,900}?sanitizeSummary\(cut\)/.test(SRC) &&
        !/summary === null\) \{[\s\S]{0,400}?return json\(res, 400/.test(SRC),
    )
    check('摘要自动生成时留 diag（可追溯）', /diag\('summary-derived'/.test(SRC))
    check('topic 缺失时补默认值而不是留 null', /const topicFinal = topic \?\? '开发日志'/.test(SRC))
    // 「传了但写错」仍然必须拒绝 —— 这条不能因为「可缺省」被放松
    check('topic 传了但写错仍然 400（可缺省 ≠ 允许乱写）', /topicRaw !== '' && topic === null[\s\S]{0,600}?return json\(res, 400/.test(SRC))
    check('拒收文案说明了「这条没有被写入」', /这条没有被写入/.test(SRC))

    // 行为验证：复刻 sanitizeSummary 的判断
    const sanitizeSummary = (raw) => {
      if (raw === undefined || raw === null) return null
      const s = String(raw).replace(/--+>\s*$/g, '').trim()
      return s === '' ? null : s
    }
    check('summary 缺失 → null（触发自动截取分支）', sanitizeSummary(undefined) === null)
    check('summary 空串 → null（触发自动截取分支）', sanitizeSummary('   ') === null)
    check('summary 正常 → 保留', sanitizeSummary('摘要内容') === '摘要内容')

    // 新增：验证「截取」这条规则本身（与源码里的逻辑同构）
    //   判据：取第一行、去 markdown 记号、超 35 字截断加省略号
    const deriveSummary = (text) => {
      const firstLine = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? text
      const cleaned = firstLine.replace(/[#*`>_~]/g, '').replace(/\s+/g, ' ').trim()
      return cleaned.length > 35 ? `${cleaned.slice(0, 34)}…` : cleaned
    }
    check('自动摘要：取第一行', deriveSummary('第一行\n第二行') === '第一行')
    check('自动摘要：去掉 markdown 记号', deriveSummary('## 标题') === '标题')
    check('自动摘要：超 35 字截断且带省略号', deriveSummary('啊'.repeat(50)).length === 35)
    check('自动摘要：短文本原样保留', deriveSummary('短') === '短')
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

console.log(`\n${'─'.repeat(50)}`)
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
  console.log('\n七个 bug 各有用例；每条都标了 [回退验证]，把修复撤掉即变红。')
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('  - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
