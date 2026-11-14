/**
 * 把 finishInjection 里的 usageLines 整体替换为极简版。
 *
 * ⚠️ 本脚本自身要生成含 `<!--mem-log` 的源码文本，所以**不能**用模板字符串
 *    直接写那串字符 —— JS 会把 `<!--` 当成 HTML 注释直接语法报错。
 *    做法：用 '<' + '!--mem-log' 拼接，规避词法阶段的误判。
 */
import fs from 'node:fs'

const FILE = 'dsh-memory/index.js'
const src = fs.readFileSync(FILE, 'utf8')

const START = '    const usageLines = dbMode\n'
const END = '    parts.push(`## 记忆使用说明\\n${usageLines.join(\'\\n\')}`)\n'

const sCount = src.split(START).length - 1
const eCount = src.split(END).length - 1
if (sCount !== 1 || eCount !== 1) {
  console.log(`锚点不唯一：START=${sCount} END=${eCount}，中止`)
  process.exit(1)
}

const iStart = src.indexOf(START)
const iEnd = src.indexOf(END, iStart)
if (iEnd < 0) { console.log('END 锚点在 START 之后找不到，中止'); process.exit(1) }

const oldBlock = src.slice(iStart, iEnd)

const mustHave = ['记忆库：', '三个标记：', '13 个', '## 什么时候记', '全局 facts.md']
const missing = mustHave.filter((k) => !oldBlock.includes(k))
if (missing.length > 0) { console.log('切出的块缺关键内容，边界算错：', missing); process.exit(1) }

const oldBytes = Buffer.byteLength(oldBlock, 'utf8')
console.log(`旧块：${oldBlock.split('\n').length} 行 / ${oldBytes} 字节`)

// 规避词法误判：分片拼接
const LT = '<'
const M = (s) => LT + s            // '<' + '!--mem-log' → '<!--mem-log'
const OPEN = (kind) => '`' + M('!--mem-' + kind)   // `<!--mem-log
const CLOSE = '`' + M('--') + '`'                  // `-->`

// 四个标记示例，与注入里要保持的写法一致
const MARK_LINE =
  '          ' +
  `'${OPEN('log')}\` 做了什么 ${CLOSE} 流水 · ` +
  `${OPEN('note')}\` 项目规则 ${CLOSE} · ` +
  `${OPEN('fact')}\` 用户画像 ${CLOSE}',`

const MARK_LOG_ONLY = `          '\`${M('!--mem-log')}\` 内容 \`${M('--')}\` → 当月流水',`
const MARK_NOTE_ONLY = `          '\`${M('!--mem-note')}\` 内容 \`${M('--')}\` → 本项目 PROJECT.md',`
const MARK_FACT_ONLY = `          '\`${M('!--mem-fact')}\` 内容 \`${M('--')}\` → 全局 facts.md（只装「关于用户本人」的事）',`

const newBlock = [
  '    const usageLines = dbMode',
  '      ? [',
  '          // ★ 2026-11-13 大改：从 56 行 / 3397 字节压到 6 行。',
  '          //   原来把「怎么分类、开发日志 vs 技术讨论、什么时候记、流水要短」',
  '          //   全部塞进每轮注入 —— 那些是「写的时候才查」的东西，',
  '          //   却每轮都占着上下文。已全部迁到 policy.md 的非注入「记忆使用说明」小节。',
  '          //   注入里只留「不做就会出错」的动作：标记语法、不许碰库、topic 要求。',
  '          //',
  '          //   另一处修正：删掉所有 /memory search 字样。那是**用户**在输入框敲的',
  '          //   斜杠命令，写进模型注入等于教模型把检索甩回给用户。查不到就说没记住。',
  "          '## 写记忆：只能写在回复正文里，用标记',",
  MARK_LINE,
  "          '**绝不能** write / edit / pwsh 碰 memory.db —— 不是被拒，是损坏数据库。',",
  "          '流水必须带 topic：mem-log 后空一格接 topic=开发日志（只用这 13 类，清单见 policy.md）。',",
  "          '写之前先分层、选分类、判断该不该记 —— 规则在 policy.md 的「记忆使用说明」一节。',",
  "          '历史流水正文不在注入里。你没有检索工具，不要自己读库；查不到就说「这段我没记住」。',",
  '        ]',
  '      : [',
  '          `记忆根目录：${store.root}`,',
  "          '',",
  "          '写记忆：只能用回复正文里的标记，不要用 write / edit 写记忆目录。',",
  MARK_LOG_ONLY,
  MARK_NOTE_ONLY,
  MARK_FACT_ONLY,
  '        ]',
  '',
].join('\n')

const newBytes = Buffer.byteLength(newBlock, 'utf8')
console.log(`新块：${newBlock.split('\n').length} 行 / ${newBytes} 字节`)
console.log(`预计省下：${oldBytes - newBytes} 字节`)

const out = src.slice(0, iStart) + newBlock + src.slice(iEnd)
fs.writeFileSync(FILE, out, 'utf8')
console.log('已写入', FILE)
