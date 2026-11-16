/**
 * 逐条核实基线里剩下的 10 条：它们出现在**当前**代码的哪一行，
 * 那条 catch 到底在做什么。跑完即删。
 */
import fs from 'node:fs'

const FILES = {
  'index.js': 'dsh-fatfishdream-memory/index.js',
  'client.js': 'dsh-fatfishdream-memory/client.js',
  'db-store.mjs': 'dsh-fatfishdream-memory/db-store.mjs',
}

// 找出所有空 catch，并打印它所在的函数 + 前后文
for (const [label, p] of Object.entries(FILES)) {
  const lines = fs.readFileSync(p, 'utf8').split('\n')
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(lines[i])) hits.push(i)
  }
  if (hits.length === 0) continue
  console.log(`\n═══ ${label}：${hits.length} 处空 catch ═══`)
  for (const i of hits) {
    // 所属函数
    let fn = '(不在函数内)'
    for (let k = i; k >= 0; k--) {
      const m = lines[k].match(/^\s{0,4}(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
      if (m) { fn = m[1]; break }
      const m2 = lines[k].match(/^\s{0,6}(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/)
      if (m2) { fn = `${m2[1]} (const)`; break }
    }
    console.log(`\n  L${i + 1}  在 ${fn} 里`)
    // 打印这行的内容 + 上下 2 行
    for (let k = Math.max(0, i - 2); k <= Math.min(lines.length - 1, i + 1); k++) {
      console.log(`      ${k + 1}${k === i ? '>' : ':'} ${lines[k].trim().slice(0, 100)}`)
    }
  }
}
