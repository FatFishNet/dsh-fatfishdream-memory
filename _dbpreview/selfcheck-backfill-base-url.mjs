/**
 * 回归测试：补记的**根地址解析**（`resolveLocalBaseUrl` 三层回退）。
 *
 * ## 它守的是什么缺陷
 *
 * 2026-11-20：补记从「子代理」重写成「`prepareCall` 直连模型」之后，
 * 连跑 2 次全部失败：
 *
 *     12:35:35 [backfill-failed] {"reason":"no DSH_WEB_URL"}
 *     12:36:14 [backfill-failed] {"reason":"no DSH_WEB_URL"}
 *
 * 根因不是 prepareCall，而是**取根地址的那一行查错了地方**：
 * `DSH_WEB_URL` 不是进程环境变量 —— 它由 `dsh-web-app` 注册进 `shellEnv`，
 * **每次模型 shell 调用时**现算并注入子进程（服务契约原文：
 * 「The namespace is rebuilt for every model shell call」）。
 * 于是 `log.ps1`（子进程）读得到，插件进程（Host 主进程）永远读不到。
 *
 * 修法是三层回退，且第 ① 层与 DSH 自己同源 —— asar 源码
 * `dsh-web-app/lib/index.js`：
 *
 *     const appRootUrl = () => publicUrl ?? ctx.webServer.getOrigin()
 *     ctx.provide("webApp", { getAdvertisedUrl: appRootUrl })
 *     shellEnv.register({ variables: { DSH_WEB_URL: … },
 *                         resolve: () => ({ DSH_WEB_URL: appRootUrl() }) })
 *
 * 也就是说 `webApp.getAdvertisedUrl()` 与 `DSH_WEB_URL` **是同一个函数**，
 * 走它等于拿到权威来源，而不是猜端口。
 *
 * ## 为什么这个脚本现在才存在
 *
 * 修完之后实测成功过一次（12:56:41 `backfill-base-url from=webApp`）——
 * 但那条证据只活在**当天的日志里**。第二天谁把第 ① 层删掉，
 * 没有任何脚本会红：补记会安静地退到第 ②/③ 层，
 * 更糟的情况是三层全断 → 回到「漏记 + 无补记」，而日志干净、界面正常。
 *
 * 硬约束 15 定：影响记流水的缺陷按**数据丢失**对待。
 * 「没有测试」= 这条防线不存在 = 违反那条约束的实质。
 *
 * ## 断言怎么做到「能失败」
 *
 * 不从源码贴一份逻辑来测（那样源码改坏了它照样绿 —— AGENTS.md 的
 * 「断言在，被测的差异不在」）。这里用 `extractFn()` 把**真实源码里的
 * 函数体**抽出来求值，源码改了测试跟着变。
 *
 * 自带第 ⑥ 段「自证」：把回退链的每一层分别改成错的实现，
 * 对应断言必须变红 —— 否则说明这些断言是恒真的。
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

/**
 * 从源码里抽出 `const <name> = (...) => { … }` 的**完整函数体**，返回可执行的函数。
 *
 * ⚠️ 必须按**括号配对**取完整表达式，不能按「一行」或「锚点字符串」取。
 *
 * 2026-11-20 在别处踩过：切片范围错了会让真实断言和自证**一起**给错结论，
 * 而自证还报告「通过」。所以这里抽完先自证一遍（第 ⑥ 段）。
 */
function extractArrowFn(src, name) {
  const head = `const ${name} = `
  const at = src.indexOf(head)
  if (at < 0) throw new Error(`源码里找不到函数声明：${name}`)
  const bodyStart = src.indexOf('{', at)
  if (bodyStart < 0) throw new Error(`${name}：找不到函数体起点`)
  let depth = 0
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) {
        // 截到闭合大括号，补上调用括号，整段就是一个可求值的箭头函数表达式
        const expr = src.slice(at + head.length, i + 1)
        // eslint-disable-next-line no-new-func
        return { fn: new Function(`return (${expr})`)() , length: i + 1 - at }
      }
    }
  }
  throw new Error(`${name}：括号没配对，抽不出函数体`)
}

const { fn: resolveLocalBaseUrl, length: fnLen } = extractArrowFn(SRC, 'resolveLocalBaseUrl')

