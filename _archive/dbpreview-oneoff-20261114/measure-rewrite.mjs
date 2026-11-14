// 测量 index.js 的构成：哪些行是「必须重建」的，哪些是「可丢弃的旧时代」。
// 用于评估「推翻重写」的工程量。
import fs from 'node:fs'

const A = fs.readFileSync('dsh-memory/index.js', 'utf8').split('\n')
const total = A.length

// 按顶层函数/常量定义切段
const bounds = []
A.forEach((l, i) => {
  if (/^(export\s+)?(async\s+)?function\s+\w+/.test(l) || /^const\s+[A-Z_]{3,}\s*=/.test(l) || /^export const\s+\w+/.test(l)) {
    bounds.push({ line: i + 1, name: l.trim().slice(0, 70) })
  }
})

// 归类
const CAT = {
  '保留·情绪引擎': /^(const (LEXICON|LEXICON_EN|EMOJI|NEGATIONS|NON_NEGATION_PHRASES|INTENSIFIERS|DIMINISHERS|ADVERSATIVES|MENTION_MARKERS|META_DISCUSSION_MARKERS|WEAK_CUES|IRONY_MARKERS|NEGATIVE_CONTEXT|POSITIVE_SURFACE|STRONG_THRESHOLD|WEAK_THRESHOLD)|function (looksIronic|stripNoise|negatedBefore|modifierBefore|capScore|splitByAdversative|analyzeEmotion))/,
  '保留·注入与写入': /function (finishInjection|renderFromDb|findTableById|readHeartbeat|writeHeartbeat|reportBudget|looksLikeRedline|sanitizeTopic)/,
  '保留·选址与工具': /function (resolveRoot|systemFallbackRoot|systemDriveLetter|isSystemDriveTarget|expandRoot|listCandidateDrives|syncPathExists|pointerPath|readPointer|writePointer|parseJson|shortHash|isSafeSlug|isInside|byteLength|truncateBytes|findSecret|safePushMessage|pad|monthKey|stamp|localDay|daysBetween|projectNameOf|slugify|readIfExists|exists|atomicWrite|copyTree|backupDbFile|projectTemplate)/,
  '旧时代·文件存储': /^(async )?function (createStore|ensureLayout)/,
  '配置与模板': /^(const (DEFAULT_CONFIG|MEMORY_DIR_NAME|SECRET_PATTERNS|FACTS_TEMPLATE|POLICY_TEMPLATE|PLUGIN_SOURCE_KIND)|export const (name|inject))/,
}

function cat(name) {
  for (const [k, re] of Object.entries(CAT)) if (re.test(name)) return k
  return '其它（含 apply 主体）'
}

const rows = []
for (let i = 0; i < bounds.length; i++) {
  const start = bounds[i].line
  const end = i + 1 < bounds.length ? bounds[i + 1].line - 1 : total
  rows.push({ name: bounds[i].name, start, end, size: end - start + 1, cat: cat(bounds[i].name) })
}

const byCat = {}
for (const r of rows) {
  byCat[r.cat] = (byCat[r.cat] || 0) + r.size
}

console.log('index.js 总行数:', total)
console.log('\n=== 按类别汇总 ===')
for (const [k, v] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
  console.log(`${k.padEnd(22)} ${String(v).padStart(5)} 行  ${Math.round((v / total) * 100)}%`)
}

console.log('\n=== 最大的 12 段 ===')
for (const r of rows.sort((a, b) => b.size - a.size).slice(0, 12)) {
  console.log(`L${String(r.start).padStart(4)}-${String(r.end).padStart(4)}  ${String(r.size).padStart(4)} 行  [${r.cat}]  ${r.name}`)
}

// 其它顶层文件
console.log('\n=== 其它文件 ===')
for (const f of ['dsh-memory/db-store.mjs', 'dsh-memory/db-schema.mjs', 'dsh-memory/client.js']) {
  const t = fs.readFileSync(f, 'utf8')
  console.log(`${f.padEnd(28)} ${String(t.split('\n').length).padStart(5)} 行`)
}
