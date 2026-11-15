/**
 * 端到端：用真实注入文本，检查「自相矛盾」与「把用户命令教给模型」是否都已消除。
 *
 * 历史口径（已废弃）：
 *   反馈者三条 → ② 必须明确「/memory search 是斜杠命令、不是模型工具」。
 *
 * 现口径（2026-11-13 晚，用户订正）：
 *   **`/memory search` 是用户在输入框敲的命令，根本不该出现在模型注入里。**
 *   正确做法是让模型知道边界：「查不到就说没记住」，而不是教它去请用户敲命令。
 *
 * 因此本测试反向断言：注入里**不得**出现 `/memory search`。
 *
 * ⚠️ 抽取时必须剥掉代码注释 —— 源码里有「删掉所有 /memory search 字样」这类
 *    说明性注释，它不进注入，但会被朴素切片误判（踩过一次）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const IDX = fs.readFileSync(path.join(REPO, 'dsh-fatfishdream-memory/index.js'), 'utf8')
const POLICY_PATH = 'D:/dsh-fatfishdream-memory/policy.md'
const POLICY = fs.existsSync(POLICY_PATH) ? fs.readFileSync(POLICY_PATH, 'utf8') : ''

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log(`${ok ? '✅' : '❌'} ${name}`)
  if (!ok && detail) console.log('   ' + detail)
}

/** 去掉整行注释与块注释行，只留可执行/字符串内容 */
const stripComments = (txt) =>
  txt
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
    })
    .join('\n')

// 抽出 dbMode 会产出的三段文本（都剥掉注释）
const usageStart = IDX.indexOf('const usageLines = dbMode')
// ⚠️ 2026-11-14：原先用 `'      : ['` 作结束标记 —— usageLines 里加入
//    `...(projectName ? [...] : [...])` 嵌套数组后，这个标记提前命中断言，
//    导致切片漏掉后半段（「URL 编码」断言假失败）。
//    改成按语句边界：切到 `parts.push('## 记忆使用说明` 为止。
const usageEnd = IDX.indexOf('parts.push(`## 记忆使用说明', usageStart)
const USAGE = usageStart >= 0 && usageEnd > usageStart ? stripComments(IDX.slice(usageStart, usageEnd)) : ''

const idxStart = IDX.indexOf('## 记忆索引<!--')
const idxEnd = IDX.indexOf('    }\n  }', idxStart)
const IDXSEC = idxStart >= 0 ? stripComments(IDX.slice(idxStart, idxEnd > idxStart ? idxEnd : idxStart + 1200)) : ''

const hintStart = IDX.indexOf("? '<!-- 本段由插件注入。记忆存于 SQLite")
const hintEnd = IDX.indexOf("      : '<!-- 本段由插件注入。读写记忆请用", hintStart)
const HINT = hintStart >= 0 ? stripComments(IDX.slice(hintStart, hintEnd > hintStart ? hintEnd : hintStart + 260)) : ''

const INJECT = [USAGE, IDXSEC, HINT].filter(Boolean).join('\n')

console.log('=== 1. 无正面 grep 指路 ===\n')
const positiveGrep = INJECT.split('\n').filter((l) => {
  if (!l.includes('grep')) return false
  const neg = ['不要', '别', '只会得到乱码', '读出来是乱码', '二进制', '不是', '无效', '拒绝']
  return !neg.some((n) => l.includes(n))
})
console.log('  正面推荐 grep 的行:', positiveGrep.length)
for (const l of positiveGrep) console.log('    ' + l.trim().slice(0, 80))
check('① 无「正面推荐 grep 读记忆库」', positiveGrep.length === 0, `${positiveGrep.length} 行`)

console.log('\n=== 2. 无「任何情况下都不要…」一刀切 ===\n')
const blanket = ['任何情况下都不要用', '任何情况下都不要碰', '任何情况下都不用 write']
const foundBlanket = blanket.filter((b) => INJECT.includes(b))
check('② 无一刀切否定', foundBlanket.length === 0, foundBlanket.join(', '))

