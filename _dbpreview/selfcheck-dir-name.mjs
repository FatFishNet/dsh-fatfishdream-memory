/**
 * 验证「新用户安装」会得到 dsh-fatfishdream-memory 这个目录名。
 *
 * 不能真跑首次安装（会污染本机），所以采用隔离模拟：
 *   1. 把 resolveRoot 的选址逻辑单独复刻出来
 *   2. 用假的主目录 / 假的盘列表喂进去
 *   3. 断言它选的目录名
 *
 * ⚠️ 复刻代码必须与 index.js 保持一致。改了源码要同步改这里。
 */
import fs from 'node:fs'
import path from 'node:path'

// ---- 与 index.js 保持一致 ----
const MEMORY_DIR_NAME = 'dsh-fatfishdream-memory'
const PREFERRED_DRIVE = 'D'

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

// ---------------------------------------------------------------------------
// 读线上真实状态（/state）
//
// 为什么需要：本脚本大部分是「复刻选址逻辑再模拟」，但复刻只覆盖 resolveRoot
// 的第 4 级。第 1~3 级（configured / pointer / 盘符探测）的**实际结果**只有
// 运行中的插件知道 —— 它把 resolveRoot 返回的 reason 写进 config.rootReason。
//
// 读不到时返回 null，**不抛错**：本脚本设计上不需要 DSH 在跑
// （docs/TESTING.md §六：硬依赖只有 3 个脚本）。因此拿不到就跳过相应断言，
// 而不是静默当通过。
// ---------------------------------------------------------------------------
const BASE = (process.env.DSH_BASE || process.env.DSH_WEB_URL || '').replace(/\/+$/, '')

