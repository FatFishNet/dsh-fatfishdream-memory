/** 核对 webServer.getOrigin() 能否在插件里拿到，以及真实返回值 */
import fs from 'node:fs'

const ASAR = 'D:/DeepSeek Harness/resources/app.asar'
const fd = fs.openSync(ASAR, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const hs = head.readUInt32LE(12)
const hb = Buffer.alloc(hs)
fs.readSync(fd, hb, 0, hs, 16)
const hdr = JSON.parse(hb.toString('utf8'))
const ds = 8 + head.readUInt32LE(8)
const files = []
function walk(n, p) {
  if (!n) return
  if (n.files) for (const [k, v] of Object.entries(n.files)) walk(v, p + '/' + k)
  else files.push({ path: p, offset: n.offset, size: n.size })
}
walk(hdr, '')

const P = '/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
const f = files.find((x) => x.path === P)
const buf = Buffer.alloc(Number(f.size))
fs.readSync(fd, buf, 0, Number(f.size), ds + Number(f.offset))
const s = buf.toString('utf8')

console.log('=== getOrigin 的实现 ===\n')
const i = s.indexOf('getOrigin()')
console.log(s.slice(Math.max(0, i - 400), i + 500))

console.log('\n\n=== getOrigin 是否出现在对外接口里（service 契约）===\n')
// 找返回值/类型声明附近
for (const kw of ['getOrigin', 'listenedPort']) {
  let idx = -1
  const pos = []
  while ((idx = s.indexOf(kw, idx + 1)) !== -1) pos.push(idx)
  console.log(`[${kw}] 出现 ${pos.length} 次，位置: ${pos.join(', ')}`)
}

console.log('\n=== 当前进程实际端口（对照用）===')
console.log('  运行时给的 URL 是 http://127.0.0.1:6242')

fs.closeSync(fd)
