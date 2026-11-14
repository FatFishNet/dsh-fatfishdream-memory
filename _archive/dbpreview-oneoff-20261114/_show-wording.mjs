// 更新过期的注入文案断言：口径从「必须教模型 /memory search 是斜杠命令」
// 改为「注入里不得出现用户侧命令 /memory search」。
// 这是一个**规则变更**，不是放宽断言 —— 新断言比旧断言更严格。

import fs from 'node:fs'

const FILE = 'docs/../_dbpreview/selfcheck-injection-wording.mjs'
const src = fs.readFileSync(FILE, 'utf8')
console.log(src.slice(0, 3000))
