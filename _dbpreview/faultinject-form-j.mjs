/**
 * 故障注入：确认 `verify-map-forms` 的**形态 J**（§3.3 带锚点行）真的会变红。
 *
 * ## 为什么必须做这一步
 *
 * 2026-11-17 这个盲区的成因就是「脚本报 0 失败，而文档里有 10 处错」。
 * 所以光加上形态 J 不算完 —— 必须证明「文档写错时它会红」，
 * 否则只是换了个地方继续假绿。
 *
 * ## 做法
 *
 * 不改源码，只**临时篡改 `docs/项目地图.md`**（这才是形态 J 真正守的东西）：
 *
 *   ① 把某一行的行号 +1 / -1 / +500      → 必须红
 *   ② 把某一行的锚点换成不存在的符号      → 必须红
 *   ③ 把某一行的锚点类型换成不匹配的      → 必须红
 *   ④ 把某一行**删掉锚点**退回裸中文描述  → 必须红（这是「盲区护栏」守的）
 *   ⑤ 全部恢复后                          → 必须绿（否则恢复本身有问题）
 *
 * ⚠️ 每次试完立刻按 sha256 逐字节还原，末尾再核对一次。
 * ⚠️ 跑的时候不要并行改这个文档，也不要并行跑其它改文档的脚本。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const MAP = path.join(REPO, 'docs/项目地图.md')
const SCRIPT = path.join(HERE, 'verify-map-forms.mjs')

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const original = fs.readFileSync(MAP, 'utf8')
const originalHash = sha(original)

let pass = 0
let fail = 0
const bad = []

function check(name, ok, detail = '') {
    if (ok) {
        pass++
        console.log(`  ✅ ${name}`)
    } else {
        fail++
        bad.push(name)
        console.log(`  ❌ ${name}${detail ? '  ← ' + detail : ''}`)
    }
}

function restore() {
    fs.writeFileSync(MAP, original)
}

/** 跑校验脚本，取回 exit code 与输出 */
function runVerify() {
    const r = runCaptured([SCRIPT], { cwd: REPO, timeout: 180000 })
    if (r.status === null) {
        console.error('子进程没跑起来（管道被拒？）—— 这不是测试失败，是环境问题')
        restore()
        process.exit(2)
    }
    const out = (r.stdout || '') + (r.stderr || '')
    return { code: r.status, out }
}

/**
 * 对地图做一次替换 → 跑脚本 → 断言期望的 exit code → 还原。
 * @param {string} label
 * @param {(text: string) => string} mutate
 * @param {number} wantExit 期望的 exit code（0 或 1）
 */
function trial(label, mutate, wantExit) {
    const changed = mutate(original)
    if (changed === original) {
        // 变异没生效 → 这一条什么也没验证，必须算失败（否则是恒真）
        check(label, false, '变异没匹配上任何内容（锚点失效），这一条等于没测')
        return
    }
    fs.writeFileSync(MAP, changed)
    const { code, out } = runVerify()
    restore()

    if (code === wantExit) {
        check(label, true)
    } else {
        const tail = out.split('\n').filter((l) => /❌|FAIL=|未带锚点/.test(l)).slice(0, 3).join(' | ')
        check(label, false, `期望 exit=${wantExit}，实际 ${code}${tail ? '  输出: ' + tail : ''}`)
    }
}

console.log('=== 形态 J 故障注入（篡改项目地图，不改源码）===\n')

// ── ⑤ 先确认基线是绿的 ──
console.log('【基线】')
{
    const { code, out } = runVerify()
    check('未篡改时 verify-map-forms 必须 exit 0', code === 0, out.split('\n').slice(-3).join(' | '))
    check('基线必须全部通过（FAIL=0）', /FAIL=0/.test(out), out.split('\n').filter((l) => /FAIL=/.test(l)).join(''))
}

// ── ① 行号篡改 ──
console.log('\n【① 行号改错 → 必须红】')
trial(
    'L2792（fn:apply）行号 +1',
    (t) => t.replace(/^L2792(\s{2,})fn:apply/m, 'L2793$1fn:apply'),
    1,
)
trial(
    'L6000（decl:runHealthCheck）行号 -1',
    (t) => t.replace(/^L6000(\s{2,})decl:runHealthCheck/m, 'L5999$1decl:runHealthCheck'),
    1,
)
trial(
    'L3640（lit:session/event）行号 +500',
    (t) => t.replace(/^L3640(\s{2,})lit:'session\/event'/m, 'L4140$1lit:\'session/event\''),
    1,
)

