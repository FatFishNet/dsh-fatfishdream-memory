/** 对比正常与污染记录的正文结构，定位 topic 污染的写入形态 */
import { DatabaseSync } from 'node:sqlite'

const db = new DatabaseSync('D:/dsh-fatfishdream-memory/memory.db', { readOnly: true })

console.log('=== 正常记录（topic=路径/沙箱）===\n')
const ok = db.prepare("SELECT id, topic, text FROM logs WHERE topic='路径/沙箱' ORDER BY id DESC LIMIT 1").get()
console.log(`#${ok.id}  topic=${JSON.stringify(ok.topic)}`)
console.log('正文:')
console.log(ok.text.split('\n').map((l) => '  ' + l).join('\n'))

console.log('\n=== 污染记录（#379）===\n')
const bad = db.prepare('SELECT id, topic, text FROM logs WHERE id=379').get()
console.log(`#${bad.id}  topic=${JSON.stringify(bad.topic)}`)
console.log('正文:')
console.log(bad.text.split('\n').map((l) => '  ' + l).join('\n'))

console.log('\n=== 正文里是否残留 "-->" ===\n')
for (const r of db.prepare("SELECT id, topic, text FROM logs WHERE topic LIKE '%--%'").all()) {
  const tail = r.text.slice(-40).replace(/\n/g, '⏎')
  console.log(`#${r.id} topic=${JSON.stringify(r.topic)}`)
  console.log(`   正文结尾: ${JSON.stringify(tail)}`)
}

console.log('\n=== 关键推断 ===')
console.log('如果正文结尾没有 "-->"，说明正则把 "-->" 算进了 topic，正文是干净的。')
console.log('这种情况下 topic 的值应当是 "开发日志 -->"，即 "topic=" 之后到行尾的全部内容。')

db.close()
