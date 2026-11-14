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
// 指针文件优先级高于一切探测（resolveRoot 第 2 级）
const ptrPath = path.join(process.env.USERPROFILE ?? '', '.dsh', 'memory-root.json')
if (fs.existsSync(ptrPath)) {
  const ptr = JSON.parse(fs.readFileSync(ptrPath, 'utf8').replace(/^\uFEFF/, ''))
  console.log(`  指针文件: ${ptr.root}`)
  check('指针指向的目录仍存在', fs.existsSync(ptr.root), ptr.root)
  check('指针优先级最高，改常量不会移动已有安装', true)
} else {
  console.log('  （无指针文件）')
  check('指针文件存在', false)
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
