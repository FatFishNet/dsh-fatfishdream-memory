// 第 5 轮收尾：地图行号重校（search 删除后 search 之后的锚点全部上移）。
import fs from 'node:fs'

const IDX = fs.readFileSync('dsh-memory/index.js', 'utf8').split('\n')
const MAP = 'docs/项目地图.md'

function lineOf(re, label) {
  const hits = []
  IDX.forEach((l, i) => { if (re.test(l)) hits.push(i + 1) })
  if (hits.length === 0) { console.log(`  ?? ${label} 找不到`); return null }
  return hits[0]
}

const A = {
  reportBudget: lineOf(/^\s*function reportBudget/, 'reportBudget'),
  runHealthCheck: lineOf(/^\s*const runHealthCheck/, 'runHealthCheck'),
  runHealthCheck调度: lineOf(/setTimeout\(runHealthCheck/, 'runHealthCheck调度'),
  sanitizeTopic: lineOf(/^\s*function sanitizeTopic/, 'sanitizeTopic'),
}

console.log(JSON.stringify(A, null, 2))

let text = fs.readFileSync(MAP, 'utf8')
const EDITS = []

// 初始化顺序块里的 reportBudget / runHealthCheck
EDITS.push([/L\d+  reportBudget/, `L${A.reportBudget}  reportBudget`])
EDITS.push([/L\d+  runHealthCheck（定义；L\d+ 延迟 600ms 跑）/, `L${A.runHealthCheck}  runHealthCheck（定义；L${A.runHealthCheck调度} 延迟 600ms 跑）`])

// 3.5 段落里的 sanitizeTopic
EDITS.push([/L\d+ `sanitizeTopic`/, `L${A.sanitizeTopic} \`sanitizeTopic\``])

// §12 健康自检
EDITS.push([/`runHealthCheck` L\d+ 定义，L\d+ 调度/, `\`runHealthCheck\` L${A.runHealthCheck} 定义，L${A.runHealthCheck调度} 调度`])

let bad = 0
for (const [re, to] of EDITS) {
  const m = text.match(new RegExp(re.source, 'g'))
  if (!m) { console.log(`❌ 无匹配: ${re}`); bad++; continue }
  text = text.replace(new RegExp(re.source, 'g'), to)
  console.log(`✅ ${re.source.slice(0, 40)} → ${to}`)
}

if (bad > 0) { console.log('中止'); process.exit(1) }
fs.writeFileSync(MAP, text, 'utf8')
console.log('已写入')
