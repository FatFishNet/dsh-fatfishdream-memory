import fs from 'node:fs'
const A = fs.readFileSync('dsh-memory/index.js', 'utf8').split('\n')

const s = A.findIndex((l) => /^\s*function renderFromFiles\(/.test(l))
console.log('renderFromFiles 起始 L' + (s + 1))

// 找闭合：从函数体开始，追踪大括号深度
let depth = 0
let started = false
let e = -1
for (let i = s; i < A.length; i++) {
  for (const ch of A[i]) {
    if (ch === '{') { depth++; started = true }
    else if (ch === '}') { depth-- }
  }
  if (started && depth === 0) { e = i; break }
}
console.log('renderFromFiles 结束 L' + (e + 1))
console.log('共 ' + (e - s + 1) + ' 行')

console.log('\n=== 调用点上下文 ===')
for (let i = 2442; i <= 2462; i++) console.log(String(i + 1).padStart(5), A[i])

console.log('\n=== factsTextSync / projectTextSync 边界 ===')
for (const name of ['factsTextSync', 'projectTextSync']) {
  const st = A.findIndex((l) => new RegExp('^\\s*function ' + name + '\\(').test(l))
  let d = 0, beg = false, en = -1
  for (let i = st; i < A.length; i++) {
    for (const ch of A[i]) {
      if (ch === '{') { d++; beg = true }
      else if (ch === '}') { d-- }
    }
    if (beg && d === 0) { en = i; break }
  }
  console.log(`${name}: L${st + 1} - L${en + 1}  (${en - st + 1} 行)`)
}