console.log('\n=== 3. 注入里不得出现用户侧命令 /memory search ===\n')
check('③ usageLines 不含 /memory search', !USAGE.includes('/memory search'),
  USAGE.includes('/memory search') ? '仍在教模型去请用户敲命令' : '')
check('③ 记忆索引段不含 /memory search', !IDXSEC.includes('/memory search'))
check('③ hint 不含 /memory search', !HINT.includes('/memory search'))

console.log('\n=== 4. 边界文案必须存在（替代旧指路）===\n')
const must = [
  ['不许碰库', /损坏数据库/],
  ['只说没记住', /没记住|不要猜|不要编/],
  ['标记语法', /mem-log/],
  // ★ 2026-11-13 新增：读取通道的指引必须存在。
  //   历史教训：为了不把 /memory search（用户侧斜杠命令）教给模型，
  //   曾经把「所有」读取指引一起删了，只留「你没有检索工具，不要自己读库」。
  //   结果模型真的不去查，反馈「索引只有标题、正文读不到、没记住」。
  //   正确做法是删掉斜杠命令、保留模型自己能走的 pwsh + HTTP 路径。
  ['读取路径（HTTP 接口）', /api\/dsh-memory\/search/],
  ['端口从环境变量取', /DSH_WEB_URL/],
  // ★ 2026-11-14 新增：scope 必须出现在注入里，且必须带空值。
  //   历史教训：示例 URL 不带 scope → 模型照着查就落到全库 / 被默认项目猜错，
  //   多项目并发时 A 项目能翻到 B 项目的记忆。
  //   现在注入直接写死本项目名，模型照抄即可；服务端不再猜。
  ['scope 参数必须出现', /&scope=/],
  ['scope 必须带值（不能是空占位以外的裸参数）', /&scope=[^\s`"']+/],
  // ★ 2026-11-16 新增：必须告诉模型「正文不要写空行」。
  //
  // 用户实报：「每轮回复的标记出现再消失，有时最下面空出一大块」。
  // 机制：标记在流式输出时以原文短暂可见；擦除器擦掉文字后，
  // 标记里的每个空行都会变成一个**空段落**，仍占行高与段间距。
  // 实测最近 8 条流水每条 1~5 个空行、合计 120~320px —— 就是那块留白。
  //
  // 为什么必须放在注入里而不是 policy.md：POLICY_TEMPLATE 只在首次安装时
  // 生成 policy.md，之后那是运行时数据；改模板对已有用户无效。
  // 只有每轮注入的 usageLines 能对**所有用户**生效。
  ['正文不要写空行（否则擦除后留空段）', /不要写空行/],
  // ★ 2026-11-16 新增：情绪不豁免记流水。
  //
  // 用户实报：情绪记录 #26/#27/#29 都是「带着情绪的实质反馈」——
  //   「你缺少实用的技能包」            → 命中「宝贝」判爱意
  //   「你有可爱的手手，漂亮的眼睛。只是你用的少」 → 命中「漂亮」判夸赞
  //   「走正规流程想想你刚才回复的是什么」   → 命中「想你」判爱意
  // 全都只进了 emotion 表，技术内容一个字没留。
  //
  // 机制上两条通道是**独立**的（analyzeEmotion 不拦 mem-log），
  // 是模型自己误以为「情感交流不算技术结论」而放弃写流水。
  // 同一个坑 2026-11-14 踩过一次，所以必须写进每轮注入并断言住。
  ['情绪不豁免：指出问题/提需求/讲偏好一律记流水', /情绪不豁免|一律记流水/],
  ['必须明说两条通道独立', /独立通道|两条独立通道|不影响写/],
  ['必须给出可执行判据', /少走一次弯路/],
]
for (const [name, re] of must) check(name, re.test(INJECT), '')

// 单独断言：新增的这句必须同时说清「为什么」，否则以后的会话可能
// 觉得它是可选的排版偏好而删掉。
check('空行规则必须给出原因（擦除后留空段）', /空行[^\n]{0,40}空段|空段[^\n]{0,40}空行|底部会空一块/.test(INJECT))

console.log('\n=== 4c. scope 必须是运行时插值（不能用死占位符）===\n')
// 注意：这里检查的是**源码**，所以看的是「有没有用变量插值」，
// 而不是「有没有变成真实项目名」—— 真实值只有运行时才知道。
// 曾写错一次：断言源码里出现真实项目名，必然失败。
const usesInterpolation = /&scope=\$\{[^}]+\}/.test(USAGE)
check('usageLines 的 scope 用变量插值（运行时替换为真实项目名）', usesInterpolation,
  usesInterpolation ? '' : '写成了固定占位符，模型会照抄错误的 scope')

console.log('\n=== 4d. 跨项目与编码边界 ===\n')
// 2026-11-14：方案 A —— 用户点名其他项目时可精确查，但不许 all=1 翻全库。
check('注入给了「点名其他项目」的精确查询规则', /点名其他项目/.test(USAGE),
  '缺这条会让模型在跨项目场景直接放弃，或被 all=1 诱导翻全库')
check('注入禁止用 all=1 翻全库', /不许用 all=1|不要用 all=1/.test(USAGE))
check('注入含 URL 编码提示（中英文项目名）', /URL 编码/.test(USAGE))
// 占位符绝不能进注入：模型会照抄它去查一个不存在的项目，0 条且不报错。
check('注入里没有「<当前项目名>」这类死占位符', !USAGE.includes('<当前项目名>'),
  '占位符会让模型查不存在的项目且静默返回空')

console.log('\n=== 4e. 硬触发条件 + 两段式用法（2026-11-14）===\n')
// 原先只有软性告知（「可以查」），缺硬条件（「报错必须查」）。
// 软告知模型可以忽略；条件→动作映射它才会在卡住时执行。
check('注入含「必须先查」硬触发提示', /必须先查/.test(USAGE),
  '缺这条模型仍会在报错时说「我没记住」而不是去查')
check('注入列出报错场景', /报错/.test(USAGE))
check('注入含「之前」「上次」这类用户话术触发', /之前.*上次|上次.*之前/.test(USAGE.replace(/\n/g, '')))
check('注入教两段式：先 summary 再取全文', /summary=1/.test(USAGE))
// ★ 2026-11-14 新增：两段式的第二步必须有**真实入口**。
//   历史教训：注入写了「按 id 取全文」，但 /entry 路由当时并不存在
//   （未注册路径一律 401），模型只能退回重查整页全文，summary 省 token 白做。
check('注入给出按 id 取全文的入口（entry?id=）', /entry\?id=/.test(USAGE),
  '缺这条时「先 summary 再取全文」是死路')
check('注入说明相似条目不去重', /不要去重/.test(USAGE),
  '去重会丢「同一件事两个阶段」的信息')
// ★ 2026-11-14 v4 新增：原文归档层必须给出**可用的查询入口**。
//   缺这条时，注入只会教模型查「结论层」（logs）。用户问「我上次原话怎么说的」，
//   模型查不到就答「没记住」—— 而原文其实在库里。
//   同时必须带上 scope，否则又会退化成跨库翻找。
check('注入给出原文归档入口（archive?scope=）', /archive\?scope=/.test(USAGE),
  '缺这条时模型无法回溯原文层，只能看到整理过的流水')
check('归档入口也带 scope（不许跨库乱翻）', /archive\?scope=[^\s`"']+/.test(USAGE))
check('注入说明归档可检索/可翻页', /关键词|limit/.test(USAGE))
// ★ 2026-11-14 现场补：隔壁项目实盘踩到——模型按 search 的字段名读 archive，
//   取 `.hits` 得到 undefined，于是判「搜不到」，其实数据就在 `rows` 里。
//   所以注入必须**同时**给出两个返回字段名，光给调用方式不够。
check('注入写明 archive 返回字段是 rows（不是 hits）',
  /`rows`/.test(USAGE) || /\brows\b/.test(USAGE),
  '缺这条时模型会去读 .hits，得到 undefined 并误判「没搜到」')
check('注入写明 search 返回字段是 hits', /`hits`/.test(USAGE) || /\bhits\b/.test(USAGE))
check('注入说明两个入口的分工（结论层 vs 原文层）',
  /结论层/.test(USAGE) && /原文层/.test(USAGE),
  '不说分工，模型搜不到结论就收工，不会去翻原文')
check('注入提醒「结论层搜不到 ≠ 没发生过」', /搜不到.*(≠|不等于)|没发生过/.test(USAGE))
// ★ 2026-11-14 现场补：隔壁项目问「之前想过早上吃什么吗」，模型查完 archive
//   答「没有，今天第一次」。数据对，但语义错 —— archive 是 v4(04:45) 才上线的，
//   更早的对话从来没存过。「查不到」和「没发生过」在用户听来完全是两件事。
//   这条断言锁住「边界必须被说出来」，否则模型会自信地给出错误否定。
check('注入写明 archive 的起始边界（不回填）',
  /archive.*(04:45|2026-11-14)|更早未回填/.test(USAGE),
  '不写边界，模型会把「archive 查不到」当成「世上没发生过」')
check('注入要求区分「我没有记录」与「没发生过」',
  /没发生过/.test(USAGE) && /没有这段记录|没记住/.test(USAGE),
  '这两种说法在用户听来不同，混用就是误导')
// ★ 2026-11-15 隔壁项目实盘补（用户带回的缺陷 1+2）：
//
//   缺陷 1（role）：用户问「我们之前讨论过吃吗」，模型查 archive 看到 assistant
//   那一大段自己的回答，答成「我们双向讨论过」。而 `rows` 每行都带 `role`，
//   数据一直是够的 —— 缺的只是「assistant 那侧是模型自己说的」这句提示。
//
//   缺陷 2（自证）：`search` 命中的 `logs` 是模型自己整理的结论，
//   拿它证明「讨论过 X」等于用自己的话证明自己的结论。
//
// 这两条锁的是同一件事：**注入必须点破「哪些内容是模型自述」**。
// 缺了它不会报错、不会查不到 —— 会产出一个看起来成立、其实伪造了对话史的回答，
// 比「查不到」危险得多，因为用户无从察觉。
check('注入点明 archive 的 role 字段（区分谁说的）',
  /role/.test(USAGE) && /(user|assistant)/.test(USAGE),
  '缺这条时模型会把 assistant 自己的回答当成「我们讨论过」')
check('注入警告 assistant 侧是模型自述、不是用户说的',
  /assistant.*(你|自己)/.test(USAGE),
  '不点破「assistant = 你自己」，模型会把自己的输出当成对话证据')
check('注入警告 logs 命中是自述、不能当证据',
  /logs.*(自己|自述)|(自己|自述).*logs/.test(USAGE),
  'search 命中的 logs 是模型自己整理的结论，拿它证明结论属于自证循环')
check('注入给出「要确认用户说过什么只看 role=user」',
  /role=user/.test(USAGE),
  '没有可执行的替代动作，模型只会知道「别这样」却不知道「那该怎样」')
// ★ 2026-11-14 v5 新增：情绪退出检索池后，注入必须说明这件事。
//   缺这句时，模型搜「喜欢」「爱意」得到 0 条会判定「没记住」，
//   而情绪记录其实在库里、只是不参与检索 —— 会变成一次误导性的「我不知道」。
check('注入说明情绪不在检索里', /情绪.*不在检索|情绪记录不在/.test(USAGE),
  '缺这条会让模型把「搜不到情绪」误判成「没记住」')

console.log('\n=== 4b. 不得再声称「没有检索工具」===\n')
// 这句话直接导致模型放弃查询，比缺指引更糟 —— 它是断言的主动错误
const falseClaims = ['你没有检索工具', '没有查询工具', '不要自己读库']
for (const s of falseClaims) {
  check(`不再出现「${s}」`, !INJECT.includes(s),
    INJECT.includes(s) ? '这句话会让模型放弃查询，应改为给出查询路径' : '')
}

console.log('\n=== 5. 不得把动作推给用户 ===\n')
const push = ['请用户敲', '请用户输入', '让用户敲', '告诉用户去敲', '交给用户去查', '请他敲']
for (const s of push) check(`不含「${s}」`, !INJECT.includes(s))

console.log('\n=== 6. 旧文案确已消失 ===\n')
const gone = ['或直接 grep 记忆库', '用 `/memory search <关键词>` 检索（中文按字匹配）', '遇到似曾相识的报错或改造，先查再动手']
for (const g of gone) check(`已删「${g.slice(0, 24)}…」`, !INJECT.includes(g), g)

console.log('\n=== 7. policy.md 与模板口径一致 ===\n')
if (POLICY === '') {
  console.log('  （policy.md 不可读，跳过）')
} else {
  check('policy.md 不含 /memory search', !POLICY.includes('/memory search'))
  check('policy.md 不含「grep 记忆库」', !POLICY.includes('grep 记忆库'))
  check('policy.md 含标记语法', POLICY.includes('mem-log'))
}

console.log('\n=== 8. POLICY_TEMPLATE 也要有空行规则（新装用户）===\n')
// ★ 2026-11-16 加。
//
// 为什么单独一段：硬约束 9 说「POLICY_TEMPLATE 改了什么，policy.md 也要同步」，
// 但反过来更容易漏 —— 只改了 usageLines（每轮注入、对老用户生效），
// 忘了模板（只在新装时生成 policy.md），新用户就收不到这条规矩。
//
// 变异测试实测确认过：删掉模板里这句，**原先没有任何测试会红**
// （mutations: policy-no-blank-line SURVIVED）。所以在这里钉死。
//
// 断言写法注意：POLICY_TEMPLATE 是源码里的模板字符串，反引号转义后是
// \`mem-log\`；而「正文不要写空行」这句本身没有反引号，可以直接按字面匹配。
// 断言必须精确到「在哪个位置」，不能只查「这个词在不在文件里」——
// 「**正文不要写空行**」在源码里出现 **2 次**（POLICY_TEMPLATE 一次、
// usageLines 一次）。只查有没有的话，变异只删掉模板那一条、另一条还在，
// 断言照样绿 → 变异 SURVIVED（2026-11-16 实测踩到，第一次版本就是这样）。
//
// 所以下面用**模板独有的后半句**定位（带 2026-11-16 日期那行），
// 它与 usageLines 里那句措辞不同，可以唯一定位。
const TEMPLATE_BLANK_RULE = '**正文不要写空行**（2026-11-16）'
check('POLICY_TEMPLATE 含空行规则（模板独有措辞）', IDX.includes(TEMPLATE_BLANK_RULE))
check('POLICY_TEMPLATE 说明了空行的后果', /空行[^\n]{0,60}空段落/.test(IDX))
// 模板里这句必须落在「流水必须带 topic 和 summary」之后 ——
// 那是讲标记格式的小节，空行规则属于同一话题。
// 不检查上界：模板后面的小节顺序可能调整，写死上界会让无关改动变红。
{
  const atRule = IDX.indexOf(TEMPLATE_BLANK_RULE)
  const atTopic = IDX.indexOf('流水必须带 topic 和 summary')
  check('空行规则位于标记语法小节之后',
    atTopic !== -1 && atRule !== -1 && atRule > atTopic,
    `atRule=${atRule} atTopic=${atTopic}`)
}

console.log('\n=== 9. POLICY_TEMPLATE 也要有「情绪不豁免」规则 ===\n')
// ★ 2026-11-16 加。同 §8 的理由：这条规则只改 usageLines 对老用户生效，
// 但新装用户的 policy.md 来自模板，漏改模板 = 新用户收不到。
//
// 断言同样要精确到「模板独有措辞」，不能只查关键词 ——
// 「一律记流水」在 usageLines 与模板里都会出现，只查有没有的话，
// 变异删掉模板那条、另一条还在，断言照样绿（§8 踩过一次）。
const TEMPLATE_EMOTION_RULE = '**用户指出的问题、提出的需求、讲的做事偏好，一律记流水。**'
check('POLICY_TEMPLATE 含「情绪不豁免」规则（模板独有措辞）', IDX.includes(TEMPLATE_EMOTION_RULE))
check('POLICY_TEMPLATE 说明了两个通道独立', /判成情绪不影响记流水，两者是独立的通道/.test(IDX))
check('POLICY_TEMPLATE 含「少走一次弯路」判据', /少走一次弯路/.test(IDX))

console.log(`\n────────────────\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
