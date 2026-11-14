import { DatabaseSync } from 'node:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ptr = join(homedir(), '.dsh', 'memory-root.json')
let root = 'D:/dsh-fatfishdream-memory'
if (existsSync(ptr)) {
  try { root = JSON.parse(readFileSync(ptr, 'utf8')).root } catch {}
}

const d = new DatabaseSync(join(root, 'memory.db'), { readOnly: true })
console.log('root:', root)
console.log('--- active logs by topic ---')
for (const r of d.prepare("SELECT topic, COUNT(*) c FROM logs WHERE status='active' GROUP BY topic ORDER BY c DESC").all()) {
  console.log(String(r.c).padStart(4), r.topic)
}
console.log('--- suspicious topics (non-whitelist) ---')
const WL = new Set(['开发日志','技术讨论','构建/编译','注入/预算','插件/装载','路径/沙箱','格式/编码','文档/行号','情绪判据','用户画像','数据清理','GUI/界面','Git'])
let bad = 0
for (const r of d.prepare('SELECT id, topic, substr(text,1,40) s FROM logs').all()) {
  if (!WL.has(r.topic)) { console.log('  #' + r.id, JSON.stringify(r.topic), r.s); bad++ }
}
console.log(bad === 0 ? 'OK 全部在白名单内' : `发现 ${bad} 条畸形 topic`)
console.log('--- integrity ---')
console.log(d.prepare('PRAGMA integrity_check').all()[0])
d.close()