/**
 * 剥掉 `//` 行注释与 `/* … *\/` 块注释，只留真正的代码。
 *
 * 为什么必须有它：本项目 2026-11-20 栽过两次「注释里的代码被当成代码」——
 * 一次是故意留旧写法作对照导致断言误报，一次是 grep 命中了说明性注释。
 * 判据是：**要断言「某段代码不在了」时，必须剥注释**，
 * 否则你查到的永远是你自己写的那句说明。
 *
 * ⚠️ 这是**字符串层面的近似**，不处理字符串字面量里出现的 `//`。
 * 对本项目够用（没有 URL 字面量里带 `//` 且后面还需要断言的场景），
 * 但别把它当通用解析器。
 */
function stripComments(text) {
  // 先剥块注释（可能跨行），再逐行剥 `//`
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, '')
  return noBlock
    .split('\n')
    .map((l) => {
      const i = l.indexOf('//')
      return i >= 0 ? l.slice(0, i) : l
    })
    .join('\n')
}

/** 造一个假的服务表：只列出确实存在的服务，其余一律 undefined（与真实 `ctx.get` 同语义）。 */
const services = (map) => (key) => map[key]

// ============================================================
console.log('=== ① 第 ① 层：webApp.getAdvertisedUrl 命中 ===\n')

{
  // 这是 2026-11-20 实测命中的那一层（日志 `from:"webApp"`）
  const r = resolveLocalBaseUrl(
    services({
      webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:6688' },
      webServer: { getOrigin: () => 'http://127.0.0.1:9999' },
    }),
    {},
  )
  check('webApp 可用时命中 webApp', r.ok === true && r.from === 'webApp', JSON.stringify(r))
  check('取到的是 webApp 的值，不是 webServer 的值',
    r.base === 'http://127.0.0.1:6688', r.base)
}

// ============================================================
console.log('\n=== ② 第 ② 层：webApp 缺失/抛错时退到 webServer ===\n')

{
  // webApp 整个服务不在
  const r1 = resolveLocalBaseUrl(
    services({ webServer: { getOrigin: () => 'http://127.0.0.1:7777' } }),
    {},
  )
  check('webApp 缺失 → 退到 webServer', r1.ok === true && r1.from === 'webServer', JSON.stringify(r1))
  check('webServer 的 base 正确', r1.base === 'http://127.0.0.1:7777', r1.base)

  // webApp 在但调用抛错（listen 之前 getOrigin 会抛，这是真实形态）
  const r2 = resolveLocalBaseUrl(
    services({
      webApp: { getAdvertisedUrl: () => { throw new Error('webserver: origin read before the listener bound a port') } },
      webServer: { getOrigin: () => 'http://127.0.0.1:7778' },
    }),
    {},
  )
  check('webApp 抛错 → 仍然退到 webServer', r2.ok === true && r2.from === 'webServer', JSON.stringify(r2))

  // webApp 在但返回空串
  const r3 = resolveLocalBaseUrl(
    services({
      webApp: { getAdvertisedUrl: () => '' },
      webServer: { getOrigin: () => 'http://127.0.0.1:7779' },
    }),
    {},
  )
  check('webApp 返回空串 → 退到 webServer', r3.ok === true && r3.from === 'webServer', JSON.stringify(r3))

  // webApp 存在但根本没有那个方法（对象形状变了）
  const r4 = resolveLocalBaseUrl(
    services({ webApp: {}, webServer: { getOrigin: () => 'http://127.0.0.1:7780' } }),
    {},
  )
  check('webApp 没有 getAdvertisedUrl → 退到 webServer',
    r4.ok === true && r4.from === 'webServer', JSON.stringify(r4))
}

// ============================================================
console.log('\n=== ③ 第 ③ 层：前两层都断了才用 env ===\n')

