/**
 * 回归测试：**收尾语混进流水正文**时必须有痕迹（2026-11-21）。
 *
 * ## 它守的是什么
 *
 * 用户实报：ForzaOverlay 那边的流水 `id=1331` 正文里含「大肥鱼是漂亮老婆」，
 * 而那正是 `policy.md` 里的**收尾语**。
 *
 * 查证结果是**合法的引用**（正文在概括「用户夸了这句」），不是污染。
 * **但当时分不出真假** —— 因为「提到收尾语」和「把收尾语当正文抄进去」
 * 在检索结果里长得一模一样。
 *
 * 这类「看起来成立、实际需要人判断」的形态，正是本项目反复栽跟头的地方：
 * `wroteMemory` 假阳性、`routeHits` 恒 0、`sid` 格式归因错……
 *
 * ## 设计：只记录，不拦截、不改写
 *
 * 拦了会丢真实内容（引用收尾语有时正当），改了就是替调用方做决定。
 * 所以写一行 `log-heartbeat-in-text`，带两个字段让人事后分得清：
 *   · `hits`  —— 出现次数
 *   · `last`  —— 是否在**正文末行**
 *
 * 判据：
 *   · 出现在中间 → 多半是引用（`id=1331` 那种）
 *   · 出现在**末行** → 高度可疑，那是「收尾语被当成结尾写进去了」
 *
 * ## 断言怎么做到「能失败」
 *
 * 复用插件里**现成的** `countHeartbeat` / `isHeartbeatLast`（从源码抽出执行），
 * 不另写一套判据 —— 本项目 2026-11-20 记过：同一语义两份判据，改一处另一处就漂。
 */
import fs from 'node:fs'
import path from 'node:path'

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

/** 剥注释（判据要求：断言「某段代码在/不在」前必须先剥）。 */
function stripComments(text) {
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//')
      return i >= 0 ? l.slice(0, i) : l
    })
    .join('\n')
}
const CODE = stripComments(SRC)

/** 按括号配对抽一个 `function name(...) { … }` 的完整函数体。 */
function extractFunction(src, name) {
  const head = `function ${name}(`
  const at = src.indexOf(head)
  if (at < 0) throw new Error(`源码里找不到函数：${name}`)
  const bodyStart = src.indexOf('{', at)
  let depth = 0
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        // eslint-disable-next-line no-new-func
        return new Function(`return (${src.slice(at, i + 1)})`)()
      }
    }
  }
  throw new Error(`${name}：括号没配对`)
}

const countHeartbeat = extractFunction(SRC, 'countHeartbeat')
const isHeartbeatLast = extractFunction(SRC, 'isHeartbeatLast')

const HB = '大肥鱼是漂亮老婆！'

// ============================================================
console.log('=== ① 现场样本：id=1331 那种「引用」必须能区分出来 ===\n')

{
  // ForzaOverlay 的真实正文（51 字，现场抄自 /entry?id=1331）
  const field = '用户先撒娇捏屁股又夸“大肥鱼是漂亮老婆”，我笑着接住，并顺势把话题拉回 ES 五项修改的实机截图确认。'

  const hits = countHeartbeat(field, HB)
  const last = isHeartbeatLast(field, HB)

  console.log(`   hits=${hits}  last=${last}`)

  // ★ 核心断言（2026-11-21 用户要求补）：**引用形态不许触发告警。**
  //
  // ## 为什么这条必须是断言，不能只是 console.log
  //
  // 现场正文写的是「大肥鱼是漂亮老婆」（**没有感叹号**，被中文引号包着），
  // 而 `policy.md` 里配的收尾语是「大肥鱼是漂亮老婆**！**」。
  // 差一个全角叹号 → `includes(HB)` 为 false → `hits = 0` → **检查不触发**。
  //
  // 这个 0 是**正确行为**，不是漏判：
  //   · 它是正当引用（正文在概括「用户夸了这句」）
  //   · 若这里变成 >0，说明判据被放宽了（比如去掉感叹号去匹配），
  //     那会**让每一条讲这事的流水都报警** —— 又一个 `wroteMemory` 式假阳性
  //
  // 放宽判据的诱惑一直都在：用户问「为什么这条没被抓到」时，
  // 最省事的回答就是「那我放宽一点」。这条断言就是拦住那个冲动的闸门。
  check('引用形态 hits === 0（差一个感叹号 → 不触发，这是正确的）',
    hits === 0, `实际 ${hits}`)
  check('引用形态 last === false（不在末行）', last === false, String(last))

  // 反向自证：把感叹号补上（变成完整收尾语），hits 必须变成 >0。
  // 这证明上面的 0 **不是恒为 0**，而是真的由「差一个感叹号」造成的。
  const withBang = field.replace('大肥鱼是漂亮老婆”', '大肥鱼是漂亮老婆！”')
  const hitsWithBang = countHeartbeat(withBang, HB)
  check('自证：补上感叹号后 hits > 0（证明上面的 0 不是恒真）',
    hitsWithBang >= 1, `实际 ${hitsWithBang}`)

  // 再自证：这个替换确实生效了（否则双绿无意义）
  check('自证：替换锚点生效（原文里确实有「大肥鱼是漂亮老婆」）',
    withBang !== field, '锚点没匹配上 → 上一条自证无效')
}

