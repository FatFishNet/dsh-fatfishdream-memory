/**
 * 回归测试：工作区脚本 `log.ps1` 的**输出必须足以判断「写对没有」**。
 *
 * ============================================================
 * 这个脚本守的是同一个病的三次复发（2026-11-19 / 11-20）
 * ============================================================
 *
 * 病根一句话：
 *
 * > **脚本把服务端的响应剪裁成一行，剪掉了「判断对错所需的信息」。**
 *
 * 而它每次都不报错 —— 因为调用本身是合法的，只是语义错了。
 *
 * ## 第一次：turnWrites（2026-11-19）
 *
 * 脚本只打 `ok id=N turn=M`。同一轮里连写 5 条时输出是：
 *
 *     ok id=972 turn=54
 *     ok id=973 turn=54     ← turn 没变，但我没注意
 *
 * 我据此得出「连续 5 轮都写了」的结论 —— **实际那 5 条全是同一轮**。
 * 服务端一直在响应里返回 `turnWrites`，是脚本没打。
 *
 * ## 第二次：topic（2026-11-20，补 turnWrites 的第二天）
 *
 * 我调用时只传了一个参数：
 *
 *     & .\log.ps1 "…判为闲聊"          ← 少了第二个参数
 *
 * `param` 里 `$Topic` 是 Position 1 的可选参数 → 它是 `$null` →
 * 请求体没有 topic → 服务端补默认值「开发日志」。
 * 于是**正文写着「判为闲聊」，实际归进了开发日志**，而输出只说：

 *     ok id=1105 turn=48 (本轮第 1 条)
 *
 * **一个字都没提 topic。**
 *
 * ## 为什么这三次都没被任何测试挡住
 *
 * 因为之前的断言全在测「脚本能不能成功写进去」，没有一个在测
 * **「脚本吐出来的信息，够不够让人发现写错了」**。
 *
 * 判据：
 * **如果某个字段缺了，调用方就看不出自己写错了 —— 那它必须在输出里。**
 *
 * ============================================================
 * 本脚本怎么测（三层，都不碰真实记忆库）
 * ============================================================
 *
 *   ① **模板文本层**：`WORKSPACE_LOG_PS1` 里必须出现 topic/turnWrites 的输出
 *   ② **PowerShell 真实执行层**：在**临时目录**里放一份脚本，
 *      用假的 `DSH_WEB_URL` 指向一个本地 mock HTTP 服务，
 *      真跑 `pwsh -File log.ps1 "正文"`，**断言 stdout 里的实际文字**
 *   ③ **自证**：把输出里的 `topic=...` 删掉，② 的断言必须变红
 *
 * ⚠️ ② 需要 `pwsh` 可执行文件。找不到就**打印「本段不适用」并跳过**
 *    （不是假通过）—— 这是 AGENTS.md 那条「没有断言可写就不要产生断言」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const INDEX = path.join(ROOT, 'dsh-fatfishdream-memory', 'index.js')
const SRC = fs.readFileSync(INDEX, 'utf8')

let pass = 0
let fail = 0
const bad = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    bad.push(`${name}${detail ? ' — ' + detail : ''}`)
    console.log(`❌ ${name}  ← ${detail}`)
  }
}

/** 抽 `WORKSPACE_LOG_PS1` 的**运行时真实值**（源码里 \` 是转义，必须求值）。 */
function extractLogPs1Template(source = SRC) {
  const m = source.match(/const WORKSPACE_LOG_PS1 = `([\s\S]*?)`\n\n\/\*\*/)
  if (!m) throw new Error('抽取 WORKSPACE_LOG_PS1 失败（模板的结尾锚点变了？）')
  // eslint-disable-next-line no-new-func
  return new Function(`return \`${m[1]}\``)()
}

const TEMPLATE = extractLogPs1Template()

// ============================================================
console.log('=== ① 模板文本层：输出必须带 topic 与 turnWrites ===\n')

