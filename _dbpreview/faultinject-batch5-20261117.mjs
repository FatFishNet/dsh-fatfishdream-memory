/**
 * 故障注入：确认 `selfcheck-batch5-20261117.mjs` 的 40 条断言真的会变红。
 *
 * 没有这个文件，上面那个测试就只是「看起来对」——
 * 今晚已经踩过两次：复刻判据来测、锚点撞车。
 *
 * ⚠️ 跑的时候不要并行改代码（它会临时改写 3 个源文件）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './lib-spawn-capture.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const TARGETS = {
  index: path.join(REPO, 'dsh-fatfishdream-memory/index.js'),
  store: path.join(REPO, 'dsh-fatfishdream-memory/db-store.mjs'),
  schema: path.join(REPO, 'dsh-fatfishdream-memory/db-schema.mjs'),
}
const TEST = 'selfcheck-batch5-20261117.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const orig = {}
const hashes = {}
for (const [k, p] of Object.entries(TARGETS)) {
  orig[k] = fs.readFileSync(p, 'utf8')
  hashes[k] = sha(orig[k])
}

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

/**
 * @param {string} label
 * @param {'index'|'store'|'schema'} key
 * @param {string} from 必须唯一
 * @param {string} to
 * @param {boolean} expectRed
 */
function trial(label, key, from, to, expectRed) {
  const n = orig[key].split(from).length - 1
  if (n !== 1) {
    check(`${label} 锚点唯一`, false, `实际匹配 ${n} 处`)
    return
  }
  try {
    fs.writeFileSync(TARGETS[key], orig[key].replace(from, to), 'utf8')
    const r = runCaptured([path.join(HERE, TEST)], { cwd: REPO, timeout: 120000 })
    const red = r.status !== 0 && r.status !== null
    check(
      `${label} → 期望${expectRed ? '红' : '绿'}，实际 exit=${r.status}`,
      r.status !== null && red === expectRed,
      r.status === null ? '子进程没跑起来' : '',
    )
  } finally {
    fs.writeFileSync(TARGETS[key], orig[key], 'utf8')
  }
}

console.log('=== 逐个撤掉五项修复，测试必须变红 ===\n')

// ── L：删掉 rules 的 review 过滤 ──────────────────────────
// 注意：三条 SQL 里 profile 和 rules 都有这个条件，要精确到 rules
trial(
  'L 删掉 search 对 rules 的 review 过滤',
  'store',
  "         WHERE rules_fts MATCH ? AND r.status='active' AND r.review IS NOT 'retracted'\n           AND (r.scope=? OR r.scope=?)",
  "         WHERE rules_fts MATCH ? AND r.status='active'\n           AND (r.scope=? OR r.scope=?)",
  true,
)

// ── A：去掉 catch 里的 db.close() ─────────────────────────
trial(
  'A 去掉迁移失败时的 db.close()',
  'schema',
  '      // close 本身也可能失败（库被占用等），但**绝不能再掩盖原始错误**。\n      try {\n        db.close()\n      } catch {',
  '      // close 本身也可能失败（库被占用等），但**绝不能再掩盖原始错误**。\n      try {\n        void 0\n      } catch {',
  true,
)

// ── C：copyTree 改回静默 return 0 ─────────────────────────
//
// ⚠️ 第一版把 `return 0` 插在注释**之后**——那只是插了一句死代码，
//    真正的 `if (ENOENT) return 0` 和 `skipped.push` 还在，断言当然照样绿。
//    要撤掉修复必须**删掉那两行实际逻辑**，不是往旁边塞一句 return。
trial(
  'C 删掉 copyTree 的 ENOENT 判断与 skipped 记账（回到静默 return 0）',
  'index',
  "    if (error && error.code === 'ENOENT') return 0\n    skipped.push(`${from}（读取失败：${error?.code ?? error?.message ?? error}）`)\n    return 0",
  '    return 0',
  true,
)

// ── P：parseId 改回 Number() ──────────────────────────────
trial(
  'P 把 parseId 换成裸 Number()',
  'index',
  '  if (typeof raw === \'number\') {\n    return Number.isSafeInteger(raw) && raw > 0 ? raw : null\n  }',
  '  if (typeof raw === \'number\') {\n    return raw\n  }',
  true,
)

// ── O：clampInt 改回 `Number(x) || def` 形态 ───────────────
trial(
  'O 去掉 clampInt 的范围钳制（改回恒等）',
  'index',
  '  return Math.max(min, Math.min(max, n))',
  '  return n',
  true,
)

// ── 对照组：什么都不改，必须仍然绿 ─────────────────────────
trial(
  '对照组：原文不动（应仍绿）',
  'index',
  "const IS_WINDOWS = process.platform === 'win32'",
  "const IS_WINDOWS = process.platform === 'win32'",
  false,
)

// ── 逐字节还原校验 ───────────────────────────────────────
for (const [k, p] of Object.entries(TARGETS)) {
  const now = sha(fs.readFileSync(p, 'utf8'))
  check(`${path.basename(p)} 已逐字节还原`, now === hashes[k], `${hashes[k].slice(0, 12)} vs ${now.slice(0, 12)}`)
}

console.log(`\n结果：PASS=${pass} FAIL=${fail}`)
if (fail > 0) {
  console.log('失败项：')
  for (const b of bad) console.log('  - ' + b)
  process.exit(1)
}