// ── ② 锚点篡改 ──
console.log('\n【② 锚点改成不存在的符号 → 必须红】')
trial(
    'fn:apply → fn:noSuchFunction',
    (t) => t.replace(/^L2792(\s{2,})fn:apply/m, 'L2792$1fn:noSuchFunction'),
    1,
)
trial(
    'lit:\'tools/result\' → lit:\'tools/not-exist\'',
    (t) => t.replace(/^L4304(\s{2,})lit:'tools\/result'/m, 'L4304$1lit:\'tools/not-exist\''),
    1,
)

// ── ③ 类型篡改：同一行换一个不成立的类型 ──
console.log('\n【③ 锚点类型换错 → 必须红】')
// L2792 是 `export function apply(...)`，用 decl: 该行不满足（不是 const/let/var 声明）
trial(
    'L2792 由 fn:apply 改成 decl:apply（类型不匹配）',
    (t) => t.replace(/^L2792(\s{2,})fn:apply/m, 'L2792$1decl:apply'),
    1,
)
// L6000 是 `const runHealthCheck = () => {`，用 fn: 也能过（fn 同时认 const X = (）。
// ⚠️ 这里**不能**期望 lit: 失败 —— 见下方「lit 天生弱」的说明。
trial(
    'L6000 由 decl:runHealthCheck 改成 call:runHealthCheck（该行不含调用形态... 实际含）',
    (t) => t.replace(/^L6000(\s{2,})decl:runHealthCheck/m, 'L6000$1fn:runHealthCheck'),
    0,
)

// ── ③b lit 判据的边界：它只保证「该行出现这个字面量」，不保证「这是定义行」 ──
//
// ⚠️ 2026-11-17 实测记录的**已知弱点**，不要假装它更强：
//   `lit:` 用 includes 判断，所以「把 decl:runHealthCheck 改成 lit:runHealthCheck」
//   照样能过 —— 因为 `const runHealthCheck = ...` 这行确实包含字符串 runHealthCheck。
//
//   这是**刻意接受的取舍**，不是遗漏：
//     · lit 的唯一用途是**事件名**（`'session/event'`、`'tools/result'`）。
//       事件名没有「定义行」可言，只能验「该行出现这一串」；
//     · 而事件名带引号（`'tools/result'`），普通行里不会碰巧出现，
//       所以 lit 对**它实际服务的场景**是够强的；
//     · 反例：用 lit 去守一个普通符号名，确实弱 —— 那就该用 fn/decl/call。
//   → **约定：lit 只用于事件名这类引号字面量。** 这正写进了地图 §3.3 的格式说明。
console.log('\n【③b lit 只服务事件名（已知取舍，不断言它为强判据）】')
trial(
    'lit 用在事件名上：把 \'tools/result\' 改成 \'tools/other\' → 必须红（上面②已验证）',
    (t) => t.replace(/^L4304(\s{2,})lit:'tools\/result'/m, "L4304$1lit:'tools/other'"),
    1,
)

// ── ④ 盲区护栏：删掉锚点退回裸中文描述 ──
console.log('\n【④ 删锚点退回裸描述 → 必须红（盲区护栏）】')
trial(
    'L3886 删掉 fn:findTableById 锚点',
    (t) => t.replace(/^L3886\s{2,}fn:findTableById\s*$/m, 'L3886  findTableById 定义'),
    1,
)

// ── ⑤ 收尾：必须逐字节还原 ──
console.log('\n【收尾】')
restore()
const finalHash = sha(fs.readFileSync(MAP, 'utf8'))
check('地图已按 sha256 逐字节还原', finalHash === originalHash, `期望 ${originalHash.slice(0, 12)}…，实际 ${finalHash.slice(0, 12)}…`)

{
    const { code, out } = runVerify()
    check('还原后再跑必须重新变绿（exit 0）', code === 0, out.split('\n').slice(-2).join(' | '))
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 结果：PASS=${pass} FAIL=${fail}${bad.length ? ` 失败项: ${bad.join(', ')}` : ''}`)
process.exit(fail === 0 ? 0 : 1)