{
  check('能抽出模板（非空）', TEMPLATE.length > 500, `${TEMPLATE.length} 字符`)

  // ★ 核心断言 1：成功分支必须打印 topic
  //
  // 判据不是「模板里有 topic 这个词」—— 上面 `param` 与 `if ($Topic)`
  // 都含这个词。必须是**输出语句里的 `$r.topic`**（服务端返回值）。
  check('成功输出里打印了 $r.topic',
    /Write-Output[^\n]*\$r\.topic/.test(TEMPLATE),
    '缺它 → 调用方看不出实际归到哪一类')

  // ★ 核心断言 2：turnWrites（第一次事故的防线，不能被回退）
  check('成功输出里打印了 $r.turnWrites',
    /Write-Output[^\n]*\$r\.turnWrites/.test(TEMPLATE),
    '缺它 → 同一轮重复写入看不出来')

  // ★ 核心断言 3：没传 topic 时必须显式提示
  //
  // 为什么不静默：不传 topic 是**合法调用**（服务端补默认值），
  // 所以永远不报错 —— 而「不报错」正是它危险的原因。
  check('没传 topic 时有显式提示',
    /-not \$Topic/.test(TEMPLATE) && /未指定 topic/.test(TEMPLATE),
    '缺它 → 「正文说闲聊、实际写开发日志」会再次静默发生')

  // 反向：不许出现「调用了 topic 但输出里没有」的形态
  check('输出语句确实是 Write-Output（不是注释里提了一句）', /Write-Output/.test(TEMPLATE))

  // 输出里不能把 topic 写死（否则永远显示同一个值，等于没打）
  check('输出里的 topic 来自服务端响应，不是字面量',
    !/Write-Output[^\n]*topic=开发日志/.test(TEMPLATE),
    'topic=开发日志 硬编码 → 无论实际是哪类都显示开发日志，比不打更坏')
}

// ============================================================
console.log('\n=== ② 真实执行层：真跑 pwsh，断言 stdout 的实际文字 ===\n')

/**
 * 沙箱安全的子进程捕获（改自 `lib-spawn-capture.mjs` 的思路）。
 *
 * ## 为什么不能直接用 `lib-spawn-capture.mjs` 的 `runCaptured`
 *
 * 那个函数**固定用 `process.execPath`**（node）当可执行文件，
 * 而这里要跑的是 **`pwsh`** —— 它不是 node 脚本。
 *
 * ## 为什么必须自己处理（2026-11-20 实踩）
 *
 * 第一版我直接写：
 *
 *     spawnSync(PWSH, [...], { encoding: 'utf8' })
 *
 * `encoding` 隐含 `stdio: 'pipe'`，而在受限沙箱下**开命名管道被拒**，
 * 于是拿回 `status: null` + **空 stdout**，8 条断言全红 ——
 * 而脚本本身是好的。这正是 AGENTS.md 记的那条：
 *
 *     「全部脚本同一形态失败且 note 空白 = 环境问题，不是代码问题」
 *
 * 这里照 `lib-spawn-capture.mjs` 的办法：先试 pipe，遇 EPERM/EACCES
 * 就退回「stdout/stderr 都重定向到临时文件」再读回来。
 */
