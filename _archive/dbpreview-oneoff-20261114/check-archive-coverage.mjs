/**
 * 只读核查（v2，按时间块比对）：_archive-md 的 .md 是否已完整进库。
 *
 * 上一版按「行」比对，全部 0% 命中 —— 那是误报：
 *   .md 里一条流水 = 一个「## 时间」标题 + 下面若干行正文，
 *   迁移时整块变成 logs 表的一条记录（正文换行保留）。
 *   按行拆开拿去跟整条记录比，永远对不上。差点据此误删归档。
 *
 * 本版做法：以「## 」为分隔把 md 切成块，取块正文的**首个非空行**当指纹，
 * 在库内文本里做「包含」匹配 —— 既能容忍尾部差异，也不会漏判。
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

// 记忆根目录从指针文件读，不要写死 —— 迁移根目录后脚本会全崩。
// 指针由插件自己维护（~/.dsh/memory-root.json）。
const resolveMemoryRoot = () => {
  const cands = [
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'memory-root.json'),
  ]
  for (const p of cands) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      if (j && typeof j.root === 'string' && j.root !== '') return j.root
    } catch {
      /* 下一个候选 */
    }
  }
  return 'D:\\dsh-fatfishdream-memory'
}
const MEM_ROOT = resolveMemoryRoot().replace(/\\/g, '/')

const db = new DatabaseSync(`${MEM_ROOT}/memory.db`, { readOnly: true })
const rows = []
for (const t of ['profile', 'rules', 'emotion', 'logs']) {
  for (const r of db.prepare(`SELECT text FROM ${t}`).all()) rows.push(String(r.text))
}
const haystack = rows.join('\n')
console.log(`库内四表合计 ${rows.length} 条文本，拼成 ${haystack.length} 字符的比对池\n`)

/** 把 md 切成块：每个「## 」标题起一块；返回 [{head, body, fingerprint}] */
function blocks(file) {
  const out = []
  let cur = null
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (/^##\s+/.test(line)) {
      if (cur) out.push(cur)
      cur = { head: line, lines: [] }
      continue
    }
    if (/^#\s+/.test(line) || line.startsWith('<!--')) continue
    if (cur) cur.lines.push(line)
  }
  if (cur) out.push(cur)

  for (const b of out) {
    b.body = b.lines.join('\n').trim()
    // 指纹：正文里第一条足够长的行（去掉列表前缀）
    b.fp =
      b.lines
        .map((l) => l.replace(/^-\s*(\[[a-z]+\]\s*)?/, '').trim())
        .filter((l) => l.length >= 8)
        .sort((a, b2) => b2.length - a.length)[0] ?? ''
  }
  return out.filter((b) => b.body !== '')
}

const ROOT = `${MEM_ROOT}/_archive-md`
const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.md') && !e.name.includes('.bak')) files.push(p)
  }
})(ROOT)

let grandMiss = 0
let grandTotal = 0
for (const f of files) {
  const bs = blocks(f)
  const miss = bs.filter((b) => b.fp !== '' && !haystack.includes(b.fp))
  grandTotal += bs.length
  grandMiss += miss.length
  const rel = path.relative(ROOT, f).replace(/\\/g, '/')
  const pct = bs.length === 0 ? 100 : Math.round(((bs.length - miss.length) / bs.length) * 1000) / 10
  console.log(`[${rel}]  ${bs.length} 块，命中 ${bs.length - miss.length}（${pct}%）`)
  for (const m of miss.slice(0, 4)) {
    console.log(`   ✗ ${m.head}  →  ${m.fp.slice(0, 70)}`)
  }
  if (miss.length > 4) console.log(`   …另有 ${miss.length - 4} 块未命中`)
}

console.log(`\n总计 ${grandTotal} 块，未命中 ${grandMiss} 块`)
db.close()