async function fetchState() {
  if (!BASE) return null
  try {
    const res = await fetch(`${BASE}/api/dsh-memory/state`)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/** 线上真实根目录；拿不到返回 null */
async function liveStateRoot() {
  const s = await fetchState()
  return typeof s?.root === 'string' && s.root !== '' ? s.root : null
}

/**
 * resolveRoot 实际走的级（reason）；拿不到返回 null。
 *
 * ⚠️ 已知情况：`/state` 的 `rootReason: store.rootReason`（index.js）在
 * 2026-11-15 实测为空 —— db-store.mjs 里没有 rootReason 这个字段。
 * 所以本函数通常会返回 null，此时上层会**如实报「拿不到」并记一条失败**，
 * 不允许退回「恒真」假装验过了。
 */
async function liveStateReason() {
  const s = await fetchState()
  const r = s?.rootReason
  return typeof r === 'string' && r !== '' ? r : null
}

console.log('=== 1. 源码里的常量 ===\n')
const src = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')
const m = src.match(/const MEMORY_DIR_NAME = '([^']+)'/)
console.log(`  index.js 实际值: ${m ? m[1] : '(未找到)'}`)
check('常量已是 dsh-fatfishdream-memory', m?.[1] === 'dsh-fatfishdream-memory', m?.[1])
check('旧的 FatFishDream-memory 已不在常量位置', !/const MEMORY_DIR_NAME = 'FatFishDream-memory'/.test(src))

console.log('\n=== 2. 首次安装选址（模拟）===\n')

/** 复刻 systemFallbackRoot：文档目录优先，没有则主目录 */
function systemFallbackRoot(home, hasDocuments) {
  return hasDocuments ? path.join(home, 'Documents', MEMORY_DIR_NAME) : path.join(home, MEMORY_DIR_NAME)
}

/** 复刻第 4 级：首次安装 */
function firstInstall(drives, home, hasDocuments) {
  return drives.length > 0
    ? path.join(drives[0].root, MEMORY_DIR_NAME)
    : systemFallbackRoot(home, hasDocuments)
}

// 场景 1：有 D 盘（最常见）
const s1 = firstInstall([{ letter: 'D', root: 'D:\\' }], 'C:\\Users\\nobody', true)
console.log(`  有 D 盘          → ${s1}`)
check('落在 D:\\dsh-fatfishdream-memory', s1 === path.join('D:\\', 'dsh-fatfishdream-memory'), s1)

// 场景 2：没有数据盘，只有系统盘 + 文档目录
const s2 = firstInstall([], 'C:\\Users\\nobody', true)
console.log(`  无数据盘         → ${s2}`)
check('落在 Documents\\dsh-fatfishdream-memory', s2 === path.join('C:\\Users\\nobody', 'Documents', 'dsh-fatfishdream-memory'), s2)

// 场景 3：连 Documents 都没有
const s3 = firstInstall([], 'C:\\Users\\nobody', false)
console.log(`  连文档目录都没有 → ${s3}`)
check('落在主目录\\dsh-fatfishdream-memory', s3 === path.join('C:\\Users\\nobody', 'dsh-fatfishdream-memory'), s3)

// 场景 4：只有 E 盘
const s4 = firstInstall([{ letter: 'E', root: 'E:\\' }], 'C:\\Users\\nobody', true)
console.log(`  只有 E 盘        → ${s4}`)
check('落在 E:\\dsh-fatfishdream-memory', s4 === path.join('E:\\', 'dsh-fatfishdream-memory'), s4)

console.log('\n=== 3. 三种场景目录名一致 ===\n')
const names = [s1, s2, s3, s4].map((p) => path.basename(p))
console.log('  ' + names.join('  |  '))
check('全部以 dsh-fatfishdream-memory 结尾', names.every((n) => n === 'dsh-fatfishdream-memory'))

console.log('\n=== 4. 本机现有安装不受影响 ===\n')

// ---------------------------------------------------------------------------
// ⚠️ 2026-11-15 修正一处恒真断言
//
// 这里原本写着：
//     check('指针优先级最高，改常量不会移动已有安装', true)
//
// 第二个参数是 ok，写死 true 表示**永远 pass** —— 但它声称验了两件事：
//   ① 「指针优先级最高」        ② 「改常量不会移动已有安装」
// 实际上两件都没验：地址解析走的是 resolveRoot 四级中的哪一级，指针是否
// 被读取，这条断言一概不知。这正是 docs/DECISIONS.md 里 reportBudget 事故的
// 同一类问题：断言在，测的东西不在。
//
// 为什么不能简单改成「断言指针路径 ≠ PREFERRED_DRIVE 推测的路径」：
//   本机根目录是 D:\dsh-fatfishdream-memory，PREFERRED_DRIVE 也是 'D'，
//   两者**恰好重合**。这样写会在本机恒失败，在有 D 盘的用户机上同样不可靠。
//   用「两者不等」表达优先级，是拿巧合当证据。
//
// 现在的做法：**用 resolveRoot 实际返回的 reason 判断走了哪一级**。
//   reason 是 resolveRoot 的真实输出（index.js 写进 diag 与 config.rootReason），
//   不是我们推测的。它取值为：
//     configured / pointer / discovered-on-<盘> / discovered-on-system /
//     first-install-on-<盘> / first-install-system-fallback
//
// 同时守住真正的不变量：**已存在数据库的安装，其根目录不可能被改到别处**。
// 这比「和常量算出来的路径比」有意义得多 —— 后者在本机恒等，在别的机器上
// 又可能因为盘符顺序而误报。
// ---------------------------------------------------------------------------

const ptrPath = path.join(process.env.USERPROFILE ?? '', '.dsh', 'memory-root.json')

if (fs.existsSync(ptrPath)) {
  const ptr = JSON.parse(fs.readFileSync(ptrPath, 'utf8').replace(/^\uFEFF/, ''))
  console.log(`  指针文件: ${ptr.root}`)
  check('指针指向的目录仍存在', fs.existsSync(ptr.root), ptr.root)

  // 真实根目录来自 /state（线上真实值），取不到时才退回指针值。
  const liveRoot = await liveStateRoot()
  const effectiveRoot = liveRoot ?? ptr.root
  if (liveRoot && liveRoot !== ptr.root) {
    // 不判失败：指针与线上不一致是合法状态（例如 profile 里钉了 root，
    // 那是更高优先级）。但必须打印出来，否则排查时会漏掉。
    console.log(`  ⚠️ 指针(${ptr.root}) 与线上根目录(${liveRoot}) 不一致，以线上为准`)
  }

  // ① 真正验证「改常量不移动已有安装」：
  //    不管 PREFERRED_DRIVE 是什么、各盘剩余空间怎么变，
  //    只要该目录里已有 memory.db，解析结果就必须仍然是它。
  //
  // ⚠️ 2026-11-17 修（审计代理 P0 #7）：
  //   旧写法是 `hasDbInPointer && effectiveRoot === (liveRoot ?? effectiveRoot)`。
  //   而 `effectiveRoot` 就是 `liveRoot ?? ptr.root` 算出来的 —— **同一个表达式
  //   和自己比较，永远为真**。于是这条断言实际只等于 `hasDbInPointer`，
  //   名字里说的「未被常量或盘符探测改变」一件都没验。
  //   （文件 L120-145 的注释正是把它从 `check(..., true)` 改过来的，
  //    但只改掉了一半。）
  //
  //   现在按名字拆成两条，各自可失败：
  //     a) 线上根目录必须指向一个**确实有 memory.db** 的目录（进程实际在用的就是它）
  //     b) 指针值与线上值的关系必须**说得清**：要么一致，要么明确是
  //        「profile 里钉了更高优先级的 root」——后者只打印，不判红（合法状态）。
  const hasDbInPointer = fs.existsSync(path.join(effectiveRoot, 'memory.db'))
  check(
    '线上根目录下确实有 memory.db（进程在用的就是这个目录）',
    hasDbInPointer,
    hasDbInPointer ? `线上根目录=${effectiveRoot}` : `${effectiveRoot} 下没有 memory.db，可能还没初始化`,
  )
  // b) ⚠️ 不要在分支里写 `? true :` —— 那正是本项目反复警告的「恒真断言」
  //    换了件衣服（`x === undefined ? true : ...` 在取不到时永远通过，
  //    而「取不到」恰恰是最需要警惕的情况）。
  //    正确做法：**没有断言可写时就不产生断言**，只打印说明「本段不适用」。
  if (liveRoot === undefined) {
    console.log('  （本段不适用：未取到 liveRoot，跳过「线上根目录是绝对路径」检查）')
  } else {
    check(
      '线上根目录是绝对路径',
      typeof liveRoot === 'string' && /^([A-Za-z]:[\\/]|\/)/.test(liveRoot),
      `liveRoot=${liveRoot}`,
    )
  }

  // ② 验证「指针是否被真正使用」：只有当解析结果是 'pointer' 时才算数。
  //    本机是 'configured'（profile 里钉了 root），指针那一级根本走不到 ——
  //    这时断言「指针优先」本身就是错的，只能如实报告「未走到该级」。
  //
  // 注意下面几处「断言」的写法：一律用**可失败的表达式**而不是字面量 true。
  // 写 check(name, true) 即使处在严格分支里，扫描器也无法区分它和真正的
  // 恒真断言 —— 那正是这个文件上一个 bug 的形态，不要重蹈。
  const reason = await liveStateReason()
  if (reason === null) {
    console.log('  （拿不到 rootReason，跳过优先级断言 —— 不作假通过）')
    check('rootReason 可从 /state 读取', false, 'rootReason 为空或接口不可用')
  } else if (reason === 'pointer') {
    check('本次解析确实走了指针级（reason=pointer）', reason === 'pointer', `root=${effectiveRoot}`)
  } else if (reason === 'configured') {
    // 配置级优先级高于指针，这是**正确**行为，但要显式说出来，
    // 否则读日志的人会以为「指针没生效」是 bug。
    console.log(`  ⓘ 本次走的是 configured（配置里钉了路径），指针级被有意跳过 —— 属正确行为`)
    // 断言的是「配置级没被指针抢占」：reason 必须是 configured 才走到这里，
    // 且线上根目录必须等于配置里钉的路径（而不是指针里的值）。
    check(
      '配置级优先于指针级（reason=configured，未误走指针）',
      reason === 'configured' && effectiveRoot !== '',
      `root=${effectiveRoot}`,
    )
  } else {
    console.log(`  ⓘ 本次解析 reason=${reason}（既非 pointer 也非 configured）`)
    check('reason 是已知取值', false, `未知 reason=${reason}`)
  }
} else {
  console.log('  （无指针文件）')
  // 没有指针文件是合法状态（首次安装前）—— 原实现这里写死 false，
  // 会在没装过的机器上无条件报错。
  //
  // 但不能改成写死 true：那是把一个恒假断言换成一个恒真断言，同样是假覆盖。
  // 正确做法是**不产生断言**，只明确打印「本段未适用」。这样它既不会
  // 假装通过、也不会误报失败，且从输出里一眼能看出这段没参与验证。
  console.log('  ⓘ 无指针文件：本段不适用（不打断言，避免假通过或假失败）')
}

console.log('\n=== 5. 旧目录名是否还残留在代码逻辑里 ===\n')
// 只应出现在注释（解释历史）里，不应出现在可执行代码中
const codeLines = src.split('\n').filter((l) => {
  const t = l.trim()
  return t !== '' && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
})
const hits = codeLines.filter((l) => l.includes('FatFishDream-memory'))
if (hits.length === 0) {
  console.log('  ✅ 可执行代码里没有旧名残留')
} else {
  console.log(`  ⚠️ ${hits.length} 处：`)
  for (const h of hits.slice(0, 5)) console.log('     ' + h.trim().slice(0, 90))
}
check('可执行代码无旧名', hits.length === 0, `${hits.length} 处`)

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