function runSafe(execPath, args, opts = {}) {
  const base = {
    cwd: opts.cwd ?? process.cwd(),
    timeout: opts.timeout ?? 30000,
    env: opts.env ?? process.env,
  }

  const first = spawnSync(execPath, args, { ...base, encoding: 'utf8' })
  if (!first.error) {
    return { status: first.status, out: `${first.stdout ?? ''}${first.stderr ?? ''}`, mode: 'pipe' }
  }
  const denied = first.error.code === 'EPERM' || first.error.code === 'EACCES'
  if (!denied) {
    // 不是管道问题（ENOENT / 超时等），原样交给调用方判断，不掩盖
    return { status: first.status, out: `${first.stdout ?? ''}${first.stderr ?? ''}`, mode: 'pipe', error: first.error }
  }

  // 退回临时文件捕获
  const tmp = path.join(os.tmpdir(), `dsh-ps1cap-${process.pid}-${Date.now().toString(36)}.txt`)
  let fd = null
  try {
    fd = fs.openSync(tmp, 'w')
    const second = spawnSync(execPath, args, { ...base, stdio: ['ignore', fd, fd] })
    fs.closeSync(fd)
    fd = null
    let captured = ''
    try { captured = fs.readFileSync(tmp, 'utf8') } catch { /* 保持空串 */ }
    return { status: second.status, out: captured, mode: 'file', error: second.error }
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/** 找一个可用的 pwsh 可执行文件 */
function findPwsh() {
  for (const name of ['pwsh.exe', 'pwsh']) {
    // 注意：这里也走 runSafe，避免探测本身就被 EPERM 卡住
    const r = runSafe(name, ['-NoLogo', '-NoProfile', '-Command', 'exit 0'], { timeout: 15000 })
    if (r.status === 0) return name
  }
  return undefined
}

const PWSH = findPwsh()

if (PWSH === undefined) {
  // 找不到 pwsh 就**不产生断言**（AGENTS.md：没有断言可写就不要产生断言）
  console.log('   ℹ️ 未找到 pwsh，本段不适用（跳过①②的真实执行验证）')
  console.log('      模板文本层的断言仍有效，但「实际输出长什么样」未被验证。')
} else {
  console.log(`   使用 ${PWSH}`)

  // 起一个 mock 服务替代真实 /log 路由 —— 绝不碰用户的记忆库
  //
  // ⚠️⚠️ 2026-11-20 实踩：**不能用本进程内的 http server 配 spawnSync**
  //
  // 第一版就是这样写的，结果 8 条断言全红、`status=null`、输出为空。
  // 排查了两轮才想通根因：
  //
  //   `spawnSync` 会**阻塞 Node 的事件循环**，而 mock server 跑在**同一个进程**里 ——
  //   子进程（pwsh）发 HTTP 请求时，父进程的事件循环正卡在 spawnSync 上，
  //   **server 永远没有机会 accept 这个连接** → 请求挂起 → 超时 → status=null。
  //
  // 这不是沙箱、不是 pwsh、不是脚本的问题，是**测试设计错误**。
  //
  // 修法：mock server 必须跑在**另一个进程**里（下面用 detached 的 node 子进程），
  // 或者干脆用真实服务（但那会往用户库里写数据，不可接受）。
  //
  // 这里选前者：起一个独立的 node 进程当 mock server，主进程只负责 spawnSync。
  const MOCK_SERVER_SRC = `
import http from 'node:http'
import fs from 'node:fs'
const reply = ${JSON.stringify({
  ok: true, id: 9999, scope: 'mock-project', bytes: 12,
  topic: '闲聊', turn: 7, turnWrites: 1, streakCleared: true,
})}
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    let hadTopic = false
    try { hadTopic = Object.prototype.hasOwnProperty.call(JSON.parse(body), 'topic') } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...reply, __requestHadTopic: hadTopic }))
  })
})
server.listen(0, '127.0.0.1', () => {
  // ⚠️ 端口写**文件**，不走 stdout —— 见下面 spawn 处的说明。
  fs.writeFileSync(process.argv[2], String(server.address().port))
})
`

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-logps1-'))
  let mock = null

  try {
    // ① 把 mock server 写成独立脚本，用**子进程**跑（关键：不能同进程）
    const mockScript = path.join(TMP, 'mock-server.mjs')
    fs.writeFileSync(mockScript, MOCK_SERVER_SRC, 'utf8')

    // ⚠️ 必须用 `process.execPath`（node）来跑那个 .mjs ——
    //    直接 spawn('.mjs') 会 EFTYPE（Windows 上 .mjs 不是可执行文件）。
    //    也不要写裸 `'node'`：本机 node 不在 PATH（AGENTS.md 记过）。
    //
    // ⚠️⚠️ 2026-11-20 第二次实踩（同一个沙箱边界，换个位置）：
    //    `stdio: ['ignore', 'pipe', 'pipe']` 在 `workspace-write` 下直接
    //    `spawn EPERM` —— 沙箱不允许开命名管道。整脚本在跑到断言**之前**就崩，
    //    而 `node --check` 通过、模板层断言全绿，看上去像「测试坏了」。
    //    这与 `selfcheck-concurrency-multiproc.mjs` 记的是同一条，那边早就
    //    改成 `stdio: 'ignore'` + 临时文件传结果了 —— 这里照抄那个写法。
    //
    // 判据：**起子进程必须在三种 stdio 里选「不与父进程交换管道」的那两种**
    //       （'ignore' / 重定向到文件）。exit code 依然准确。
    const portFile = path.join(TMP, 'mock-port.txt')
    mock = spawn(process.execPath, [mockScript, portFile], {
      stdio: 'ignore',
      env: { ...process.env },
    })

    // ② 从端口文件里读出实际端口（子进程 listen 后写一行）
    const port = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 30000
      let exited = null
      mock.on('error', (e) => reject(e))
      mock.on('exit', (code) => { exited = code })
      const poll = () => {
        let txt = ''
        try { txt = fs.readFileSync(portFile, 'utf8').trim() } catch { /* 还没写 */ }
        const m = /^(\d{2,5})$/.exec(txt)
        if (m) return resolve(Number(m[1]))
        if (exited !== null) return reject(new Error(`mock server 提前退出 code=${exited}`))
        if (Date.now() > deadline) return reject(new Error('mock server 30 秒内没报端口'))
        setTimeout(poll, 100)
      }
      poll()
    })

    check('mock server 已在独立进程就绪（拿到端口）', Number.isInteger(port) && port > 0, String(port))

    const scriptPath = path.join(TMP, 'log.ps1')
    fs.writeFileSync(scriptPath, TEMPLATE, 'utf8')

    /** 真跑一次脚本，返回 stdout+stderr 拼接（沙箱安全） */
    const runScript = (args) => {
      const r = runSafe(PWSH, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args], {
        cwd: TMP,                    // cwd 是临时目录，不是用户工作区
        timeout: 30000,
        env: { ...process.env, DSH_WEB_URL: `http://127.0.0.1:${port}`, DSH_SESSION_ID: 'mock-session' },
      })
      return r
    }

    // ---- 场景 A：传了两个参数 ----
    {
      const { out, status } = runScript(['测试正文', '闲聊'])
      check('A 传 topic 时脚本退出码为 0', status === 0, `status=${status}`)
      // ★ 核心：stdout 里必须能**看见**归到哪一类
      check('A stdout 里出现 topic=闲聊', /topic=闲聊/.test(out),
        `实际输出：${out.trim().replace(/\n/g, ' | ')}`)
      check('A stdout 里出现 id=', /id=\d+/.test(out), out.trim())
      check('A stdout 里出现 turnWrites 那个「第 N 条」', /本轮第 \d+ 条/.test(out), out.trim())
      // 传了 topic 就不该出现「未指定」的提示
      check('A 不该提示「未指定 topic」', !/未指定 topic/.test(out), out.trim())
    }

    // ---- 场景 B：只传一个参数（就是 2026-11-20 那次事故的形态）----
    {
      const { out, status } = runScript(['只有一个参数的正文'])
      check('B 少传 topic 时脚本仍然成功（说明这是「合法但语义错」的调用）',
        status === 0, `status=${status}`)
      // ★ 核心：必须**显式**告诉调用方「服务端补了默认值」
      check('B 缺 topic 时有「未指定 topic」提示', /未指定 topic/.test(out),
        `实际输出：${out.trim().replace(/\n/g, ' | ')}`)
      // 并且要能看见服务端实际补了什么
      //
      // ⚠️ 这里**不能断言补成「开发日志」** —— 那是真实服务端的默认值，
      //    而 mock server 返回的 topic 是「闲聊」。第一版写死了「开发日志」，
      //    于是这条假红。判据应该是「提示里带出了服务端返回的那个 topic」，
      //    而不是「带出了某个特定值」。
      check('B 提示里说明了服务端实际补成哪一类',
        /未指定 topic[^]*补了「[^」]+」/.test(out),
        out.trim())
    }
  } finally {
    // 关掉 mock server 子进程（不关会残留 node 进程）
    if (mock !== null) {
      try { mock.kill() } catch {}
    }
    try { fs.rmSync(TMP, { recursive: true, force: true }) } catch {}
  }
}

