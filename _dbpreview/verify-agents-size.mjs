/**
 * 回归守卫：`AGENTS.md` 的体积预算。
 *
 * ## 为什么需要它（2026-11-26）
 *
 * `AGENTS.md` 是**会话启动时读一次**的文件，有 65536 字节的硬上限。
 * 2026-11-26 实测它长到 **65470 字节**，而系统**实际只读到 65141** ——
 * 尾部 330 字节被**静默截断**，被吞掉的恰好是「关于下一个会话的我」整节。
 *
 * **最要命的是：没有任何脚本发现这件事。**
 * 当时 `grep 65536 _dbpreview/` 是 **0 命中** —— 全套 78 个脚本，
 * 没有一个看这个文件的大小。它溢出是「用户偶然发现」，不是「回归报红」。
 *
 * 这正是本项目记过的：「检测器本身有盲区，而且它不会告诉你」。
 *
 * ## 判据（两条阈值，分工不同）
 *
 * | 阈值 | 含义 | 超了怎么办 |
 * |---|---|---|
 * | **30000 B**（硬失败） | 距系统截断点还有一半余量。到这里说明该搬内容了 | 必须先搬再提交 |
 * | **24000 B**（警告） | 接近上限，下次加东西就会顶到 | 想办法压，或先搬一节 |
 *
 * 当前基线 19410 B（2026-11-26 精简后，从 65470 降下来）。
 *
 * ⚠️ **不要把它设成 65141。** 那是系统截断点，等它报红时文件**已经损坏**了
 * （模型读到的版本少了尾巴，而磁盘上看不出任何异常）。守卫要设在**真出事之前**。
 *
 * ## 覆盖边界（必须写出来）
 *
 *   - 只管 `AGENTS.md` 一个文件；`docs/` 下的文档没有启动读取，不受这条限制
 *   - 只按**字节**算，不按行数、不按词数 —— 系统上限就是字节
 *   - 不做「自动删内容」：它只报告，改什么由人决定
 *
 * ## 故障注入
 *
 * `--self-test` 会用伪造的字节数跑一遍，证明两条阈值**确实会红**。
 * 不加参数时只校验真实文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DOC = path.join(ROOT, 'AGENTS.md')

const SELF_TEST = process.argv.includes('--self-test')

/** 系统实际读取上限（2026-11-26 实测：磁盘 65470 / 实读 65141） */
const SYSTEM_READ_LIMIT = 65141
/** 硬失败阈值：到这个数就该搬内容了 */
const HARD_LIMIT = 30000
/** 警告阈值 */
const WARN_LIMIT = 24000

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

/**
 * 对一份「字节数」做判定，返回 { hard, warn }。
 *
 * 抽成函数是为了让 `--self-test` 能复用**同一份**判定逻辑 ——
 * 自证里复刻一份的话，判定逻辑改了自证不会跟着变，两边一起错还报「通过」。
 */
function judge(bytes) {
  return {
    hard: bytes <= HARD_LIMIT,
    warn: bytes <= WARN_LIMIT,
  }
}

function runOn(bytes, label) {
  console.log(`\n=== ${label} ===\n`)
  console.log(`  AGENTS.md = ${bytes} 字节`)
  console.log(`  硬失败阈值 ${HARD_LIMIT} / 警告阈值 ${WARN_LIMIT} / 系统实读上限 ${SYSTEM_READ_LIMIT}\n`)

  const v = judge(bytes)

  check(
    `体积未超硬上限（${HARD_LIMIT} 字节）`,
    v.hard,
    v.hard ? '' : `超了 ${bytes - HARD_LIMIT} 字节 —— 必须先把内容搬进 docs/ 再提交`,
  )
  check(
    `体积在警戒线内（${WARN_LIMIT} 字节）`,
    v.warn,
    v.warn ? '' : `超了 ${bytes - WARN_LIMIT} 字节 —— 下次再加东西就会顶到硬上限`,
  )
  // 这条永远该成立：硬上限必须远低于系统截断点，否则守卫等于没有
  check(
    '硬上限远低于系统截断点（留足余量）',
    HARD_LIMIT < SYSTEM_READ_LIMIT - 20000,
    `HARD_LIMIT=${HARD_LIMIT} / SYSTEM_READ_LIMIT=${SYSTEM_READ_LIMIT}`,
  )
}

// ---- 主流程 ----
if (!fs.existsSync(DOC)) {
  console.log(`\n  ℹ️ 本段不适用：${DOC} 不存在。`)
  console.log('  这不是「代码坏了」—— 换机器 / 只检出部分文件时本来就可能没有。')
  process.exit(0)
}

const realBytes = fs.statSync(DOC).size
runOn(realBytes, '真实文件校验')

if (SELF_TEST) {
  console.log('\n\n########## 故障注入（--self-test）##########')
  console.log('\n  证明：阈值确实会红 —— 否则上面的「通过」没有意义。')

  // ① 超硬上限必须红
  {
    const p0 = pass
    const f0 = fails.length
    runOn(HARD_LIMIT + 1, `注入 1：${HARD_LIMIT + 1} 字节（超硬上限 1 字节）`)
    check(
      '注入 1 必须让硬上限断言变红',
      fails.length > f0,
      `实际新增失败 ${fails.length - f0} 条`,
    )
    pass = p0
    fails.length = f0
  }

  // ② 在硬上限与警告线之间：只该警告项红
  {
    const p0 = pass
    const f0 = fails.length
    runOn(WARN_LIMIT + 1, `注入 2：${WARN_LIMIT + 1} 字节（只超警告线）`)
    check(
      '注入 2 必须让警告断言变红',
      fails.length > f0,
      `实际新增失败 ${fails.length - f0} 条`,
    )
    pass = p0
    fails.length = f0
  }

  // ③ 远超系统截断点（就是 2026-11-26 那次的现场）必须红
  {
    const p0 = pass
    const f0 = fails.length
    runOn(65470, '注入 3：65470 字节（2026-11-26 溢出时的真实值）')
    check(
      '注入 3 必须变红（复现当初那次溢出）',
      fails.length > f0,
      `实际新增失败 ${fails.length - f0} 条`,
    )
    pass = p0
    fails.length = f0
  }

  // ④ 基线（当前真实值）必须绿 —— 证明它不会对正常状态乱报
  {
    const p0 = pass
    const f0 = fails.length
    runOn(realBytes, `注入 4：当前真实值 ${realBytes} 字节（必须绿）`)
    check(
      '注入 4 当前真实值必须全绿',
      fails.length === f0,
      `误报 ${fails.length - f0} 条`,
    )
    pass = p0
    fails.length = f0
  }
}

console.log('\n──────────────────────────────────────────────────────────────────────')
console.log(
  fails.length === 0
    ? `✅ 全部通过：${pass} 通过 / 0 失败`
    : `❌ ${pass} 通过 / ${fails.length} 失败`,
)
if (fails.length > 0) {
  console.log('失败项：')
  for (const f of fails) console.log(`  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`)
}
process.exit(fails.length === 0 ? 0 : 1)