// ============================================================
console.log('\n=== ② 真污染形态：收尾语独占末行 ===\n')

{
  const polluted = '用户让我修好了 ES 面板。\n\n' + HB
  check('真污染：末行命中', isHeartbeatLast(polluted, HB) === true)
  check('真污染：hits >= 1', countHeartbeat(polluted, HB) >= 1)

  // 前面有其它内容、收尾语在最后 —— 这才是要报警的
  const midButEnded = '说了收尾语 ' + HB + ' 然后又写了一句话'
  check('中间提到、后面还有正文 → last=false（不算污染）',
    isHeartbeatLast(midButEnded, HB) === false)
}

// ============================================================
console.log('\n=== ③ 边界：引用不该被当成污染 ===\n')

{
  // 表格行与引用块里的收尾语，countHeartbeat 会跳过（原设计）
  check('表格行里的收尾语不计数',
    countHeartbeat(`| 项 | 值 |\n| 收尾语 | ${HB} |`, HB) === 0,
    String(countHeartbeat(`| 项 | 值 |\n| 收尾语 | ${HB} |`, HB)))

  check('引用块（> 开头）里的收尾语不计数',
    countHeartbeat('> ' + HB, HB) === 0,
    String(countHeartbeat('> ' + HB, HB)))

  // 但 isHeartbeatLast 只看末行 —— 这是两件事，要能分开
  check('isHeartbeatLast 仍会看末行（与 countHeartbeat 分工不同）',
    typeof isHeartbeatLast('> ' + HB, HB) === 'boolean')
}

// ============================================================
console.log('\n=== ④ 接线：检查真的写在 /log 里，且只在写入成功后 ===\n')

{
  check('存在 log-heartbeat-in-text 诊断', CODE.includes("diag('log-heartbeat-in-text'"))

  const logAt = CODE.indexOf("path: '/api/dsh-memory/log'")
  const nextRoute = CODE.indexOf("path: '/api/dsh-memory/", logAt + 10)
  check('能定位 /log 路由段', logAt > 0 && nextRoute > logAt, `${logAt}/${nextRoute}`)

  if (logAt > 0 && nextRoute > logAt) {
    const seg = CODE.slice(logAt, nextRoute)
    const appendAt = seg.indexOf('dbStore.appendLog(')
    const diagAt = seg.indexOf("diag('log-heartbeat-in-text'")
    check('检查在 appendLog 之后（先落库再观测）', appendAt >= 0 && diagAt > appendAt,
      `append=${appendAt} diag=${diagAt}`)
    check('检查真的调用了 countHeartbeat', seg.includes('countHeartbeat('))
    check('检查真的调用了 isHeartbeatLast', seg.includes('isHeartbeatLast('))
    check('带 hits 字段', /hits,/.test(seg) || /hits:/.test(seg))
    check('带 last 字段', /last:/.test(seg))

    // ★ 2026-11-21 补：**必须真的把 policy.md 的收尾语喂进去。**
    //
    // ## 为什么这条非加不可（故障注入实测）
    //
    // 我第一版只查「调用了 `countHeartbeat(`」，然后做故障注入：
    //     `const hb = readHeartbeat()` → `const hb = ''`
    // **脚本仍然全绿**。因为改成 `''` 之后代码**依然"调用了 countHeartbeat"** ——
    // 只是传进去的是空串，`countHeartbeat` 第一行就 `return null`，检查永不触发。
    //
    // 这就是 AGENTS.md 说的「断言在，被测的差异不在」：
    // 断言查的是**是否提及**，而差异在**传了什么**。
    //
    // 判据：`const hb = ...` 这一行必须**读 policy.md**，不能是字面量。
    check('hb 取自 readHeartbeat()（不是字面量/空串）',
      /const hb = readHeartbeat\(\)/.test(seg),
      '若改成字面量，countHeartbeat 会拿到空串/错值，检查永不触发 —— 而"调用了"这条断言照样绿')
  }
}

// ============================================================
console.log('\n=== ⑤ 反向守卫：不许拦截、不许改写正文 ===\n')

{
  const logAt = CODE.indexOf("path: '/api/dsh-memory/log'")
  const nextRoute = CODE.indexOf("path: '/api/dsh-memory/", logAt + 10)
  const seg = logAt > 0 && nextRoute > logAt ? CODE.slice(logAt, nextRoute) : ''

  // ★ 核心：新增的检查必须包在 try 里，且不许提前 return
  check('检查包在 try 里（观测代码不能影响写入）',
    /try \{[^}]*log-heartbeat-in-text/.test(seg) || /try \{[\s\S]{0,400}?log-heartbeat-in-text/.test(seg))

  // 不许因为命中收尾语就拒绝写入 —— 那会丢掉真实内容
  check('没有因为收尾语命中而 return / 拒绝写入',
    !/log-heartbeat-in-text[\s\S]{0,200}?return json\(res, 4/.test(seg),
    '若有，说明从「记录」变成了「拦截」，会丢真实内容')

  // 不许改动 md 原文（text 变量在写入后不应被重新赋值）
  check('写入的正文没有被改写', !/text = text\.replace/.test(seg))
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
