/**
 * 回归：情绪词典的「复合词误判」闸门。
 *
 * 2026-11-14 实测两次（emotion #17、#20）：
 *   用户写「还需要**麻烦**你通过记忆系统去回忆一下」，
 *   单字词条「烦」命中「麻**烦**」→ 记成「用户表达吐槽（烦·0.80）」。
 *
 * 修法：`NON_EMOTION_COMPOUNDS` 排除「麻烦/积累/无语义」这类中性复合词，
 * 并改成扫描同一词的所有出现位置。
 *
 * 本测试**从源码抽取**词表与排除表（不手抄），复刻排除判断后验证：
 *   - 真实误判句不再命中
 *   - 真实情绪句仍然命中（不能把「好烦」「累死了」一起误伤）
 *   - 每个单字词条都登记了复合词表
 */
import fs from 'node:fs'

const SRC = fs.readFileSync('dsh-fatfishdream-memory/index.js', 'utf8')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

/** 从源码里截取 `const NAME = <literal>` 的字面量并求值（不 import，因为在 apply 闭包里） */
function extractLiteral(name, open, close) {
  const start = SRC.indexOf(`const ${name} = `)
  if (start < 0) throw new Error(`找不到 const ${name}`)
  const from = SRC.indexOf(open, start)
  const end = SRC.indexOf(close, from)
  if (from < 0 || end < 0) throw new Error(`无法截取 ${name}`)
  return new Function(`return ${SRC.slice(from, end + close.length)}`)()
}

const COMPOUNDS = extractLiteral('NON_EMOTION_COMPOUNDS', '{', '\n}')
const LEXICON = extractLiteral('LEXICON', '[', '\n]')

/** 与 index.js 保持一致（occurrencesOf / inNonEmotionCompound 的复刻） */
function occ(text, word, limit = 20) {
  const out = []
  let from = 0
  while (out.length < limit) {
    const at = text.indexOf(word, from)
    if (at === -1) break
    out.push(at)
    from = at + word.length
  }
  return out
}
function inCompound(text, at, word) {
  const list = COMPOUNDS[word]
  if (list === undefined) return false
  for (const compound of list) {
    for (const start of occ(text, compound)) {
      if (at >= start && at + word.length <= start + compound.length) return true
    }
  }
  return false
}

/** 复刻「按词表命中 + 复合词排除」，返回命中的词 */
function hits(text) {
  const out = []
  for (const entry of LEXICON) {
    for (const word of entry.words) {
      for (const at of occ(text, word)) {
        if (inCompound(text, at, word)) continue
        out.push({ cls: entry.cls, word })
      }
    }
  }
  return out
}
const wordsOf = (t) => new Set(hits(t).map((h) => h.word))

console.log('=== 1. 真实误判句（emotion #17 / #20）必须不再命中「烦」 ===\n')
const FP = [
  '为了防止自己改的自己测不出来，所以还需要麻烦你通过记忆系统自身去回忆一下记忆，不要去直接读数据库',
  '查询那两次情绪误判的关键词是什么，然后联网匹配或查询字典库把类似的非情绪化词汇记录到程序里，防止下次继续误判。',
  '麻烦你检查一下日志',
  '烦请确认一下',
  '烦劳你跑一遍',
]
for (const t of FP) {
  check(`不命中「烦」：${t.slice(0, 22)}…`, !wordsOf(t).has('烦'),
    JSON.stringify([...wordsOf(t)]))
}

console.log('\n=== 2. 真实情绪表达仍要命中（不能误伤） ===\n')
const TP = [
  ['好烦', '烦'],
  ['真烦人', '烦'],
  ['烦死了', '烦'],
  ['好累', '累'],
  ['累死了', '累'],
  ['太累了', '累'],
  ['无语', '无语'],
  ['真无语', '无语'],
]
for (const [t, w] of TP) {
  check(`命中「${w}」：${t}`, wordsOf(t).has(w), JSON.stringify([...wordsOf(t)]))
}

console.log('\n=== 3. 同一句里先「麻烦」后「好烦」：后面的真实表达不能漏 ===\n')
const mixed = '麻烦你先跑一遍测试，这个报错真的好烦'
const h = hits(mixed)
check('只命中 1 次「烦」（来自好烦）', h.filter((x) => x.word === '烦').length === 1,
  JSON.stringify(h))
check('「累」在「积累」里不算情绪', !wordsOf('积累了 3 个 bug').has('累'))
check('「累」在「累积」里不算情绪', !wordsOf('累积运行 10 次').has('累'))
check('「累加」不算情绪', !wordsOf('数值累加').has('累'))
check('「无语义」不算吐槽', !wordsOf('这个函数名无语义').has('无语'))
check('「无语言」不算吐槽', !wordsOf('无语言依赖').has('无语'))

console.log('\n=== 4. 词表结构：单字词必须有排除表 ===\n')
const singles = []
for (const entry of LEXICON) {
  for (const word of entry.words) if ([...word].length === 1) singles.push(word)
}
check('存在单字词条（否则测试失去意义）', singles.length > 0, JSON.stringify(singles))
for (const w of singles) {
  check(`单字「${w}」有非情绪复合词表`, Array.isArray(COMPOUNDS[w]) && COMPOUNDS[w].length > 0)
  if (Array.isArray(COMPOUNDS[w])) {
    check(`「${w}」的复合词里都含这个字`, COMPOUNDS[w].every((c) => c.includes(w)),
      JSON.stringify(COMPOUNDS[w]))
  }
}

console.log('\n=== 5. 源码接线：判定确实调用了排除函数 ===\n')
check('analyzeEmotion 里调用了 inNonEmotionCompound',
  /inNonEmotionCompound\(text, at, word\)/.test(SRC))
check('词表循环用 occurrencesOf 全量扫描',
  /for \(const at of occurrencesOf\(text, word\)\)/.test(SRC))
check('旧的 indexOf 单次命中已移除',
  !/const at = text\.indexOf\(word\)\s*\n\s*if \(at === -1\) continue/.test(SRC))

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
