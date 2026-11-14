/**
 * 验证「未登记」分支：projectName 为空时，注入不得出现 <当前项目名> 占位符。
 * 直接从源码抽 usageLines 语句，用 projectName='' 求值。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const idxSrc = readFileSync('dsh-memory/index.js', 'utf8')
const start = idxSrc.indexOf('const usageLines = dbMode')
const end = idxSrc.indexOf('parts.push(`## 记忆使用说明', start)
const stmt = idxSrc.slice(start, end)

const root = JSON.parse(readFileSync(join(homedir(), '.dsh', 'memory-root.json'), 'utf8')).root

function build(projectName) {
  const scopeHint = projectName || ''
  return new Function(
    'dbMode', 'dbPathOf', 'config', 'store', 'projectName', 'scopeHint',
    `${stmt}; return usageLines`,
  )(true, () => join(root, 'memory.db'), { factsBytes: 8000, policyBytes: 8000, projectBytes: 4096 }, { root }, projectName, scopeHint)
}

const withName = build('dsh-fatfishdream-memory').join('\n')
const noName = build('').join('\n')

const check = (name, ok, extra = '') => console.log(`${ok ? '✅' : '❌'} ${name}${extra ? '  ← ' + extra : ''}`)

console.log('=== 有项目名 ===')
check('含真实项目名 scope', withName.includes('scope=dsh-fatfishdream-memory'))
check('含「点名其他项目」规则', withName.includes('点名其他项目'))
check('含 URL 编码提示', withName.includes('URL 编码'))
check('无死占位符', !withName.includes('<当前项目名>'))

console.log('\n=== 无项目名（未登记）===')
check('未回退占位符', !noName.includes('<当前项目名>'), noName.includes('<当前项目名>') ? '仍出现占位符' : '')
check('明确告知未登记', noName.includes('未登记'))
check('要求先确认项目名', noName.includes('确认项目名'))
check('未给出错误的 scope 示例', !/scope=dsh-fatfishdream-memory/.test(noName))