{
  const r = resolveLocalBaseUrl(services({}), { DSH_WEB_URL: 'http://127.0.0.1:5555' })
  check('前两层缺失 → 用 env', r.ok === true && r.from === 'env', JSON.stringify(r))
  check('env 的 base 正确', r.base === 'http://127.0.0.1:5555', r.base)

  // ★ 顺序断言：env 有值时，若 webApp 也有值，**不许**用 env。
  //   这条守的是「回退顺序」本身 —— 少了它，把 env 提到第一位也能全绿。
  const rOrder = resolveLocalBaseUrl(
    services({ webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:1111' } }),
    { DSH_WEB_URL: 'http://127.0.0.1:2222' },
  )
  check('webApp 与 env 同时有值 → 必须优先 webApp（回退顺序）',
    rOrder.from === 'webApp' && rOrder.base === 'http://127.0.0.1:1111',
    JSON.stringify(rOrder))
}

// ============================================================
console.log('\n=== ④ 三层全断：必须失败且把三层都记进 tried ===\n')

{
  const r = resolveLocalBaseUrl(services({}), {})
  check('三层全断 → ok === false', r.ok === false, JSON.stringify(r))
  check('三层全断 → base 为空串', r.base === '', JSON.stringify(r.base))
  check('三层全断 → from 为 null', r.from === null, String(r.from))

  // ★ 核心：`tried` 必须把三层都列出来。
  //
  // 为什么这条重要：旧代码三层全断只留一句 `no DSH_WEB_URL`，
  // 下一个会话要**从零查起**（本次修 bug 的代价就是一整轮）。
  // 有 tried 才能一眼看出「是 webApp 没有、webServer 抛了、env 也没有」。
  check('tried 是数组', Array.isArray(r.tried), typeof r.tried)
  const joined = Array.isArray(r.tried) ? r.tried.join(' ') : ''
  check('tried 记录了 webApp 这一层', /webApp/.test(joined), joined)
  check('tried 记录了 webServer 这一层', /webServer/.test(joined), joined)
  check('tried 记录了 env 这一层', /env/.test(joined), joined)

  // 三层各缺一次，tried 长度至少 3（层数不许被谁悄悄少算）
  check('tried 至少 3 项（三层都试过）',
    Array.isArray(r.tried) && r.tried.length >= 3, `实际 ${r.tried?.length}`)
}

// ============================================================
console.log('\n=== ⑤ 尾斜杠归一：base 不许带尾部 / ===\n')

{
  // 为什么必须归一：后面要拼 `${base}/api/dsh-memory/log`，
  // 尾斜杠会拼出 `//api/...`，部分服务端会 404，且这种 404 看起来像「路由没注册」。
  const r = resolveLocalBaseUrl(
    services({ webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:6688/' } }),
    {},
  )
  check('单个尾斜杠被去掉', r.base === 'http://127.0.0.1:6688', r.base)

  const r2 = resolveLocalBaseUrl(
    services({ webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:6688///' } }),
    {},
  )
  check('多个尾斜杠被去掉', r2.base === 'http://127.0.0.1:6688', r2.base)
}

// ============================================================
console.log('\n=== ⑥ 自证：把每一层改成错的实现，对应断言必须变红 ===\n')

{
  // 抽取器自证：函数体长度必须合理（太小说明括号配对截错了）
  check('自证：抽出的函数体长度合理（不是截到第一个 } 就停）',
    fnLen > 800, `实际 ${fnLen} 字符`)

  // 自证 1：如果第 ① 层被删（webApp 分支整段移除），① 的断言必须红。
  //   这里用「把 getAdvertisedUrl 的返回值判断改成恒假」模拟——
  //   等价于这一层永远不命中。
  const broken1 = (src) => src.replace(
    "if (typeof v === 'string' && v !== '') {\n          return { ok: true, base: v.replace(/\\/+$/, ''), from: 'webApp', tried }",
    "if (false) {\n          return { ok: true, base: v.replace(/\\/+$/, ''), from: 'webApp', tried }",
  )
  const mut1 = broken1(SRC)
  check('自证：第 ① 层的注入锚点唯一（改得到，不是空操作）',
    mut1 !== SRC, '锚点没匹配上 → 下面的自证无效')
  if (mut1 !== SRC) {
    const { fn: brokenFn } = extractArrowFn(mut1, 'resolveLocalBaseUrl')
    const r = brokenFn(
      services({
        webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:6688' },
        webServer: { getOrigin: () => 'http://127.0.0.1:9999' },
      }),
      {},
    )
    // 正确实现下 from 应为 webApp；破坏后必须不再是 webApp
    check('自证：破坏第 ① 层后，① 的断言会红（from 不再是 webApp）',
      r.from !== 'webApp', `错误实现返回 from=${r.from}`)
  }

  // 自证 2：如果 env 被提到最前面（回退顺序被改坏），③ 的顺序断言必须红。
  const hoisted = SRC.replace(
    'const resolveLocalBaseUrl = (getService = (key) => ctx.get(key), env = process.env) => {\n    const tried = []',
    'const resolveLocalBaseUrl = (getService = (key) => ctx.get(key), env = process.env) => {\n    const tried = []\n    if (env.DSH_WEB_URL) return { ok: true, base: env.DSH_WEB_URL, from: \'env\', tried }',
  )
  check('自证：env 提前的注入锚点唯一', hoisted !== SRC, '锚点没匹配上')
  if (hoisted !== SRC) {
    const { fn: brokenFn2 } = extractArrowFn(hoisted, 'resolveLocalBaseUrl')
    const r = brokenFn2(
      services({ webApp: { getAdvertisedUrl: () => 'http://127.0.0.1:1111' } }),
      { DSH_WEB_URL: 'http://127.0.0.1:2222' },
    )
    check('自证：把 env 提前后，③ 的顺序断言会红',
      r.from === 'env', `错误实现返回 from=${r.from}（正确实现应为 webApp）`)
  }

  // 自证 3：如果 tried 不再记录层名，④ 的 tried 断言必须红。
  const noTried = SRC.replace("tried.push('webApp:missing')", "tried.push('x')")
  check('自证：tried 的注入锚点唯一', noTried !== SRC, '锚点没匹配上')
  if (noTried !== SRC) {
    const { fn: brokenFn3 } = extractArrowFn(noTried, 'resolveLocalBaseUrl')
    const r = brokenFn3(services({}), {})
    check('自证：丢掉 webApp 层名后，④ 的断言会红',
      r.tried.includes('webApp:missing') === false &&
        !r.tried.join(' ').includes('webApp'),
      `错误实现 tried=${JSON.stringify(r.tried)}`)
  }
}

// ============================================================
// ⑦ 接线核对：这个函数必须真的被 runBackfillTask 调用，
//    且调用点不再直接读 process.env.DSH_WEB_URL。
//
// 为什么要这一段：函数写对了但没人调用 = 什么都没修好。
// 这正是 AGENTS.md 记的「reportBudget 静默失效：函数在、调用点没了」。
// ============================================================
console.log('\n=== ⑦ 接线：函数必须真被调用，且旧的裸读已消失 ===\n')

{
  const callCount = (SRC.split('resolveLocalBaseUrl()').length - 1)
  check('resolveLocalBaseUrl() 在源码里被调用至少 1 次',
    callCount >= 1, `实际 ${callCount} 次`)

  // 调用点必须在 runBackfillTask 里（补记那条链）
  const rbt = SRC.indexOf('const runBackfillTask = ')
  check('能找到 runBackfillTask', rbt > 0)
  if (rbt > 0) {
    const tail = SRC.slice(rbt, rbt + 3000)
    check('runBackfillTask 内部调用了 resolveLocalBaseUrl',
      tail.includes('resolveLocalBaseUrl()'), '没调用 → 补记仍拿不到根地址')
  }

  // ★ 旧的裸读必须消失。注意**剥掉注释再查** ——
  // AGENTS.md 2026-11-20 那条：注释里留一段旧写法做对照，
  // 会让「旧写法已消失」的断言误报，也会让「新写法存在」的断言误判。
  //
  // ⚠️ 剥离必须同时处理 `//` **和** `/* … *\/`。
  //    第一版只剥了行注释，于是块注释里的
  //        * ## 为什么不能只读 `process.env.DSH_WEB_URL`（2026-11-20 实测）
  //        *   ③ `process.env.DSH_WEB_URL` —— 兜底…
  //    让这条断言**假红**了一次。
  //    这正是本条断言想防的那个坑，只不过这次踩的是测试自己。
  const stripped = stripComments(SRC)
  check('代码（非注释）里不再裸读 process.env.DSH_WEB_URL',
    !stripped.includes('process.env.DSH_WEB_URL'),
    '函数体内还有裸读 → 回退链被绕过')
  check('env 读取走注入的 env 参数',
    stripped.includes('env.DSH_WEB_URL'), '没找到 env.DSH_WEB_URL')

  // 自证：剥离函数本身必须真的剥掉块注释与行注释。
  // 用一段已知形状的文本喂**同一份 stripComments**，
  // 不在自证里复刻逻辑（否则剥离坏了，真实断言和自证会一起错）。
  {
    const sample = [
      '/**',
      ' * 旧写法是 process.env.DSH_WEB_URL',
      ' */',
      'const a = env.DSH_WEB_URL // 行尾注释里的 process.env.DSH_WEB_URL',
      'const b = 1',
    ].join('\n')
    const out = stripComments(sample)
    check('自证：块注释被剥掉', !out.includes('旧写法'), out.replace(/\s+/g, ' ').slice(0, 60))
    check('自证：行尾注释被剥掉', !out.includes('行尾注释'), out.replace(/\s+/g, ' ').slice(0, 60))
    check('自证：真实代码保留', out.includes('env.DSH_WEB_URL') && out.includes('const b = 1'),
      out.replace(/\s+/g, ' ').slice(0, 80))
    check('自证：剥离后不再含任何 process.env.DSH_WEB_URL',
      !out.includes('process.env.DSH_WEB_URL'), out)
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
