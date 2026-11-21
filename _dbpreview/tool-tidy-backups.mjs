/**
 * 一次性脚本：把散落的 `.pre-*` 备份整理进 `back/`。
 *
 * ## 整理规则
 *
 * 文件名：`<原文件名>.<YYYYMMDD-HHMMSS>.<描述词>`
 *   - 时间戳用**文件修改时间**（那才是备份时的真实时刻）
 *   - 描述词 = 原 `.pre-` 后面那段，**去掉里面已含的日期**（避免两份时间打架）
 *
 * ## 为什么保留描述词
 *
 * 那些代号（`refnum` / `closingwarn` / `hiddenbug`）记录了「当时在改什么」，
 * 是备份唯一的语义信息。丢掉它们，文件就变成一堆匿名快照 ——
 * 那正是这次要解决的问题。
 *
 * ## 为什么先 dry-run
 *
 * 移动 51 个文件是不可逆操作。先打印完整计划，确认无误再 `--apply`。
 */

import { readdirSync, statSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const BACK = join(REPO, 'back')
const APPLY = process.argv.includes('--apply')

/** 要扫描的目录（相对 REPO） */
const SCAN_DIRS = ['dsh-fatfishdream-memory', '_dbpreview']

/** 跳过这些前缀的目录 */
const SKIP_RE = /(^|\\)(node_modules|\.git|_dbbackup|_coldbackup|_archive|back)(\\|$)/

function walk(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (SKIP_RE.test(p)) continue
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(p)
  }
  return out
}

function two(n) { return String(n).padStart(2, '0') }

function stamp(d) {
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-` +
         `${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
}

function main() {
  const files = []
  for (const d of SCAN_DIRS) walk(join(REPO, d), files)

  const backups = files.filter((f) => basename(f).includes('.pre-'))
  if (backups.length === 0) {
    console.log('没有需要整理的备份文件。')
    return 0
  }

  if (!existsSync(BACK)) mkdirSync(BACK, { recursive: true })

  const plan = []
  const used = new Set()
  for (const f of backups) {
    const name = basename(f)
    const [orig, tagRaw] = name.split('.pre-')
    const st = statSync(f)
    // 去掉描述词里的日期片段，只留语义
    const tag = tagRaw.replace(/-?\d{8}(-\d{6})?/g, '').replace(/^-+|-+$/g, '') || 'backup'
    let newName = `${orig}.${stamp(st.mtime)}.${tag}`

    // 极端情况：同秒同描述 → 加序号，避免覆盖
    let n = 2
    while (used.has(newName)) newName = `${orig}.${stamp(st.mtime)}.${tag}-${n++}`
    used.add(newName)

    plan.push({ from: f, to: join(BACK, newName), size: st.size })
  }

  plan.sort((a, b) => a.to.localeCompare(b.to))

  const totalMB = (plan.reduce((s, p) => s + p.size, 0) / 1024 / 1024).toFixed(1)
  console.log(`${APPLY ? '执行' : '预览'}：${plan.length} 个文件，共 ${totalMB} MB\n`)

  for (const p of plan) {
    const rel = (s) => s.replace(REPO + '\\', '').replace(REPO + '/', '')
    console.log(`  ${rel(p.from)}`)
    console.log(`    → back\\${basename(p.to)}`)
    if (APPLY) renameSync(p.from, p.to)
  }

  if (APPLY) {
    console.log(`\n✅ 已移动 ${plan.length} 个文件到 back/`)
  } else {
    console.log('\n（这是预览。确认无误后加 --apply 实际执行。）')
  }
  return 0
}

process.exit(main())
