import fs from 'node:fs'
const src = fs.readFileSync('dsh-memory/index.js', 'utf8')

for (const name of ['ensureProject', 'ensureMonthlyLog', 'appendLog', 'appendFact', 'appendProjectNote', 'fixFactsByRegex']) {
  const re = new RegExp('async function ' + name + '\\(')
  const m = re.exec(src)
  if (!m) { console.log(name, '找不到'); continue }
  const at = m.index
  console.log(`\n=== ${name} ===`)
  console.log('正则命中位置:', at)
  console.log('该处前后 120 字符:')
  console.log(JSON.stringify(src.slice(at - 40, at + 80)))
}