// ============================================================
console.log('\n=== ③ 自证：把 topic 从输出里删掉，断言必须变红 ===\n')

{
  // 把两处 ` topic=$($r.topic)` 去掉，模拟「回到 2026-11-20 之前的样子」
  const broken = TEMPLATE.replace(/\s*topic=\$\(\$r\.topic\)/g, '')
  const replaced = broken !== TEMPLATE
  check('自证锚点有效（能找到并删掉 topic 输出）', replaced)

  if (replaced) {
    // ⚠️ 判据要精确到「成功输出那几行」，不能对整个模板跑 `$r.topic` ——
    //
    // 第一版就是整模板匹配，结果自证失败：因为第三行那句
    //   ℹ️ 未指定 topic，服务端补了「$($r.topic)」
    // **也含 `$r.topic`**，删掉前两处之后它仍然命中，于是
    // 「坏版本里没有 topic 输出」判成了 false（假红）。
    //
    // 这正是 AGENTS.md 记的「断言用的文本在别处也出现」那个形态 ——
    // 同一个变量名在多个输出语句里，整模板匹配分不清是哪一处。
    //
    // 修法：先把「未指定 topic」那一整行剔掉，再看剩下的成功输出里有没有。
    const successOnly = broken
      .split('\n')
      .filter((l) => !/未指定 topic/.test(l))
      .join('\n')

    const hasTopicEcho = /Write-Output[^\n]*\$r\.topic/.test(successOnly)
    check('自证：删掉后「成功输出里打印 $r.topic」判为假（证明 ① 能红）',
      hasTopicEcho === false,
      hasTopicEcho ? '仍命中 → 断言可能没测到成功那两行' : '')

    // 再自证「没传 topic 的提示」那一条
    const brokenWarn = broken.replace(/if \(-not \$Topic\) \{[\s\S]*?\n\}/, '')
    const warnGone = !/未指定 topic/.test(brokenWarn)
    check('自证：删掉警告块后「有显式提示」判为假（证明那条能红）', warnGone === true)
  }
}

// ============================================================
console.log('\n=== ④ 派生一致性：模板改了，三个工作区的副本会怎么更新 ===\n')
{
  // 这条不测工作区实际文件（那是 selfcheck-workspace-script-sync 的职责），
  // 只确认「判据仍然是比较内容」—— 因为若它退化成 exists()，
  // 模板改了而副本永远不更新，①②③ 全绿也没意义。
  check('ensureWorkspaceScripts 仍在比内容（createHash）',
    /createHash\('sha256'\)\.update\(current/.test(SRC),
    '若退回 exists() → 模板改了副本也不会更新')

  console.log('   ℹ️ 模板本次变更后，三个工作区的 log.ps1 会在**下一次新会话**时')
  console.log('      被自动覆盖为最新版（sha256 不一致即覆写）。')
  console.log('      要立刻生效就手动覆盖那三份 —— 但别手改内容，那会被下次覆盖。')
}

// ============================================================
console.log('\n' + '─'.repeat(70))
if (fail === 0) {
  console.log(`✅ 全部通过：${pass} 通过 / 0 失败`)
} else {
  console.log(`❌ ${pass} 通过 / ${fail} 失败`)
  for (const b of bad) console.log('   - ' + b)
}
process.exit(fail === 0 ? 0 : 1)
