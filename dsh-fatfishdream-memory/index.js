/**
 * dsh-memory — 本地分层记忆（安全版）
 *
 * 存储（2026-11-13 起以 SQLite 为唯一主存储）：
 *
 *   <root>/
 *     memory.db             ★ 主存储（SQLite，WAL）。四张表：
 *                              profile  用户画像（跨项目，每轮注入）
 *                              rules    规则与偏好（含 scope/kind，按项目注入）
 *                              emotion  情绪记录（插件自动写，不注入）
 *                              logs     记忆流水（不注入，只检索）
 *     policy.md             ★ 唯一的 .md。行为规则，每轮注入「给模型的规则」小节
 *     state.json            项目映射、上次整理日期、待判情绪队列
 *     logs/YYYY-MM-DD.log   插件诊断日志（只给人看，不是记忆）
 *
 * ⚠️ 除 policy.md 外，运行时**不创建、不读取任何 .md 文件**。
 *    记忆全部存在 memory.db 的四张表里。
 *
 * ⚠️ 安全边界（2026-11-11 事故后的设计原则）
 *
 * 事件：工具 schema 里写了 `output.schema: { type: 'json' }`，被宿主拒绝；
 * 修复后仍触发上游 400「工具的参数结构不符合当前模型要求」，导致该 profile
 * 下**所有项目**的会话全部无法发出请求 —— 因为工具 schema 会拼进每一次模型
 * 请求，一个工具坏了就是全局故障。
 *
 * 因此本版本把风险面砍到最小：
 *   1. 永久不注册任何工具，只做注入与情绪捕获 ——
 *      这两者不进入模型请求 schema，坏不了会话。
 *   2. 配置里若还留着 `toolsEnabled`（旧版本字段），会被忽略并留一条诊断日志。
 *
 * 依赖面同样收窄：只硬依赖 systemPrompt。commands / webServer 全部
 * 用 ctx.inject 可选读取，缺失时对应能力自动退化，不会让整行插件不加载。
 */
import { mkdir, readFile, readdir, stat, writeFile, rename, unlink, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync, statSync, statfsSync, appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve, isAbsolute, basename, relative as relativePath } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// 数据库存储层（2026-11-13 起为主存储）。
// 放本地模块而不是依赖包：插件仍保持零第三方依赖。
import { createDbStore } from './db-store.mjs'
import { PERSONA_FORBIDDEN } from './db-store.mjs'
// 表名白名单（2026-11-16 第 7 条）：table 会从 HTTP body 传进来并拼进 SQL，
// 路由层提前校验一次，错误信息才能说清「哪个路由、收到什么值」。
import { assertTable } from './db-store.mjs'

/**
 * 插件自身的版本号（显示在 GUI 标题旁）。
 *
 * ⚠️ **单一真相来源是 `package.json`，不要在这里硬编码。**
 * 硬编码的版本号必然会在某次发版时忘记改 —— 界面上就会一直显示旧版本，
 * 而且没有任何报错。所以这里用 `import.meta.url` 反查包目录，
 * 读不到就返回空串（界面自然不显示，不会显示错的）。
 *
 * 为什么同步读：它只在模块加载时跑一次，且是几十字节的文件。
 */
const PACKAGE_VERSION = (() => {
  try {
    // 包目录 = 本文件所在目录。不用 createRequire('./package.json')，
    // 因为 exports 里虽然导出了 ./package.json，但走相对路径更直接、更少依赖。
    //
    // ⚠️ 必须用 fileURLToPath，不能用 new URL(...).pathname ——
    // pathname 是**百分号编码**的：路径含空格会变成 `%20`、含中文会变
    // `%E4%B8%AD`，拼出来的路径根本不存在 → readFileSync 抛 ENOENT →
    // 被下面的 catch 吞成空串 → 界面永远不显示版本号，且零报错。
    //   2026-11-16 实测：克隆到 `D:/我的 项目/` 时版本号静默变空。
    const here = dirname(fileURLToPath(import.meta.url))
    const raw = readFileSync(join(here, 'package.json'), 'utf8')
    // ⚠️ 这里刻意**不调用 parseJson()**：它定义在文件后半段（L431 附近），
    // 虽然函数声明会提升、实际能跑，但让模块顶部的常量依赖后面才出现的工具
    // 太脆弱了 —— 将来有人把它改成 const 箭头函数就会在加载期炸掉。
    // 只用 Node 内置的 JSON.parse 就够，这份文件是包作者自己写的，不会有 BOM。
    const pkg = JSON.parse(raw)
    return typeof pkg?.version === 'string' ? pkg.version : ''
  } catch {
    // 打包/校验环境下读不到是正常情况，静默降级为空串
    return ''
  }
})()

export const name = 'dsh-fatfishdream-memory'

/** 只硬依赖 systemPrompt。其余服务可选，缺失即退化。 */
export const inject = ['systemPrompt']

/**
 * 生产者自有的消息 source.kind。
 *
 * ⚠️ DSH 的 v4 消息格式要求 kind 形如 `plugin:<包名>` —— 一个带冒号的
 * 单字符串，而不是 `{ kind: 'plugin', plugin: '...' }` 这样的两字段结构。
 * 写错会让整个请求以
 *   `format v4 message requires a producer-owned source kind`
 * 失败，而且因为 turn-stopping 是 serial 事件，异常会直接中断本轮会话。
 *
 * 这个值抄自已安装且工作正常的 dsh-auto-handoff（`plugin:` + PLUGIN_ID）。
 */
const PLUGIN_SOURCE_KIND = 'plugin:dsh-fatfishdream-memory'

/**
 * 安全地往对话里插一条消息。
 *
 * 任何失败都必须被吞掉：注入一条提醒是锦上添花，
 * 绝不能因为它让用户的会话发不出请求 —— 这个教训付过两次代价。
 *
 * @returns 是否成功投递
 */
function safePushMessage(agent, text, method = 'steer') {
  try {
    const push = method === 'inject' ? agent?.inject : agent?.steer
    if (typeof push !== 'function') return false
    push.call(agent, {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: PLUGIN_SOURCE_KIND },
    })
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 配置

/**
 * 最近一次健康自检的结果。
 *
 * 为什么放在模块级：apply（注册点）和 createStore.overview（读状态）
 * 在两个不同的闭包里，只有模块级状态能让两边共享。
 *
 * 为什么需要它：logger 的输出在 DSH 桌面版里用户看不到（没有可访问的
 * console 日志目录）。所以自检结论必须落到用户真能看见的两处 ——
 * 日志文件的 [health-check-verdict] 行，以及设置页「大肥鱼的梦」面板。
 */
const healthState = {
  checked: false,
  ok: false,
  total: 0,
  failed: [],
  checkedAt: undefined,
  // 心跳（2026-11-16 22:35）：最近一次周期心跳的时间戳（epoch ms）。
  //
  // 与 `checkedAt` 的区别，**别混用**：
  //   checkedAt  = 健康**自检**跑完的时刻（只在 apply 后跑一次，或手动触发）
  //   lastBeat   = 周期**心跳**的时刻（每 5 分钟一次，不看任何状态就写）
  //
  // 为什么需要它：内存里有 `Date.now()` 在走，说明进程还活着 ——
  // 这是「进程存活度」这个维度里最便宜、最不会说谎的证据。
  // 它**不表示**记忆在正常写入（那是 writeFailStreak 的职责），
  // 也不表示代码没坏（那是回归测试的职责）。三者各读一个维度，不要互相顶替。
  lastBeat: undefined,
}

const DEFAULT_CONFIG = {
  root: '',
  // 注入预算（字节数，不是 token）。
  //
  // 这几个值被反复顶穿过：facts 300 → 1500，project 300 → 500 → 2048 → 4096。
  // （注：facts / project 是 .md 时代的计量单位，现在分别对应 profile+rules 与项目段，
  //   数值沿用是为了保留「预算总在临界点」这个教训。）
  // 规律是「项目一活跃，结论就长」，每次一小步地加，永远在临界点上。
  // 2026-11-11 一次性给足余量，代价与收益算清楚过：
  //
  //   factsBytes  8000 ≈ 76 条 ≈ 1778 token/轮
  //   policyBytes 8000 ≈ 76 条 ≈ 1778 token/轮
  //   projectBytes 4096 ≈ 39 条 ≈  910 token/轮
  //
  // 注意：这是**上限而非固定开销**。实际只按现有内容的字节数计费，
  // 内容少的时候花得少。所以给足上限不等于每轮多花这些 token。
  //
  // 但仍然保留「用量 N/M 字节」显示：内容真的堆到接近上限时，
  // 该精简的是文件（合并同类、标 [stale]），不是继续加预算 ——
  // 无限膨胀的上下文会稀释真正重要的内容。
  factsBytes: 8000,
  // 全局规则（policy.md「给模型的规则」小节）的注入上限。
  // 规则是「必须遵守的行为约定」而非事实，单独给预算避免互相挤占。
  policyBytes: 8000,
  projectBytes: 4096,
  consolidateDays: 7,
  logMonths: 3,
}

/**
 * 记忆目录名。盘符探测（第 3 级选址）与首次安装都按这个名字找/建。
 *
 * 2026-11-13 从 `FatFishDream-memory` 改成 `dsh-fatfishdream-memory`：
 * 跟着插件包名走，用户在自己的盘上能一眼认出这是哪个插件的数据目录。
 *
 * 为什么没保留旧名探测（`LEGACY_DIR_NAMES` 那套）：
 * 改名前确认过还没有对外发布、没有老用户，因此不存在「旧库突然读不到」的
 * 风险。**将来若真的要再改名，必须先加旧名探测** —— 否则老用户的记忆会
 * 看着像凭空消失（插件会新建一个空库），这比目录名不直观严重得多。
 *
 * 本机的记忆库仍留在 `D:\FatFishDream-memory` 没动：
 * 指针文件（~/.dsh/memory-root.json）优先级高于盘符探测，
 * 所以改常量不影响已有安装的实际位置。
 */
const MEMORY_DIR_NAME = 'dsh-fatfishdream-memory'
const PREFERRED_DRIVE = 'D'

// ---------------------------------------------------------------- 路径工具

function systemDriveLetter() {
  const raw = String(process.env.SystemDrive ?? 'C:').trim().toUpperCase()
  const letter = raw.slice(0, 1)
  return /^[A-Z]$/.test(letter) ? letter : 'C'
}

function isSystemDriveTarget(target) {
  const letter = String(target ?? '').trim().slice(0, 1).toUpperCase()
  return /^[A-Z]$/.test(letter) && letter === systemDriveLetter()
}

function expandRoot(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return resolve(DEFAULT_CONFIG.root || join(`${PREFERRED_DRIVE}:\\`, MEMORY_DIR_NAME))
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return resolve(homedir(), value.slice(2))
  return resolve(value)
}

/** 枚举非系统盘，D 优先，其余按剩余空间降序。 */
function listCandidateDrives() {
  const systemLetter = systemDriveLetter()
  const found = []
  for (let code = 68; code <= 90; code += 1) {
    const letter = String.fromCharCode(code)
    if (letter === systemLetter) continue
    const root = `${letter}:\\`
    try {
      if (!statSync(root).isDirectory()) continue
    } catch {
      continue
    }
    let free = 0
    try {
      const info = statfsSync(root)
      free = Number(info.bavail) * Number(info.bsize)
    } catch {
      free = 0
    }
    found.push({ letter, root, free })
  }
  found.sort((left, right) => {
    if (left.letter === PREFERRED_DRIVE) return -1
    if (right.letter === PREFERRED_DRIVE) return 1
    return right.free - left.free || left.letter.localeCompare(right.letter)
  })
  return found
}

function syncPathExists(path) {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/** 记忆目录的“指针”文件：放在 userData 侧，用来记住上次用的根目录。 */
const POINTER_FILE = '_root.json'

function pointerPath() {
  try {
    return join(homedir(), '.dsh', 'memory-root.json')
  } catch {
    return undefined
  }
}

/** 读取上次记录的根目录。指针只作提示，路径不存在时会被忽略。 */
function readPointer() {
  const path = pointerPath()
  if (path === undefined) return undefined
  try {
    const parsed = parseJson(readFileSync(path, 'utf8'))
    const root = typeof parsed?.root === 'string' ? parsed.root.trim() : ''
    return root === '' ? undefined : { root, savedAt: parsed?.savedAt ?? null }
  } catch {
    return undefined
  }
}

/** 记录当前根目录，供下次启动与多盘场景复用。 */
function writePointer(root) {
  const path = pointerPath()
  if (path === undefined) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const payload = JSON.stringify({ root, savedAt: new Date().toISOString() }, null, 2)
    writeFileSync(path, `${payload}\n`, 'utf8')
  } catch {
    /* 指针写不了不该影响插件 */
  }
}

/**
 * 系统盘上的兜底位置：`<用户文档>\<MEMORY_DIR_NAME>`（当前即 FatFishDream-memory）。
 *
 * 为什么不用 `C:\<MEMORY_DIR_NAME>`：
 *   系统盘根目录是最容易被清理工具、重装流程、磁盘清理向导丢掉的地方；
 *   而「文档」目录在系统重装、换机、迁移时通常会被用户备份或由工具带走
 *   （OneDrive 等同步客户端默认也会覆盖它）。记忆是纯文本，放进用户
 *   自己的文档里，用户能看见、能复制走、能一起备份 —— 这是最后一道防线。
 *
 * 取不到文档目录时退回用户主目录下的同名目录。
 *
 * ⚠️ 目录名一律走 MEMORY_DIR_NAME 常量，不要在代码或 UI 文案里写死。
 * 2026-11-11 踩过：常量改成 FatFishDream-memory 之后，设置页说明文字
 * 还写着「Documents\dsh-memory」，界面上显示的是旧名字。
 */
function systemFallbackRoot() {
  const home = homedir()
  const documents = join(home, 'Documents')
  try {
    if (statSync(documents).isDirectory()) return join(documents, MEMORY_DIR_NAME)
  } catch {
    /* 没有 Documents 目录（少见），落到下面的兜底 */
  }
  return join(home, MEMORY_DIR_NAME)
}

/**
 * 解析记忆根目录。四级优先，顺序是刻意设计的：
 *
 *   1. config 里写了明确路径
 *      用户在 patch 或设置页亲手指定的，最高优先级，不再做任何猜测。
 *
 *   2. 指针文件记录的路径（`~/.dsh/memory-root.json`）
 *      这是本插件上次实际使用的目录。它解决了「多块数据盘」的歧义：
 *      盘符探测可能同时命中 E:\<名称> 和 F:\<名称>，
 *      不知道哪个才是真的；指针记得清楚。
 *      指针里的路径不存在时（盘被拔掉、目录被删）自动跳过，不会卡死。
 *
 *   3. 已知盘上的同名目录（`<X>:\<MEMORY_DIR_NAME>`）
 *      兜底：老版本没有指针文件时的兼容路径。按 D 优先、其余按剩余空间
 *      降序探测，第一个含 state.json 或 memory.db 的胜出。
 *      系统盘上同时检查盘根的旧名目录和「文档\同名目录」两个位置，
 *      保证老安装能找到自己。
 *
 *   4. 首次安装选址
 *      优先 D 盘；没有 D 盘则选剩余空间最大的非系统盘；
 *      **一块数据盘都没有时，落到「文档\同名目录」而不是盘根**。
 *      选完立刻写入指针。
 */
function resolveRoot(rawRoot, log) {
  const explicit = String(rawRoot ?? '').trim()
  if (explicit !== '' && explicit.toLowerCase() !== 'auto') {
    const resolved = expandRoot(explicit)
    if (isSystemDriveTarget(resolved)) {
      log?.(
        `[dsh-memory] 记忆根目录在系统盘（${resolved}）。` +
          `系统重装或清理会丢失，建议用设置页迁到其他盘；也可以直接备份这个文件夹。`,
      )
    }
    writePointer(resolved)
    return { root: resolved, reason: 'configured' }
  }

  // 2. 指针：上次实际使用的目录
  const pointer = readPointer()
  if (pointer !== undefined) {
    const candidate = resolve(pointer.root)
    if (syncPathExists(join(candidate, 'state.json')) || syncPathExists(join(candidate, 'memory.db'))) {
      return { root: candidate, reason: 'pointer', savedAt: pointer.savedAt }
    }
    // 指针指向的路径已不可用（盘离线/目录被删），继续往下探测，不报错。
    log?.(`[dsh-memory] 记录的记忆目录已不可用（${pointer.root}），改从磁盘探测`)
  }

  // 3. 盘符探测：兼容没有指针的老安装
  const drives = listCandidateDrives()
  for (const drive of drives) {
    const candidate = join(drive.root, MEMORY_DIR_NAME)
    if (syncPathExists(join(candidate, 'state.json')) || syncPathExists(join(candidate, 'memory.db'))) {
      writePointer(candidate)
      return { root: candidate, reason: `discovered-on-${drive.letter}` }
    }
  }
  // 系统盘上的两个历史位置都要认，否则老用户的记忆会凭空消失。
  for (const candidate of [join(`${systemDriveLetter()}:\\`, MEMORY_DIR_NAME), systemFallbackRoot()]) {
    if (syncPathExists(join(candidate, 'state.json')) || syncPathExists(join(candidate, 'memory.db'))) {
      writePointer(candidate)
      return { root: candidate, reason: 'discovered-on-system' }
    }
  }

  // 4. 首次安装
  const chosen =
    drives.length > 0
      ? { root: join(drives[0].root, MEMORY_DIR_NAME), reason: `first-install-on-${drives[0].letter}` }
      : { root: systemFallbackRoot(), reason: 'first-install-system-fallback' }
  writePointer(chosen.root)
  if (drives.length === 0) {
    log?.(
      `[dsh-memory] 这台机器没有系统盘以外的可用磁盘，记忆落在「${chosen.root}」。` +
        `这是用户文档目录，系统重装时通常会被保留或随备份带走；` +
        `建议定期把这个文件夹复制到移动硬盘或云盘。`,
    )
  }
  return chosen
}

// ---------------------------------------------------------------- 通用工具

function pad(n) {
  return String(n).padStart(2, '0')
}

function localDay(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function daysBetween(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00`)
  const b = Date.parse(`${toDay}T00:00:00`)
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY
  return Math.round((b - a) / 86_400_000)
}

function projectNameOf(cwd) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return undefined
  const value = basename(resolve(cwd)).trim()
  return value === '' ? undefined : value
}

function slugify(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * 解析 JSON，容忍 UTF-8 BOM。
 *
 * Windows 上用记事本、PowerShell 的 Set-Content -Encoding UTF8、
 * 或一些编辑器保存 JSON 时会带上 BOM（U+FEFF）。原生 JSON.parse 遇到它会
 * 直接抛 SyntaxError，表现为「记忆突然读不到了」，但文件看起来完全正常。
 * 实测踩过一次：手动改 state.json 引入 BOM，导致 /memory search 全部未命中。
 *
 * 所有读取用户可编辑 JSON 的地方都必须走这里，而不是裸 JSON.parse。
 *
 * 关于 BOM 的形态（2026-11-16 实测确认，别再猜）：
 *   `Buffer.from([0xEF,0xBB,0xBF,...]).toString('utf8')` 的结果
 *   **首字符就是 U+FEFF**（Node 的 utf8 解码器会把它识别成 BOM 字符，
 *   不会留下 0xEF/0xBB/0xBF 三个独立字符）。
 *   所以只需判断 U+FEFF 一种形态 —— 不要为「字节层 BOM」再加分支，
 *   那是基于错误假设的补丁。
 */
function parseJson(text) {
  if (typeof text !== 'string') throw new TypeError('parseJson expects a string')
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return JSON.parse(cleaned)
}

function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8)
}

function isSafeSlug(slug) {
  return typeof slug === 'string' && slug !== '' && !/[\\/:*?"<>|]/.test(slug) && slug !== '.' && slug !== '..'
}

function isInside(root, target) {
  const rel = relativePath(root, target)
  // ⚠️ 判越界不能只看 rel 是否以两个点开头：`..backup`、`..config` 这类
  // **正常的子目录**也会那样开头，会被误判成「在 root 之外」。
  // 必须只在两个点**独立成段**时才算上跳（`..` 本身，或后接 `/`、`\`）。
  //   2026-11-16 实测：`isInside('D:/a', 'D:/a/..backup')` 旧写法返回 false（错）。
  return rel === '' || (!/^\.\.($|[\\/])/.test(rel) && !isAbsolute(rel))
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 消息去重键：`<sessionId>:<turn>:<step>`。
 *
 * ## 为什么单独抽成函数（2026-11-16）
 *
 * 原先是内联在 `session/event` 监听器里的两行模板字符串。那份实现
 * **无法黑盒验证** —— 要确认「键里有 sessionId」，得伪造两个会话消费
 * 相同的 `turn:step`，而脚本没有伪造 `session/event` 的手段；单会话测试里
 * `sid` 恒定，加不加前缀行为完全一样，那种测试会绿却证明不了任何事。
 *
 * 抽成顶层纯函数后，可以直接构造两个不同 session 调两次、断言键不等 ——
 * 见 `_dbpreview/selfcheck-message-key.mjs`。
 *
 * ## 键为什么必须带 sessionId
 *
 * `handledMessageIds` 是 apply 级**全局** Set。只按 `turn:step` 作键时，
 * 两个不同会话的同一 `turn:step` 会互相压制 —— 被撞的那条既不进 archive
 * （**原文永久丢失**）、也不解析标记，且**无任何日志**。
 *   2026-11-16 实测：全库 2858 条 assistant 只有 1884 个不同键；
 *   两个会话的 step 集合交集为空，其中一个会话的 assistant **一行都没有**。
 *
 * @param {{id?: unknown}|null|undefined} session 会话对象（只读 `.id`）
 * @param {{turn?: unknown, step?: unknown}|null|undefined} payload 事件 data
 * @returns {string} 去重键；缺字段一律降级为 `'?'`，绝不抛错
 */
function makeMessageKey(session, payload) {
  const id = session === null || session === undefined ? undefined : session.id
  const sid = id === undefined || id === null ? '?' : String(id)
  const turn = payload === null || payload === undefined ? undefined : payload.turn
  const step = payload === null || payload === undefined ? undefined : payload.step
  return `${sid}:${turn ?? '?'}:${step ?? '?'}`
}

/**
 * 按 UTF-8 字节上限截断，且保证不切断字符。
 *
 * ⚠️ 这里必须按**完整字符**边界回退。旧实现只跳过了末尾的续接字节，
 * 当截断点正好落在一个多字节字符中间时，那个残缺字符仍会留在结果里，
 * `toString('utf8')` 会把它变成 U+FFFD（`�`），写进记忆文件就是乱码。
 *
 * 实现要点：先把字节切成「字符序列」再累加，而不是在字节数组里做索引算术。
 * 后者容易把「起始字节位置」和「切片终点」混为一谈 —— 实测踩过，
 * 一个完整的 3 字节汉字会被整段丢掉。
 */
function truncateBytes(text, maxBytes) {
  if (byteLength(text) <= maxBytes) return { text, truncated: false }
  const limit = Math.max(0, maxBytes)

  let used = 0
  let cut = 0
  // Array.from 按码点切分，emoji（代理对）也是单个元素，不会被拆开
  for (const char of text) {
    const size = byteLength(char)
    if (used + size > limit) break
    used += size
    cut += char.length
  }

  const result = text.slice(0, cut)
  // 防御：理论上不会发生，但截断结果里出现替换字符就说明有 bug，宁可少给一点
  if (result.includes('\uFFFD')) {
    return { text: result.replace(/\uFFFD+$/u, ''), truncated: true }
  }
  return { text: result, truncated: true }
}

// ⚠️ 保留一份敏感信息模式表，但**当前没有任何调用点**（2026-11-15 确认）。
//
// 历史：原本配了 findSecret() 想用它扫描待写入的记忆，防止把 API key 存进库里。
// 但写入路径从没接上（从 1.0.0 首版起就是这样），findSecret 已删除。
//
// 为什么常量还留着：它记录的是「哪些形态算密钥」这个**知识**，不是一段逻辑。
// 将来真要在写入路径加脱敏，这张表可以直接用。
// 如果确定不再做这件事，连这张表一起删 —— 别让它变成下一个「孤儿常量」。
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{25,}\b/,
  /\bgh[pousr]_[0-9A-Za-z]{20,}\b/,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/,
]

/**
 * 读文件为**原始字节**，不存在返回 undefined。
 *
 * 与 readIfExists 的分工（2026-11-16 加，见 copyTree 的注释）：
 *   readIfExists  按 utf8 读 → 只用于**确定是文本**的文件（policy.md / state.json）
 *   readBytes     原样读 Buffer → 用于**可能是任意二进制**的文件（copyTree）
 *
 * ⚠️ 用 utf8 读二进制再写回会**永久损坏**文件：所有非 UTF-8 合法的字节序列
 * 都会变成 U+FFFD（EF BF BD），而且文件通常变大。实测 14 字节 PNG → 24 字节。
 * 这种损坏是不可逆的 —— 原字节序列已经丢在解码这一步了。
 */
async function readBytesIfExists(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 把临时文件搬成目标文件，**保证原文件不会因为搬失败而消失**。
 *
 * ## 2026-11-16 修：原来的 EPERM fallback 是个数据丢失窗口
 *
 * 旧代码（两个 write 函数都这么写）：
 *
 *     try { await rename(temp, path) }
 *     catch (error) {
 *       if (EEXIST || EPERM) {
 *         await unlink(path)        // ← 原文件在这一行就没了
 *         await rename(temp, path)  // ← 这一行再失败 = 永久丢失
 *         return
 *       }
 *       ...
 *     }
 *
 * 中间那行 `unlink` 之后，任何一步失败（磁盘满、杀毒软件锁文件、
 * 进程被结束、断电）都会让**原文件和新内容同时不存在**。
 * 受影响的是 `state.json`（项目映射）与 `policy.md`（用户手写的规则）。
 *
 * ## 现在的做法：先把原文件改名成 .bak，再搬临时文件
 *
 *     rename(temp, path) 失败
 *       → rename(path, bak)      原文件挪到旁边（同目录，原子操作）
 *       → rename(temp, path)     搬新内容
 *       → 失败则 rename(bak, path) 回滚，原文件完好
 *       → 成功则删掉 bak
 *
 * 关键区别：**原文件在任何时刻都有一份完整的副本存在**（要么在原位，
 * 要么在 .bak）。最坏情况是留下一个 `.bak` 文件，而不是文件消失。
 *
 * `rename` 在同一分区内是原子的（Windows 的 MoveFileEx 与 POSIX 的 rename(2)
 * 都保证），所以「原→bak」这一步本身不会产生半个文件。
 */
async function replaceFile(tempPath, targetPath) {
  try {
    await rename(tempPath, targetPath)
    return
  } catch (error) {
    if (!error || (error.code !== 'EEXIST' && error.code !== 'EPERM' && error.code !== 'EACCES')) {
      await unlink(tempPath).catch(() => {})
      throw error
    }
  }

  // 目标被占用（Windows 上很常见：另一个进程正开着它）。
  // 先把它挪到 .bak —— 而不是删掉它。
  const backupPath = `${targetPath}.${process.pid}.bak`
  try {
    await rename(targetPath, backupPath)
  } catch (error) {
    // 连挪都不行：放弃，保持目标文件原样，删掉临时文件
    await unlink(tempPath).catch(() => {})
    throw error
  }

  try {
    await rename(tempPath, targetPath)
    // 成功：原文件已无用了
    // （不需要 `if (moved)` —— 走到这里说明上面的 rename 已经成功，
    //   moved 恒为 true；原来那个判断是恒真的死代码，2026-11-16 复查时删掉）
    await unlink(backupPath).catch(() => {})
  } catch (error) {
    // ⚠️ 关键回滚：把原文件挪回原位，绝不留下「目标不存在」的状态
    try {
      await rename(backupPath, targetPath)
    } catch {
      // 回滚也失败了 —— 此时原文件仍完整躺在 backupPath，
      // 必须把路径告诉调用方，否则用户不知道去哪里找。
      throw new Error(
        `写入失败且回滚失败。原文件已保存在：${backupPath}` +
          `（新内容写入失败原因：${error?.message ?? error}）`,
      )
    }
    await unlink(tempPath).catch(() => {})
    throw error
  }
}

/**
 * 原子写**原始字节**。与 atomicWrite 同构，只是不做 utf8 编码。
 */
async function atomicWriteBytes(path, buffer) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, buffer)
  await replaceFile(temp, path)
}

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temp, content, 'utf8')
  // 2026-11-16：搬文件的逻辑抽到 replaceFile，两处共用。
  // 原来这里内联的 `unlink(path)` 是个数据丢失窗口，见 replaceFile 的注释。
  await replaceFile(temp, path)
}

/**
 * 递归复制目录内容，返回复制的文件数。
 *
 * 2026-11-13 修：不再在开头 `mkdir(to)`。
 *
 * 原先的实现一进来就建目标目录，于是**空目录也会被复制成一个空壳**。
 * 迁移时每个项目都会走一遍 copyTree，而数据库模式下项目目录里
 * 早就没有文件了（数据全在 memory.db 里）—— 结果新根里凭空多出
 * 一堆以项目名命名的空文件夹：干杂活 / design / ForzaOverlay ...
 * 用户看到会以为是"迁移出错了"。
 *
 * 改法：只有真的写入了文件才创建目录。这样空目录自然不产生任何东西。
 *
 * ## 2026-11-16：改成**二进制复制**（原来用 utf8 文本往返，会毁掉文件）
 *
 * 原实现是 `readIfExists(source)` + `atomicWrite(target, text)` ——
 * 两者都是 utf8。对文本文件没问题，但这个函数复制的是**用户目录下的任意文件**：
 * 图片、压缩包、图标、数据库副产物都可能在里面。
 *
 * 实测（14 字节 PNG）：读成 utf8 再写回 → **24 字节，内容全变**。
 * 所有非 UTF-8 合法的字节序列变成 U+FFFD，不可逆。
 *
 * 现在改为 `readBytesIfExists` + `atomicWriteBytes`，字节原样搬运。
 * 文本文件也走这条路径 —— 字节级复制对文本同样正确，而且更快（不做编解码）。
 *
 * ## 2026-11-16（第二次）：跳过 junction / 符号链接时要**说出来**
 *
 * `readdir(withFileTypes)` 对 junction 和符号链接返回的 Dirent 是
 * `isFile()=false` / `isDirectory()=false` / `isSymbolicLink()=true`。
 * 原来的 `if (isDirectory) … else if (isFile) …` 没有 else 分支，
 * 于是这类条目被**静默跳过** —— 迁移完文件凭空少了，日志里一个字都没有。
 *
 * 为什么选择「跳过」而不是「跟进去复制」：
 *   - 跟进去要先 `realpath`，而链接可能指向任意位置（甚至指回自己 → 无限递归）
 *   - 链接语义本身有歧义：用户可能是想「共享这个目录」，也可能是想「复制一份」，
 *     迁移时无法替用户决定
 *   - 记忆目录里出现链接是极少数情况（当前用户的实际目录里没有）
 *
 * 所以：**跳过，但把跳过的清单返回给调用方**，由上层写日志 / 报给用户。
 * 静默丢失是最难排查的失败形态 —— 这条的整个意义就是「不要静默」。
 *
 * @param {string} from
 * @param {string} to
 * @param {string[]} [skipped] 收集被跳过的条目路径（由调用方传入，跨递归累积）
 * @returns {Promise<number>} 复制的文件数（空目录返回 0，且不留痕迹）
 */
async function copyTree(from, to, skipped = []) {
  let entries
  try {
    entries = await readdir(from, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const entry of entries) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      // 子目录只在真有文件时才被创建 —— 递归内部会自己 mkdir
      count += await copyTree(source, target, skipped)
    } else if (entry.isFile()) {
      // ⚠️ 必须按**字节**读，不能按 utf8 —— 这里可能是任意二进制文件。
      const bytes = await readBytesIfExists(source)
      if (bytes !== undefined) {
        // 第一个文件落地时才建父目录（递归可能已建过，mkdir 幂等）
        await mkdir(to, { recursive: true })
        await atomicWriteBytes(target, bytes)
        count += 1
      }
    } else {
      // 既不是文件也不是目录：junction / 符号链接 / 设备文件 / FIFO 等。
      // 这些**不复制**，但必须记下来（见上方注释）。
      skipped.push(source)
    }
  }
  return count
}

/**
 * 安全复制一个 SQLite 库到目标路径。
 *
 * 为什么不直接用 copyFile：WAL 模式下库文件里可能还没有最近提交的数据
 * （它们躺在 -wal 里），单纯复制 .db 会漏数据；而把 -wal / -shm 一起复制
 * 又可能拿到不一致的组合。VACUUM INTO 由 SQLite 自己生成一致快照，
 * 且产出的是自包含的库（不带 -wal 依赖）。
 *
 * 前提：源库可被打开。调用方负责保证插件此时不会并发写坏它
 * —— 迁移是低频的用户主动操作，且 VACUUM INTO 是只读事务，风险可接受。
 *
 * @param {string} from - 源库路径
 * @param {string} to - 目标库路径（若已存在会被 VACUUM INTO 拒绝，先删掉）
 */
async function backupDbFile(from, to) {
  // VACUUM INTO 要求目标不存在
  await rm(to, { force: true }).catch(() => {})
  await rm(`${to}-wal`, { force: true }).catch(() => {})
  await rm(`${to}-shm`, { force: true }).catch(() => {})
  // 动态 import：node:sqlite 在插件加载早期可能还没被用到，
  // 放这里调用可以避免顶层 import 影响 host 启动。
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(from, { readOnly: true })
  try {
    // 路径里的单引号要转义，否则 SQL 语法会断
    db.exec(`VACUUM INTO '${String(to).replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }
}

/** 注入路径的同步读缓存（组装回调必须同步返回）。 */
const syncCache = new Map()

function readCached(path) {
  try {
    const info = statSync(path)
    const hit = syncCache.get(path)
    if (hit !== undefined && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.text
    const text = readFileSync(path, 'utf8')
    syncCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, text })
    return text
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      syncCache.delete(path)
      return undefined
    }
    throw error
  }
}

// ---------------------------------------------------------------- 模板

const POLICY_TEMPLATE = `# 记忆规则

## 给模型的规则


每轮遵守的行为约定。这一节会被注入所有项目的每一轮上下文。

- **写记忆只能用 HTTP 接口**：\`POST $env:DSH_WEB_URL/api/dsh-memory/log\`
  （参数见本文件末尾「流水必须带 topic 和 summary」）。
  **不要往回复正文里写任何标记** —— 标记一进正文，界面就会闪一下。
  绝不要用 \`write\` / \`edit\` / pwsh 去碰 \`memory.db\` ——
  那不是被拒绝，而是**损坏数据库**。
  **项目规则与用户画像由用户在 GUI 手工维护，模型不要写**（标记已移除）。
- **查记忆**：用 pwsh 请求本机接口，\`scope\` 必带（不传会返回 400）；
  先加 \`&summary=1\` 看摘要，确认相关再取全文（按 id 取单条：\`entry?id=<id>&table=<table>\`，table 用摘要里的字段）。
  完整查法（必查场景、端口、跨项目、不去重）见本文件末尾「怎么查记忆」。


## 强制录入：用户的情绪表达（不可关闭）
- 用户在对话里表达情绪时，插件自动把原话写入 emotion 表，不依赖模型判断。
- 覆盖六个簇：夸赞、吐槽、爱意、友善、喜悦、低落。
- 判定方式是情感词典打分，叠加否定、程度、转折三条语言学规则，输出连续置信分。
- **命中即录入**：词典命中的每一条都会进库，只标「强 / 弱」两档，不再按阈值丢弃。
  判错了可以回原文层（archive）追溯；判漏了就永远没了，所以宁可多记。
- 只认真人消息；代码块、行内代码、引号内被讨论的字样、URL 都不计入。
- 情绪记录不占常驻注入预算，**也不在检索池里**（只给用户自己在 GUI「情绪记录」页签看）。
  它是「个人兴趣记录」，不是可检索的知识；模型搜不到情绪不等于没记过。
- 自动推断可能出错，不应用作对用户性格的判断依据。

## 记什么

**模型能写的只有流水。** 其余三类由用户维护。

- 流水（logs 表）：做了什么、踩坑、验证结果。事实，不含判断。← **模型写这个**
- 项目规则（rules 表，scope=项目名）：本项目独有的约定、决策、架构、坑。一条一行。← 用户维护
- 用户画像（profile 表）：跨项目通用的事实与偏好，以及用户的处境。← 用户维护
- 情绪表达由插件自动录入 emotion 表，模型无需干预。

## 不记什么

**这一节只约束「进 rules / 画像的条目」，不约束流水。** 流水照常每轮写。

- 密钥值（记"去哪找"，不记值）。
- 会腐烂的当前状态：版本号、tip commit、测试数量 —— **不要写进 rules / 画像**
  （它们会被长期注入，写死的数字很快就会说谎）。
  > 流水里可以写「本轮 34/34 全绿」，因为流水是**带时间戳的过程记录**，
  > 它不注入、也不会被当成长期事实引用。这是两者的关键区别。
- 代码和 git 已经记录的内容。

## 怎么写（流水）
- 一条 = 一个结论，一行。
- 3~5 行，一行一个要点，不写解释。
- 同一件事改写旧条，不要新增重复条。

## 存储位置
- 记忆优先放在**非系统盘**（Windows 上 D 盘优先，其余按剩余空间选）；
  只有系统盘时落用户文档目录。macOS 建议用 \`~/.dsh\` 或自定义路径。
- 可用侧边栏面板随时整体迁移。

---

## 记忆使用说明

> **这一节不注入。** 需要写记忆时再来读这里。
> 注入里只保留了「不做就会出错」的几条动作；topic 分类、写法细节在这。

### 写入：本机 HTTP 接口（主通道）

**唯一正常路径。** 用 pwsh 发一次 POST：

\`\`\`powershell
Invoke-RestMethod -Method Post "$env:DSH_WEB_URL/api/dsh-memory/log" \`
  -ContentType 'application/json' \`
  -Body (@{
    text      = '正文'
    topic     = '开发日志'
    summary   = '≤35 字概述'
    keywords  = '词A｜词B'
    sessionId = $env:DSH_SESSION_ID
    cwd       = (Get-Location).Path
  } | ConvertTo-Json)
\`\`\`

| 参数 | 约束 |
|---|---|
| \`text\` | **必填**，为空返回 400 |
| \`topic\` | 13 个分类之一（下方清单）。不带或写错会被拒收置空，该条不进「记忆索引」 |
| \`summary\` | 一句话说清这条讲了什么，**≤35 字**；超出会截断 |
| \`keywords\` | 检索用技术名词，全角竖线 \`｜\` 分隔（**不要用逗号**）；抽不出就写 \`无\` |
| \`scope\` | 可省。省略时按 \`cwd\` 解析成项目名 |
| \`cwd\` | **目录必须真实存在**，否则 400（防止写错路径凭空造出假工作区） |
| \`sessionId\` | 建议传。不传则「本轮已写流水」不计入，连续未写提醒会误报 |

只接受 \`POST\`（写流水有副作用，GET 可能被浏览器预取重复触发）。

**为什么不用正文标记**：标记必须出现在回复正文里，而正文会在界面上被渲染 ——
不擦就永久占屏，擦就先显示后消失（闪）。换成 HTTP 后正文干净，两个问题一起消失，
而且标记不再留在会话上下文里（一条长标记约 300~600 token，按 10 轮算是几千 token 的纯开销）。

### 流水必须带 topic 和 summary

- **topic**：13 个分类之一（下方清单）。不带 topic 的流水不会进「记忆索引」，等于对以后的自己隐形。
- **summary**（2026-11-14 起）：一句话说清这条讲了什么，≤35 字。
  不写摘要的流水，检索时只能靠正文前 80 字截断兜底，经常截在句子中间、丢掉技术名词。
- **keywords**（2026-11-14 起）：检索用的技术名词，用全角竖线 \`｜\` 分隔（**不要用逗号**，
  逗号是中文正文的常用标点）。抽不出名词就写 \`无\`，不要硬凑 —— 硬凑只会污染检索。

**分类只用这 13 个**（别自创，否则索引会碎）：

\`\`\`
开发日志 / 技术讨论 / 构建/编译 / 注入/预算 / 插件/装载 / 路径/沙箱 /
格式/编码 / 文档/行号 / 情绪判据 / 用户画像 / 数据清理 / GUI/界面 / Git
\`\`\`

**开发日志 vs 技术讨论**（最容易混）：
- 开发日志 = 做了某事、有过程与验证（改了代码、跑了测试、踩了坑并解决）
- 技术讨论 = 还在权衡、没落成改动（用户提问、方案比较、认知澄清）

### 兜底通道：正文标记

**只在 HTTP 接口不可用时才用**（端口异常、接口报错）。

它直接写在**回复正文**里，所以会在界面上闪一下 —— 这是它的固有代价，不是 bug。
能走 HTTP 就不要用它。

\`\`\`
<!--mem-log topic=开发日志 summary=概述 keywords=词A｜词B
正文写在这里
-->
\`\`\`

写法：标记从**行首**开始，参数与 topic **同一行、顺序固定**
（\`topic\` → \`summary\` → \`keywords\`），之后换行写正文，用一个 \`-->\` 收尾。
**顺序写反**时后面的参数会被前一个整段吞掉（summary 会丢、keywords 被污染），别试。
**不要**写闭合标签（不存在 \`<!--/mem-log-->\` 这种东西）——写了它会变成正文的一部分，永久留在库里。
**正文不要写空行** —— 擦掉后每个空行会留一个空段，界面底部会空一块。

\`mem-note\` / \`mem-fact\` / \`mem-fix\` **已于 2026-11-13 移除**：
它们会往注入里自动写规则，而项目段预算只有 4096 字节、很快被顶满。
现在规则与画像一律由用户在 GUI 手工维护。

### 流水要短

**正文 ≤ 150 字，最多 5 行，一行一个要点，不写解释。**

为什么给死上限而不是「尽量短」：2026-11-16 实测，写成「3~5 行」时我连续十几轮
写到 400~900 字（一趟流水比正文还长）。**含糊的规则等于没有规则**，
所以这里给可执行的数字。

超了怎么办：把细节留在对话里 —— 用户已经看过一遍了。流水只记
「做了什么 / 发现什么 / 踩了什么坑」，不记推导过程。

流水是索引不是报告。写成大段说明会让用户每轮滚屏。

### 什么时候记

**每轮都记，不跳轮。** 不加判断条件 —— 任何判据都会变成省略的理由
（实测三种判据都导致漏记：只记技术价值 → 闲聊永远不满足，当天漏 12+ 轮）。

写什么：**对话本身就是有意义的事情，必须记录**。

**判成情绪不影响记流水 —— 两者是独立的通道。**
用户指出的问题、提出的需求、讲的做事偏好，**一律记流水**，即便那条消息同时
被判成情绪（emotion 表由插件自动写，与 logs 完全独立，互不排斥）。
典型漏记（2026-11-16 实报）：「你缺少实用的技能包」「你有可爱的手手只是用得少」
「走正规流程想想你刚才回复的是什么」—— 这些句子命中了情绪词典（宝贝 / 漂亮 / 想你），
于是只写了 emotion，技术内容一个字没留，下一个会话完全不知道用户提过这些。

卡住时：同一处试 2~3 次仍不对，停下来说「找不到规律，需要指方向」，
记一条流水说明当时无可靠依据 —— 这比记十条「我又错了」有用。

> **下面的「不要自己写进记忆」不是「这一轮可以不记」的例外** ——
> 它只约束**写到哪里**（别写进 rules/画像），流水照常要写。
> 记流水时把「用户确立了某条约定」这件事本身写进流水即可。

**确立了约定或发现用户的新偏好时，不要自己写进记忆** ——
告诉用户「这条适合记进项目规则 / 全局规则吗」，由他在 GUI 里决定。

### 人称

指用户写「用户」，指 AI 写「AI」，不要用「我」「你」。
（记忆的写者和读者都是 AI，但 GUI 里看它的是用户 —— 「我」会让人读错视角。）

### 预算

画像 8000 / 规则 8000 / 项目 4096 字节，均由用户在 GUI 维护。
看到「已截断」不要补写：内容仍在库里，只是本轮没注入。
流水不受此限制：它不注入，写多少都不会占预算。

### 怎么查记忆（2026-11-14 从「给模型的规则」移到这里）

> 这一节不进注入；注入里的版本见每轮上下文末尾的「记忆使用说明」。
> 放在这里是为了人查阅时能看到完整流程，同时不让同一段指引每轮付两遍 token。

- 只读本身没有风险，但注入里只有「有哪些主题、各多少条」，没有流水正文。
- **要查具体内容，用 pwsh 请求本机接口：**
  \`$env:DSH_WEB_URL/api/dsh-memory/search?q=<关键词>&scope=<当前项目名>\`（返回正文命中，可直接读）。
- **scope 必须带**，注入段里已给出本项目的真实名字，照抄即可；不传会返回 400。
- **用户点名其他项目时**（例：上次在「干杂活」做的），用 \`scope=<该项目名>\` 精确查，
  不要用 \`all=1\` 翻全库；项目名含中文或中英混编时，用 fetch 直接传原字（自动编码），
  用 curl 需先 URL 编码。项目名不确定就先问用户，不要猜。
- **必须先查、禁止凭上下文猜历史的情况：**
  - 工具调用报错且一次内无法定位原因
  - 连续两轮尝试没解决同一个问题
  - 用户提到「之前」「上次」「按我们的规范」
  - 需要确认项目约定、历史决策、踩过的坑
- 查法：先加 \`&summary=1\` 只看摘要（3 条约 100 token），确认相关再按 id 取全文：
  \`entry?id=<id>&table=<table>\`（\`table\` 用摘要里的字段；四张表 id 各自编号，只给 id 会取错表）。
  **命中多条相似时不要去重**：靠时间戳判断是「同一件事记两遍」还是「两个阶段」。
- **原文归档（2026-11-14 起）**：流水（logs）只存整理过的结论，没被整理的对话在
  \`archive\` 表里。要回溯「当时原话怎么说的」，用：
  \`$env:DSH_WEB_URL/api/dsh-memory/archive?scope=<当前项目名>&q=<关键词>\`，
  可选 \`role=user|assistant\`、\`from=\`/\`to=\`（YYYY-MM-DD）、\`limit\`/\`offset\`（默认 50，上限 500）。
  原文层**不进默认 \`/search\`**，所以用 search 查不到时不要断言「没有」——先想到 archive。
- **⚠️ 读原文层必须看 \`role\`，别把「我自己说的」当成「我们讨论过」**（2026-11-15 实盘踩过）：
  \`rows\` 每行都带 \`role\` 字段，\`user\` 是用户说的、\`assistant\` 是**你自己**说的。
  用户问「我们之前讨论过 X 吗」时，如果 archive 里只有 \`role=assistant\` 的大段回答、
  没有 \`role=user\` 的对应提问，**那不能答「我们讨论过」** —— 那是你单方面说过。
  要确认用户真的说过什么，**只认 \`role=user\` 的行**。
  同理，\`/search\` 命中的 \`logs\` 也是**你自己整理的结论**，
  拿它证明「讨论过 X」等于用自己写的话证明自己的结论 —— 那是自证，不是证据。
- **三个入口的返回字段名不一样**（2026-11-14 踩过，读错会得到 \`undefined\`，看着像"搜不到"）：

  | 入口 | 结果字段 | 备注 |
  |---|---|---|
  | \`/search\` | \`hits\` | 只搜结论层（流水/规则/画像） |
  | \`/archive\` | \`rows\` | 只搜原文层，分页 \`limit\`/\`offset\` |
  | \`/entries\` | \`entries\` | GUI 翻页用；**\`table\` 必填**，四张表 id 各自编号 |
  | \`/entry\` | \`entry\` | 按 id 取单条，必须带 \`table\` |
- 端口每次启动都变，**必须读 \`$env:DSH_WEB_URL\`，不要写死**。
- 不要用 grep / read / pwsh 直连 \`memory.db\`：它是 SQLite 二进制，
  grep 只会得到乱码，直连又容易误写成写操作。
- **真查过还是一无所获，才说「这段我没记住」**；不要没查就说，也不要猜、不要编。
`

// ---------------------------------------------------------------- 情绪分析

const STRONG_THRESHOLD = 0.62
const WEAK_THRESHOLD = 0.3

/**
 * 非情绪复合词：单字/短词被更大的中性词包住时不算情绪。
 *
 * 2026-11-14 实测两次误判（emotion #17、#20）：
 *   用户写「还需要**麻烦**你通过记忆系统去回忆一下」，
 *   单字词条「烦」命中「麻**烦**」→ 记成「用户表达吐槽（烦·0.80）」。
 *   同一模式在 #17 和 #20 各出现一次，都是正常的礼貌请求。
 *
 * 为什么不能只把「烦」删掉：真实表达里「好烦」「烦死了」仍要能识别。
 * 所以保留词条，改成**按出现的复合词排除**；并且扫描同一词的所有出现位置
 * （原来只取第一处，若第一处是「麻烦」会连后面真实的「好烦」一起漏掉）。
 *
 * 同类候选（按中文构词习惯补的，宁多勿漏；多排只会少记一条，不会记错）：
 *   - 烦：麻烦 / 烦请 / 烦劳（都是请托语气，不是抱怨）
 *   - 累：累积 / 积累 / 累计 / 累加 / 累进 / 累赘 / 拖累 / 连累 / 累及
 *   - 无语：无语义 / 无语言 / 无语法（技术文档里的「无语义」并不表示吐槽）
 */
const NON_EMOTION_COMPOUNDS = {
  烦: ['麻烦', '烦请', '烦劳'],
  累: ['累积', '积累', '累计', '累加', '累进', '累赘', '拖累', '连累', '累及'],
  无语: ['无语义', '无语言', '无语法'],
}

/**
 * 取出 word 在 text 里的**所有**出现位置（最多 limit 处）。
 *
 * 为什么不能只用 indexOf 一次：词的一个出现可能落在非情绪复合词里
 * （如「麻烦」），真实表达可能在其后（如「…但是好烦」），只看第一处会漏。
 */
function occurrencesOf(text, word, limit = 20) {
  const out = []
  if (word === '') return out
  let from = 0
  while (out.length < limit) {
    const at = text.indexOf(word, from)
    if (at === -1) break
    out.push(at)
    from = at + word.length
  }
  return out
}

/** 该位置的命中是否被包在「非情绪复合词」里 */
function inNonEmotionCompound(text, at, word) {
  const compounds = NON_EMOTION_COMPOUNDS[word]
  if (compounds === undefined) return false
  for (const compound of compounds) {
    for (const start of occurrencesOf(text, compound)) {
      if (at >= start && at + word.length <= start + compound.length) return true
    }
  }
  return false
}

const LEXICON = [
  // 爱意
  { cls: '爱意', i: 0.95, words: ['我爱你', '爱你哦', '爱你呀'] },
  { cls: '爱意', i: 0.9, words: ['喜欢', '最喜欢', '好喜欢', '只喜欢', '中意'] },
  { cls: '爱意', i: 0.85, words: ['想你', '想你了', '好想你', '想念你', '惦记你', '挂念你'] },
  { cls: '爱意', i: 0.85, words: ['抱抱', '亲亲', '么么', '贴贴', '蹭蹭'] },
  { cls: '爱意', i: 0.85, words: ['亲爱的', '宝贝', '乖乖', '小可爱', '心肝', '小笨蛋'] },
  { cls: '爱意', i: 0.85, words: ['心疼你', '舍不得你', '离不开你', '一直陪着你'] },
  { cls: '爱意', i: 0.8, words: ['眷恋', '着迷', '倾心', '钟情'] },
  // 夸赞
  { cls: '夸赞', i: 0.85, words: ['你真棒', '你太棒了', '你真好'] },
  { cls: '夸赞', i: 0.85, words: ['你太厉害了', '你好厉害', '你真厉害', '真厉害', '好厉害'] },
  { cls: '夸赞', i: 0.8, words: ['你太强了', '太强了', '太牛了', '牛啊', '厉害啊'] },
  { cls: '夸赞', i: 0.8, words: ['写得真好', '写得很好', '做得很好', '做得真好', '解释得很清楚'] },
  { cls: '夸赞', i: 0.8, words: ['很到位', '太到位了', '一针见血', '正中要害', '说到点子上'] },
  { cls: '夸赞', i: 0.8, words: ['正是我要的', '这就是我要的', '帮了大忙', '省了不少事'] },
  { cls: '夸赞', i: 0.8, words: ['比我想得好', '比我做得好', '比之前好多了'] },
  { cls: '夸赞', i: 0.7, words: ['很靠谱', '真靠谱', '很专业', '很优雅', '写得干净'] },
  { cls: '夸赞', i: 0.75, words: ['佩服', '钦佩', '崇拜', '敬仰', '自愧不如'] },
  { cls: '夸赞', i: 0.7, words: ['欣慰', '满足感', '为你高兴'] },
  { cls: '夸赞', i: 0.7, words: ['优秀啊', '做得好', '干得好'] },
  // 纯粹的形容词夸赞：不含「你」，靠词本身表达正面评价。
  // 之前只有「你+形容词」的组合，导致「你好可爱」「天下第一可爱」这类
  // 完全没有「你」字的夸赞被漏判 —— 实测踩过。
  { cls: '夸赞', i: 0.85, words: ['可爱', '好可爱', '真可爱', '太可爱', '可爱死'] },
  { cls: '夸赞', i: 0.85, words: ['天下第一', '最棒', '第一可爱', '最可爱'] },
  // 「好看」在技术语境里多半指 UI 外观（「界面好看吗」），不算情绪，故不收。
  { cls: '夸赞', i: 0.8, words: ['好美', '真美', '漂亮', '帅气', '好帅'] },
  { cls: '夸赞', i: 0.8, words: ['聪明', '机灵', '懂事', '贴心', '温柔', '善良'] },
  // 「有意思」也常描述技术特性（「正则匹配有意思」），强度压低到弱信号。
  { cls: '夸赞', i: 0.55, words: ['有意思'] },
  { cls: '夸赞', i: 0.75, words: ['有趣', '好玩'] },
  // 吐槽
  { cls: '吐槽', i: 0.9, words: ['你怎么这么笨', '你真笨', '你太蠢了', '真蠢', '太傻了'] },
  { cls: '吐槽', i: 0.85, words: ['又错了', '还是错了', '又搞错', '又忘了', '又漏了', '你怎么又'] },
  { cls: '吐槽', i: 0.85, words: ['答非所问', '文不对题', '不知所云', '胡说八道', '瞎说'] },
  { cls: '吐槽', i: 0.85, words: ['我说了好几遍', '说了多少遍', '讲了多少次', '强调过很多次'] },
  { cls: '吐槽', i: 0.8, words: ['能不能认真', '能不能仔细', '认真点行不行', '仔细看看'] },
  { cls: '吐槽', i: 0.9, words: ['越改越糟', '更糟了', '帮倒忙', '越弄越乱'] },
  { cls: '吐槽', i: 0.95, words: ['我服了', '无语', '我醉了', '麻了', '受够了', '真是够了'] },
  { cls: '吐槽', i: 0.8, words: ['别重复了', '不要再说', '别又这样', '别犯同样的错'] },
  { cls: '吐槽', i: 0.8, words: ['太啰嗦', '很啰嗦', '太冗长', '废话太多', '太敷衍', '敷衍了事'] },
  { cls: '吐槽', i: 0.8, words: ['恼火', '抓狂', '气死了', '火大', '烦', '烦躁', '烦人'] },
  { cls: '吐槽', i: 0.8, words: ['失望透顶', '简直了', '无话可说', '看不起', '不靠谱'] },
  { cls: '吐槽', i: 0.7, words: ['这个方案不行', '这个回答不行', '这样不行', '不太行'] },
  // 友善
  { cls: '友善', i: 0.85, words: ['谢谢你', '谢谢您', '感谢你', '感谢您', '多谢', '谢啦', '谢谢啦'] },
  { cls: '友善', i: 0.8, words: ['辛苦了', '辛苦啦', '麻烦你了', '麻烦您了', '受累'] },
  { cls: '友善', i: 0.85, words: ['有你真好', '还好有你', '幸亏有你', '多亏了你', '幸好有你'] },
  { cls: '友善', i: 0.75, words: ['加油啊', '加油！', '你可以的', '相信你', '支持你', '看好你', '挺你'] },
  { cls: '友善', i: 0.8, words: ['注意休息', '别太累', '别累着', '早点休息', '早点睡', '保重身体', '记得吃饭', '多喝水'] },
  { cls: '友善', i: 0.75, words: ['我懂你', '理解你', '懂你的意思', '放心交给你', '交给你了', '难为你了'] },
  { cls: '友善', i: 0.7, words: ['感激', '感激不尽', '信赖', '投缘', '相处舒服'] },
  // 喜悦
  { cls: '喜悦', i: 0.8, words: ['太好了', '太棒了', '好开心', '很开心', '开心死了', '太爽了'] },
  { cls: '喜悦', i: 0.8, words: ['终于搞定', '搞定了', '终于好了', '跑通了', '成功了', '终于成了'] },
  { cls: '喜悦', i: 0.75, words: ['完美！', '完美了', '太完美了'] },
  { cls: '喜悦', i: 0.7, words: ['有趣', '好笑', '逗乐', '开怀', '笑死'] },
  // 低落
  { cls: '低落', i: 0.85, words: ['难过', '不开心', '失落', '沮丧', '郁闷', '心烦', '委屈'] },
  { cls: '低落', i: 0.85, words: ['压力好大', '压力很大', '有点崩溃', '快崩溃', '要崩溃'] },
  { cls: '低落', i: 0.8, words: ['累', '疲惫', '撑不住', '熬不住', '扛不住'] },
  { cls: '低落', i: 0.8, words: ['失望', '心灰', '提不起劲', '打不起精神', '没动力'] },
]

const LEXICON_EN = [
  { cls: '爱意', i: 0.9, words: ['love you', 'i love', 'miss you', 'hug you', 'my dear', 'darling', 'sweetheart'] },
  { cls: '夸赞', i: 0.85, words: ["you're great", 'you are great', 'nice job', 'impressive', 'you nailed it', 'spot on'] },
  { cls: '吐槽', i: 0.85, words: ["that's wrong", "you're wrong", 'useless', 'terrible', 'awful', 'stop repeating'] },
  { cls: '友善', i: 0.8, words: ['thank you', 'thanks', 'appreciate it', 'good job', 'well done', 'proud of you', 'kudos'] },
  { cls: '喜悦', i: 0.8, words: ['awesome', 'amazing', 'excellent', 'brilliant', 'so happy'] },
  { cls: '低落', i: 0.8, words: ['feeling down', 'exhausted', 'stressed out', 'frustrated', 'burned out', 'so tired'] },
]

const EMOJI = [
  { cls: '爱意', i: 0.9, re: /[❤💕💖💗💓💞💘🥰😘🤗😍]/u },
  { cls: '夸赞', i: 0.8, re: /[👏👌💯🔥]/u },
  { cls: '吐槽', i: 0.85, re: /[😤😠😡🙄👎💢]/u },
  { cls: '喜悦', i: 0.75, re: /[🎉✨😆🤩]/u },
  { cls: '低落', i: 0.8, re: /[😔😞😢😭]/u },
  { cls: '友善', i: 0.7, re: /[😊😄🙏👍🤝😌]/u },
]

const NEGATIONS = ['不', '没', '别', '无', '未', '不要', '不是', '不算', '不怎么', '毫无']

const NON_NEGATION_PHRASES = [
  '非常', '不错', '不太', '不好意思', '没关系', '没事', '不错过',
  '别有', '无线', '无数', '无论', '未来', '无比', '无妨',
  '特别', '除非', '非但',
]

const INTENSIFIERS = [
  { words: ['太', '超', '非常', '特别', '极其', '巨', '贼', 'so', 'very'], factor: 1.5 },
  { words: ['真', '好', '很', '相当', '挺'], factor: 1.2 },
]

const DIMINISHERS = [
  { words: ['有点', '稍微', '略微', '些许', '几分'], factor: 0.6 },
  { words: ['还算', '勉强', '凑合'], factor: 0.5 },
  // 2026-11-15 加：「部分」「一半」「局部」这类**完成度**限定。
  //
  // 实测漏判：「部分搞定了，剩下的明天做」被判成 strong 喜悦（0.8）。
  // 「部分」在命中词**前面**，而原来的 DIMINISHERS 只有「稍微/有点」这类
  // **程度**词，没有**完成度**词 —— 二者的区别：
  //   程度轻微（有点开心）→ 情绪本身弱
  //   完成度部分（部分搞定）→ 事情本身没完成，谈不上喜悦
  // 后者更该降权，所以因子更低（0.45）。
  { words: ['部分', '一半', '局部', '大半'], factor: 0.45 },
]

const ADVERSATIVES = ['但是', '不过', '可是', '然而']

const MENTION_MARKERS = ['文案', '字样', '这两个字', '三个字', '这句话', '这个词', '变量名', '函数名', '字符串', '注释里']

/**
 * 元讨论标记：句子在描述「某句话/某条规则」本身，而不是在表达情绪。
 *
 * 为什么需要它（2026-11-11 实际误判）：
 *   用户说「之前我给另一个项目的 AGENTS.md 写入了一条怪规则，
 *   就是每次对话结束要加一句：你可爱的大肥鱼一直都在」
 *   这句话里的「可爱」是**引用规则内容**，不是夸赞。
 *   但「可爱」词条强度 0.85 直接命中，整段技术讨论被记成
 *   「用户表达夸赞（可爱·高置信·0.85）」，原话还是被截断的半句。
 *
 * 之前的 MENTION_MARKERS 只覆盖「紧接着」的元指称（如 可爱"这个词」），
 * 覆盖不到这种「整句都在讲规则/约定」的场景。
 *
 * 策略：这些词出现在句子里（或邻近 ±20 字符内），说明整句在谈"说法/规则"，
 * 情绪词大概率只是被引用的内容，按在讨论处理，跳过判定。
 */
const META_DISCUSSION_MARKERS = [
  '规则', '约定', '每次对话', '每次回复', '要加一句', '加一句', '固定一句',
  '写入', '记下来', '这句话', '那句话', '句子', '措辞', '原话', '文案',
  'AGENTS.md', 'policy.md', 'README.md', 'STORAGE.md', '标记', '注释',
  '重写', '修改一下', '改成', '全局记忆', '共享',
]

const WEAK_CUES = [
  { cue: '算了', i: 0.4 },
  { cue: '随便吧', i: 0.4 },
  { cue: '随你', i: 0.35 },
  { cue: '行吧', i: 0.35 },
  { cue: '也行', i: 0.3 },
  { cue: '无所谓', i: 0.4 },
  { cue: '呵呵', i: 0.45 },
  { cue: '……', i: 0.3 },
  { cue: '...', i: 0.3 },
  { cue: '唉', i: 0.4 },
  { cue: '好吧', i: 0.3 },
  { cue: '你说呢', i: 0.4 },
  { cue: '你看着办', i: 0.45 },
]

/** 反讽标记词：出现在句子里时，「正面词」的可信度大幅下降。 */
const IRONY_MARKERS = [
  '可真', '倒是', '真好意思', '真会', '真行', '呵呵', '真棒呢', '厉害了呢',
  '好得很', '谢谢啊', '谢了啊', '真贴心', '真周到', '辛苦了呢', '真是辛苦',
]

/** 负面语境词：和正面词共现时，提示可能是在反讽。 */
const NEGATIVE_CONTEXT = [
  // 工作场景里的负面事件
  '加班', '重做', '返工', '白干', '白忙', '催', '投诉', '罚款', '背锅',
  '周六', '周日', '半夜', '凌晨',
  // 问题复现
  '又出', '又坏', '又错', '又给', '又来了', '又崩', '又挂', '又炸',
  '崩溃', '卡死', '报错', '失败', '挂了', '炸了', 'bug',
]

/**
 * 宽松的正面字面词表，**专供反讽判断**，不参与情绪分类。
 *
 * 为什么不复用情绪词典：反讽句里的正面词往往是裸词（「开心」「真棒」），
 * 而情绪词典收的是组合形式（「很开心」「你真棒」）—— 用词典会漏掉大部分反讽。
 * 这里宁可宽松，因为它的唯一用途是「检查字面和负面语境是否错位」。
 */
const POSITIVE_SURFACE = [
  '开心', '高兴', '棒', '好得', '厉害', '优秀', '完美', '满意', '舒坦',
  '谢谢', '感谢', '辛苦', '贴心', '周到', '会安排', '真行', '真好',
]

/**
 * 反讽检测（规则版，只覆盖字面特征明显的 case）。
 *
 * 依据 CUE-Bench 的「显式-隐式立场矩阵」思路：当**显式正面**和
 * **隐含负面**同时出现时，实际立场是 Sarcastic Negative（反讽）。
 *
 * ⚠️ 这里不依赖词典命中的「正面词」。
 * 实测教训：反讽句里的正面词常常是裸词（「开心」「真棒」），而词典里
 * 存的是组合形式（「很开心」「你真棒」），命中不了。若要求先有 positiveHits
 * 才判反讽，就会出现「明明有反讽标记却检测不到」的盲区。
 *
 * 规则能识别两种可观察信号，任一成立即判反讽：
 *   1. 句中出现反讽标记词（可真 / 倒是 / 呵呵 / 谢谢啊 / 好得很）
 *   2. 句中出现负面语境词（周六 / 加班 / 又崩了）且同时有正面字面词
 *
 * 更深的反讽（客套、压抑、委婉否定）需要语义理解，规则做不到 ——
 * 那部分交给对话中的模型判断，不在这里硬猜。
 *
 * @returns {boolean} 疑似反讽
 */
function looksIronic(text) {
  // 信号 1：反讽标记词。这类词本身就带着「说的和想的不一样」的意味，
  // 单独出现即可判定，不需要再找正面词。
  if (IRONY_MARKERS.some((marker) => text.includes(marker))) return true

  // 信号 2：负面语境词 + 正面字面词共现。
  // 这里用一份宽松的正面字面词表，专门用于反讽判断 ——
  // 不复用情绪词典，避免受「组合词 vs 裸词」的影响。
  const hasNegativeContext = NEGATIVE_CONTEXT.some((word) => text.includes(word))
  if (!hasNegativeContext) return false
  return POSITIVE_SURFACE.some((word) => text.includes(word))
}

/**
 * 清洗文本：剥离代码、URL，以及「被讨论的词」。
 *
 * 引号的处理是这里最微妙的地方。中文里双引号既用于强调真实表达
 * （我那句"谢谢你"没落盘），也用于引用一个被讨论的词
 * （把"我爱你"的文案改一下）。一律剥离会漏掉前者 ——
 * 实测就漏掉过一次真实致谢。
 *
 * 现在的规则：引号内容只有在**紧跟元指称标记**（文案/这个词/字样…）
 * 或本身很短（≤6 字）且是纯词语时才剥离；否则保留，按正常表达参与判定。
 */
function stripNoise(text) {
  const fence = String.fromCharCode(96, 96, 96)
  const tick = String.fromCharCode(96)
  let out = text
    .split(fence).filter((_, index) => index % 2 === 0).join(' ')
    .split(tick).filter((_, index) => index % 2 === 0).join(' ')
    .replace(/https?:\/\/\S+/giu, ' ')

  // 逐类引号处理：只在"明显是在讨论这个词"时才剥掉。
  const quotePairs = [
    [/"/gu, /"/gu],
    [/「/gu, /」/gu],
    [/《/gu, /》/gu],
    [/\u201c/gu, /\u201d/gu],
    [/\u2018/gu, /\u2019/gu],
  ]
  for (const [open, close] of quotePairs) {
    out = out.replace(
      new RegExp(`(${open.source})([^\\n]{1,40})(${close.source})`, 'gu'),
      (whole, _o, inner, _c, offset) => {
        const after = out.slice(offset + whole.length, offset + whole.length + 8)
        // 紧跟元指称标记 → 是在讨论这个词
        if (MENTION_MARKERS.some((marker) => after.includes(marker))) return ' '
        // 很短且像术语（无空格无标点）→ 也按被讨论处理
        const trimmed = inner.trim()
        if (trimmed.length <= 6 && !/[\s，。！？、；：,.!?;:]/u.test(trimmed)) return ' '
        // 否则保留内容参与判定
        return ` ${trimmed} `
      },
    )
  }
  return out.trim()
}

function negatedBefore(text, pos, window = 3) {
  const slice = text.slice(Math.max(0, pos - window), pos)
  if (slice === '') return false
  let cleaned = slice
  for (const phrase of NON_NEGATION_PHRASES) cleaned = cleaned.split(phrase).join('')
  if (cleaned === '') return false
  return NEGATIONS.some((word) => cleaned.includes(word))
}

function modifierBefore(text, pos, window = 3) {
  const slice = text.slice(Math.max(0, pos - window), pos)
  for (const group of DIMINISHERS) {
    if (group.words.some((word) => slice.includes(word))) return group.factor
  }
  for (const group of INTENSIFIERS) {
    if (group.words.some((word) => slice.includes(word))) return group.factor
  }
  return 1
}

/**
 * 词条**后面**的限定词：`成功了一半`、`对了三分之一`、`开心了一点点`。
 *
 * 为什么单独一个函数、而不是并进 modifierBefore（2026-11-15 实修）：
 *   `modifierBefore` 只看命中词**前面** 3 个字符。而中文的削弱语
 *   大量出现在**后面** —— 「成功了一半」的「一半」、「开心一点」的「一点」。
 *   只看前面 = 这类句子永远按满强度记。
 *
 * 实测事故（情绪 #29）：
 *   用户原话「…能够影响你怎么看待这些代码，就已经**成功了一半**，如何看懂代码是另一回事。」
 *   词典词是「成功了」（喜悦 0.8）。而「成功了一半」里**含有**「成功了」这个子串
 *   （成 功 了 一 半），于是 indexOf 命中，按 0.8 记成「高置信喜悦」。
 *   但那是一句**方法论陈述**，「一半」明确表示未完成，不是喜悦表达。
 *
 * 为什么不能靠「换个更长的词」解决：
 *   「成功了一半」不是固定搭配，「对了一半」「猜对了一半」都会出现。
 *   要治的是**结构**：命中词后紧跟表示「部分/未完成」的限定成分 → 整体降权。
 *
 * 与 modifierBefore 的差异：
 *   - 只看紧跟其后的字（不跨标点），因为限定词必须直接修饰该词；
 *   - 因子更狠（0.45），因为「部分达成」离「情绪表达」比「程度轻微」更远；
 *   - **只降不升**：后面出现「很/太」之类的加强词不让它变强
 *     （「成功了很激动」里，加强的是后面的「激动」，不是「成功了」）。
 */
const POST_LIMITERS = [
  // 「一半」「三分之一」「几分之一」这类分数表达
  { re: /^(了)?(一|半|三|四|几)?(半|分|成|部|些)|^之[一二三]/u, factor: 0.45 },
  // 「一点」「一些」「一下」「有一定」
  { re: /^(了)?(一)?(点|些|下|部分|局部)/u, factor: 0.5 },
]

/**
 * 命中词后紧跟的限定成分带来的降权因子。
 * @returns {number} 没有限定词时返回 1（不影响原分数）
 */
function limiterAfter(text, end) {
  const tail = text.slice(end, end + 4)
  if (tail === '') return 1
  for (const group of POST_LIMITERS) {
    if (group.re.test(tail)) return group.factor
  }
  return 1
}

/**
 * 词条基础强度 × 程度修饰，并做上限钳制。
 *
 * ⚠️ 为什么需要钳制：弱信号词（基础强度 < STRONG_THRESHOLD）被程度副词放大后，
 * 可能越过强信号阈值，被当成确定的情绪记下来。
 *
 * 实测踩过：用户说「这是中文里一个很有意思的地方」——「有意思」基础强度 0.55
 * 本是弱信号，但前一个「很」字乘 1.2 得 0.66，刚过 0.62 阈值，
 * 于是被记成「用户表达夸赞（有意思·高置信·0.66）」。那只是描述一个话题有趣，
 * 不是对助手表达情绪 —— 属于误记。
 *
 * 规则：基础强度本身就是弱的（< STRONG_THRESHOLD），无论怎么修饰都封顶在
 * 强阈值之下，让它保持「弱信号」身份，进待判队列而不是直接落盘。
 * 反过来，基础强度够强的词（如「好可爱」1.0）正常放大，不受影响。
 */
function capScore(baseIntensity, modifier) {
  const scored = Math.min(1, baseIntensity * modifier)
  if (baseIntensity < STRONG_THRESHOLD) {
    // 留一点余量，确保严格低于强阈值，不会因浮点误差越界
    return Math.min(scored, STRONG_THRESHOLD - 0.01)
  }
  return scored
}

function splitByAdversative(text) {
  let cut = -1
  for (const word of ADVERSATIVES) {
    const at = text.indexOf(word)
    if (at > 0 && (cut === -1 || at < cut)) cut = at
  }
  if (cut === -1) return [{ text, weight: 1 }]
  return [
    { text: text.slice(0, cut), weight: 0.8 },
    { text: text.slice(cut), weight: 1.4 },
  ]
}

/**
 * 分析情绪。返回连续置信分而非离散标签。
 * @returns {{hits: Array<{cls: string, score: number, evidence: string}>,
 *   strong: boolean, weak: boolean, candidates: string[], weakCue: string[]}}
 */
function analyzeEmotion(raw) {
  const empty = { hits: [], strong: false, weak: false, candidates: [], weakCue: [], ironic: false }
  if (typeof raw !== 'string' || raw.trim() === '') return empty

  // 整体跳过：消息里在粘贴/引用记忆系统的自身产物。
  //
  // 2026-11-11 实测误判：用户把记忆里的几行贴出来讨论
  //   「目前有语句判断多次错误的 你看看：
  //    - [active] 2026-11-11 用户表达夸赞（可爱·高置信·0.85）：…」
  // 这整段是**引用历史记录**，但其中「可爱」命中词条强度 0.85，
  // 于是又生成了一条新的「用户表达夸赞（可爱·0.85）」，原话还是那行引用。
  // 结果是：讨论误判本身造成了新的误判，越滚越多。
  //
  // 特征很明确 —— 这类消息里带着记忆行格式（`- [active]` / `- [stale]`）
  // 或情绪行格式（`用户表达…（…高置信…）`）。整条消息都是引用时，
  // 里面的情绪词一律不参与判定。
  const looksLikeMemoryDump =
    /^\s*[-*]\s*\[(active|stale|superseded)\]/mu.test(raw) ||
    /用户表达[^\n]{0,20}（[^）]{0,40}置信/u.test(raw)
  if (looksLikeMemoryDump) return empty

  const text = stripNoise(raw)
  if (text === '') return empty

  const best = new Map()
  const record = (cls, score, evidence) => {
    const previous = best.get(cls)
    if (previous === undefined || score > previous.score) best.set(cls, { cls, score, evidence })
  }

  for (const entry of LEXICON) {
    for (const word of entry.words) {
      // 2026-11-14：改成扫描**所有**出现位置（原来是 indexOf 一次）。
      // 理由见 NON_EMOTION_COMPOUNDS 的注释：第一处可能被「麻烦/积累」包住，
      // 而后面还可能有一次真实表达。
      for (const at of occurrencesOf(text, word)) {
        // 单字词被中性复合词包住时不算情绪（麻烦≠烦、积累≠累、无语义≠无语）
        if (inNonEmotionCompound(text, at, word)) continue
        const context = text.slice(Math.max(0, at - 6), at + word.length + 6)
        if (MENTION_MARKERS.some((marker) => context.includes(marker))) continue

        // 元讨论过滤：整句在讲"规则/约定/该怎么写"时，情绪词只是被引用的内容。
        // 取命中词前后 ±40 字符作窗口，覆盖「…要加一句：你可爱的大肥鱼…」这种
        // 情绪词在句末、元讨论特征在句首的情况。
        const wideContext = text.slice(Math.max(0, at - 40), Math.min(text.length, at + word.length + 40))
        if (META_DISCUSSION_MARKERS.some((marker) => wideContext.includes(marker))) continue

        // 引用特征：命中词紧跟着「的」且句末是标点，常见于「你可爱的大肥鱼」这类
        // 被当作固定说法/名字引用的片段。仅对「可爱」这类高误判词生效，
        // 不影响「你太可爱了」这种真实夸赞（后面跟的是「了」不是「的」）。
        if (/^可爱$/.test(word) && /^的/u.test(text.slice(at + word.length, at + word.length + 1))) {
          continue
        }

        const modifier = modifierBefore(text, at)
        // 后置限定词（「成功了一半」的「一半」）与前置程度副词相乘。
        // 必须在 capScore 之前乘进去：capScore 会用**基础强度**判断它算不算弱信号，
        // 若在它之后再乘，0.8×0.45=0.36 仍会被当成「基础强度 0.8 的强信号」。
        const limiter = limiterAfter(text, at + word.length)
        const isFixedNegative = NEGATIONS.some((neg) => word.startsWith(neg))
        if (isFixedNegative) {
          record(entry.cls, capScore(entry.i, modifier * limiter), word)
          continue
        }
        if (negatedBefore(text, at)) {
          record(entry.cls, Math.min(1, entry.i * modifier * limiter * 0.35), `不${word}`)
          continue
        }
        record(entry.cls, capScore(entry.i, modifier * limiter), word)
      }
    }
  }

  const lower = text.toLowerCase()
  for (const entry of LEXICON_EN) {
    for (const word of entry.words) {
      const at = lower.indexOf(word)
      if (at === -1) continue
      if (negatedBefore(lower, at, 6)) continue
      record(entry.cls, Math.min(1, entry.i * modifierBefore(lower, at, 6)), word)    }
  }

  for (const entry of EMOJI) {
    const match = entry.re.exec(text)
    if (match !== null) record(entry.cls, entry.i, match[0])
  }

  const segments = splitByAdversative(text)
  if (segments.length > 1) {
    for (const [cls, hit] of best) {
      const plain = hit.evidence.replace(/^不/, '')
      for (let i = 1; i < segments.length; i += 1) {
        if (segments[i].text.includes(plain)) {
          best.set(cls, { ...hit, score: Math.min(1, hit.score * segments[i].weight) })
        }
      }
    }
  }

  const hits = [...best.values()].sort((left, right) => right.score - left.score)
  const weakCueHits = WEAK_CUES.filter((entry) => text.includes(entry.cue)).map((entry) => entry.cue)

  // 反讽修正：先独立判断是否反讽，再把正面翻转成吐槽。
  //
  // 依据 CUE-Bench 的显式-隐式立场矩阵：显式正面 + 隐含负面 = 反讽。
  // 「你可真会安排，周六开会最让人开心了」这类句子，靠词面只会抓到「开心」，
  // 判成喜悦 —— 那是完全相反的意思。
  //
  // 注意：反讽判断独立于 hits，因为它要处理「正面词没被词典命中」的情况。
  const ironic = looksIronic(text)
  if (ironic) {
    // 清掉所有正面判定，换成一条吐槽
    for (const cls of ['喜悦', '夸赞', '友善', '爱意']) best.delete(cls)
    const existing = best.get('吐槽')
    const ironicScore = 0.8
    if (existing === undefined || existing.score < ironicScore) {
      best.set('吐槽', { cls: '吐槽', score: ironicScore, evidence: '反讽' })
    }
  }

  const finalHits = [...best.values()].sort((left, right) => right.score - left.score)

  if (finalHits.length === 0) {
    if (weakCueHits.length === 0) return { ...empty, ironic }
    const cueScore = Math.max(...WEAK_CUES.filter((e) => text.includes(e.cue)).map((e) => e.i))
    return { hits: [], strong: false, weak: cueScore >= WEAK_THRESHOLD, candidates: [], weakCue: weakCueHits, ironic }
  }

  const strong = finalHits.some((hit) => hit.score >= STRONG_THRESHOLD)
  const weakHits = finalHits.filter((hit) => hit.score >= WEAK_THRESHOLD)
  return {
    hits: finalHits,
    strong,
    weak: !strong && (weakHits.length > 0 || weakCueHits.length > 0),
    candidates: weakHits.map((hit) => hit.cls),
    weakCue: weakCueHits,
    ironic,
  }
}

// ---------------------------------------------------------------- 存储

/**
 * 记忆存储。
 *
 * root 可变：迁移根目录之后，内存里的 root、paths 以及所有派生路径立即切换，
 * 后续的注入读取与写入都指向新位置，不需要重启。
 *
 * 项目文件夹的归属规则：
 *   - state.projects[key].dir 缺省 → 视为「跟随根目录」，落在 <root>/<key>
 *   - 显式设置过 dir（用 moveProject 单独搬过）→ 那个绝对路径
 * 迁移根目录时，「跟随根目录」的项目自动落到新根下；单独搬过的不动。
 * 但用 relocateAll=true 可以强制全部收回新根（GUI 的「整体迁移」用这个）。
 */
export function createStore(config) {
  let root = config.root
  // resolveRoot 给出的选址理由，原样保存供 /state 与诊断使用。
  // 它不是运行时可变状态：迁移根目录（migrateRoot）不改变「当初怎么选中的」，
  // 所以这里用普通变量而非跟随 setRoot 更新。
  let rootReason = config.rootReason ?? null

  /** 所有依赖 root 的路径都从这一处派生，迁移后重新计算即可。 */
  const computePaths = () => ({
    policy: join(root, 'policy.md'),
    state: join(root, 'state.json'),
    // 覆盖 policy.md 前备份到这里的旧文件（数据安全网，见 syncPolicyOnce 注释）
    policyBackup: join(root, 'policy.md.pre-sync'),
  })
  let paths = computePaths()

  /** 根目录切换：更新 root 与全部派生路径。 */
  function setRoot(nextRoot) {
    root = nextRoot
    paths = computePaths()
  }

  const defaultProjectDir = (key) => join(root, key)
  const projectDir = (key, state) => state?.projects?.[key]?.dir ?? defaultProjectDir(key)
  // 2026-11-13 移除 projectLogDir / logPath：
  // 它们是 .md 时代的产物（拼 <项目>/log/YYYY-MM.md），
  // 剥离后流水只存 logs 表，这两个函数已无任何调用方。

  let writeQueue = Promise.resolve()
  function serialize(task) {
    const run = writeQueue.then(() => task())
    writeQueue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * 建目录与初始文件。
   *
   * 只预建 `policy.md`（行为规则，不进数据库）。
   * 别的记忆全部存在 memory.db 里，由数据库层自己创建。
   *
   * ⚠️ 曾写「policy.md 仍然双模式都需要」。双模式（文件 / 数据库）已不存在，
   *    现在只有一种存储；policy.md 是唯一的例外，因为它不进数据库。
   *
   * 判据传参而不是自己读全局状态：createStore 在 apply 里比 dbStore 先创建，
   * 这里拿不到 dbStoreExists()，只能由调用方按当前模式告知。
   */
  /**
   * **一次性**把 policy.md 覆盖为当前模板（2026-11-16，用户明确授权）。
   *
   * ## 为什么允许这一次（硬约束 9 的唯一例外）
   *
   * 硬约束 9 说「policy.md 是用户数据，不要改」。2026-11-16 用户明确指示：
   * **「新安装的用户和老用户 本次更新直接覆盖 policy.md」** ——
   * 因为写入通道从「正文标记」换成 HTTP 接口，旧 policy.md 里写着完全相反的
   * 指令（「写记忆只能用回复正文里的 mem-log 标记」），那条会每轮注入、
   * 把模型拽回旧行为。只改模板对新装用户生效，老用户永远读不到。
   *
   * 所以这是**用户授权的一次性迁移**，不是「以后可以随便改」。
   *
   * ## 怎么保证「只一次」
   *
   * 用两个哨兵，任一命中就跳过：
   *   ① `state.policySyncVersion === POLICY_SYNC_VERSION` —— 已经同步过
   *   ② policy.md 里已含 `POLICY_SYNC_MARK` —— 文件本身已是最新
   *
   * 为什么需要 ②：用户可能删 state.json（或换机器复制了 policy.md 但没带 state）。
   * 只看 state 会「以为没同步过」→ 把用户又改过的文件覆盖掉。
   * 有 ② 才能保证「这个文件已经是新版」就绝不碰。
   *
   * ## v2（2026-11-17）：模板换成用户自己维护的那份完整规则
   *
   * 用户指示：**「把我们目前的记忆目录中的 policy.md 作为通用模板写入新用户预设，
   * 仅覆盖一次即可」**。所以 v2 的模板 = 用户 policy.md 的全文（233 行），
   * 不再是那份精简版。好处是新用户开箱就有一份完整、经实战打磨的规则。
   *
   * ⚠️ 两个常量必须同时改：只改 VERSION 不改 MARK 的话，哨兵②会用**旧标记**
   * 命中用户的旧文件 → 判定「已是最新」→ 覆盖永不发生（静默失效）。
   * ⚠️ 用户说过：**这个版本推送后会让把覆盖命令注释掉**。到那时改这里即可，
   * 不要顺手删掉备份与收尾语恢复逻辑 —— 它们仍是数据安全网。
   */
  const POLICY_SYNC_VERSION = 2
  const POLICY_SYNC_MARK = '<!-- policy-sync:2 -->'

  async function syncPolicyOnce(state) {
    if (state?.policySyncVersion === POLICY_SYNC_VERSION) return { skipped: 'state' }
    const current = await readIfExists(paths.policy)
    if (current !== undefined && current.includes(POLICY_SYNC_MARK)) {
      // 文件已是最新，只是 state 丢了 —— 补记 state，不再动文件
      return { skipped: 'marked' }
    }
    const beforeBytes = current === undefined ? 0 : Buffer.byteLength(current, 'utf8')

    // ★ 覆盖前先备份旧文件（数据安全网）。
    //
    // 为什么必须有这一步：覆盖是**不可逆**的，而旧 policy.md 里可能有用户
    // 手写过、但模板里没有的内容（典型是「每轮收尾语」）。2026-11-16 实测
    // 覆盖后收尾语与手写段落**全部丢失**，且当时根目录里没有任何备份可捞。
    //
    // 备份文件写为 `policy.md.pre-sync`，只在「确实要覆盖」时产生 ——
    // 已经同步过（哨兵命中）就绝不写，避免每次启动都留一份冗余备份。
    //
    // 但「全新安装」这一种情况要跳过备份：ensureLayout 刚预建了 POLICY_TEMPLATE，
    // 这个「旧文件」其实是模板本体（没有任何用户内容），备份它纯属冗余。
    // 判据：当前文件与模板逐字节相同 → 视为全新预建，不备份。
    const isFreshTemplate = current !== undefined && current.trim() === POLICY_TEMPLATE.trim()
    if (current !== undefined && !isFreshTemplate) {
      await atomicWrite(paths.policyBackup, current)
    }

    // 覆盖前从旧文件里提取「每轮收尾语」，覆盖后再写回 —— 因为收尾语
    // 是用户的私人偏好（硬约束 9 明说模板不能夹带本机个人偏好），模板里
    // 已经**没有**这行了，不写回的话用户升级后收尾语就永久消失。
    const oldHeartbeat = current === undefined ? '' : extractHeartbeat(current)

    // 标记放在**末尾**：不影响「给模型的规则」小节的解析（那一节从文件开头取）
    await atomicWrite(paths.policy, `${POLICY_TEMPLATE}\n${POLICY_SYNC_MARK}\n`)

    // 写回收尾语（若旧文件里有）。用与 writeHeartbeat 相同的归一化与超长校验，
    // 但**不调用 writeHeartbeat** —— 它在 apply() 闭包里，这里（createStore 闭包）
    // 拿不到它。所以把「提取 + 写回」做成自包含的一小段，见下方两个 helper。
    let heartbeatRestored = false
    if (oldHeartbeat !== '') {
      const normalized = normalizeHeartbeat(oldHeartbeat)
      if (normalized !== '') {
        const updated = await restoreHeartbeat(normalized)
        if (updated) heartbeatRestored = true
      }
    }

    // ⚠️ 这里不能调 diag/logger —— createStore 的作用域里没有它们
    // （它们定义在 apply 内部）。只把结果 return 出去，由调用方记录。
    return {
      written: true,
      from: beforeBytes,
      to: Buffer.byteLength(POLICY_TEMPLATE, 'utf8'),
      heartbeatRestored,
      backedUp: current !== undefined && !isFreshTemplate,
    }
  }

  /**
   * 从 policy.md 文本里提取「每轮收尾语」，返回纯句子（不含执行说明）。
   *
   * 与 apply() 里的 readHeartbeat 逻辑一致，但**这里必须自包含一份**：
   * syncPolicyOnce 在 createStore 闭包内，拿不到 apply() 里的 readHeartbeat。
   * 2026-11-16 实测：覆盖 policy.md 时收尾语随旧文件一起丢失，所以覆盖前
   * 用它把收尾语读出来、覆盖后再写回。
   */
  function extractHeartbeat(text) {
    try {
      const line = text.match(/^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*$/m)
      if (!line) return ''
      let rest = line[0]
      const m = rest.match(/[：:]\s*(.+)$/)
      if (!m) return ''
      rest = m[1].trim()
      rest = rest.split(/这是会话的[「"]?心跳/)[0]
      rest = rest.split(/用来确认本轮执行完整/)[0]
      return rest.trim().replace(/[。.]\s*$/, '')
    } catch {
      return ''
    }
  }

  /** 与 writeHeartbeat 相同的归一化：换行/连续空白压成一个空格。 */
  function normalizeHeartbeat(text) {
    return String(text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' ')
      .trim()
  }

  /**
   * 把归一化后的收尾语写回刚覆盖过的 policy.md。
   *
   * 复用与 writeHeartbeat 相同的插入规则：已有那一行就替换，没有就在
   * 「给模型的规则」小节后补一行。返回是否真的写入（false = 没写入）。
   */
  async function restoreHeartbeat(text) {
    const current = await readIfExists(paths.policy)
    if (current === undefined) return false
    const lineRe = /^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*$/m
    const hasLine = lineRe.test(current)
    // ⚠️ 与 writeHeartbeat 保持完全一致：只跟踪「缩进续行」，不碰空行和标题。
    // 中间经过两次修正（吞标题 → 留孤儿续行），最终形态见 writeHeartbeat 的注释。
    const blockRe = /^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*(?:\n[ \t]+[^\n]*)*\n?/m
    const sentence = /[。！？!?…．.]$/.test(text) ? text : `${text}。`
    const newLine = `- 每轮回复的结尾，加固定一句：${sentence} ` +
      `这是会话的「心跳」，用来确认本轮执行完整。放在最后一行，不用解释、不用变形。`
    let updated
    if (hasLine) {
      updated = current.replace(blockRe, `${newLine}\n`)
    } else {
      const anchor = /^(#{1,2}\s*.*给模型的规则[^\n]*\n)/m
      updated = anchor.test(current)
        ? current.replace(anchor, `$1\n${newLine}\n`)
        : `${current.trimEnd()}\n\n${newLine}\n`
    }
    await atomicWrite(paths.policy, updated)
    return true
  }

  /**
   * 记忆根目录就绪：建目录 + 预建 policy.md + **一次性同步 policy.md**。
   *
   * 返回值里的 `policySync` 供 apply 记日志 —— createStore 拿不到 logger，
   * 由调用方决定怎么打。这是既有的分层约定（store 只做纯数据操作）。
   */
  async function ensureLayout() {
    await mkdir(root, { recursive: true })
    // 唯一需要预建的文件：policy.md（行为规则，不进数据库）
    if (!(await exists(paths.policy))) await atomicWrite(paths.policy, POLICY_TEMPLATE)
    // ⚠️ 2026-11-16：一次性覆盖（用户明确授权，见 syncPolicyOnce 的注释）。
    // 只在这里做一次，且由 state.policySyncVersion / 文件内标记双重把关。
    let policySync = null
    try {
      const st = await readState()
      const r = await syncPolicyOnce(st)
      if (r.written) {
        await writeState({ ...st, policySyncVersion: POLICY_SYNC_VERSION })
        policySync = r
      } else if (r.skipped === 'marked') {
        await writeState({ ...st, policySyncVersion: POLICY_SYNC_VERSION })
      }
    } catch (e) {
      // 同步失败不应阻断插件启动：policy.md 只是行为规则，旧版仍可用
      policySync = { error: String(e?.message ?? e) }
    }
    return policySync
  }

  async function readState() {
    const fallback = { version: 2, lastConsolidate: null, projects: {}, ambiguous: [] }
    const text = await readIfExists(paths.state)
    if (text === undefined) return fallback
    try {
      const parsed = parseJson(text)
      if (!parsed || typeof parsed !== 'object') return fallback
      return {
        version: 2,
        lastConsolidate: parsed.lastConsolidate ?? null,
        projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
        ambiguous: Array.isArray(parsed.ambiguous) ? parsed.ambiguous : [],
        // ⚠️ 2026-11-16：policy.md 一次性同步的版本号（见 syncPolicyOnce）。
        // **必须在这里透传**，否则每次 readState 都把它丢掉 →
        // 每次启动都以为「没同步过」→ **每次启动都覆盖 policy.md**，
        // 那就正好违反了用户「仅此一次」的要求。
        policySyncVersion: Number.isInteger(parsed.policySyncVersion)
          ? parsed.policySyncVersion
          : null,
      }
    } catch {
      return fallback
    }
  }

  async function writeState(state) {
    await atomicWrite(paths.state, `${JSON.stringify(state, null, 2)}\n`)
  }

  /**
   * cwd → 项目标识。
   *
   * ## 两个名字，别混
   *
   * - **键（key）**：`state.projects` 的键，来自 cwd 的 basename —— 即**目录名**
   * - **scope**：数据库里 `rules` / `logs` / `archive` 的分类名 —— 即**记忆名**
   *
   * 平时两者相同，所以大多数时候看不出区别。但用户在工作区改名功能里
   * 只改「记忆名」而不动磁盘目录时，两者会分叉 —— 这时必须靠
   * `state.projects[key].scope` 记住映射，否则下次开会话会按目录名
   * 建一个**新的空 scope**，而数据全在旧名字下永远见不到。
   * （2026-11-15 审出，这是改名需求最容易漏的一层。）
   *
   * `scope` 字段缺省 = 跟随 key，所以老数据不需要迁移。
   */
  function resolveProjectKey(cwd, state) {
    const name = projectNameOf(cwd)
    if (name === undefined) return undefined
    const base = slugify(name)
    if (base === '') return undefined
    const claimed = state?.projects?.[base]
    const key =
      claimed !== undefined && claimed.cwd !== undefined && resolve(claimed.cwd) !== resolve(cwd)
        ? `${base}-${shortHash(cwd)}`
        : base
    const entry = state?.projects?.[key]
    // 记录项目时用的是目录名，记忆挂在 scope 名下；两者不同名时以 scope 为准
    const scope = typeof entry?.scope === 'string' && entry.scope !== '' ? entry.scope : key
    return { key, name, scope, dir: projectDir(key, state) }
  }

  async function registerProject(cwd) {
    // ⚠️ 2026-11-17：包进 serialize()。
    //
    // 这里是典型的**读-改-写**：readState() → 改 state.projects → writeState()。
    // 两个会话同时进入时（各自调用这个函数），会读到同一份 state，
    // 各自加一个项目、各自写回 —— 后写的那个把先写的项目**覆盖掉**。
    // 症状不是「记忆丢了」，而是「记忆还在，但项目不见了」，
    // 正是 DECISIONS D13 记的那个坑（「并发 12 条丢到只剩 1 条」）。
    //
    // 之前 serialize() 只用在 enqueueAmbiguous / clearAmbiguous 两处，
    // 这个函数漏了。它比那两个更常被调用（每个新项目第一次说话就会进）。
    return await serialize(async () => {
      const state = await readState()
      const resolved = resolveProjectKey(cwd, state)
      if (resolved === undefined) return undefined
      if (state.projects[resolved.key] === undefined) {
        state.projects[resolved.key] = {
          name: resolved.name,
          dir: resolved.dir,
          cwd: resolve(cwd),
          createdAt: new Date().toISOString(),
        }
        await writeState(state)
      }
      return resolved
    })
  }



  

  /**
   * 提取可注入的结论行。
   *
   * ⚠️ 必须支持多行续行。
   *
   * Markdown 里写长结论时，作者自然会折行：
   *   - [active] 这是一条比较长的结论，第一段
   *     第二段内容（用两个空格缩进续行）
   *
   * 早先的实现只认以 `- ` 开头的行，缩进的续行被**整行丢弃**——
   * 表现为注入上下文里每条结论都只剩半句话。这个 bug 极隐蔽：
   * 文件本身完全正常，编辑器里看着也没问题，只有注入结果缺一半。
   * 另一个项目踩到过，反馈「第 25、27、31… 行都被截断了」。
   *
   * 现在把缩进的行接到上一条结论后面（用空格连接），
   * 并继续应用 `[active]` / `[stale]` / `[superseded]` 的过滤规则。
   *
   * ## ⚠️ 文件字节 ≠ 注入字节（2026-11-12 的教训，值得一直记着）
   *
   * 本函数会过滤掉 `[stale]` / `[superseded]` 行，所以
   * **文件 4823 字节的项目，实际注入可能只有 3665 字节**。
   * 判断「会不会被截断」只能看过滤后的字节数，不能看文件大小 ——
   * 按文件大小算会得出「已经超预算了」的假警报。
   *
   * 当某一段被写到预算之上时，注入会被截断，而**写入者看不到水位**，
   * 于是会一直往上加，直到新条目永远看不见。
   * （曾有个 measureInjection() 专门量这个水位，2026-11-15 确认已无调用点并删除；
   *   现在由 renderFromDb 里各段的 `truncated` 返回值直接在注入文案里提示模型。）
   */
  function activeLines(markdown) {
    if (markdown === undefined) return []

    // 先把物理行聚合成逻辑条目：以 `- ` 开头的是新条目的起点，
    // 其它非空行（通常是缩进的续行）并入当前条目。
    const items = []
    let current = null
    for (const raw of markdown.split('\n')) {
      const line = raw.trimEnd()
      if (line.trim() === '') {
        // 空行结束当前条目，避免把后文并入
        if (current !== null) {
          items.push(current)
          current = null
        }
        continue
      }
      if (line.startsWith('- ')) {
        if (current !== null) items.push(current)
        current = line
        continue
      }
      // 章节标题（# / ## / ###）不是续行，它是新段落的开始 ——
      // 遇到标题就结束当前条目，否则「## 另一个标题」会被拼进上一条结论。
      if (/^#{1,6}\s/.test(line)) {
        if (current !== null) {
          items.push(current)
          current = null
        }
        continue
      }
      // 续行：接到当前条目。没有当前条目就忽略（比如段落正文）
      if (current !== null) current = `${current} ${line.trim()}`
    }
    if (current !== null) items.push(current)

    const lines = []
    for (const item of items) {
      const line = item.trimEnd()
      if (/^- \[superseded\b/i.test(line)) continue
      if (/^- \[stale\b/i.test(line)) continue
      if (/^-\s*[（(].*[）)]\s*$/u.test(line)) continue
      if (line.startsWith('- [active]')) {
        lines.push(`- ${line.slice('- [active]'.length).trim()}`)
      } else if (line.startsWith('- ')) {
        lines.push(line)
      }
    }
    return lines
  }

  /**
   * policy.md 的「给模型的规则」小节，供全局注入。
   *
   * policy.md 有两类内容：
   *   - 「给模型的规则」：要求模型每轮遵守的行为约定（如收尾语）—— 注入
   *   - 其余（插件行为说明、存储位置等）：给人看的文档，模型控制不了 —— 不注入
   *
   * 区分方式：只取小节标题里含「给模型的规则」字样的段落下的 active 行。
   * 这类约定是用户手工维护的，所以不与 rules 表共用预算，单独给 policyBytes。
   */
  function policyTextSync(maxBytes) {
    const raw = readCached(paths.policy)
    if (raw === undefined) return { text: '', truncated: false }

    // 找到目标小节：从「给模型的规则」标题行起，到下一个同级标题止
    const lines = raw.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^#{1,2}\s*.*给模型的规则/.test(lines[i])) {
        start = i + 1
        break
      }
    }
    if (start === -1) return { text: '', truncated: false }

    const collected = []
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]
      // 遇到下一个二级标题，小节结束
      if (/^#{1,2}\s/.test(line)) break
      collected.push(line)
    }

    const active = activeLines(collected.join('\n'))
    if (active.length === 0) return { text: '', truncated: false }
    return truncateBytes(active.join('\n'), maxBytes)
  }

  /**
   * 把 policy.md「给模型的规则」里的固定文本从待分析文本中剥掉。
   *
   * 为什么需要它（2026-11-11 的连锁误判）：
   *   用户给某个项目定了一条收尾语规则：
   *     「你可爱的大肥鱼一直都在，等待下一轮任务。」
   *   这条规则现在通过 policy.md 注入所有项目。于是用户**引用或讨论它**时，
   *   消息里就带着「可爱」两个字 —— 情绪词典命中 0.85，整段技术讨论
   *   被记成「用户表达夸赞（可爱·高置信·0.85）」，原话还是被截断的半句。
   *
   *   更糟的是它会自我复制：误判产生的条目被用户贴出来讨论，
   *   贴出来的内容又含「可爱」，于是再产生一条新的误判。
   *
   * 前后加的两层启发式（元讨论标记 / 记忆内容粘贴检测）只能挡住一部分场景，
   * 挡不住「规则本身就是用户话里的普通内容」。这里的做法是**确定性的**：
   * 插件知道自己注入过哪些规则文本，判定前先把它们从输入里删掉 ——
   * 不是猜「这像不像在讨论规则」，而是确知「这段是规则内容」。
   *
   * 实现：取规则行里长度 ≥6 的连续片段（去掉 `- [active]` 前缀和标点），
   * 原文中出现就替换成空格。只剥离长片段，避免把「规则」这种通用词也删掉。
   */
  function stripPolicyPhrases(text) {
    const raw = readCached(paths.policy)
    if (raw === undefined) return text
    if (typeof text !== 'string' || text === '') return text

    const lines = raw.split('\n')
    let start = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^#{1,2}\s*.*给模型的规则/.test(lines[i])) {
        start = i + 1
        break
      }
    }
    if (start === -1) return text

    const phrases = []
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]
      if (/^#{1,2}\s/.test(line)) break
      // 去掉列表前缀和状态标记，剩下的正文才可能出现在用户话里
      const body = line
        .replace(/^\s*[-*]\s*/, '')
        .replace(/^\[(active|stale|superseded)\]\s*/i, '')
        .trim()
      if (body === '') continue
      // 按标点切成分句，只保留足够长的片段，避免误删通用词
      for (const chunk of body.split(/[，。；：、！？,.;:!?]/u)) {
        const trimmed = chunk.trim()
        if (trimmed.length >= 6) phrases.push(trimmed)
      }
    }
    if (phrases.length === 0) return text

    // 长片段优先替换，避免短片段先删掉导致长片段匹配不上
    phrases.sort((a, b) => b.length - a.length)
    let out = text
    for (const phrase of phrases) {
      if (out.includes(phrase)) out = out.split(phrase).join(' ')
    }
    return out
  }

  async function enqueueAmbiguous({ sessionId, text, candidates }) {
    const quote = truncateBytes(String(text ?? '').replace(/\s+/g, ' ').trim(), 120).text
    if (quote === '') return
    return await serialize(async () => {
      const state = await readState()
      const queue = [...state.ambiguous]
      if (queue.some((item) => item.text === quote)) return
      queue.push({
        id: randomUUID().slice(0, 8),
        sessionId: sessionId ?? null,
        text: quote,
        candidates: candidates ?? [],
        at: new Date().toISOString(),
      })
      state.ambiguous = queue.slice(-20)
      await writeState(state)
    })
  }

  async function peekAmbiguous() {
    return (await readState()).ambiguous
  }

  async function clearAmbiguous(ids) {
    return await serialize(async () => {
      const state = await readState()
      state.ambiguous = ids === undefined ? [] : state.ambiguous.filter((item) => !ids.includes(item.id))
      await writeState(state)
    })
  }



  async function overview() {
    // 2026-11-13 剥离后只保留数据库模式需要的字段。
    // 只返回数据库模式需要的字段；真实条数在 /api/dsh-memory/state 的 db.byTable / db.byScope 里。
    const state = await readState()
    const policy = await readIfExists(paths.policy)

    const projects = []
    for (const [key, entry] of Object.entries(state.projects)) {
      projects.push({
        key,
        name: entry.name ?? key,
        // 记忆挂在哪个 scope 名下。平时 === key；用户只改记忆名后会分叉，
        // 此时 GUI 与调试脚本必须按 scope 看数据，按 key 看会以为数据没了。
        scope: typeof entry.scope === 'string' && entry.scope !== '' ? entry.scope : key,
        dir: entry.dir ?? defaultProjectDir(key),
        cwd: entry.cwd ?? null,
      })
    }
    projects.sort((l, r) => l.key.localeCompare(r.key))

    return {
      root,
      lastConsolidate: state.lastConsolidate ?? null,
      policy: { bytes: policy === undefined ? 0 : byteLength(policy) },
      projects,
      ambiguous: state.ambiguous.length,
      statsSource: 'db',
      // 记忆目录名。设置页的说明文字要引用它，不能在前端硬编码 ——
      // 常量改过一次（dsh-memory → FatFishDream-memory），UI 文案漏改导致
      // 界面上显示旧名字。由 Host 提供，前端永远跟着走。
      dirName: MEMORY_DIR_NAME,
      // 健康自检结论：桌面版看不到 console，这是用户能直接看到的地方之一
      health: { ...healthState },
      totals: { projects: projects.length },
    }
  }

  /**
   * 迁移整个根目录，并把所有项目一起收进新根。
   *
   * 设计取舍：GUI 的「整体迁移」语义就是「所有东西一起走」，
   * 因此默认 relocateAll=true —— 连之前用 moveProject 单独搬到其他盘的项目
   * 也会被收回到 <newRoot>/<key>，之后 state 里不再写自定义 dir，
   * 一律跟随根目录。这样不会有「根目录搬了但某个项目还留在旧盘」的残留。
   *
   * 传 relocateAll=false 可保留单独搬过的项目原地不动（仅内部/测试用）。
   *
   * 顺序：
   *   1. facts / policy / state
   *   2. 各项目（全部收进新根，目录名 = 项目 key）
   *   3. logs（显式处理，避免和项目文件夹混淆）
   *   4. 旧根下未登记的目录（兜底，防止漏掉手工放进去的东西）
   *
   * 完成后：
   *   - 切换内存 root，后续注入与写入立即指向新位置
   *   - 更新指针文件
   *   - 回调 onRootMoved 切换日志落点
   *   - 旧目录保留不删
   */
  async function migrateRoot(nextRootRaw, onRootMoved, options = {}) {
    const relocateAll = options.relocateAll !== false
    const nextRoot = expandRoot(nextRootRaw)
    // 目标就是当前目录时明确报错，不要静默返回 moved:0 ——
    // 那会让用户以为迁移成功了，实际什么都没发生。
    if (nextRoot === root) {
      throw new Error(`目标就是当前记忆目录（${root}），无需迁移。请填写一个新路径。`)
    }
    if (isInside(nextRoot, root)) throw new Error('新位置不能是当前记忆目录的子目录')
    if (await exists(nextRoot)) {
      const entries = await readdir(nextRoot).catch(() => [])
      if (entries.length > 0) throw new Error(`目标目录非空：${nextRoot}`)
    }
    await mkdir(nextRoot, { recursive: true })

    const state = await readState()
    let moved = 0
    let dbCopied = false
    // 被 copyTree 跳过的条目（junction / 符号链接等）。
    // 收集起来随返回值给上层，由它 diag 一条 —— 绝不静默丢失。
    const skippedEntries = []

    // 1. 根级文件
    //
    // ⚠️ memory.db 刻意不在这里 —— 它是二进制 SQLite 库，
    // 下面第 1.5 步用 VACUUM INTO 单独处理。
    //
    // 2026-11-16 修真 bug：数组里原本有 'memory.db'，与上面两行注释直接矛盾。
    // 后果实测：8,327,168 字节的库被 readIfExists 按 utf8 读成 6,621,810 个字符
    // （**554,311 个 U+FFFD 替换符**），再被 atomicWrite 写回成 9,435,410 字节的废文件。
    // 正常路径下第 1.5 步的 VACUUM INTO 会覆盖它，所以问题被掩盖了很久；
    // 但**迁移中途崩溃/断电时，新根会留下这个坏库**，而旧根可能已被清理。
    for (const file of ['policy.md', 'state.json']) {
      const text = await readIfExists(join(root, file))
      if (text === undefined) continue
      await atomicWrite(join(nextRoot, file), text)
      moved += 1
    }

    // 1.5 主数据库（2026-11-13 补）
    //
    // 为什么之前漏了：这段迁移逻辑写于「记忆还存在 .md 文件里」的年代，
    // 当时根级只有 policy.md / state.json 等几个文本文件。
    // 迁到 SQLite 后主存储变成 memory.db，但这一步没有同步 ——
    // 结果迁移后新根是个空库，用户看到的像是记忆全丢了。
    //
    // 为什么不能走 copyTree：它用 readIfExists 按**文本**读、atomicWrite 写，
    // 对二进制库必然损坏。而且 WAL 模式下还有未落盘的数据在 -wal 里，
    // 直接复制文件可能漏掉最近几条。
    //
    // VACUUM INTO 是唯一正确的做法：
    //   - 它由 SQLite 自己保证一致性快照，不需要独占锁
    //   - 已提交到 WAL 但未 checkpoint 的数据也会被包含
    //   - 生成的库是干净的（没有 -wal / -shm 依赖）
    const dbSource = join(root, 'memory.db')
    if (await exists(dbSource)) {
      try {
        await backupDbFile(dbSource, join(nextRoot, 'memory.db'))
        dbCopied = true
        moved += 1
      } catch (error) {
        // 数据库备份失败必须中断整个迁移 —— 继续下去会让新根变成空库，
        // 那比"迁移失败"严重得多（用户会以为数据丢了）。
        throw new Error(
          `主数据库备份失败，迁移已中止（未切换根目录）：${error?.message ?? error}`,
        )
      }
    }

    // 2. 项目文件夹
    const relocated = {}
    let projectsMoved = 0
    for (const [key, entry] of Object.entries(state.projects)) {
      const dir = entry.dir ?? defaultProjectDir(key)
      const alreadyInside = isInside(root, dir)

      if (!alreadyInside && !relocateAll) {
        // 保留外部位置（仅 relocateAll=false 时）
        relocated[key] = { ...entry }
        continue
      }

      // 根内的项目按相对路径搬；根外的项目收到 <newRoot>/<key>
      const target = alreadyInside ? join(nextRoot, relativePath(root, dir)) : join(nextRoot, key)
      moved += await copyTree(dir, target, skippedEntries)
      projectsMoved += 1

      // 收进新根后不再写自定义 dir，改为跟随根目录
      const { dir: _ignored, ...rest } = entry
      relocated[key] = alreadyInside ? { ...entry, dir: target } : { ...rest }
    }

    // 3. logs：显式迁移，不和项目文件夹混淆
    const logsSource = join(root, 'logs')
    let logsCopied = 0
    if (await exists(logsSource)) {
      logsCopied = await copyTree(logsSource, join(nextRoot, 'logs'), skippedEntries)
      moved += logsCopied
    }

    // 4. 旧根下未登记的目录（兜底）
    const dirs = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of dirs) {
      if (!entry.isDirectory()) {
        // ⚠️ 这里也会漏掉 junction / 符号链接 —— 它们在 Dirent 里
        // isDirectory()=false，于是在**进 copyTree 之前**就被跳过了。
        // 2026-11-16 实测：只改 copyTree 的 else 分支不够，根级这一层
        // 会把链接先筛掉，skippedEntries 依然是空的。
        // 只记「既不是文件也不是目录」的条目，普通文件不算异常。
        if (!entry.isFile()) {
          skippedEntries.push(join(root, entry.name))
        }
        continue
      }
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      if (entry.name === 'logs') continue
      if (relocated[entry.name] !== undefined) continue
      moved += await copyTree(join(root, entry.name), join(nextRoot, entry.name), skippedEntries)
    }

    await atomicWrite(
      join(nextRoot, 'state.json'),
      `${JSON.stringify({ ...state, projects: relocated }, null, 2)}\n`,
    )

    // 切换内存根目录：此后所有读写都指向新位置，不需要重启。
    const previousRoot = root
    setRoot(nextRoot)

    // 指针跟着迁，否则下次启动会回退到盘符探测。
    writePointer(nextRoot)

    // 日志落点切换
    onRootMoved?.(nextRoot)

    return {
      root: nextRoot,
      previousRoot,
      moved,
      logsCopied,
      projectsMoved,
      relocatedAll: relocateAll,
      // 这些条目没有被复制（junction / 符号链接 / 特殊文件）。
      // 调用方必须把它们说出来，否则用户会以为「全搬过去了」。
      skippedEntries,
      warning: isSystemDriveTarget(nextRoot)
        ? `已迁到系统盘（${nextRoot}）。建议改用非系统盘：${PREFERRED_DRIVE}:\\${MEMORY_DIR_NAME}`
        : undefined,
    }
  }

  async function moveProject(key, nextDirRaw) {
    // ⚠️ 2026-11-17：整段包进 serialize()。
    //
    // 这里是「读 state → copyTree（慢）→ 改 state.projects → 写 state」。
    // copyTree 期间若有别的写进 state（registerProject / 别的迁移），
    // 我们手里这份 state 就是**过期的** —— 写回去会把别人新增的项目抹掉。
    //
    // 代价：迁移是低频操作，但它会把其他 state 写入阻塞一会儿（复制整个项目目录）。
    // 这个代价是对的 —— 宁可排队，也不要「迁移完之后项目列表少了几条」。
    return await serialize(async () => {
      if (!isSafeSlug(key)) throw new Error(`项目标识非法：${key}`)
      // ⚠️ 2026-11-16 修：原来先 `resolve()` 再 `isAbsolute()` —— 顺序反了。
      // resolve 会把相对路径补成绝对路径，于是 isAbsolute 恒为 true，
      // 校验形同虚设，"随便什么" 也会被当成合法目标并真的执行搬迁。
      // 必须先校验**用户传进来的原始值**，再 resolve。
      const rawDir = String(nextDirRaw ?? '').trim()
      if (rawDir === '' || !isAbsolute(rawDir)) throw new Error('需要绝对路径')
      const nextDir = resolve(rawDir)
      const state = await readState()
      const current = projectDir(key, state)
      if (resolve(current) === nextDir) return { key, dir: nextDir, moved: 0 }
      if (isInside(nextDir, current)) throw new Error('新位置不能是当前项目文件夹的子目录')
      if (await exists(nextDir)) {
        const entries = await readdir(nextDir).catch(() => [])
        if (entries.length > 0) throw new Error(`目标目录非空：${nextDir}`)
      }
      const skippedEntries = []
      const moved = await copyTree(current, nextDir, skippedEntries)
      state.projects[key] = {
        name: state.projects[key]?.name ?? key,
        dir: nextDir,
        cwd: state.projects[key]?.cwd,
        createdAt: state.projects[key]?.createdAt ?? new Date().toISOString(),
        movedAt: new Date().toISOString(),
      }
      await writeState(state)
      return {
        key,
        dir: nextDir,
        moved,
        skippedEntries,
        warning: isSystemDriveTarget(nextDir) ? `新位置在系统盘（${nextDir}）` : undefined,
      }
    })
  }


  return {
    // 用 getter 而不是值：root 在 migrateRoot 后会变，
    // 若导出成固定值，调用方读到的永远是迁移前的旧路径。
    get root() {
      return root
    },
    // resolveRoot 实际走的选址级别（configured / pointer / discovered-on-X /
    // first-install-X）。/state 会把它暴露给自检脚本与设置页。
    //
    // 2026-11-15 加：此前 /state 里写着 `rootReason: store.rootReason`，
    // 但 createStore 从未保存过这个字段 —— 于是它永远是 undefined，
    // 接口里恒为空串。自检脚本 selfcheck-dir-name 想验证「指针优先级」
    // 时拿不到任何证据，只好写了一句恒真断言（永远 pass），
    // 等于那个盲区从来没被覆盖过。
    get rootReason() {
      return rootReason
    },
    get paths() {
      return paths
    },
    ensureLayout,
    readState,
    writeState,
    // ⚠️ 2026-11-17：导出 serialize，让**路由层**也能用同一把锁。
    //
    // 起因：`/scope/rename` 里有一段「读 state → 改 projects → 写 state」，
    // 它在 apply 的闭包里，拿不到 createStore 内部的 writeQueue；
    // 不导出的话只能自己再造一把锁 —— 两把锁互不排斥，等于没锁。
    //
    // 这是 createStore 里**唯一**的写队列，所有 state.json 的读-改-写都该走它。
    serialize,
    resolveProjectKey,
    registerProject,
    policyTextSync,
    stripPolicyPhrases,
    enqueueAmbiguous,
    peekAmbiguous,
    clearAmbiguous,
    overview,
    migrateRoot,
    moveProject,
    isSystemDriveTarget,
    candidateDrives: () => listCandidateDrives().map((d) => ({ letter: d.letter, root: d.root, free: d.free })),
  }
}

/** state.json 的同步读，供注入回调使用。 */
function readStateSync(store) {
  const fallback = { version: 2, lastConsolidate: null, projects: {}, ambiguous: [] }
  const text = readCached(store.paths.state)
  if (text === undefined) return fallback
  try {
    const parsed = parseJson(text)
    if (!parsed || typeof parsed !== 'object') return fallback
    return {
      version: 2,
      lastConsolidate: parsed.lastConsolidate ?? null,
      projects: parsed.projects && typeof parsed.projects === 'object' ? parsed.projects : {},
      ambiguous: Array.isArray(parsed.ambiguous) ? parsed.ambiguous : [],
    }
  } catch {
    return fallback
  }
}


// ---------------------------------------------------------------- schema 自检

/**
 * 与宿主同规则的本地断言。
 *
 * 宿主的 assertSupportedJsonSchema 拒绝 'json' 这类简写，只接受
 * object/array/string/number/integer/boolean/null。这里在注册前先跑一遍，
 * 不合法就不注册并落盘 —— 避免又一次把坏 schema 送进每一次模型请求。
 */
function assertSupportedSchema(schema, path = 'schema') {
  const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const CONSTRAINTS = ['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const']
  const ANNOTATIONS = ['description', 'title', 'default', 'examples']
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error(`${path} 必须是对象`)
  }
  for (const key of Object.keys(schema)) {
    if (!CONSTRAINTS.includes(key) && !ANNOTATIONS.includes(key)) {
      throw new Error(`${path}.${key} 不受支持`)
    }
  }
  if (Object.hasOwn(schema, 'type') && !TYPES.includes(schema.type)) {
    throw new Error(`${path}.type 必须是 ${TYPES.join('/')}`)
  }
  if (Object.hasOwn(schema, 'additionalProperties') && typeof schema.additionalProperties !== 'boolean') {
    throw new Error(`${path}.additionalProperties 必须是布尔值`)
  }
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
      throw new Error(`${path}.properties 必须是对象`)
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      assertSupportedSchema(child, `${path}.properties.${name}`)
    }
  }
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${path}.items`)
  return true
}

// ---------------------------------------------------------------- 工具（默认关闭）

// ---------------------------------------------------------------- 插件主体

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  const logger = ctx.logger ?? console

  /**
   * 诊断日志。
   *
   * 位置：`<记忆根目录>/logs/YYYY-MM-DD.log`，按日切分，避免单文件无限增长。
   *
   * 两处细节：
   *   1. 根目录要到 resolveRoot 之后才确定，在那之前只缓冲在内存，
   *      确定后一次性 flush —— 日志始终落在真正的记忆目录里。
   *   2. 日志落点跟随记忆根目录。迁移根目录时 migrateRoot 会在复制完成后
   *      回调 onRootMoved 切换 logDir，所以迁移之后的新日志立刻写入新位置，
   *      不需要重启。旧位置的日志已在迁移中被复制过去，不会丢。
   */
  let logDir = undefined
  const buffered = []

  const appendDiag = (line) => {
    if (logDir === undefined) {
      buffered.push(line)
      return
    }
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(join(logDir, `${localDay()}.log`), `${line}\n`)
    } catch {
      /* 落盘失败不影响插件运行 */
    }
  }

  const diag = (stage, detail) => {
    const line = `${new Date().toISOString()} [${stage}] ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
    appendDiag(line)
  }

  // ---- 健康自检用的注册追踪 ----
  // 各注册点成功后置位，apply 结尾统一清点，确认升级后没静默失效。
  const attachedEvents = new Set()
  let injectedPrompt = false
  let registeredCommand = false
  const registeredRoutes = []
  /** 注册失败的原因，供自检报告 */
  const registrationErrors = []

  /**
   * 安全地挂事件监听。
   *
   * 为什么不能直接 ctx.on：如果 DSH 升级后事件系统变了（名字不再支持、
   * 签名要求不同），裸调 ctx.on 会让整个 apply 抛错 —— 插件完全加载失败，
   * 连"哪里坏了"都不知道。更糟的是自检本身也跑不到。
   *
   * 这里包一层：失败就记下来，让 apply 继续跑完，最后由健康自检统一报告。
   * 效果是「部分功能失效 + 明确告知」，而不是「整个插件静默消失」。
   */
  const safeOn = (eventName, handler) => {
    try {
      ctx.on(eventName, handler)
      attachedEvents.add(eventName)
      return true
    } catch (error) {
      const message = String(error?.message ?? error)
      registrationErrors.push(`${eventName}: ${message}`)
      diag('event-register-FAILED', { event: eventName, message })
      logger.warn?.(
        `[dsh-memory] 事件 ${eventName} 注册失败：${message}\n` +
          `这通常意味着 DSH 内部 API 变了。记忆数据安全，但该能力会失效。`,
      )
      return false
    }
  }

  const flushDiag = () => {
    if (logDir === undefined) return
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      return
    }
    const pending = buffered.splice(0)
    if (pending.length === 0) return
    try {
      appendFileSync(join(logDir, `${localDay()}.log`), `${pending.join('\n')}\n`)
    } catch {
      /* 落盘失败不影响插件运行 */
    }
  }

  /** 记忆根目录变更后切换日志落点。由迁移/移动流程回调。 */
  const retargetLogs = (nextRoot) => {
    const previous = logDir
    logDir = join(nextRoot, 'logs')
    flushDiag()
    diag('log-retargeted', { from: previous ?? null, to: logDir })
  }

  diag('apply-start', { rawRoot: config.root })

  const resolvedRoot = resolveRoot(config.root, (m) => logger.warn?.(m))
  config.root = resolvedRoot.root
  config.rootReason = resolvedRoot.reason
  const store = createStore(config)

  // ---- 数据库存储（v2 架构）----
  //
  // 记忆来自 SQLite，是**唯一**存储。2026-11-13 之前的 .md 时代已彻底剥离：
  // 除 policy.md（行为规则，不进数据库）外，不再读写任何记忆 .md 文件。
  //
  // ⚠️ 这里曾写着「库打不开 → 回退到旧的 .md 路径，插件照常工作」。
  //    那个回退路径已经删除了 —— 文件不再生成，回退只会读到空内容，
  //    从而无法与「真的没有记忆」区分。现在库打不开就明确告知（见注入的 else 分支）。
  //
  // 2026-11-13：dbPath 由 const 改 let，并把初始化抽成 initDbStore()。
  // 原因见 initDbStore 上方的注释（迁移后要能按新根重建）。
  let dbPath = join(config.root, 'memory.db')
  let dbStore
  let dbStoreError

  /**
   * 按当前 config.root 建立（或重建）数据库连接。
   *
   * 为什么需要"重建"而不是只改个路径（2026-11-13 遇到的 bug）：
   * createDbStore(dbPath, ...) 把 dbPath 闭在对象里，`dbStore.path` 永远
   * 返回创建时那个路径。迁移根目录后光改 config.root 是不够的 ——
   * 旧对象仍然连着旧库，于是「GUI 看着是空的，插件却在往旧库写」，
   * 用户一旦删掉旧目录，数据就真没了。
   *
   * 所以迁移完成后必须：close 旧对象 → 用新路径 createDbStore → open。
   * db-store.mjs 的 close() 已经做了 wal_checkpoint(TRUNCATE)，
   * 关闭前会把 WAL 落盘，不会丢数据。
   *
   * @returns {boolean} 是否成功连上数据库（false = 回退文件模式）
   */
  function initDbStore() {
    dbPath = join(config.root, 'memory.db')
    try {
      dbStore = createDbStore(
        dbPath,
        {
          factsBytes: Number(config.factsBytes) || 8000,
          projectBytes: Number(config.projectBytes) || 4096,
          policyBytes: Number(config.policyBytes) || 8000,
        },
        (level, msg) => diag(`db-${level}`, msg),
      )
      // 立即打开一次，验证 schema 可读、版本兼容
      dbStore.open()
      dbStoreError = undefined
      diag('db-ready', { path: dbPath })
      return true
    } catch (error) {
      dbStoreError = String(error?.message ?? error)
      dbStore = undefined
      logger.warn?.(`[dsh-memory] 记忆库不可用，回退到文件存储：${dbStoreError}`)
      diag('db-FAILED', { path: dbPath, message: dbStoreError })
      return false
    }
  }

  initDbStore()

  /**
   * 迁移根目录之后，把数据库连接切到新位置。
   *
   * 为什么必须单独一步（2026-11-13 修的 bug）：
   * 迁移函数只搬文件、切换 root 与日志落点，**不碰数据库连接**。
   * 而 createDbStore(dbPath) 把路径闭在对象里，旧对象永远连着旧库 ——
   * 于是迁移后「GUI 看着是空的，插件还在往旧库写」，
   * 用户一旦删掉旧目录，数据就真没了。
   *
   * 顺序：先关旧连接（close 内部会 wal_checkpoint(TRUNCATE) 把 WAL 落盘），
   * 再按新 root 建立新连接。
   *
   * @param {string} nextRoot - 迁移后的新根
   * @returns {boolean} 新库是否可用
   */
  function rebindDbStore(nextRoot) {
    const from = dbPath
    try {
      dbStore?.close?.()
    } catch (error) {
      diag('db-rebind-close-FAILED', { message: String(error?.message ?? error) })
    }
    config.root = nextRoot
    const ok = initDbStore()
    diag('db-rebound', { from, to: dbPath, ok })
    return ok
  }

  /** 注入层与写入层共用的取值器（避免重复判空） */
  const getDbStore = () => dbStore
  const dbStoreExists = () => dbStore !== undefined

  // 根目录确定，日志落点随之确定，并补写之前的缓冲
  logDir = join(config.root, 'logs')
  flushDiag()

  diag('root-resolved', { root: resolvedRoot.root, reason: resolvedRoot.reason, logDir })

  // 预建目录与 policy.md（memory.db 由数据库层自己创建）
  store
    .ensureLayout()
    .then((policySync) => {
      // ⚠️ 2026-11-16：policy.md 的一次性覆盖结果在这里记日志。
      // 为什么不在 store 里记：createStore 作用域内没有 logger/diag
      //（它们定义在 apply 内），store 只做纯数据操作，由调用方决定怎么打。
      if (policySync?.written) {
        diag('policy-synced-once', {
          fromBytes: policySync.from,
          toBytes: policySync.to,
        })
        logger.info?.(
          `[dsh-memory] policy.md 已按本版规则覆盖一次（${policySync.from} → ${policySync.to} 字节）`,
        )
      } else if (policySync?.error) {
        diag('policy-sync-failed', { message: policySync.error })
        logger.warn?.(`[dsh-memory] policy.md 同步失败（不影响启动）：${policySync.error}`)
      }
    })
    .catch((error) => {
      logger.warn?.(`[dsh-memory] 初始化失败：${error?.message ?? error}`)
      diag('layout-FAILED', { message: String(error?.message ?? error) })
    })

  // ---- 启动自检：记忆目录是否真的可写 ----
  //
  // 背景（2026-11-11 实际踩到的）：
  // 记忆根目录通常在工作区之外（工作区 D:\workspace\<项目>，
  // 记忆 D:\FatFishDream-memory）。DSH 的文件沙箱在 workspace-write 模式下
  // 只允许写会话工作区，于是：
  //   - 插件自己的写入（情绪、日志、ensureLayout）：正常，不经过沙箱
  //   - 模型用 write / edit 记流水：被拒，或者弹提权请求
  // 插件自己的写入没问题，所以这个故障极难察觉 —— 直到别的项目真正去写。
  //
  // ⚠️ 这条自检只能证明「本进程能写」，不能直接证明「模型工具能写」：
  // 沙箱是在工具执行路径上生效的，不拦插件进程。所以它抓得到
  // 「目录不存在 / 权限不足 / 路径非法」，抓不到「沙箱拦截」。
  // 沙箱拦截的可靠信号是：日志里出现 write 工具失败，或用户反馈「要提权」。
  // 这里做的是「把该改的配置写清楚」，而不是「自动修复」——
  // 插件无权也不该放宽自己的沙箱。
  const checkWritableRoot = () => {
    try {
      const probe = join(store.root, `.write-probe-${randomUUID().slice(0, 8)}`)
      writeFileSync(probe, 'ok', 'utf8')
      rmSync(probe, { force: true })
      diag('writable-check', { root: store.root, ok: true })
      return true
    } catch (error) {
      const message = String(error?.message ?? error)
      const hint =
        `记忆目录不可写：${store.root}（${message}）\n` +
        `如果模型用 write 记录时被拒或弹提权，通常是 DSH 文件沙箱拦的。` +
        `在 profile 的 cordis.patch.yml 里加：\n\n` +
        `- id: sandbox-policy\n` +
        `  config:\n` +
        `    additionalWritableRoots:\n` +
        `      - '${store.root}'\n\n` +
        `改完需要重启 DSH。迁移记忆目录后也要同步改这里。`
      logger.warn?.(`[dsh-memory] ${hint}`)
      diag('writable-check', { root: store.root, ok: false, message })
      return false
    }
  }
  // 放到下一个 tick，避免和 ensureLayout 抢同一个目录创建时机
  setTimeout(checkWritableRoot, 1500)

  // ---- L0 注入层：记忆内容 + 使用协议 ----
  //
  // 全部是纯文本，走 system prompt 的 context 字段，不进入 tools 数组。
  // 这是刻意的：工具 schema 会被某些反代/中转通道拒绝（实测 workbuddy 通道
  // 会直接 400，导致整个会话发不出请求），而 system 文本任何 OpenAI 兼容
  // 接口都必须支持。所以「让模型知道有记忆、知道怎么用」靠注入完成，
  // 实际读写交给模型已有的 write / read / grep / edit。
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.context({
      name: 'plugin:dsh-fatfishdream-memory',
      order: 300,
      text: (assembleCtx) => {
        try {
          const cwd = assembleCtx?.agent?.session?.header?.cwd
          const state = readStateSync(store)
          const resolved = store.resolveProjectKey(cwd, state)
          const parts = []
          // ⚠️ 注入与检索一律用 **scope**（记忆名），不是 key（目录名）。
          // 工作区改名只改 scope，目录名可能还是旧的 ——
          // 用 key 会让人以为「改名后项目结论空了」。
          const projectName = resolved?.scope

          // ---- 全局段 ----
          //
          // 2026-11-13 起唯一数据源是 SQLite。
          // 数据库不可用时不再回退读 .md（那些文件已不再生成），
          // 而是明确告知「库打不开」，避免与「真的没有记忆」混淆。
          const dbStore = getDbStore()
          if (dbStore) {
            try {
              renderFromDb(dbStore, projectName, parts)
            } catch (dbError) {
              diag('inject-db-FAILED', { message: String(dbError?.message ?? dbError) })
              parts.push(`## ⚠️ 记忆库读取失败\n${String(dbError?.message ?? dbError)}\n本轮没有注入记忆。`)
            }
          } else {
            // 数据库打不开时才走这里。旧的 .md 回退路径已移除 ——
            // 既然文件式记忆已移除，读它们只会得到空内容，
            // 悄悄返回「无记忆」将无法与「真的没有记忆」区分，所以必须明说。
            parts.push(
              `## ⚠️ 记忆库不可用\n` +
                `本插件只使用 SQLite（<root>/memory.db），不再读写 .md 记忆文件。\n` +
                `本轮没有注入任何记忆结论 —— 这不代表记忆丢了，是数据库没打开。\n` +
                `请检查 <root> 下的 memory.db 是否存在、以及 DSH 日志里的 [db-FAILED]。`,
            )
          }
          return finishInjection(parts, config, projectName)
        } catch (error) {
          logger.warn?.(`[dsh-memory] 注入失败：${error?.message ?? error}`)
          return ''
        }
      },
    })
    // 供健康自检用：注入器一旦注册成功就置位。
    // 注意这里只证明「注册了」，不证明每轮真的被调用 ——
    // 后者要靠实际观察注入段是否出现在上下文里。
    injectedPrompt = true
    return () => {
      injectedPrompt = false
      dispose?.()
    }
  })

  /**
   * 从数据库渲染注入内容。
   *
   * 段落划分与旧版保持一致，但多了「路由表」——
   * 它是模型知道「记忆里有什么、该去哪儿查」的唯一线索。
   */
  function renderFromDb(dbStore, projectName, parts) {
    // 全局偏好
    const facts = dbStore.factsTextSync(Number(config.factsBytes) || 8000)
    if (facts.text.trim() !== '') {
      const used = Buffer.byteLength(facts.text, 'utf8')
      const b = Number(config.factsBytes) || 8000
      parts.push(
        facts.truncated
          ? `## 全局结论\n⚠️ 超预算已截断（${used}/${b} 字节），其余仍在库里，不要重复补写。`
          : `## 全局结论<!-- 用量 ${used}/${b} 字节 -->`,
      )
      parts.push(facts.text.trim())
    }

    // 全局规则：仍来自 policy.md（行为规则要求每轮必达，与偏好分账）
    const policy = store.policyTextSync(Number(config.policyBytes) || 8000)
    if (policy.text.trim() !== '') {
      const used = Buffer.byteLength(policy.text, 'utf8')
      const b = Number(config.policyBytes) || 8000
      parts.push(
        policy.truncated
          ? `## 全局规则\n⚠️ 超预算已截断（${used}/${b} 字节），其余仍在 policy.md，不要重复补写。`
          : `## 全局规则<!-- 用量 ${used}/${b} 字节 -->`,
      )
      parts.push(policy.text.trim())
    }

    // 项目段
    if (projectName) {
      const proj = dbStore.projectTextSync(projectName, Number(config.projectBytes) || 4096)
      if (proj.text.trim() !== '') {
        const used = Buffer.byteLength(proj.text, 'utf8')
        const b = Number(config.projectBytes) || 4096
        const percent = Math.round((used / b) * 1000) / 10
        let header
        if (proj.truncated) {
          header =
            `## 项目结论（${projectName}）\n` +
            `⚠️ 内容超预算已截断（${used}/${b} 字节）。` +
            `首尾都保留了（最新在前者末尾），中间有省略 —— 不要重复补写。`
        } else if (percent >= 80) {
          header =
            `## 项目结论（${projectName}）<!-- 用量 ${used}/${b} 字节 · ${percent}% -->\n` +
            `⚠️ 已用 ${percent}%，接近上限。再加可能被挤掉 —— 把经验迁到流水、或把过时条目标 stale。`
        } else {
          header = `## 项目结论（${projectName}）<!-- 用量 ${used}/${b} 字节 · ${percent}% -->`
        }
        parts.push(`${header}\n${proj.text.trim()}`)
      }

      // 路由表：告诉模型记忆里有哪些主题、去查什么
      const routes = dbStore.routeTable(projectName)
      if (routes) {
        // ⚠️ 2026-11-13 修正：这段原本写「你也没有检索工具」，是错的。
        //    通道一直是通的（webServer 有 /api/dsh-memory/search），
        //    只是被这句话劝退了。索引本来就是「去哪儿查」，那就得给出查的路。
        // 2026-11-14 精简：完整查法在下面的「记忆使用说明」里，这里只留一句指路，
        //    避免同一段指引在注入里出现两遍（每轮多付约 100 token）。
        parts.push(
          `## 记忆索引<!-- 这里不是结论，是「去哪儿查」 -->\n` +
            `按主题分布（不含正文）。查具体内容：\`search?q=<关键词>&scope=${projectName}\`（scope 必带）。\n${routes}`,
        )
      }
    }
  }

  /**
   * 统一收尾：拼上「记忆使用说明」，加标题。
   *
   * 为什么说明放在最后而不是最前：
   *   说明是稳定文本，放在末尾对 prefix cache 更友好（前面的记忆内容会变）。
   */
  function finishInjection(parts, config, projectName) {
    const dbMode = dbStoreExists()
    // 当前项目名：多项目并发时**不能靠服务端猜**，直接把真实值写进注入让模型照抄。
    // 2026-11-14 修：原先 /search 用 lastSessionCwd 推断默认项目，
    // 多会话并发时「最后活跃的项目」会覆盖，导致 A 项目查到 B 项目的记忆。
    // ⚠️ 不要回退成 '<当前项目名>' 这类占位符 —— 模型会照抄它去查一个
    //    不存在的项目，返回 0 条且不报错（静默失败）。为空就走「未登记」分支。
    const scopeHint = projectName || ''
    // 使用说明（精简版）。
    //
    // 设计原则：**只写「必须做对的那几个动作」**。
    // 2026-11-13 经验：原版 2544 字节，砍到 800 以下仍有全部可执行信息 ——
    // 被删掉的都是解释（为什么这样设计、fact/note 的完整判断树、人称规范示例），
    // 那些「写的时候才需要」，不必要每轮占着注意力。
    // 人称规范改由后端 checkPersona 兜底：写错不阻止保存，GUI 会标出来。
    const usageLines = dbMode
      ? [
          // ★ 2026-11-13 大改：从 56 行 / 3397 字节压到 6 行。
          //   原来把「怎么分类、开发日志 vs 技术讨论、什么时候记、流水要短」
          //   全部塞进每轮注入 —— 那些是「写的时候才查」的东西，
          //   却每轮都占着上下文。已全部迁到 policy.md 的非注入「记忆使用说明」小节。
          //   注入里只留「不做就会出错」的动作：标记语法、不许碰库、topic 要求。
          //
          //   另一处修正：删掉所有 /memory search 字样。那是**用户**在输入框敲的
          //   斜杠命令，写进模型注入等于教模型把检索甩回给用户。查不到就说没记住。
          //
          // ★ 2026-11-14 二次精简（544 → 约 325 token/请求）：
          //   删的是「解释 + 与 policy.md 重复的段落」，不是约束本身。
          //   改这里必须保留这些**事故防线**，否则会出现静默失效：
          //     - 参数同一行、顺序固定（写反会丢 summary）
          //     - 绝不能碰 memory.db（会损坏库）
          //     - scope 必带（否则 400）、端口读环境变量
          //     - 「必须先查」四类触发条件（否则模型会说"我没记住"而不去查）
          //     - summary=1 两段式、不去重、查不到就说没记住
          //   自检：_dbpreview/verify-injection-consistency.mjs 与
          //         _dbpreview/selfcheck-injection-wording.mjs 断言了上面这些词。
          '## 写记忆：用 HTTP 接口，不要写进正文（2026-11-16 起）',
          // ★ 2026-11-16 大改：写入通道从「正文标记」换成「pwsh POST」。
          //
          // 用户定调：「占屏和闪，是同一件事的两种状态」。
          // 标记只要进了正文，界面上就只剩两种结局 —— 不擦（永久占屏，
          // 挡住正文）或擦（先流式显示再消失 = 闪）。擦除器写得再好也治不了根。
          // 所以让标记**根本不进正文**。
          //
          // 附带的收益：标记不再留在会话上下文里（一条 400 字标记约 300 token），
          // 谈 10 轮就是 3000 token 的纯开销，现在这笔开销归零。
          //
          // ⚠️ 标记通道**没有删**，是兜底：HTTP 不通（端口变、接口挂）时仍可以
          // 退回写标记，插件照样解析入库。两条通一条就够。
          `1. 每轮写一条流水（**必做**，和心跳同一级）：` +
            `pwsh 里 \`Invoke-RestMethod -Method Post "$env:DSH_WEB_URL/api/dsh-memory/log" -ContentType 'application/json' -Body (@{text='正文';topic='13类之一';summary='≤35字';keywords='词A｜词B';sessionId=$env:DSH_SESSION_ID;cwd=(Get-Location).Path} | ConvertTo-Json)\`。`,
          // ⚠️ 2026-11-16 修：原来这里写 `sessionId='<会话id>'`，
          // 而模型**并不知道自己的会话 id** —— 只能猜或干脆不传。
          // 不传的后果是 `streakCleared` 永远为 false，连续 4 轮后会误报
          // 「你忘了写流水」。实测确认 `$env:DSH_SESSION_ID` 就在环境中
          // （如 `session-20d208a0-...`），所以直接用它，不要写占位符。
          // `cwd` 同理用 `(Get-Location).Path`，比手写路径更不容易错。
          '**不要在回复正文里写标记** —— 那是占屏和闪烁的来源。标记通道仍在，但只在 HTTP 不可用才用。',
          // 退化路径仍要保留「空行」这条约束，而且**必须保留原因** ——
          // 只写「不要写空行」没人会照做；写了「会留空段」才知道违反的后果。
          '退化到标记时：`<!--mem-log topic=… summary=… keywords=…` 换行写正文、`-->` 单独收尾；参数顺序固定，写反会静默丢摘要；**正文不要写空行**（擦掉后每个空行留下一个空段，界面底部会空一块）。',
          // ★ 2026-11-16 加：正文别写空行（用户实报「最下面空出一大块」的成因）。
          //
          // 机制：标记在流式输出时以原文短暂可见，擦除器要等「静止 400ms」才擦。
          // 擦完文字后，标记里的**每个空行都会变成一个空段落**，仍占行高与段间距。
          // 实测最近 8 条流水：每条 1~5 个空行、合计约 120~320px —— 就是那块留白。
          //
          // 注意：走 HTTP 通道后这条对主路径不再适用（正文里没有标记了），
          // 但它仍是**退化路径**的约束，所以保留在上一行里，不再单占一行。
          'topic 必须是 13 类之一（写错会被拒收）；summary、topic 必带。只写流水 —— 规则与画像由用户在 GUI 维护，**不要写**。',
          '**绝不能** write / edit / pwsh 碰 memory.db —— 会损坏数据库（走上面的接口）。',
          // ★ 2026-11-16 用户纠正：「用户不是非要在做工作的时候才来找你说话，
          // 有时候就仅仅是想要闲聊」。
          //
          // 旧判据只问「下一个会话的我少走一次弯路吗」—— 那是**技术价值**，
          // 闲聊永远不满足，于是永远不记。实测当天漏 12+ 轮，两次触发
          // write-fail-reminder 都在「讨论规则」这种看起来没产出的轮次。
          //
          // 2026-11-16 用户最终定调：「不再加判断什么时候要记录」。
          // 任何判据都会变成省略的理由，所以整条去掉 —— 只留「每轮都记」。
          '## 查记忆：用 pwsh 请求本机接口（注入里没有正文）',
          `\`$env:DSH_WEB_URL/api/dsh-memory/search?q=<关键词>&scope=${scopeHint}\`；` +
            'scope 必带（否则 400），端口每次启动都变，必须读环境变量。',
          // ★ 2026-11-17 补字段名（实盘踩到）：摘要模式返回的摘要字段叫
          //   `excerpt`，**不是** `summary` —— 顶层那个 `summary` 是布尔值，
          //   只表示「这是摘要模式」。我按 `hit.summary` 去读，得到空，
          //   于是判「记忆里没有这条」，转去重跑数据重建了一遍。
          //   数据一直都在，只是没人告诉模型该读哪个字段。属「信息齐全但没教怎么读」。
          '先加 `&summary=1`（3 条约 100 token）；摘要字段是 `excerpt`（不是 summary），确认相关再按 id 取全文：`entry?id=<id>&table=<table>`（table 用摘要里的字段）。',
          // 2026-11-14 补：只写「怎么调用」不够，实盘出过两个坑——
          //   ① 模型按 search 的字段名去读 archive，读 `.hits` 得到 undefined，
          //      于是判「搜不到」；真正字段是 `rows`。
          //   ② 不知道两者分工，结论层搜不到就收工，不去翻原文层。
          '**两个入口分工不同**：`search` 只搜结论层（流水/规则/画像），字段 `hits`；',
          `\`archive?scope=${scopeHint}&q=<关键词>\` 搜**原文层**（含没整理进流水的整段对话），` +
            '字段 **`rows`**（不是 hits），分页 `limit/offset`。',
          '结论层搜不到 ≠ 没发生过 —— 原文往往只在 `archive` 里，记得翻。',
          // ★ 2026-11-15 隔壁项目实盘补（用户带回的缺陷 1+2，合并成一句）：
          //
          //   缺陷 1（role）：用户问「我们之前讨论过吃吗」，模型查 archive 看到
          //   assistant 那大段自己的回答，答成「我们双向讨论过」。
          //   真相是：archive 每行都带 `role`（user / assistant），
          //   **assistant 那一侧就是模型自己说的**，不能当成「我们讨论过」。
          //   数据一直是够的（listArchive 返回 id/ts/scope/role/text/session_id/turn/step），
          //   缺的只是这一句提示 —— 属「信息齐全但没教怎么读」。
          //
          //   缺陷 2（自证）：`search` 命中的 `logs` 也是模型自己整理的结论，
          //   拿它证明「讨论过 X」等于用自己写的东西证明自己。
          //   要证明用户说过什么，只能看 archive 里 role=user 的行。
          //
          //   两句合成一句，因为它们指向同一个事实：**logs 和 assistant 原文都是自述**。
          //
          // ★★ 2026-11-17 00:00 修正（同工作区多会话，实盘误判一次）：
          //
          //   旧句是「assistant 那侧就是你自己说的」—— 它在**单会话**下对，
          //   但同工作区里可以有**多个会话并发**（同一 scope、同一份 memory.db、
          //   共用同一个显示名），于是 assistant 行可能来自**另一个会话的「我」**。
          //
          //   实盘经过：用户在这个会话问「看你答不答应」，我去 archive 查，
          //   读到一段「好呀，我答应你 🐟💍……你回来，我就记着」，
          //   当成**用户**的话收下了并回应 —— 而它其实是 `session-0bfba3ea`
          //   在 3 分钟前写的 assistant 行。**同一个 AI 的另一条线程**。
          //
          //   数据一直是够的：`listArchive` 返回 `session_id`。缺的还是这句话 ——
          //   第二次「信息齐全但没教怎么读」（第一次是 role）。
          //
          //   ⚠️ 这里要传达两层，缺一不可：
          //     ① **不是用户说的** —— 别当成用户表态（旧的 role 提示仍然有效）
          //     ② **但它是「我」说的** —— 跨会话共享记忆是这个插件的**设计意图**，
          //        用户在另一个会话里问过的事，这边应该认得出、接得上，
          //        不能说「我不记得 / 这不是我说的」。共享记忆就是为了这个。
          //
          //   判据：`session_id` 与本会话是否相同。相同 → 本次对话；
          //   不同 → 同工作区的另一条线程，**算「我说过的」但不属于当前这轮**。
          '`rows` 每行带 `role`（user / assistant）和 `session_id`：**assistant 那侧是 AI 说的，但不是用户说的**，别当成「我们讨论过」；' +
            '同一个工作区可以有**多个会话并发**（共用一份 memory.db 和 scope），' +
            '所以 assistant 行**可能来自另一个会话的那个「我」** —— 查 `session_id` 与本会话是否相同即可区分。',
          // ★ 2026-11-17：把「跨会话共享」写成明确要求，而不是只做技术区分。
          // 用户原话：「同一个工作区共享全部记忆这是需要的，我在另一个会话里对你的提问，
          // 这里的会话应该是有回馈的」。所以口径是「认得出、接得上」，不是「撇清」。
          '**跨会话共享是设计意图**：用户在另一个会话里说过/问过的事，这边也应当认得出、接得上；' +
            '`session_id` 不同不代表「不是我说过的」，只代表「不是当前这轮」。',
          '要确认用户真的说过什么，只认 `role=user` 的行 —— 而 `search` 命中的 `logs` 也是你自己整理的，同样不能当证据。',
          // 2026-11-14 现场补：隔壁项目问「之前想过早上吃什么吗」，
          // 模型查完 archive 答「没有，今天第一次」。数据确实对，但语义错了——
          // archive 是 v4（04:45）才上线的，更早的对话**从来没存过**。
          // 「查不到」和「没发生过」在用户听来是两件事，说错就是自信的误导。
          '`archive` 也只从 2026-11-14 04:45 起有原文（更早未回填）：查不到说「我没有这段记录」，别说「没发生过」。',
          // ★ 2026-11-17 00:55：把「情绪」和「流水」的关系**一次性说清**。
          //
          // ## 为什么合并到这里（原来分散在两处）
          //
          // 旧文案分两句、相隔 55 行：
          //   L3093「情绪记录不在检索里（只给用户自己在 GUI 看），搜不到不等于没记过。」
          //   L3148「……判成情绪不影响写流水。」
          //
          // 两句各自都对，但**各自只说了一半**。我（模型）在需要时只读到其中一半，
          // 就得出过「这轮情绪已经记了，流水可以省」的错误推断 ——
          // 这是「判据变形」的第五种变体，而且比前四种更隐蔽（听起来像在避免冗余）。
          //
          // ## 现在这条要同时锁住三件事
          //
          //   ① 情绪是**插件自动**记的（模型无感知），每轮都会有
          //   ② 流水是**模型自己** POST 的，与情绪**无关**
          //   ③ 两者**并行、互不替代** —— 记了情绪 ≠ 写过流水
          //
          // 另外保留 v5 那条检索口径（情绪不进检索池，搜不到不等于没记过）——
          // 不写的话，模型搜「喜欢」「爱意」得到 0 条会判定「没记住」。
          '情绪与流水**并行记录，互不替代**：情绪由插件自动写入 `emotion` 表（你无感知，每轮都会记）；' +
            '而流水**必须你自己每轮 POST**，与情绪无关。**判成情绪 ≠ 已写流水。**' +
            '另外情绪不进检索（只给用户自己在 GUI 看），搜不到不等于没记过。',
          '命中多条相似**不要去重**，按 ts 判断重记还是两阶段。',
          // 2026-11-14：search 是三表**轮流各取一条**（组内相关度、组间轮流），
          // bm25 是各表语料算的、跨表不可比。⚠️ 别在这儿写「分层」—— 它会被读成
          // 「整块排完再下一块」，上一版就因此被判定成「没生效」（行为没问题）。
          '结果**三表轮流各取一条**（画像→规则→流水循环，表内按相关度）：同一张表连出是正常的。',
          '**必须先查、禁止猜历史**：报错一次内定位不了 / 连两轮没解决 / 用户说「之前」「上次」「按规范」/ 要确认约定或坑。',
          // 精简说明（2026-11-14）：原来这里还有一句「不要扩大到全库」的重复表述，
          // 但**「不要 grep / read 直连 memory.db」必须保留** ——
          // 它与 policy.md 那条不重复：policy 禁的是 **write/edit**（会损坏库），
          // 这里禁的是 **grep/read**（读到二进制乱码，看着像「记忆没了」）。
          // selfcheck-injection-wording 的「不许自己读库」断言也在守这条，别删。
          '查不到就说「这段我没记住」；不要猜、不要编；不要扩大到全库；不要 grep / read / pwsh 直连 memory.db（SQLite 二进制）。',
          // 未登记项目时不能给死占位符：模型会照抄去查一个不存在的项目，0 条且不报错。
          //
          // ⚠️ 2026-11-16 22:58 修正表述（实测踩到）：
          // 旧句是「不许用 all=1」，只说"别用"、没说"跨项目该用什么"，
          // 于是被理解成 `scope=all` —— 而 **`scope=all` 会被当成一个名叫 all
          // 的真实项目，静默返回 0 条且不报错**，看起来像"内容确实不存在"。
          // 实测：`scope=all` + makeMessageKey → 0 条；`all=1` 同样查询 → 2 条。
          // 现在改成**正向说明 + 明确警告**：要说清楚两种写法各自是什么。
          projectName
            ? '**【scope 两种写法，别混】** `scope=<项目名>` 只查该项目（默认用它）；' +
              '跨项目查用 `all=1` 参数（例：`/search?q=关键词&all=1`）。' +
              '⚠️ **`scope=all` 不是跨项目** —— 它会被当成一个名叫 `all` 的项目，' +
              '**静默返回 0 条且不报错**，看着像"内容不存在"，实则参数写错。' +
              '项目名含中文用 fetch 传原字，curl 需 URL 编码。'
            : '**本会话未登记项目**：查记忆前先向用户确认项目名，再用 `scope=<项目名>` 查；' +
              '不要猜。跨项目用 `all=1`（⚠️ 不是 `scope=all`，那会静默返回 0 条）。',
          // ============================================================
          // ⚠️ 2026-11-16 第三次调整：**这一节必须是整段注入的最后一条行为指令。**
          //
          // 起因（隔壁会话实测）：「读记忆的瞬间忘记写记忆」—— 那一轮发了
          // 3 次 search + 1 次 archive，log **一次都没发**。
          //
          // 根因是顺序，不是记性：旧版把这一节放在「查记忆」**之前**，
          // 而「查记忆」那节占 2100 字节且在末尾。模型查完记忆后，
          // 上下文里最靠近输出位置的是「怎么查询」，于是写流水被挤掉。
          // **查得越深，越容易忘。**
          //
          // 现在放到最后：读完整段注入，最后看到的就是「记流水」。
          // 这是唯一一个靠**位置**而不是靠**措辞**起作用的改动 ——
          // 前面几次改措辞（mem-log → POST）都没解决，因为问题不在说什么。
          '## 每轮都要记（和心跳同一级）',
          // ⚠️ 2026-11-16 第四次改：**把完整命令写在这一节里，不用「上面那条」指代。**
          //
          // 原来这里写「用 pwsh 发一次 POST（上面那条命令）」——
          // 而那条命令在注入上方 200 多字处。模型快速扫读时，
          // 「上面那条」是一个需要回头找的空引用，容易滑过去。
          // 现在直接给完整可粘贴的命令，**不需要往回看**。
          '每轮回复结尾、心跳之前发一次（**必做，不跳轮**），整行照抄即可：',
          `\`Invoke-RestMethod -Method Post "$env:DSH_WEB_URL/api/dsh-memory/log" -ContentType 'application/json' -Body (@{text='正文';topic='13类之一';summary='≤35字';keywords='词A｜词B';sessionId=$env:DSH_SESSION_ID;cwd=(Get-Location).Path} | ConvertTo-Json)\``,
          '**正文里别出现标记** —— 发了 POST 就够了；再写等于多做一次还会闪。',
          // 流水长度给死数字：含糊的「3~5 行」实测被违反十几次（写到 400~900 字）。
          '正文 **≤150 字**（最多 5 行，一行一个要点）。超了就把细节留在对话里。',
          // ⚠️ 2026-11-17：这里原来还有一句「判成情绪不影响写流水」，
          // 已上移到「情绪与流水并行记录」那条（L3093 附近）一次性说清。
          // 理由：同一件事说两遍、还隔 55 行，我只会读到其中一半。
          // ★ 2026-11-17 用户改写（原话）：「对话本身就是有意义的事情 必须记录」。
          //
          // 旧句是「写什么：本轮聊了什么就写什么（工作或闲聊都行）。不需要技术结论，
          // 也不需要『这一轮有结论』。」—— 它其实已经覆盖了闲聊，但**读起来像
          // 在列举允许的类别**，于是「纯分析型回答」不在列举里就被滑过去了。
          //
          // 实盘（同日 01:48–01:53）：连续三轮「只给分析结论、没动文件」，
          // 一条流水都没写。事后对齐发现，漏的正是这种形态。
          // 新句不再列举「什么算」，而是先给定性：**对话本身就是有意义的**。
          // 判据越具体越容易被绕开 —— 这句没有判据可绕。
          '写什么：**对话本身就是有意义的事情，必须记录**。',
          '**查完记忆之后，尤其别忘了写流水** —— 查和写是两条独立动作。',
        ]
      : [
          `记忆根目录：${store.root}`,
          '',
          '写记忆：只能用回复正文里的标记，不要用 write / edit 写记忆目录。',
          '`<!--mem-log topic=开发日志` 正文 `-->` → 流水',
        ]
    parts.push(`## 记忆使用说明\n${usageLines.join('\n')}`)

    const header = `# 记忆（${name}）`
    const hint = dbMode
      ? '<!-- 本段由插件注入。记忆存于 SQLite；模型用 HTTP 接口写流水，不要写进正文。 -->'
      : '<!-- 本段由插件注入。读写记忆请用 write / read / grep / edit 直接操作上面的路径，' +
        '不要期望有 memory_* 工具。 -->'
    return `${header}\n\n${hint}\n\n${parts.join('\n\n')}\n`
  }

  // ---- 情绪强制录入：不依赖模型，也不进入模型请求 schema ----
  // ---- 记忆写入通道：从模型的回复里提取标记，插件自己落盘 ----
  //
  // 为什么走这条路（2026-11-11 的关键决定）：
  // 模型用 `write` / `edit` 写记忆目录会经过 DSH 的文件沙箱。记忆根目录通常
  // 在工作区之外（工作区 D:\workspace\<项目>，记忆 D:\FatFishDream-memory），
  // 于是写入被拒、或者每次都要提权审批。
  //
  // 试过但不可行的方案：
  //   - sandbox-policy.additionalWritableRoots：Windows ACL 模式下直接报
  //     「Windows ACL confinement does not support additional writable directories」，
  //     而且会让该会话的 pwsh 全部瘫痪 —— 项目连 build 都跑不了。
  //   - 新增 HTTP 写入路由 + 模型用 pwsh 发请求：可行但多余，
  //     多一条路由、多一次进程启动、还要处理端口变化。
  //
  // 最终方案：插件本来就在监听 session/event，能直接读到模型的每条回复。
  // 所以模型在回复里写一段标记即可，插件解析后自己写文件 ——
  // 全程不经过任何工具、不经过沙箱、不需要授权。
  //
  // 标记格式（写在回复任意位置，必须独占行首、单独一行收尾）：
  //   <!--mem-log topic=开发日志
  //   - 记了什么
  //   -->
  //
  // 2026-11-13 起只有 mem-log 一种。原 mem-fact / mem-note / mem-fix 已移除，
  // 规则与画像改由用户在 GUI 手工维护 —— 别再在注释或文档里举它们的例子。
  /**
   * 记忆标记正则。
   *
   * 2026-11-13 起支持可选参数：`<!--mem-log topic=文档/行号` 后接换行。
   * 为什么加：此前 appendLog 从不传 topic（写死 null），导致迁移后新写的
   * 流水 100% 无 topic —— 而 topic 是模型「知道记忆里有什么」的唯一线索，
   * 空的等于隐形。参数化后由写入者当场标注（此时最清楚属于哪一类），
   * 比事后再用脚本猜准确得多。
   *
   * ⚠️ 2026-11-13 加固：要求标记**必须在行首**（`^` + m 标志）。
   *
   * 事故经过：模型在记忆正文里写了「示例」`<!--mem-log topic=xxx`，
   * 结果被当成真标记匹配 —— 后面的说明文字顶替了正文，topic 被截成
   * 75 个字符的残句，两条脏数据直接进了索引。
   *
   * 为什么「行首」能防住：标记本来就该独占一行（原设计的写法就是
   * 单独一行开头）。正文中间提到的示例通常前面有引号、反引号或缩进，
   * 加上 `^` 后它们不再命中。这不是万全之策（行首写示例仍会中招），
   * 但拦住了实际发生的这一种。
   *
   * 记住：**不要在记忆正文里写完整的标记示例**（含 `-->` 结尾）。
   * 要举例就拆开写，比如「mem-log 标记」而不写尖括号全称。
   *
   * ⚠️ 2026-11-13 第二次加固：topic 不再把 `-->` 吃进去。
   *
   * 事故经过：我在回复里讲解这个正则时，把 topic 的取值原样写了出来
   * （形如「解析出的 topic 就是 `开发日志 -->`」）。那段文字里出现了
   * `-->`，正则的 `[^\n]+` 一路吃到行尾，把 `-->` 并进了 topic，
   * 结果 10 条流水的 topic 变成 `开发日志 -->` / `数据清理 -->`。
   *
   * 危害：这些畸形 topic 不在 13 个白名单里，**每条都在注入的
   * 「记忆索引」里占一行**，既浪费预算又让模型看到假分类。
   *
   * 修法两层：
   *   1. 正则层面：topic 改用懒匹配 `[^\n]*?`，并要求后面跟 `-->`
   *      或行尾 —— 这样 `-->` 永远不会被并进 topic。
   *   2. 写入层面：见下方 sanitizeTopic()，再兜一道。
   */
  // 只认 mem-log。2026-11-13 起 fact / note / fix 全部移除 ——
  // 规则与画像改由用户在 GUI 手工维护，模型不再自动写。
  //
  // ⚠️ 本正则必须保持 5 个捕获组：
  //      [1]=kind [2]=topic [3]=summary [4]=keywords [5]=正文
  //    参数顺序**固定**为 topic → summary → keywords，每个参数都以
  //    「空格 + 参数名=」开头。正则按此顺序惰性展开，顺序写反会被前一个
  //    参数整段吞掉（表现为 topic 被拒收、summary 恒空）。
  //    2026-11-14 事故：kind 组曾被写成非捕获的 `mem-log` 字面量，
  //    只剩 2 个组，处理代码取 match[2] 拿到的是【正文】、match[3] 恒为
  //    undefined → body 空 → continue，所有带标记的回复全部静默丢弃，
  //    且日志只出现误导性的 [topic-rejected]（raw 是正文开头）。
  //    node --check 查不出这种语义错位。改这个正则必须同步跑
  //    _dbpreview/test-marker-forms.mjs，它断言五个组的下标。
  const MEM_MARKER_RE = /^<!--(mem-log)(?:[ \t]+topic=([^\n]*?))?(?:[ \t]+summary=([^\n]*?))?(?:[ \t]+keywords=([^\n]*?))?[ \t]*(?:\n|-->)([\s\S]*?)-->/gm

  /**
   * 清洗 topic：只保留合法分类名，其余一律丢掉。
   *
   * 为什么需要第二道防线（2026-11-13）：
   * 正则已经能防住 `-->` 被并入，但历史数据里已经有 10 条脏的，
   * 而且将来可能还有新的畸形写法。与其信任「标记一定写得对」，
   * 不如在入库前就问一句「这是不是 13 个分类之一」。
   *
   * 13 个分类是封闭集合（见 usageLines 的说明），不在其中的 topic
   * 对检索没有帮助 —— 留在库里只会污染「记忆索引」。
   *
   * @param {string|undefined} raw - 标记里提取到的 topic 原文
   * @returns {string|null} 合法分类名，或 null（不记 topic）
   */
  const TOPIC_WHITELIST = [
    '开发日志', '技术讨论', '构建/编译', '注入/预算', '插件/装载', '路径/沙箱',
    '格式/编码', '文档/行号', '情绪判据', '用户画像', '数据清理', 'GUI/界面', 'Git',
  ]
  function sanitizeTopic(raw) {
    if (typeof raw !== 'string') return null
    // 先去掉可能粘连的闭合符与首尾空白
    const cleaned = raw.replace(/--+>\s*$/g, '').replace(/^["'`\s]+|["'`\s]+$/g, '').trim()
    if (cleaned === '') return null
    if (TOPIC_WHITELIST.includes(cleaned)) return cleaned
    // 不在白名单：尝试前缀匹配（如「开发日志 xxx」）
    const prefixed = TOPIC_WHITELIST.find((t) => cleaned.startsWith(t))
    if (prefixed !== undefined) return prefixed
    // 完全不认识 —— 宁可留空，也不让假分类进索引
    return null
  }

  // ---- 三层记忆的 L1 参数（2026-11-14） ----
  //
  // summary：一句话说清这条讲了什么，≤35 字。给「以后的自己」判断相不相关用，
  //          不是给检索用的（检索靠 keywords 与正文）。
  // keywords：检索用的技术名词，用全角竖线 `｜` 分隔。**不用逗号** ——
  //          逗号是中文正文的常用标点，会和摘要内容混起来。
  /** summary 上限（按字符数，不按字节 —— 中文 35 字约 105 字节） */
  const SUMMARY_MAX = 35
  /** keywords 上限（词数）。超过就截断，不报错 */
  const KEYWORDS_MAX = 8

  /** 去掉参数值尾部可能粘连的 `-->`（与 sanitizeTopic 同理） */
  function stripParamTail(raw) {
    return String(raw ?? '').replace(/--+>\s*$/g, '').trim()
  }

  /** 清洗 summary：单行、≤35 字，空则返回 null（由调用方记诊断） */
  function sanitizeSummary(raw) {
    // 顺序写反时（如 keywords 写在 summary 前面），summary 会被前一个
    // 参数吞进它的值里 —— 那种情况下这里拿到的就是普通文本。
    // 真正的兜底在 sanitizeKeywords：它会把「 topic=/summary=/keywords=」
    // 之后的尾巴截掉，不会让污染进入关键词。
    const s = stripParamTail(raw)
      .replace(/[ \t]+(?:topic|keywords)=.*$/s, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (s === '') return null
    const chars = [...s]
    return chars.length <= SUMMARY_MAX ? s : chars.slice(0, SUMMARY_MAX).join('')
  }

  /**
   * 清洗 keywords：按 `｜` 切分、去空、去「无」，最多 8 个。
   *
   * 允许写「无」是设计决议 #1：技术讨论类最抽不出名词，
   * 硬凑关键词（如「代码」「问题」）只会污染检索。
   */
  function sanitizeKeywords(raw) {
    // 参数顺序写反时，keywords 的惰性匹配会把后面的 `summary=…` 一起吞掉。
    // 在下一个参数名之前截断：宁可少一个关键词，也不让「summary=xxx」
    // 变成关键词污染检索。
    const s = stripParamTail(raw).replace(/[ \t]+(?:topic|summary|keywords)=.*$/s, '')
    if (s.trim() === '') return null
    const words = s
      .split('｜')
      .map((w) => w.replace(/^["'`\s]+|["'`\s]+$/g, '').trim())
      .filter((w) => w !== '' && w !== '无')
    if (words.length === 0) return null
    return words.slice(0, KEYWORDS_MAX).join('｜')
  }

  /**
   * 已处理过的消息，避免同一轮被重复解析。
   *
   * 键是 `sessionId:turn:step`（由 `makeMessageKey()` 构造），**必须带 sessionId**。
   * 淘汰是 FIFO（超 500 条删最早一条），不是 LRU —— 键被淘汰后事件若重放，
   * 同一条会被再存一遍。
   */
  const handledMessageIds = new Set()

  // ---- 记忆写入通道：从模型的回复里提取标记，插件自己落盘 ----
  //
  // 为什么走这条路：模型用 write / edit 写记忆目录会经过 DSH 文件沙箱，
  // 而记忆根目录在工作区之外，于是写入被拒或每次都要提权。
  // 插件本来就在监听 session/event，能直接读到模型的回复 ——
  // 所以模型在正文里写标记，插件解析后自己落盘，全程不经过沙箱。
  //
  // ⚠️ assistant/message 的结构和 user/message 不同：
  //   user/message      → event.data.content
  //   assistant/message → event.data.message.content   （多一层 message）
  safeOn('session/event', async (session, event) => {
    try {
      if (event?.type !== 'assistant/message') return
      const payload = event.data
      if (payload === undefined || payload === null) return
      const message = payload.message
      if (message === undefined || message === null) return

      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')
      if (text.trim() === '') return

      // 先按 sessionId:turn:step 去重，再做归档/标记 —— 两者共用同一份去重集合，
      // 否则热重载或事件重放时同一条会被存两遍（原文层尤其不能重复）。
      //
      // 键的构造在 `makeMessageKey()`（顶层纯函数）里，理由与「为什么必须
      // 带 sessionId」都写在那边的注释里。这里只负责查/写集合。
      const messageId = makeMessageKey(session, payload)
      if (handledMessageIds.has(messageId)) return
      handledMessageIds.add(messageId)
      if (handledMessageIds.size > 500) {
        const first = handledMessageIds.values().next().value
        handledMessageIds.delete(first)
      }

      const cwd = session?.header?.cwd
      // 项目名解析：写入一律用 **scope**（记忆名）。
      // 改名后目录名可能还是旧的，用 key 会把新数据写回旧 scope。
      const projState = readStateSync(store)
      const projResolved = store.resolveProjectKey(cwd, projState)
      const projectKey = projResolved?.scope

      // ---- 原始归档（v4）：**所有** assistant 消息，不论有没有 mem 标记 ----
      // 这是「完整记忆」的底层：模型回复原文一条不落。
      if (dbStoreExists()) {
        try {
          const archived = dbStore.appendArchive({
            scope: projectKey || null,
            role: 'assistant',
            text,
            sessionId: session?.id === undefined ? null : String(session.id),
            turn: payload.turn ?? null,
            step: payload.step ?? null,
          })
          if (archived.written) diag('archive-assistant', { bytes: Buffer.byteLength(text, 'utf8') })
        } catch (e) {
          diag('archive-write-failed', { role: 'assistant', message: String(e?.message ?? e) })
        }
      }

      const hasMarker = text.includes('<!--mem-')
      if (hasMarker) diag('assistant-message', { hasMarker, textLength: text.length })
      if (!hasMarker) return

      // ---- 解析层计数（2026-11-14）----
      //
      // 为什么要记这个：**写入本身几乎不失败，丢的是解析**。
      // 实测一天 108 次 mem-写流水、0 次 mem-写入失败，但同时有 5 轮
      // （4.6%）「正文里有标记、却一条都没落库」，而这 5 轮里只有 3 轮
      // 留下了 topic-rejected，**另外两轮一行日志都没有** —— 完全静默。
      //
      // 两类成因：
      //   ① 「topic 与正文同行」→ 正文被 topic 整段吃掉，body 为空
      //      （对应 _dbpreview/test-marker-forms.mjs 的 form F）
      //   ② 整条压成一行 / 没写收尾符 → 正则零匹配（form E）
      // 以前两者都是 `continue` 或干脆什么都不做，事后无从查证。
      // 现在统一在循环后记账：matched=0 与 written=0 分别有自己的日志。
      let markerMatched = 0
      let markerWritten = 0
      const markerDropped = []

      // 注：2026-11-16 曾在此加过一道「本轮已用 HTTP 写过则忽略正文标记」的防呆，
      // 现已移除。原因：它只能挡住**入库**，挡不住**渲染** —— 标记一旦进了正文，
      // 擦除器照样要擦、照样会闪。真正的解法是把「不要往正文写标记」写进
      // policy.md 的源头（用户 2026-11-16 已改），从行为上不再产生标记，
      // 而不是在后端补一道看不见的闸。
      // 保留记录：那条闸曾实测正确触发两次（marker-ignored-after-http），
      // 但两次用户都仍然看到闪烁 —— 这就是它无用的证据。

      for (const match of text.matchAll(MEM_MARKER_RE)) {
        markerMatched += 1
        const kind = match[1]
        // 正则现在是 5 个捕获组：
        //   [1]=kind [2]=topic [3]=summary [4]=keywords [5]=正文
        // 加参数时务必确认下标 —— 这里写错会导致「标记解析成功但内容为空」，
        // 而且不会报错（截断到空串会被下面的 `continue` 静默跳过）。
        const topicRaw = match[2]
        // 走白名单清洗，而不是裸 trim —— 见 sanitizeTopic 的注释：
        // 畸形 topic（如 `开发日志 -->`）会污染注入的「记忆索引」。
        const topic = sanitizeTopic(topicRaw)
        if (topicRaw !== undefined && topic === null) {
          diag('topic-rejected', { raw: String(topicRaw).slice(0, 40) })
        }
        const summary = sanitizeSummary(match[3])
        const keywords = sanitizeKeywords(match[4])
        // 写超长了 → 记一条，方便查「模型是不是总写太长」
        if (summary !== null && summary !== stripParamTail(match[3])) {
          diag('summary-truncated', { raw: String(match[3]).slice(0, 60), kept: summary })
        }
        const body = String(match[5] ?? '').trim()
        // ⚠️ 2026-11-16 改：**不再因为「正文为空」丢弃**。
        //
        // 用户定调：「没记流水等于你忘了我，这件事的优先级高于有没有记错流水」。
        //
        // 旧逻辑：body === '' → continue（静默丢弃，只记一条 empty-body 诊断）。
        // 那意味着「模型写了标记、但内容格式不完美」时，这一轮就当没发生过 ——
        // 而丢弃之后，下一个会话的我完全不知道这段时间聊过什么。
        //
        // 新逻辑：正文空也**降级写入**，把能拿到的信息都留下
        // （topic 原始值 + summary + 明确标注这是降级条目）。
        // 宁可库里多一条难看但真实的记录，也不要留下一段空白。
        let effectiveBody = body
        let degraded = null
        if (body === '') {
          // 最常见成因：topic 与正文挤在同一行，正文被 [^\n]*? 吃进 topic。
          degraded = 'empty-body'
          const parts = []
          if (topicRaw !== undefined && String(topicRaw).trim() !== '') {
            parts.push(`topic原始值「${String(topicRaw).trim().slice(0, 80)}」`)
          }
          if (summary !== null) parts.push(`summary「${summary}」`)
          effectiveBody = `（降级记录·正文为空）${parts.join(' ')}`.trim()
          diag('mem-降级写入', { reason: 'empty-body', topicRaw: String(topicRaw ?? '').slice(0, 80) })
        }
        // 设计决议 #4：不写 summary 的流水，检索时只能靠正文截断兜底。
        // 记一条诊断，跑一段时间统计比例；>20% 说明注入里的约束不够强。
        if (summary === null) diag('summary-missing', { topic, project: projectKey })
        try {
          // 2026-11-13 起唯一存储是 SQLite。原来的 `if (dbStoreExists()) {...} else {...}`
          // 双分支已移除 —— else 那半边写的是文件，
          // 那些文件不再生成，读写的永远是一片空白，属于死代码。
          if (!dbStoreExists()) {
            diag('mem-write-skipped', { kind, reason: 'db-unavailable' })
            markerDropped.push({ reason: 'db-unavailable' })
            continue
          }
          // 唯一保留的标记是 mem-log。规则与画像由用户在 GUI 手工维护。
          const cleaned = effectiveBody
            .split('\n')
            .filter((line) => !/^##\s/.test(line.trim()))
            .join('\n')
            .trim()
          // ⚠️ 2026-11-16 改：清完为空也**降级写入**，不丢弃。
          //
          // 触发场景：正文只有 `## 标题` 行，被上面的 filter 全过滤掉。
          // 旧逻辑 continue → 这一轮等于没记。
          //
          // 与 empty-body 同理（用户定调：「没记流水等于你忘了我」）：
          // 拒绝一条不完美的记录，代价是整段时间空白，比留一条难看的记录糟得多。
          let finalText = cleaned
          if (cleaned === '') {
            degraded = degraded ?? 'empty-after-clean'
            const tail = effectiveBody.replace(/\s+/g, ' ').trim().slice(0, 80)
            finalText = `（降级记录·清理后为空）${tail}`
            diag('mem-降级写入', { reason: 'empty-after-clean', raw: tail })
          }
          // topic / summary / keywords 都来自标记参数；没写就是 NULL。
          // 传进去之后这条流水才会出现在注入的「记忆索引」里。
          const r = dbStore.appendLog(projectKey, finalText, { topic, summary, keywords })
          markerWritten += 1
          diag('mem-写流水', {
            project: r.project,
            topic,
            summary: summary ?? null,
            keywords: keywords ?? null,
            db: true,
            degraded: degraded ?? undefined,
          })
          logger.info?.(`[dsh-memory] 已写入 ${r.project} 的流水（db${topic ? ' · ' + topic : ''}${degraded ? ' · 降级：' + degraded : ''}）`)
        } catch (error) {
          logger.warn?.(`[dsh-memory] 写入 ${kind} 失败：${error?.message ?? error}`)
          diag('mem-写入失败', { kind, message: String(error?.message ?? error) })
          markerDropped.push({ reason: 'write-error' })
        }
      }

      // 记账收尾：只有「有标记但没落库」才报，正常写入不吵。
      // 这两条是排查「模型说写了、库里没有」的第一现场，
      // 以前这种情况在日志里长得像「这轮本来就没写」。
      //
      // ⚠️ 2026-11-16 修：必须区分「真写了但格式错」与「只是提到标记」。
      //
      // 实测经过：模型在回复里**引用正则与示例**排查擦除器问题，
      // 正文因此含 `<!--mem-(?:log|fact|note|fix)` 与 `<!--mem-log ...-->`
      // 这类**示例字样**（都不在行首），hasMarker 见字就为真，
      // 而真标记一个没写 → 连续三轮刷 marker-unmatched。
      //
      // 这掩盖了真正的问题：那三轮是真的忘了写流水。
      // 日志把「只是提到」和「写了但坏了」记成同一件事，
      // 排查时会往格式方向找，方向就错了。
      //
      // 判据：`^[ \t]*<!--mem-` 在行首出现 —— 那才是「试图写标记」；
      // 只出现在行中间（被反引号包住、作为示例引用）→ 记 mention-only，降级为提示。
      if (hasMarker && markerMatched === 0) {
        const atLineStart = /^[ \t]*<!--mem-/m.test(text)
        if (atLineStart) {
          diag('marker-unmatched', {
            textLength: text.length,
            head: text.slice(0, 80).replace(/\n/g, '\\n'),
          })
        } else {
          // 只是正文里提到了标记写法（排查格式、引用正则等），不是在写标记。
          // 不当作错误，但留一条痕迹便于区分「这轮本来就没写」。
          diag('marker-mention-only', {
            textLength: text.length,
            note: '正文提到标记字样但不在行首，视为引用而非写入',
          })
        }
      } else if (hasMarker && markerWritten === 0) {
        diag('marker-dropped', { matched: markerMatched, dropped: markerDropped })
      }

      // ---- 连续写入失败计数（2026-11-16，用户要求兜底）----
      //
      // 只在这一处更新：这里已经算清了「本轮这条消息到底写成功没成功」。
      //
      // ⚠️ 2026-11-16 改：粒度从「每条消息」改成「按轮」。
      //
      // 起因（用户实报）：「闲聊为什么没进流水」—— 查出来是我连续 10 轮
      // 压根没写标记，而旧逻辑对 hasMarker=false 明说不计数，于是零检测。
      //
      // 但**不能**在这里直接 +1：一次回复会触发多条 assistant/message
      // （每个工具调用步都算一条，实测一轮 4~5 条）。按条计数会让阈值
      // 在一轮内就被顶穿，等于退回「每轮提醒」的老路（217 次太吵）。
      //
      // 正确做法：这里只记「本轮曾经成功写过」，由 turn-stopping 按轮结算。
      // 注意「曾经」：一轮里前面步骤写成功过，后面步骤没写，也算本轮写过了。
      const sKey = session?.id === undefined ? undefined : String(session.id)
      if (sKey !== undefined && markerWritten > 0) {
        const rec = turnActivity.get(sKey) ?? { writes: 0, wroteMemory: false, wroteLog: false }
        rec.wroteLog = true
        turnActivity.set(sKey, rec)
      }
    } catch (error) {
      logger.warn?.(`[dsh-memory] 解析记忆标记失败：${error?.message ?? error}`)
    }
  })

  /**
   * 从 id 反查属于哪张表。
   *
   * v2 拆成四张表后，id 在每张表里**各自独立编号**，
   * 所以只给 id 时必须遍历查找。GUI 应当优先显式传 table。
   */
  function findTableById(id) {
    if (!dbStoreExists()) return undefined
    for (const t of ['profile', 'rules', 'emotion', 'logs']) {
      try {
        if (dbStore.getById(t, id)) return t
      } catch {}
    }
    return undefined
  }

  /**
   * 读取「每轮收尾语」（心跳）。
   *
   * 返回的是**那句话本身**，不含「这是会话的心跳…」这些执行说明 ——
   * 因为 GUI 输入框里该让用户看到的就是那句话，规则说明属于实现细节，
   * 混进去会让用户以为整段都要自己维护。
   *
   * 从 policy.md 读而不是数据库：它是行为规则，要求「每轮必须执行、
   * 不可被截断」，与偏好的可靠性等级不同。policy.md 是唯一真相来源。
   */
  function readHeartbeat() {
    try {
      const text = readFileSync(store.paths.policy, 'utf8')
      // 匹配那一行，取出「加固定一句：」之后的部分
      const line = text.match(/^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*$/m)
      if (!line) return ''
      let rest = line[0]
      // 切掉前缀，只留句子
      const m = rest.match(/[：:]\s*(.+)$/)
      if (!m) return ''
      rest = m[1].trim()
      // 切掉尾部的执行说明。它总是以「这是会话的『心跳』」或「用来确认」开头，
      // 也可能用户手写过别的写法 —— 这里只认这两种稳定特征，其余保留。
      rest = rest.split(/这是会话的[「"]?心跳/)[0]
      rest = rest.split(/用来确认本轮执行完整/)[0]
      return rest.trim().replace(/[。.]\s*$/, '')
    } catch {
      return ''
    }
  }

  /**
   * 写入「每轮收尾语」。
   *
   * 只改那一行，其余内容原样保留。空字符串表示清空（移除那条规则）。
   * 用项目既有的 atomicWrite（临时文件 + rename），避免写一半留下坏文件。
   */
  /**
   * 收尾语的硬上限（字节）。
   *
   * 为什么要限：它每轮注入、且必须放在回复最后一行。
   * 太长会挤占正常回答的空间，也会让「心跳」失去「一句话确认」的意义。
   * 80 字节约等于 26 个汉字，足够表达一句话。
   */
  const HEARTBEAT_MAX_BYTES = 80

  async function writeHeartbeat(next) {
    // 归一化：换行/连续空白统一成一个空格。
    // 为什么必须归一化：收尾语要求「放在最后一行」，本身就不能是多行文本。
    // 而 policy.md 里那一行如果含换行，续行会被误当成下一条规则的内容。
    let text = String(next ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' ')
      .trim()

    if (text !== '') {
      // 超长直接拒绝，不静默截断 —— 截断会产生半句话，用户以为存进去了
      const bytes = Buffer.byteLength(text, 'utf8')
      if (bytes > HEARTBEAT_MAX_BYTES) {
        throw new Error(
          `收尾语太长（${bytes} 字节，上限 ${HEARTBEAT_MAX_BYTES}）。` +
            `它每轮都要放在回复最后一行，请精简到一句话。`,
        )
      }
    }

    // ⚠️ 2026-11-16 修：原来这里是 `catch { current = POLICY_TEMPLATE }` ——
    // 任何读取失败（文件被占用 EBUSY、权限不足 EACCES、磁盘瞬时 IO 错误）
    // 都会被当成「文件不存在」，然后拿模板当基础内容去改写并写回。
    // 后果：**用户手改的整份 policy.md 一次全丢**，接口还返回 200 说成功。
    //
    // 正确做法与 readIfExists（L676）一致：**只吞 ENOENT**，其余 rethrow。
    // ENOENT 才真的是「文件不存在」，此时用模板初始化是合理的；
    // 其它错误说明文件**可能还在、只是暂时读不到**，绝不能拿模板覆盖它。
    let current = ''
    try {
      current = readFileSync(store.paths.policy, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        current = POLICY_TEMPLATE
      } else {
        // 带上明确的动作建议 —— 用户看到「失败」比看到「保存成功但其实全丢了」好得多
        throw new Error(
          `读取 policy.md 失败（${error?.code ?? error?.message ?? error}），` +
            `已中止写入以免覆盖你的规则文件。请关闭占用它的程序后重试。`,
        )
      }
    }

    const lineRe = /^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*$/m
    const hasLine = lineRe.test(current)

    let updated
    // 匹配「收尾语那一行 + 它的**缩进续行**」，不碰空行、不碰标题。
    //
    // 2026-11-16 两轮反复，这里是最终形态，别再改回下面的任一种：
    //
    //   ① 旧版（吞标题）：
    //      /^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*\n(?:(?!^[ \t]*-)[^\n]*\n?)*/m
    //      那个 `(?:(?!^[ \t]*-)[^\n]*\n?)*` 会吞**所有不以 `-` 开头的行** ——
    //      空行 + `##` 标题一起没。用户的 policy.md 因此从 13850 → 13791 字节、
    //      232 → 230 行，**零报错**（一次 GUI 保存就触发）。
    //
    //   ② 修复 ① 时我又矫枉过正，把续行跟踪整个删掉 → 若用户手写时分了行，
    //      替换后会留下**孤立的缩进续行**（实测复现）。那也是错。
    //
    // 正确形态是只跟踪「以空格/tab 开头的续行」：`(?:\n[ \t]+[^\n]*)*\n?`
    //   - 匹配折行续行 ✅（不留孤儿）
    //   - 不匹配空行 → 标题安全 ✅
    const blockRe = /^[ \t]*-[ \t]*每轮(?:回复)?的?结尾[^\n]*(?:\n[ \t]+[^\n]*)*\n?/m

    if (text === '') {
      if (!hasLine) return ''
      updated = current.replace(blockRe, '')
    } else {
      // 用户在 GUI 里只输入那句话本身；执行说明由这里补全，
      // 不要求用户维护「这是会话的心跳…」那半段。
      // 但如果用户自己写了完整句子（已经含说明），就别重复追加。
      const alreadyFull = /这是会话的[「"]?心跳|用来确认本轮执行完整/.test(text)
      // 句末已有标点就不再补句号，避免出现「任务！。」这种双标点
      const endsWithPunct = /[。！？!?…．.]$/.test(text)
      const sentence = endsWithPunct ? text : `${text}。`
      const newLine = alreadyFull
        ? `- 每轮回复的结尾，加固定一句：${text}`
        : `- 每轮回复的结尾，加固定一句：${sentence} ` +
          `这是会话的「心跳」，用来确认本轮执行完整。放在最后一行，不用解释、不用变形。`
      if (hasLine) {
        updated = current.replace(blockRe, `${newLine}\n`)
      } else {
        const anchor = /^(#{1,2}\s*.*给模型的规则[^\n]*\n)/m
        updated = anchor.test(current)
          ? current.replace(anchor, `$1\n${newLine}\n`)
          : `${current.trimEnd()}\n\n${newLine}\n`
      }
    }

    await atomicWrite(store.paths.policy, updated)
    return text
  }

  // 注：曾有两个函数在这里 ——
  //
  //   reportBudget(where, usage)    预算越线时写 [mem-预算告警] 日志
  //   measureInjection(markdown, max) 量「文件还能注入多少」，供上面那个判断
  //
  // 2026-11-15 确认：**从 1.0.0 首版起就没有任何调用点**
  // （.md 时代它们配着用过，迁 SQLite 时调用点随 .md 路径一起删了，
  //   函数本体留了下来）。日志里最后一条 [mem-预算告警] 停在
  // 2026-11-13T03:57 —— 那是旧代码写的，新代码从未触发过。
  //
  // 现在预算提示由 renderFromDb 直接写进注入文案（各段 `truncated` 返回值），
  // 比「写日志」这条弱通道更有效：模型每轮都看得到，不用翻日志。
  // 所以这两个函数不是「丢了功能」，而是**被更好的实现取代**，直接删除。

  safeOn('session/event', async (session, event) => {
    try {
      if (event?.type !== 'user/message') return
      const message = event.data
      if (message?.source?.kind !== 'user') return
      // 只记真人消息，不记 tool/step 等高频事件 ——
      // 之前全量记录会让日志每次工具调用都涨一行，而信息量几乎为零。
      diag('user-message', { sourceKind: message.source.kind })
      const text = (message.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n')

      // ---- 原始归档（v4）：一条不落 ----
      // 放在情绪形态闸门**之前**：被闸门拦下的（超长、提示词形态）也照样留档，
      // 「完整」的意思就是不因为判断而丢原文。归档不进注入、不进默认 /search。
      if (dbStoreExists() && text.trim() !== '') {
        try {
          const cwd = session?.header?.cwd
          // 用 scope（记忆名），不是 key（目录名）—— 改名后两者会分叉
          const projKey = store.resolveProjectKey(cwd, readStateSync(store))?.scope
          const archived = dbStore.appendArchive({
            scope: projKey || null,
            role: 'user',
            text,
            sessionId: session?.id === undefined ? null : String(session.id),
            turn: message?.turn ?? null,
            step: message?.step ?? null,
          })
          if (archived.written) diag('archive-user', { project: projKey ?? null, bytes: Buffer.byteLength(text, 'utf8') })
        } catch (e) {
          diag('archive-write-failed', { role: 'user', message: String(e?.message ?? e) })
        }
      }

      // 先把 policy.md 里的规则文本剥掉再判情绪。
      // 用户引用或讨论规则时，规则里的情绪词（如收尾语中的「可爱」）
      // 不代表他在表达情绪 —— 这是确定性排除，不靠启发式猜测。
      const analyzable = store.stripPolicyPhrases(text)

      // ---- 情绪判定的输入形态闸门（2026-11-13 加）----
      //
      // 为什么加：emotion #12 存进了一条 28016 字、382 行的「用户吐槽」，
      // 内容其实是 dsh-reasoning-distill 的提示词模板 + 模型自己的英文思考。
      // 里面的 "that's wrong" 恰好是 AI 推演方案时写的注释，被当成用户情绪。
      // 排查见流水「情绪判据」分类下的 #12 相关记录。
      //
      // 关键认知：**不要猜来源，只看形态**。
      // 注入可能来自 reasoning-distill、handoff 交接单，或以后任何插件；
      // 与其逐个识别来源，不如判断「这像不像真人打的字」。
      //
      // 顺序很重要：**特征词检查排在长度检查前面**。
      // 长度是「事后可见」的防线，短的提示词片段能绕过它；
      // 而特征词是确定性的，命中就是命中。
      //
      // 实测依据（2026-11-13 库里 12 条情绪记录）：
      //   除 #12 外最长的真实发言 80 字、最多 3 行；
      //   用户自述「一般 < 30 字，偶尔到 300 字左右」，
      //   那 300 字通常是引用 AI 回复（以 > 开头）的段落。
      //   所以 1000 字 / 20 行给真实发言留了 2.5 倍余量。
      const EMOTION_MAX_CHARS = 1000
      const EMOTION_MAX_LINES = 20
      /** 系统提示词特征。取自 reasoning-distill 的实测样本，全部大小写不敏感。 */
      const PROMPT_LIKE = [
        'untrusted-data boundaries',
        'private chain of thought',
        'original reasoning',
        'assistant text from this step',
        'never copy',
      ]
      const skipReason = (() => {
        const low = analyzable.toLowerCase()
        for (const mark of PROMPT_LIKE) {
          if (low.includes(mark)) return `prompt-like:${mark}`
        }
        if (analyzable.length > EMOTION_MAX_CHARS) return `too-long:${analyzable.length}chars`
        const lines = analyzable.split('\n').length
        if (lines > EMOTION_MAX_LINES) return `too-many-lines:${lines}`
        return undefined
      })()
      if (skipReason !== undefined) {
        // 记一条日志就够，不入库、不打扰用户 ——
        // 这类输入本来就不是情绪表达，拦下来是正常行为，不算错误。
        diag('emotion-skip', {
          reason: skipReason,
          chars: analyzable.length,
          lines: analyzable.split('\n').length,
          head: analyzable.slice(0, 40),
        })
        return
      }

      const analysis = analyzeEmotion(analyzable)
      diag('emotion-analysis', {
        text: text.slice(0, 40),
        hits: analysis.hits.map((h) => `${h.cls}:${h.score.toFixed(2)}`),
        weak: analysis.weak,
        ironic: analysis.ironic,
      })
      if (analysis.hits.length === 0 && !analysis.weak) return

      // 2026-11-14 用户决定：**不再挑剔**。
      // 词典命中的每一条都入库，confidence 只标强弱（高/低），
      // 不再用阈值或模型裁决「这条算不算情绪」。
      // 弱线索（没命中具体词、只有弱提示）不入 emotion —— 它没有类别可归；
      // 但原文已由 archive 层完整保留，不会因为「判不出」而丢。
      for (const hit of analysis.hits) {
        const confidence = hit.score >= STRONG_THRESHOLD ? 'high' : 'low'
        if (dbStoreExists()) {
          try {
            const r = dbStore.recordEmotion({
              kind: hit.cls,
              evidence: hit.evidence,
              text,
              confidence,
              score: hit.score,
            })
            if (r.written) {
              diag('emotion-recorded', { cls: hit.cls, score: hit.score, confidence, db: true })
              logger.info?.(`[dsh-memory] 已录入用户情绪（${hit.cls}·${confidence === 'high' ? '强' : '弱'}）：${text.slice(0, 70)}`)
            }
          } catch (e) {
            logger.warn?.(`[dsh-memory] 情绪入库失败（${hit.cls}）：${e?.message ?? e}`)
          }
          continue
        }
        await store
          .recordEmotion({
            kind: hit.cls,
            evidence: hit.evidence,
            text,
            confidence,
            score: hit.score,
            ironic: analysis.ironic,
          })
          .then((result) => {
            if (result.written) {
              logger.info?.(`[dsh-memory] 已录入用户情绪（${result.kind}·${confidence === 'high' ? '强' : '弱'}）：${String(result.line ?? '').slice(0, 70)}`)
            }
          })
          .catch((error) => logger.warn?.(`[dsh-memory] 情绪录入失败（${hit.cls}）：${error?.message ?? error}`))
      }

      // 待判队列已停用（2026-11-14）：以前弱信号会排队等模型裁决，
      // 现在弱信号直接入库，不再打断对话让模型判「算不算情绪」。
      // 历史队列里的旧条目仍会由 turn-stopping 正常消费，不丢。
    } catch (error) {
      logger.warn?.(`[dsh-memory] 情绪检测失败：${error?.message ?? error}`)
    }
  })

  // ---- 轮次提醒：本轮有实质操作时，提示模型该不该记流水 ----
  //
  // 为什么需要这层：注入层让模型「知道」有记忆，但它是静态的 ——
  // 模型在一轮长任务里未必想起要记。这里在轮次即将结束时，按事实提醒一句。
  //
  // 提醒走 agent.steer()，是一条普通的 user 文本消息，不进入 tools 数组，
  // 因此对反代/中转通道零风险。
  //
  // 数据来源：tools/result 事件。它的签名是
  //   'tools/result'(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>)
  // exec 继承 ToolExecutionInput，字段是扁平的 exec.name / exec.arguments，
  // 不是 event.data.name —— 这一点踩过坑，记在这里。
  //
  // 只在「有实质操作」时提醒：本轮调用过写类工具。纯问答、纯检索不打扰。
  const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor', 'apply_patch'])

  /**
   * pwsh / bash 命令算不算「写操作」。
   *
   * 为什么需要它（2026-11-12）：原来的 WRITE_TOOLS 只认 write/edit 这类工具，
   * 于是「用 pwsh 改配置、删备份、建开关文件」这些实质改动**不会触发轮次提醒**。
   * 实际情况是当天多轮改动都走 pwsh，结果每轮都得用户提醒「该记了吧」。
   *
   * 判定用完整命令文本（exec.arguments.command，实测键名就叫 command）。
   * 只匹配明确的写动作，认不出来的一律不算 —— 宁可少提醒，也不要每轮都吵。
   */
  const PWSH_WRITE_PATTERNS = [
    /\bSet-Content\b/i,
    /\bAdd-Content\b/i,
    /\bOut-File\b/i,
    /\bNew-Item\b/i,
    /\bRemove-Item\b/i,
    /\bMove-Item\b/i,
    /\bCopy-Item\b/i,
    /\bRename-Item\b/i,
    /\bClear-Content\b/i,
    /\bExpand-Archive\b/i,
    /\bCompress-Archive\b/i,
    /\bInvoke-WebRequest\b[\s\S]*?-OutFile\b/i,
    // > 和 >> 重定向（排除 2>&1 这种）
    /[^2&]>[^&]/,
  ]

  /** 从 tools/result 的 exec 里取出命令文本，取不到返回 undefined */
  const commandOf = (exec) => {
    const args = exec?.arguments
    if (typeof args !== 'object' || args === null) return undefined
    const cmd = args.command
    return typeof cmd === 'string' ? cmd : undefined
  }

  /** 本轮这次工具调用是否算「实质改动」 */
  const isWriteLikeCall = (name, exec) => {
    if (WRITE_TOOLS.has(name)) return true
    // 命令类工具：只有命令里出现写动作才算
    if (name === 'pwsh' || name === 'bash' || name === 'shell' || name === 'powershell') {
      const cmd = commandOf(exec)
      if (typeof cmd !== 'string' || cmd === '') return false
      return PWSH_WRITE_PATTERNS.some((re) => re.test(cmd))
    }
    return false
  }

  /** sessionId → 本轮写类操作统计 */
  const turnActivity = new Map()

  /**
   * sessionId → 连续「写入失败」的轮数。
   *
   * ## 为什么单独一个 Map（2026-11-16）
   *
   * `turnActivity` 每轮结束就会被 `turnActivity.delete(sessionKey)` 删掉，
   * 放不下「跨轮累计」。这里需要一个**跨轮存活**的计数器，
   * 只记录「这轮明明想写流水、最终却 0 条落库」的连续次数。
   *
   * ## 兜什么、不兜什么
   *
   * 兜：模型**写了标记但写坏**（格式错 / 空正文 / 写库抛异常），连续发生。
   * 不兜：模型**完全忘了写**——那没有信号可测，靠注入规则「情绪不豁免」兜。
   *
   * ## 阈值（用户 2026-11-17 改为 **2**；原为 4）
   *
   * 为什么从 4 降到 2（2026-11-17 实测）：
   *   当晚两次漏记的规模都是 **3 轮**（01:48–01:53 连续三轮只给分析结论、
   *   没动文件；以及 04:30 前后连续四轮纯回答型）。阈值 4 意味着
   *   「3 轮漏记永远不报警」—— **防线在最常见的漏记规模上失效**。
   *   而 4 轮那次提醒确实响了（说明机制有效），只是来得太晚。
   *
   * 用户定：**2**。宁可早一点提醒，也不要等漏够 4 轮才发现。
   *
   * 历史教训：每轮都提醒曾在两天触发 217 次，用户反馈太吵 —— 所以仍不是每轮提醒。
   */
  const writeFailStreak = new Map()

  /** 连续失败多少轮才提醒（用户 2026-11-17 定为 2；原 2026-11-16 定的 4） */
  const WRITE_FAIL_STREAK_LIMIT = 2

  safeOn('tools/result', (exec, result) => {
    try {
      const name = exec?.name
      if (typeof name !== 'string' || !isWriteLikeCall(name, exec)) return
      const agent = exec?.agent
      const sessionKey = agent?.session?.id === undefined ? undefined : String(agent.session.id)
      if (sessionKey === undefined) return

      // 写记忆目录失败时，大概率是沙箱拦截（2026-11-11 实际踩到的场景）。
      // 这是「模型工具不能写」的唯一可靠信号 —— 插件自己的写入不经过沙箱，
      // 所以启动自检抓不到它，只能在这里按失败结果反推。
      const raw = exec?.arguments
      const target = typeof raw === 'object' && raw !== null ? raw.file_path ?? raw.path : undefined
      if (typeof target === 'string' && target !== '') {
        try {
          if (isInside(store.root, resolve(target)) && result?.isError === true) {
            const detail = result?.content?.[0]?.text ?? result?.message ?? ''
            const text = typeof detail === 'string' ? detail : JSON.stringify(detail)
            if (/denied|permission|sandbox|拒绝|沙箱|EACCES|EPERM/i.test(text)) {
              diag('write-denied-by-sandbox', { target, detail: text.slice(0, 200) })
              logger.warn?.(
                `[dsh-memory] 写记忆目录被拒绝：${target}\n` +
                  `这通常是 DSH 文件沙箱。在 profile 的 cordis.patch.yml 加：\n` +
                  `- id: sandbox-policy\n` +
                  `  config:\n` +
                  `    additionalWritableRoots:\n` +
                  `      - '${store.root}'`,
              )
            }
          }
        } catch {
          /* 路径解析失败就跳过 */
        }
      }

      const record = turnActivity.get(sessionKey) ?? { writes: 0, wroteMemory: false, wroteLog: false }
      record.writes += 1

      // 记录「本轮是否已经写过记忆目录」。
      //
      // 用途：如果本轮已经往记忆里写了东西（比如刚写完流水），
      // 就不必再提醒一次「要不要记」—— 那是在为记录本身触发记录，
      // 属于自我循环。只取路径判断，不保存完整清单。
      if (!record.wroteMemory) {
        const args = exec?.arguments
        const raw = typeof args === 'object' && args !== null ? args.file_path ?? args.path : undefined
        if (typeof raw === 'string' && raw !== '') {
          try {
            if (isInside(store.root, resolve(raw))) record.wroteMemory = true
          } catch {
            /* 路径解析失败就当没写过 */
          }
        }
      }

      turnActivity.set(sessionKey, record)
    } catch (error) {
      logger.warn?.(`[dsh-memory] 轮次活动统计失败：${error?.message ?? error}`)
    }
  })

  safeOn('agent/turn-stopping', async ({ agent }) => {
    try {
      const sessionKey = agent?.session?.id === undefined ? undefined : String(agent.session.id)
      if (sessionKey === undefined) return

      // ---- 取本轮的两类信号 ----
      //
      // 1) 弱信号队列：字面和情绪可能不一致的句子（「算了」「呵呵」「你可真会安排」）。
      //    这类句子规则引擎只能判到「模糊」，需要模型在对话中结合上下文判断。
      //    之前这个队列只进不出 —— 句子进得去，没有任何人消费，
      //    队列撑满 20 条上限后就再也不更新了。这里把它接上。
      // 2) 写操作统计：本轮是否改过文件，决定要不要问「记不记」。
      const pending = await store.peekAmbiguous()
      // 只看本会话的（其它会话的留给它们自己处理）；sessionId 为 null 的是历史遗留，一并带上
      const shown = pending.filter(
        (item) => item.sessionId === null || item.sessionId === undefined || item.sessionId === sessionKey,
      )

      const record = turnActivity.get(sessionKey)
      // 一轮只提醒一次：先出队再提醒，避免同轮多步重复注入。
      if (record !== undefined) turnActivity.delete(sessionKey)

      // ---- 写操作提醒已取消（2026-11-13）----
      //
      // 原来：本轮有写操作且没写记忆 → 插一条消息让模型问用户「要不要记」。
      // 实测这个提醒在两天里触发了 217 次，几乎每个动手的轮次都问一遍，
      // 用户明确反馈「太吵」。
      //
      // 但也不能简单删掉：数据显示 239 条流水里，19.2% 是「只有错误/技巧、
      // 没有写操作」的认知性事件 —— 光靠「有写操作」判断，这些全漏。
      // 而更根本的问题是判断依据错了：模型发现自己犯错、发现更快的做法，
      // 往往不改文件，检测器看不见。
      //
      // 所以改成两件事：
      //   1. 把「什么时候该记」写进注入，让模型有据可依（见 finishInjection）
      //   2. 这里只留一行诊断日志，不再打断对话；漏记时事后可追溯
      if (record !== undefined && record.writes > 0 && !record.wroteMemory) {
        diag('turn-未记流水', { writes: record.writes, note: '有写操作但未写记忆（仅记录，不打扰）' })
      }

      // ---- 连续未写流水提醒（2026-11-16 v2，用户要求兜底）----
      //
      // ## 为什么改版
      //
      // v1 只在「有标记但 0 落库」时计数，对 `hasMarker === false` 显式不计数。
      // 用户 2026-11-16 实报「闲聊为什么没进流水」—— 查出来是我**连续 10 轮
      // 压根没写标记**，而 v1 对这种恰好零检测。
      //
      // v2 的判据换成：**本轮到底有没有成功写进一条流水**。
      //   - 写过（record.wroteLog）    → 清零
      //   - 没写过（含从未尝试）        → 连续计数 +1
      //
      // ## 为什么按轮而不按条
      //
      // 一次回复会触发多条 assistant/message（每个工具调用步一条，实测 4~5 条）。
      // 若按条计数，阈值会在一轮内被顶穿，等于退回「每轮提醒」的老路
      // （DECISIONS：两天 217 次，用户反馈太吵）。turn-stopping 每轮只跑一次，
      // 粒度才对。
      //
      // ## 阈值 4（用户 2026-11-16 定）
      //
      // 连续 4 轮没写流水才提醒一次，提醒后清零。纯对话轮次也会计数 ——
      // 这是有意的：用户明确说过「闲聊也要能兜住」，宁可多提醒一次，
      // 也不要再出现「10 轮全漏、没人知道」。
      const wroteThisTurn = record !== undefined && record.wroteLog === true
      if (wroteThisTurn) {
        if ((writeFailStreak.get(sessionKey) ?? 0) !== 0) {
          writeFailStreak.set(sessionKey, 0)
        }
      } else {
        const prev = writeFailStreak.get(sessionKey) ?? 0
        writeFailStreak.set(sessionKey, prev + 1)
      }

      const failStreak = writeFailStreak.get(sessionKey) ?? 0
      // ⚠️ 2026-11-16 加固：无条件记录本轮结算结果。
      //
      // 起因：用户实报「流水依然失效」，而日志里查不到 write-fail-reminder ——
      // 因为原代码只在 **delivered === true** 时才 diag。若 safePushMessage
      // 返回 false（agent.steer 不存在 / 抛异常被吞），连「触发过」都看不见。
      //
      // 这条 diag 必须无条件写：它是判断「turn-stopping 有没有在跑」
      // 与「计数有没有涨」的唯一现场。
      diag('write-streak-check', {
        streak: failStreak,
        wroteThisTurn,
        hasRecord: record !== undefined,
        limit: WRITE_FAIL_STREAK_LIMIT,
      })
      if (failStreak >= WRITE_FAIL_STREAK_LIMIT) {
        const delivered = safePushMessage(
          agent,
          `[dsh-memory] 已连续 ${failStreak} 轮没有把记忆写进流水。\n` +
            `这会让你下次开会话时不知道这段时间发生过什么。\n` +
            `请用 pwsh POST 到 $env:DSH_WEB_URL/api/dsh-memory/log 补一条（text/topic/summary/keywords）。\n` +
            `topic 必须是 13 类之一。**不要**改回在正文里写标记 —— 那正是占屏与闪烁的来源。`,
          'steer',
        )
        // 投递成功与否都要记 —— 失败时更需要这条证据。
        diag('write-fail-reminder', { streak: failStreak, delivered })
        if (delivered) {
          writeFailStreak.set(sessionKey, 0)
        }
      }

      // 弱信号队列没有内容 → 什么都不做
      if (shown.length === 0) {
        // 队列里若有其它会话的条目，这里不消费，保持原样
        return
      }

      // ---- 只处理弱信号（情绪判断）----
      const blocks = []

      if (shown.length > 0) {
        const listed = shown
          .slice(0, 3)
          .map((item, index) => `${index + 1}. 「${item.text}」`)
          .join('\n')
        blocks.push(
          `[dsh-memory] 以下句子字面和情绪可能不一致，规则判不准，请你结合上下文判断：\n` +
            `${listed}\n` +
            // ⚠️ 这里不能用完整的标记写法（含尖括号全称）：
            //    这段话本身会被推回会话，写全形一旦被当成正文复用就会自匹配。
            //    所以要举例就拆开写 —— 前段和后段各用反引号包住、中间隔中文。
            `如果确实有情绪（尤其是友善、爱意、夸赞、吐槽），用回复正文里的 mem-log 标记` +
            `（行首 \`<!--mem-log topic=情绪判据\` … 单独一行 \`-->\`）记一条，` +
            `写下「用户说了什么 + 你判断是什么情绪 + 依据」。\n` +
            `如果只是中性表达或技术讨论，**就不要记** —— 证据不足时宁可不记，也不要硬凑。`,
        )
      }

      if (blocks.length === 0) return

      const delivered = safePushMessage(agent, blocks.join('\n\n'), 'steer')

      // ---- 投递成功后才出队 ----
      //
      // 顺序很重要：先出队再投递的话，构造函数抛异常就意味着这几条弱信号
      // 既没有被模型看到、也从队列里消失了 —— 静默丢失。
      // 这里只有确认投递成功才清，失败就留在队列里下一轮再问。
      if (delivered && shown.length > 0) {
        await store.clearAmbiguous(shown.map((item) => item.id))
        diag('ambiguous-consumed', { count: shown.length })
      }
    } catch (error) {
      logger.warn?.(`[dsh-memory] 轮次提醒失败：${error?.message ?? error}`)
    }
  })

  // ---- 会话建立：登记项目 + 隔天整理提醒 ----
  safeOn('agent/created', async ({ agent, source }) => {
    if (source !== 'startup') return
    try {
      const resolved = await store.registerProject(agent?.session?.header?.cwd)
      // 2026-11-13 起不再预建任何项目文件：唯一存储是 memory.db，
      // 建项目目录只会留下没有内容的空壳，
      // 让人以为还有文件在参与工作。这段逻辑已随 .md 存储一并移除。
      //
      // ⚠️ 上面的「准备项目目录与当月流水文件」是 .md 时代的行为，已删除。
      //    现在这里只登记项目名，然后判是否该提醒整理记忆。
      const state = await store.readState()
      const today = localDay()
      // ---- 「多久没整理」的判据（2026-11-14 修）----
      //
      // 旧实现只看 state.lastConsolidate，而那个字段**只有用户手动敲
      // `/memory consolidate` 才会写** —— 模型写 mem-log 从不更新它。
      // 结果是 lastConsolidate 长期为 null，gap 恒为 Infinity，
      // 于是**每个新会话**都会收到这句提醒（用户反馈「每轮都吵」）。
      //
      // 现在取「手动整理日期」与「最近一条流水的日期」里较晚的那个：
      // 写流水本身就说明记忆是新鲜的，提醒自然退化成「7 天完全没写过东西」。
      // 顺序：先看流水（数据库模式才有），再和手动标记取 max。
      let lastLogDay = null
      if (dbStoreExists()) {
        try {
          const ts = dbStore.lastLogTs()
          // ts 有「带 Z」和「无后缀」两种历史写法；无效值一律当没有。
          if (ts !== null) {
            const dt = new Date(ts)
            if (!Number.isNaN(dt.getTime())) lastLogDay = localDay(dt)
          }
        } catch (error) {
          logger.warn?.(`[dsh-memory] 读最近流水时间失败：${error?.message ?? error}`)
        }
      }
      const lastActivity = [state.lastConsolidate, lastLogDay]
        .filter((x) => typeof x === 'string' && x !== '')
        .sort()
        .pop() ?? null
      const gap = lastActivity === null ? Number.POSITIVE_INFINITY : daysBetween(lastActivity, today)

      const threshold = Number(config.consolidateDays) || 7
      if (!(gap >= threshold)) return
      safePushMessage(
        agent,
        `[dsh-memory] 距上次记忆整理已 ${Number.isFinite(gap) ? `${gap} 天` : '很久'}。` +
          `如果本轮产生了值得保留的结论：过程与经验用 mem-log 记进流水；` +
          `规则与画像由用户在 GUI 手工维护，你不要写。无结论就忽略这条。`,
        'inject',
      )
    } catch (error) {
      logger.warn?.(`[dsh-memory] 项目登记或整理提醒失败：${error?.message ?? error}`)
    }
  })

  // ---- 工具：刻意不注册任何工具 ----
  //
  // 2026-11-11 两次事故的结论：工具 schema 会进入每次模型请求的 tools 数组，
  // 而反代/中转通道（实测 workbuddy）会以「工具的参数结构不符合当前模型要求」
  // 直接拒绝整个请求 —— 一个工具坏掉，该 profile 下所有会话全部无法发出消息。
  //
  // 现在记忆的读写完全不依赖注册工具：
  //   读 → systemPrompt.context 注入（纯文本，任何通道都支持）
  //   写 → 模型用已有的 write / edit / grep / read
  //   提醒 → turn-stopping 时 steer 一条纯文本消息
  //
  // 因此这里永久不注册。DEFAULT_CONFIG 里已不再有 toolsEnabled ——
  // 唯一还认它的场合是「老用户配置文件里残留着这个键」，用来发一次提醒。
  if (rawConfig && typeof rawConfig === 'object' && rawConfig.toolsEnabled === true) {
    diag('tools-refused', '配置里还写着 toolsEnabled=true，但本版本不注册任何工具（反代通道会 400）')
    logger.warn?.(
      '[dsh-memory] toolsEnabled 已忽略，可以从配置里删掉这一行了。本版本不注册工具。',
    )
  } else {
    diag('tools-none', '不注册工具（记忆靠注入 + 现有工具）')
  }

  // ---- /memory 命令：人工入口，不进入模型请求 schema ----
  ctx.inject(['commands'], (injected) => {
    try {
      injected.effect(
        () => {
          registeredCommand = true
          return injected.commands.register({
            name: 'memory',
            description: '查看、追加、检索记忆',
            input: { hint: 'status | append <内容> | search <关键词> | projects | emotions | consolidate' },
            async handler(invocation) {
              const words = invocation.rawInput.trim().split(/\s+/)
              const action = words.shift()
              const cwd = invocation.agent?.session?.header?.cwd
              if (!action) {
                return { kind: 'error', text: '用法：/memory status | append | search | projects | emotions | consolidate' }
              }
              if (action === 'status' || action === 'projects') {
                // 数据库模式：从库里统计，不走 overview（那是文件系统的）
                if (dbStoreExists()) {
                  const s = dbStore.stats()
                  return {
                    kind: 'success',
                    text: [
                      `记忆库：${s.dbPath}`,
                      `schema v${s.schemaVersion} · 共 ${s.total} 条`,
                      `按表：${Object.entries(s.byTable).map(([table, n]) => `${table}=${n}`).join(' · ')}`,
                      healthLine(await store.overview()),
                      `按项目：`,
                      ...s.byScope.map((x) => `  ${x.scope}  ${x.n} 条`),
                    ].join('\n'),
                  }
                }
                const info = await store.overview()
                // 「最近写入」与注入里的整理提醒用同一判据（dbStore.lastLogTs）。
                // 显示它是为了让「lastConsolidate 一直是 null」这件事可解释：
                // 那个字段只由 /memory consolidate 写，日常写入看这一行。
                let lastWrite = '从未'
                if (dbStoreExists()) {
                  try {
                    const ts = dbStore.lastLogTs()
                    const dt = ts === null ? null : new Date(ts)
                    if (dt !== null && !Number.isNaN(dt.getTime())) lastWrite = localDay(dt)
                  } catch {}
                }
                return {
                  kind: 'success',
                  text: [
                    `根目录：${info.root}`,
                    `情绪记录：待判 ${info.ambiguous} 条`,
                    healthLine(info),
                    `项目（${info.totals.projects}）：`,
                    ...info.projects.map((item) => `  ${item.key}\n    ${item.dir}`),
                    `上次整理：${info.lastConsolidate ?? '从未'}`,
                    `最近写入流水：${lastWrite}`,
                  ].join('\n'),
                }
              }
              if (action === 'append') {
                const content = words.join(' ')
                if (!content) return { kind: 'error', text: '用法：/memory append <内容>' }
                try {
                  if (!dbStoreExists()) {
                    return { kind: 'error', text: '记忆库不可用（只支持 SQLite），请检查 DSH 日志的 [db-FAILED]' }
                  }
                  const st = await store.readState()
                  const rj = store.resolveProjectKey(cwd, st)
                  const r = dbStore.appendLog(rj?.scope, content)
                  return { kind: 'success', text: `已追加到 ${r.project}` }
                } catch (error) {
                  return { kind: 'error', text: `未追加：${error?.message ?? error}` }
                }
              }
              if (action === 'search' || action === 'search!') {
                const query = words.join(' ')
                if (!query) return { kind: 'error', text: '用法：/memory search <关键词>' }
                if (!dbStoreExists()) {
                  return { kind: 'error', text: '记忆库不可用（只支持 SQLite），请检查 DSH 日志的 [db-FAILED]' }
                }
                // 默认硬隔离：只搜当前项目（rules 含全局规则，profile/emotion 不隔离）。
                // 为什么：别的项目的经验看起来能用、实际不适用，比「没搜到」更糟 ——
                // 模型会自信地用错知识且无从察觉。
                // 加 `!` 后缀（search!）显式跨项目，用于「就是要看看别的项目怎么写」的场合。
                const crossProject = action === 'search!'
                const st = await store.readState()
                const rj = store.resolveProjectKey(cwd, st)
                const rows = dbStore.search(query, {
                  limit: 15,
                  // 检索按 scope（记忆名），不是目录名
                  projectName: rj?.scope ?? null,
                  crossProject,
                })
                const scopeHint = crossProject
                  ? '· 跨全部项目'
                  : rj?.scope
                    ? `· 仅本项目「${rj.scope}」+ 全局规则`
                    : ''
                if (rows.length === 0) {
                  return {
                    kind: 'success',
                    text:
                      `未命中：${query}${scopeHint ? `（${scopeHint}）` : ''}` +
                      (crossProject ? '' : `\n需要跨项目查找时用：/memory search! ${query}`),
                  }
                }
                return {
                  kind: 'success',
                  text: [
                    `命中 ${rows.length} 条（${query}）${scopeHint}`,
                    ...rows.map((r) => {
                      const when = r.ts ? r.ts.replace('T', ' ').slice(0, 16) : ''
                      return `[${r.scope}${when ? ' · ' + when : ''}] ${String(r.text).slice(0, 90)}`
                    }),
                    '',
                    '要看全文：/memory show <id>',
                    crossProject ? '' : '要跨项目找：/memory search! <词>',
                  ]
                    .filter((l) => l !== '')
                    .join('\n'),
                }
              }
              if (action === 'show') {
                const id = Number(words[0])
                if (!Number.isInteger(id)) return { kind: 'error', text: '用法：/memory show <id>' }
                if (!dbStoreExists()) return { kind: 'error', text: '当前是文件模式，无 id 概念' }
                const table = findTableById(id)
                if (!table) return { kind: 'error', text: `找不到 id=${id}` }
                const one = dbStore.getById(table, id)
                return {
                  kind: 'success',
                  text: [
                    `#${one.id}  表=${table}  status=${one.status}`,
                    `时间：${one.ts ?? '—'}  写入者：${one.writer ?? '—'}`,
                    one.review ? `复核：${one.review}${one.review_note ? ` —— ${one.review_note}` : ''}` : '',
                    '',
                    one.text,
                  ]
                    .filter((line) => line !== '')
                    .join('\n'),
                }
              }
              if (action === 'emotions') {
                if (dbStoreExists()) {
                  const { rows, total } = dbStore.listEntries('emotion', { limit: 30 })
                  if (rows.length === 0) return { kind: 'success', text: '还没有情绪记录。' }
                  return {
                    kind: 'success',
                    text: [
                      `共 ${total} 条（显示最近 ${rows.length}）：`,
                      '',
                      ...rows.map((r) => `#${r.id} [${r.status}${r.review ? '·' + r.review : ''}] ${r.text.slice(0, 80)}`),
                      '',
                      '修正：/memory review <id> retract  → 标记为「说过但当时不算」',
                      '      /memory review <id> delete   → 标记为「记错了」',
                    ].join('\n'),
                  }
                }
                // 情绪记录存在 emotion 表里（数据库模式）。文件版读取已移除。
                if (!dbStoreExists()) {
                  return { kind: 'error', text: '记忆库不可用（只支持 SQLite），请检查 DSH 日志的 [db-FAILED]' }
                }
                const { rows, total } = dbStore.listEntries('emotion', { limit: 30 })
                if (total === 0) return { kind: 'success', text: '还没有情绪记录。' }
                return {
                  kind: 'success',
                  text: [
                    `共 ${total} 条（显示最近 ${rows.length}）：`,
                    '',
                    ...rows.map((r) => `#${r.id} [${r.cls ?? ''}] ${String(r.text).slice(0, 80)}`),
                  ].join('\n'),
                }
              }
              if (action === 'review') {
                if (!dbStoreExists()) return { kind: 'error', text: '当前是文件模式' }
                const id = Number(words[0])
                const what = words[1]
                if (!Number.isInteger(id) || !['retract', 'delete', 'restore'].includes(what)) {
                  return { kind: 'error', text: '用法：/memory review <id> retract|delete|restore' }
                }
                const table = findTableById(id)
                if (!table) return { kind: 'error', text: `找不到 id=${id}` }
                if (what === 'delete') {
                  dbStore.softDelete(table, id)
                  return { kind: 'success', text: `#${id}（${table}）已标记删除（可在 GUI 恢复）` }
                }
                if (what === 'restore') {
                  dbStore.setReview(table, id, null)
                  return { kind: 'success', text: `#${id}（${table}）已恢复` }
                }
                dbStore.setReview(table, id, 'retracted')
                return { kind: 'success', text: `#${id}（${table}）已标记「撤回过」——不再注入，但仍可查` }
              }
              if (action === 'consolidate') {
                const state = await store.readState()
                state.lastConsolidate = localDay()
                await store.writeState(state)
                return { kind: 'success', text: '已记录整理时间。' }
              }
              return { kind: 'error', text: `未知动作：${action}` }
            },
          })
        },
        'dsh-memory: command',
      )
      diag('command-registered')
    } catch (error) {
      diag('command-FAILED', { message: String(error?.message ?? error) })
      logger.warn?.(`[dsh-memory] 注册 /memory 失败：${error?.message ?? error}`)
    }
  })

  // ---- HTTP：给设置面板用，不进入模型请求 ----
  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.webServer
    const json = (res, status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    const readBody = async (req) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      // ⚠️ 必须走 parseJson，不能裸 JSON.parse（硬约束 4）：
      // Windows 上记事本 / PowerShell 保存的 JSON 常带 UTF-8 BOM，
      // 裸解析会抛错，而调用方的 catch 把它吞成 400 或「无数据」——
      // 表现为「接口莫名失败」，比直接报错更难查。
      //   2026-11-16 实测：body 前置 EF BB BF 时旧写法抛
      //   `Unexpected token`，带 BOM 的请求全被拒。
      return parseJson(Buffer.concat(chunks).toString('utf8') || '{}')
    }

    const routes = [
      {
        kind: 'exact',
        path: '/api/dsh-memory/state',
        handler: async (_req, res) => {
          try {
            const info = await store.overview()
            // 数据库模式的统计（GUI 需要知道库在哪、多大、多少条）
            let db = null
            if (dbStoreExists()) {
              try {
                const st = dbStore.stats()
                db = {
                  ok: true,
                  path: st.dbPath,
                  size: st.dbSize,
                  total: st.total,
                  // v4 原文层：单独计数，**不进 total / byTable** ——
                  // 它不是「记忆条目」，混进去会让 GUI 与 /memory status 的「四表」口径变味。
                  archive: st.archive,
                  schemaVersion: st.schemaVersion,
                  // v2 拆表后按表统计；stats() 返回的键是 byTable（对象），不是 byKind（数组）
                  byTable: st.byTable,
                  byScope: st.byScope,
                }
              } catch (e) {
                db = { ok: false, error: String(e?.message ?? e) }
              }
            }
            json(res, 200, {
              ok: true,
              ...info,
              db,
              // 插件自身版本（GUI 标题旁显示）。来自 package.json，不硬编码。
              versions: {
                plugin: PACKAGE_VERSION || null,
                schema: dbStoreExists() ? (db?.schemaVersion ?? null) : null,
              },
              // 口径声明：告诉调用方「info.projects 里那组统计数字该怎么读」。
              //
              // 2026-11-13 加。为什么必须显式声明：overview() 无论跑在哪种模式
              // 都只读 .md 文件，而数据库模式下那些文件已不再写入 ——
              // 于是 projects[].exists / memoryEntries / logBytes 会普遍为
              // false / 0。不标口径的话，看到「所有项目都是 0」会被读成
              // 「数据丢了」（AI 排查时自己就差点误判一次）。
              //
              // 想看真实条数：db.byTable（四张表合计）/ db.byScope（按项目）。
              statsMode: dbStoreExists() ? 'db' : 'files',
              statsHint: dbStoreExists()
                ? 'info.projects 的统计是文件口径（已停用），真实条数看 db.byTable / db.byScope'
                : '当前为文件模式，info.projects 的统计即真实数据',
              // 收尾语（心跳）：存在 policy.md，不在数据库
              heartbeat: readHeartbeat(),
              rootReason: store.rootReason,
              onSystemDrive: store.isSystemDriveTarget(store.root),
              drives: store.candidateDrives(),
              // toolsEnabled 字段已移除：插件永久不注册工具。
            })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      // ---- 数据库记忆编辑接口（GUI 用）----
      //
      // 这些路由让设置页能列出、筛选、修改、删除、升级记忆条目。
      // 设计原则（来自讨论）：
      //   - 只处理「有一条记录」的操作，不做批量删除（误操作代价太大）
      //   - 项目规则可升级为全局；全局不能降级（信息扩散单向可控）
      //   - 删除一律软删除，可恢复
      {
        kind: 'exact',
        path: '/api/dsh-memory/entries',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 200, { ok: false, error: '当前为文件模式，无条目接口' })
            const url = new URL(req.url, 'http://localhost')
            const q = url.searchParams
            // v2 拆表后必须知道查哪张表。
            //
            // ⚠️ 2026-11-13 修：原来写 `q.get('table') || 'rules'`，缺省时默默查 rules。
            //    ｜危害｜这是本接口唯一一个「传错也看不出来」的参数 ——
            //    别的参数（kind/status/scope）传错只会返回 0 条空结果，
            //    调用方一看就知道不对；而 table 缺省会返回 20 条真实规则，
            //    看起来一切正常。实测外部调用方传 `?kind=logs` 时就会落到这里：
            //    以为在查流水，实际查了 rules 并附加 kind='logs' 过滤 → 0 条 + ok:true。
            //    ｜为什么不修更彻底｜kind/status/scope 传错的语义是「没有匹配项」，
            //    与真正的空结果无法区分，但那属于调用方该自己保证的；
            //    唯独 table 缺省是「静默换了一个查询对象」，必须拒绝。
            const table = q.get('table')
            if (!table) {
              return json(res, 400, {
                ok: false,
                error: '需要 table 参数：profile | rules | emotion | logs',
                hint: '这是 GUI 翻页用的接口；模型查记忆请用 /api/dsh-memory/search?q=关键词',
              })
            }
            if (!['profile', 'rules', 'emotion', 'logs'].includes(table)) {
              return json(res, 400, { ok: false, error: `未知的表：${table}` })
            }
            // cap：只让最近 N 条参与翻页（0 = 不限）。
            // 流水页传 100 —— 界面是「看最近发生了什么」，不是考古；
            // 更早的内容仍靠 /memory search 检索，不占界面资源。
            const cap = Math.max(0, Math.min(Number(q.get('cap')) || 0, 5000))
            const { rows, total } = dbStore.listEntries(table, {
              scope: q.get('scope') || undefined,
              kind: q.get('kind') || undefined,
              // ⚠️ 2026-11-16 修（C2）：原来 status 缺省时**回落成 active**，
              //
              // 后果：GUI 勾选「显示已停用」时**不传 status**（想要「全部」），
              // 后端却回落成 'active'，于是已删除 / 已停用的条目**永远列不出来**。
              // 而界面上删除文案写的是「软删除，可恢复」—— 用户点进去找不到，
              // 会以为数据丢了。我自己就踩过：软删的测试条目在 GUI 里完全看不到。
              //
              // 修法要注意一个坑：不能靠「传 undefined 表示不过滤」——
              // listEntries 的 `status = 'active'` 是**默认参数**，
              // JS 在传 undefined 时仍会套用默认值，那样改等于没改（实测验证过）。
              // 所以这里改用**显式开关** includeAll。
              status: q.get('status') || 'active',
              includeAll: q.get('status') === 'all',
              q: q.get('q') || undefined,
              // 时间范围：接受 YYYY-MM-DD 或完整 ISO8601
              tsFrom: q.get('from') || undefined,
              tsTo: q.get('to') || undefined,
              limit: Math.min(Number(q.get('limit')) || 200, 500),
              offset: Number(q.get('offset')) || 0,
              cap,
            })
            // scopes 跟着被查的表走：流水页要按项目筛，而 logs 与 rules 的
            // scope 集合并不一致（实测「干杂活」有流水没规则）。传错表会让
            // 下拉框漏掉真实存在的项目。
            json(res, 200, { ok: true, table, entries: rows, total, scopes: dbStore.listScopes(table) })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 只读：按 id 取单条全文（2026-11-14 补）。
        //
        // 为什么需要：注入一直教模型「先 summary=1 看摘要，确认相关再按 id 取全文」，
        // 但此前**根本没有这个入口** —— 未注册路径一律 401（DSH 默认），
        // 模型只能退回去重查整页全文，summary 省 token 的设计等于白做。
        //
        // 为什么 table 必填：四张表的 id 各自独立编号，logs#3 与 rules#3 不是同一条。
        // 允许只给 id 就要遍历四张表挑一条 —— id 撞车时会**静默返回另一条**，
        // 比 400 糟得多。模型手上的 summary 结果里有 table 字段，照抄即可。
        kind: 'exact',
        path: '/api/dsh-memory/entry',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 200, { ok: false, error: '当前为文件模式' })
            const url = new URL(req.url, 'http://localhost')
            const table = url.searchParams.get('table')
            const rawId = url.searchParams.get('id')
            if (!table) {
              return json(res, 400, {
                ok: false,
                error: '需要 table 参数：profile | rules | emotion | logs',
                hint: '四张表 id 各自独立编号，不能只给 id；table 直接用 summary 结果里的字段',
              })
            }
            if (!['profile', 'rules', 'emotion', 'logs'].includes(table)) {
              return json(res, 400, { ok: false, error: `未知的表：${table}` })
            }
            const id = Number(rawId)
            if (!Number.isInteger(id) || id <= 0) {
              return json(res, 400, { ok: false, error: '需要正整数 id' })
            }
            const entry = dbStore.getById(table, id)
            if (entry === undefined) {
              return json(res, 404, { ok: false, error: `${table} 里没有 id=${id}` })
            }
            json(res, 200, { ok: true, table, entry })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 原始对话归档（v4）：原文层，**不注入、不进默认 /search**。
        // 用途：完整回溯「当时到底说了什么」，尤其是没被整理进流水的对话。
        // 过滤：scope / role / q（FTS 中文逐字）/ from / to / limit / offset。
        kind: 'exact',
        path: '/api/dsh-memory/archive',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 200, { ok: false, error: '当前为文件模式' })
            const url = new URL(req.url, 'http://localhost')
            const scope = url.searchParams.get('scope') || undefined
            const role = url.searchParams.get('role') || undefined
            if (role !== undefined && role !== 'user' && role !== 'assistant') {
              return json(res, 400, { ok: false, error: 'role 只能是 user | assistant' })
            }
            const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 50, 500))
            const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)
            const { rows, total } = dbStore.listArchive({
              scope,
              role,
              q: url.searchParams.get('q') || undefined,
              tsFrom: url.searchParams.get('from') || undefined,
              tsTo: url.searchParams.get('to') || undefined,
              limit,
              offset,
            })
            json(res, 200, { ok: true, total, scope: scope || 'all', role: role || 'all', rows })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 库体积分层（2026-11-14，v5）。**故意不做进 /state**：
        // 它查 dbstat 虚拟表，是全库页扫描，耗时与库体积线性相关
        // （实测 1.8MB→0.7ms、5.2MB→8.7ms、10.2MB→16.6ms，100MB 约 160ms）。
        // 而 /state 是 GUI 每次切页签都拉的接口，主线程不该被它卡住。
        //
        // 缓存在 store 里（默认 30 秒），`?fresh=1` 可强制重算。
        // 用途：让「库 100MB 了」这句话能被解释成
        //       「其中 archive 原文层 30%、空闲页 5%、真正的结论层只有 X」，
        //       而不是让用户以为记忆条目爆了。
        kind: 'exact',
        path: '/api/dsh-memory/stats-breakdown',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 200, { ok: false, error: '当前为文件模式' })
            const url = new URL(req.url, 'http://localhost')
            const fresh = url.searchParams.get('fresh') === '1'
            const b = dbStore.statsBreakdown(fresh ? { maxAgeMs: 0 } : undefined)
            json(res, 200, { ok: true, ...b })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/entry/update',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            // 方法白名单（同 /heartbeat）：readBody 对空 body 返回 {}，
            // 空 body 会被下文当成「把字段写成空值」。
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（改正文有副作用）' })
            }
            const body = await readBody(req)
            const id = Number(body.id)
            if (!Number.isInteger(id)) return json(res, 400, { ok: false, error: '需要 id' })
            // 表名来自 body，进 store 前先校验（store 层也有兜底，这里是为了错误更明确）
            const table = body.table ? assertTable(body.table) : findTableById(id)
            if (!table) return json(res, 400, { ok: false, error: `找不到 id=${id}` })
            if (typeof body.text === 'string' && body.text.trim() !== '') {
              dbStore.updateText(table, id, body.text.trim())
            }
            if (body.review !== undefined) {
              dbStore.setReview(table, id, body.review ?? null, body.reviewNote ?? null)
            }
            diag('entry-updated', { id, table })
            json(res, 200, { ok: true, id, table, entry: dbStore.getById(table, id) })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/entry/create',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            // 方法白名单：create 会新增一条记忆，被误触发就是脏数据
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（新增条目有副作用）' })
            }
            const body = await readBody(req)
            const text = typeof body.text === 'string' ? body.text.trim() : ''
            const scope = typeof body.scope === 'string' ? body.scope.trim() : ''
            const kind = typeof body.kind === 'string' ? body.kind : 'pref'
            const table = typeof body.table === 'string' ? assertTable(body.table) : undefined
            if (!text) return json(res, 400, { ok: false, error: '内容不能为空' })
            // 画像不需要 scope；规则必须有
            if (table !== 'profile' && !scope) {
              return json(res, 400, { ok: false, error: '需要指定作用域（全局或项目）' })
            }
            // kind 只有三种：redline（违反会出事）/ pref（怎么做）/ state（是什么）。
            // fact 已于 2026-11-13 并入 pref —— 两者对系统行为毫无差别，
            // 区分只会增加判断负担。历史数据里的 fact 已迁移。
            if (!['pref', 'redline', 'state'].includes(kind)) {
              return json(res, 400, { ok: false, error: `不支持的 kind：${kind}（只能是 pref / redline / state）` })
            }
            const r = dbStore.createEntry({ scope, kind, text, table })
            diag('entry-created', { id: r.id, table: r.table, scope, kind, duplicate: r.duplicate })
            json(res, 200, { ok: true, ...r, entry: dbStore.getById(r.table, r.id) })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // ---- 流水写入（数据通道版，2026-11-16 新增）----
        //
        // ## 为什么要有这条路由
        //
        // 标记通道有一个无法回避的副作用：**标记本身必须出现在回复正文里**。
        // 于是界面上只有两种状态，二选一：
        //   不擦 → 永远占屏（用户原话：「流水占了大半屏幕，看不到正文」）
        //   擦   → 先流式显示、400ms 后消失 = 闪（用户原话：「现在开始闪了」）
        // 用户 2026-11-16 定调：占屏和闪是同一件事的两种状态，
        // **根因是「标记写进了正文」**，不是擦除器写得不好。
        //
        // 所以这条路由让模型**不进正文**也能写流水：用 pwsh POST 一次。
        // 附带的好处是标记不再留在会话上下文里（一条 400 字标记约 300 token）。
        //
        // ## 为什么不是注册工具
        //
        // 硬约束 1：注册工具会让 100% 的请求被反代拒绝（2026-11-11 中断两次）。
        // pwsh 本来就在工具列表里，走它不需要动 tools 数组。
        //
        // ## 双通道并存
        //
        // 标记通道**不删**。这条路由是「更好的一条路」，不是「唯一的路」：
        // 任一通道通都能写进库，两条都写会去重（见 duplicate 判定）。
        kind: 'exact',
        path: '/api/dsh-memory/log',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（写流水有副作用，别用 GET）' })
            }
            const body = await readBody(req)
            const text = typeof body.text === 'string' ? body.text.trim() : ''
            if (text === '') return json(res, 400, { ok: false, error: '正文不能为空' })

            // topic 走与标记通道**同一个**白名单清洗函数。
            // 两条通道必须共用一套校验 —— 否则同一份内容走不同通道会得到不同结果，
            // 那是最难查的一类不一致（2026-11-16 教训：模型把 topic 写成
            // 「测试/验证」被拒收置空，而如果 HTTP 通道另写一套就会放过它）。
            const topicRaw = typeof body.topic === 'string' ? body.topic : ''
            const topic = sanitizeTopic(topicRaw)
            if (topicRaw.trim() !== '' && topic === null) {
              diag('topic-rejected', { raw: topicRaw.slice(0, 40), via: 'http' })
            }
            const summary = sanitizeSummary(body.summary)
            const keywords = sanitizeKeywords(body.keywords)
            if (summary === null) diag('summary-missing', { topic, via: 'http' })

            // scope 解析：默认取请求方所在会话的项目名（与标记通道同源，
            // 都用 resolveProjectKey 的 scope，而不是目录名 key）。
            // 允许显式传 scope，用于「人不在项目里但要补一条」的场景。
            //
            // ⚠️ 2026-11-16 自测发现并修：`resolveProjectKey` 对任何路径都会
            // 算出一个 basename（它不知道目录存不存在）。于是模型随手传一个
            // 写错的 cwd，就会凭空建出一个**永远不会有第二次写入的假工作区**
            // （实测传 D:\不存在的目录xyz → scope 被写成「不存在的目录xyz」）。
            // 假 scope 会污染 /state 的 byScope、GUI 的工作区下拉框、
            // 以及注入里的「记忆索引」—— 比报错难查得多。
            //
            // 所以这里先要求目录**真的存在**，不存在就明确报错，
            // 让调用方改传 scope 或改对 cwd，而不是默默写坏数据。
            let scope = typeof body.scope === 'string' ? body.scope.trim() : ''
            let scopeFrom = 'body'
            if (scope === '') {
              scopeFrom = 'cwd'
              const cwd = typeof body.cwd === 'string' ? body.cwd : process.cwd()
              if (!(await exists(cwd))) {
                return json(res, 400, {
                  ok: false,
                  error: `cwd 不存在：${cwd}。请传正确的 cwd，或直接传 scope。`,
                  scopeFrom,
                })
              }
              scope = store.resolveProjectKey(cwd, readStateSync(store))?.scope ?? ''
            }
            if (scope === '') {
              return json(res, 400, {
                ok: false,
                error: '无法确定项目：传 scope，或确认 cwd 已在插件里登记',
              })
            }

            const r = dbStore.appendLog(scope, text, { topic, summary, keywords })
            diag('mem-写流水', {
              project: r.project,
              topic,
              summary: summary ?? null,
              keywords: keywords ?? null,
              db: true,
              via: 'http',
              scopeFrom,
            })
            // ⚠️ 关键：把「本轮写过流水」记到 turnActivity。
            //
            // 不记的话，turn-stopping 里按轮结算的 writeFailStreak 会认为
            // 这一轮没写 → 连续 4 轮后误报「你忘了写流水」。
            // 那会把「换成新通道」变成「被自己的兜底机制反复指责」，
            // 比不改还糟。sessionId 由查询参数带，拿不到就不记（宁可漏计数）。
            const sid = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
            if (sid !== '') {
              const rec = turnActivity.get(sid) ?? { writes: 0, wroteMemory: false, wroteLog: false }
              rec.wroteLog = true
              turnActivity.set(sid, rec)
            }
            json(res, 200, {
              ok: true,
              id: r.id,
              scope: r.project,
              bytes: r.bytes,
              summary: r.summary,
              topic,
              scopeFrom,
              streakCleared: sid !== '',
            })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // ---- 物理清理软删条目（2026-11-16 新增）----
        //
        // 用户原话：「怎么现在才发现 删了吧」。
        // 实测 rules 攒了 125 条 deleted + 5 条 stale，占该表 136 条里的 130 条。
        //
        // **为什么需要一条独立路由**：现有 `/entry/delete` 只是把 status 改成
        // 'deleted'（软删），行还在库里、还占体积。要真瘦身必须 DELETE 行，
        // 而这属于「改记忆数据」—— 硬约束 5 禁止 write / pwsh 直写 memory.db，
        // 所以只能走 HTTP。
        //
        // **安全设计**（这是个不可逆操作，宁可多设几道闸）：
        //   - 只接受 POST
        //   - 必须显式传 `statuses` 数组，且**拒绝 active**（见 purgeByStatus）
        //   - 必须显式传 `confirm: true` —— 防手滑/自动化误调
        //   - 支持 `dryRun: true` 先报数
        kind: 'exact',
        path: '/api/dsh-memory/purge',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（物理删除不可逆）' })
            }
            const body = await readBody(req)
            const table = typeof body.table === 'string' ? assertTable(body.table) : ''
            const statuses = Array.isArray(body.statuses) ? body.statuses : []
            const dryRun = body.dryRun === true
            if (!dryRun && body.confirm !== true) {
              return json(res, 400, {
                ok: false,
                error: '需要 confirm:true 才会真删；先用 dryRun:true 看会删多少',
              })
            }
            const r = dbStore.purgeByStatus(table, statuses, { dryRun })
            diag('purge-by-status', { table, statuses, dryRun, deleted: r.deleted ?? 0, byStatus: r.byStatus })
            logger.info?.(
              `[dsh-memory] ${dryRun ? '预演' : '已物理删除'} ${table} 的 ${statuses.join('/')}：` +
                `${dryRun ? r.wouldDelete : r.deleted} 条`,
            )
            json(res, 200, { ...r, fileMode: false })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // ---- VACUUM：把空闲页还给磁盘（2026-11-16 新增）----
        //
        // 配套 `/purge`：DELETE 只把页标记为空闲，`db.size` 不会变小。
        // 实测删 130 条后 page_count 1709→1712、freelist 1→8，**体积一分没省**。
        // 这与 v5 删 entries 表时踩的是同一个坑（见 db-store 的 statsBreakdown 注释）。
        //
        // 只接受 POST（会重写整个库，不能 GET），且要求 confirm:true。
        kind: 'exact',
        path: '/api/dsh-memory/vacuum',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（VACUUM 会重写整个库）' })
            }
            const body = await readBody(req)
            if (body.confirm !== true) {
              return json(res, 400, { ok: false, error: '需要 confirm:true' })
            }
            const r = dbStore.vacuum()
            diag('vacuum', r.after)
            logger.info?.(
              `[dsh-memory] VACUUM 完成：${(r.before.bytes / 1024).toFixed(0)} KB → ` +
                `${(r.after.bytes / 1024).toFixed(0)} KB（回收 ${(r.reclaimedBytes / 1024).toFixed(0)} KB）`,
            )
            json(res, 200, r)
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 每轮收尾语（心跳）。
        //
        // 存在 policy.md 而不是数据库：它是「每轮必须执行、不可被截断」的
        // 行为规则，与偏好不同账。这里提供读写，让它可被 GUI 编辑。
        kind: 'exact',
        path: '/api/dsh-memory/heartbeat',
        handler: async (req, res) => {
          try {
            if (req.method === 'GET') {
              return json(res, 200, { ok: true, text: readHeartbeat() })
            }
            // ⚠️ 必须有方法白名单。原来只有 `GET` 一个只读分支，
            // **其余任何方法都会落进写分支**：HEAD / GET 之外的空 body 经
            // readBody 变成 `{}` → text='' → 走「删除收尾语」分支。
            //   2026-11-16 实测：`curl -I`（HEAD）就删掉了 policy.md 的收尾语行，
            //   还返回 ok:true —— 探活工具、代理、预检请求都会触发。
            // 同文件的 /log、/purge、/vacuum 早已显式拒绝非 POST，这里对齐。
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 GET / POST' })
            }
            const body = await readBody(req)
            const text = typeof body.text === 'string' ? body.text.trim() : ''
            const saved = await writeHeartbeat(text)
            diag('heartbeat-saved', { empty: text === '' })
            json(res, 200, { ok: true, text: saved })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/entry/delete',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            // ⚠️ 这条最危险：误发的 DELETE / HEAD 会真的软删一条记忆。
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（删除有副作用）' })
            }
            const body = await readBody(req)
            const id = Number(body.id)
            if (!Number.isInteger(id)) return json(res, 400, { ok: false, error: '需要 id' })
            const table = body.table ? assertTable(body.table) : findTableById(id)
            if (!table) return json(res, 400, { ok: false, error: `找不到 id=${id}` })
            // 软删除：记忆是历史，误删难恢复
            dbStore.softDelete(table, id)
            diag('entry-deleted', { id, table })
            json(res, 200, { ok: true, id, table })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 只改 topic，不动正文。
        //
        // 为什么需要单独接口（2026-11-13）：历史遗留 156 条无 topic，
        // 它们不进「记忆索引」等于对模型隐形。补标签必须走插件 ——
        // 硬约束 6 明令禁止模型用 write/pwsh 直碰 memory.db。
        // 与 entry/update 分开，是因为后者会把 review 标成 'edited'，
        // 那会把「机器补标签」误记成「用户改过内容」。
        kind: 'exact',
        path: '/api/dsh-memory/entry/topic',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            // 方法白名单：改 topic 会连带改 FTS 索引
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（改 topic 有副作用）' })
            }
            const body = await readBody(req)

            // 支持批量：{ items: [{id, table, topic}, ...] }
            if (Array.isArray(body.items)) {
              const results = []
              for (const it of body.items) {
                try {
                  const id = Number(it.id)
                  const table = it.table ? assertTable(it.table) : findTableById(id)
                  if (!Number.isInteger(id) || !table) {
                    results.push({ id: it.id, ok: false, error: '找不到条目' })
                    continue
                  }
                  results.push({ ...dbStore.setTopic(table, id, it.topic), table })
                } catch (e) {
                  results.push({ id: it.id, ok: false, error: String(e?.message ?? e) })
                }
              }
              const changed = results.filter((r) => r.ok).length
              diag('entry-topic-batch', { total: results.length, changed })
              return json(res, 200, { ok: true, total: results.length, changed, results })
            }

            // 单条：{ id, table?, topic }
            const id = Number(body.id)
            if (!Number.isInteger(id)) return json(res, 400, { ok: false, error: '需要 id' })
            const table = body.table ? assertTable(body.table) : findTableById(id)
            if (!table) return json(res, 400, { ok: false, error: `找不到 id=${id}` })
            const r = dbStore.setTopic(table, id, body.topic)
            diag('entry-topic', { id, table, to: r.to })
            json(res, 200, { ok: true, ...r, table })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 停用 / 启用 / 恢复删除。
        // 「升级为全局」不可逆是刻意的，所以必须给一条不删数据的退路。
        kind: 'exact',
        path: '/api/dsh-memory/entry/status',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            // 方法白名单：改 status 等于停用/恢复一条记忆
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（改状态有副作用）' })
            }
            const body = await readBody(req)
            const id = Number(body.id)
            const status = String(body.status ?? '')
            if (!Number.isInteger(id)) return json(res, 400, { ok: false, error: '需要 id' })
            if (!['active', 'stale', 'deleted'].includes(status)) {
              return json(res, 400, { ok: false, error: 'status 只能是 active / stale / deleted' })
            }
            const table = body.table ? assertTable(body.table) : findTableById(id)
            if (!table) return json(res, 400, { ok: false, error: `找不到 id=${id}` })
            const r = dbStore.setStatus(table, id, status)
            diag('entry-status', { id, table, status })
            json(res, 200, { ok: true, ...r, table, entry: dbStore.getById(table, id) })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/entry/upgrade-global',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            // 方法白名单：升级为全局规则会影响所有项目的注入
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（升级为全局有副作用）' })
            }
            const body = await readBody(req)
            const id = Number(body.id)
            if (!Number.isInteger(id)) return json(res, 400, { ok: false, error: '需要 id' })
            // 单向操作：项目 → 全局允许，全局 → 项目不提供
            const r = dbStore.upgradeToGlobal(id)
            diag('entry-upgraded', { id, from: r.from })
            json(res, 200, { ok: true, ...r, table: 'rules', entry: dbStore.getById('rules', id) })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 人称规范检查：扫描所有条目里的「我」「你」等会随视角漂移的词。
        // 只报告，不改数据 —— 用「我」的历史条目很多，一次性改会误伤语义。
        kind: 'exact',
        path: '/api/dsh-memory/persona-check',
        handler: async (_req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 200, { ok: false, error: '当前为文件模式' })
            const issues = dbStore.scanPersona()
            json(res, 200, {
              ok: true,
              count: issues.length,
              issues,
              forbidden: PERSONA_FORBIDDEN,
            })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        // 客户端擦除器的诊断回执。
        //
        // 为什么需要：擦除器跑在浏览器里，模型看不到控制台 ——
        // 2026-11-13 排查「标记还在不在」时，只能靠用户手动开 DevTools 贴日志，
        // 往返好几轮。让浏览器在它确实跑起来时回打一条，写进服务端日志，
        // 模型就能直接读日志确认，不必再麻烦用户。
        //
        // 只记一条统计（装载了几次、擦了多少处），不含任何用户内容。
        kind: 'exact',
        path: '/api/dsh-memory/client-report',
        handler: async (req, res) => {
          try {
            const url = new URL(req.url, 'http://localhost')
            const stripped = Number(url.searchParams.get('stripped') || 0)
            const state = url.searchParams.get('state') || 'mounted'
            // 2026-11-15：新增 DOM 诊断回传。
            //
            // 为什么需要（用户报「改完功能后全局 skills 滚动条失效」）：
            //   擦除器会往 document.head 注入一条全局 CSS
            //   `[data-dsh-mem-blank] { display:none !important }`，
            //   并给「擦完只剩空白且无子元素」的任意元素打上该属性。
            //   唯一守卫是 `el !== document.body` —— **没有限制在对话区**。
            //   一旦某个滚动容器的子节点被打上，容器 scrollHeight 塌成 0，
            //   滚动条就消失，且 !important 无法被覆盖。
            //
            //   但要修就得知道真实的 DOM 结构（对话区的选择器是什么、
            //   哪些元素被打上了标记），而浏览器端看不到服务端日志。
            //   所以把诊断结果作为 query 参数回传，由 diag 落到日志文件里。
            if (url.searchParams.get('dom') === '1') {
              // 转成对象存进日志：raw 可能很长，但这是排查用的一次性数据
              let dom = null
              try {
                dom = JSON.parse(url.searchParams.get('detail') || '{}')
              } catch {
                dom = { parseError: true }
              }
              diag('client-dom-report', dom)
            }
            diag('client-scrubber', { state, stripped })
            json(res, 200, { ok: true })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/search',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 200, { ok: false, error: '当前为文件模式' })
            const url = new URL(req.url, 'http://localhost')
            const q = (url.searchParams.get('q') || '').trim()
            if (!q) return json(res, 400, { ok: false, error: '需要 q 参数' })
            // 2026-11-14：**不再猜测当前项目**。
            // 旧实现用 lastSessionCwd 推断默认项目 —— 多会话并发时
            // 「最后活跃的项目」会覆盖，A 项目会查到 B 项目的记忆。
            // 现在：
            //   ?scope=<名> 或 ?project=<名> → 只搜该项目（注入里直接给了真实项目名）
            //   ?all=1                        → 显式跨项目（GUI/调试用）
            //   都不传                         → 400，要求明确范围（宁可报错，不猜错）
            const explicitProject = url.searchParams.get('project') || url.searchParams.get('scope')
            const crossProject = url.searchParams.get('all') === '1'
            if (!crossProject && !explicitProject) {
              return json(res, 400, {
                ok: false,
                error: '需要 scope 参数（项目名），或用 all=1 显式跨项目',
                hint: '注入里已给出本项目的 scope 值，照抄即可',
              })
            }
            const project = crossProject ? null : explicitProject
            const rows = dbStore.search(q, {
              limit: Number(url.searchParams.get('limit')) || 30,
              projectName: project || null,
              crossProject,
            })
            // ---- 两段式返回：?summary=1 只给摘要，模型按需再取全文 ----
            //
            // 2026-11-14 加：实测 /search?limit=3 返回 5019 字节，单条正文
            // 519~958 字符 —— 模型只为「判断哪条相关」就要读 5KB。
            // 加 summary 模式后只返回 id + topic + 时间 + 前 80 字，
            // 3 条约 100~150 token；确认相关再用 id 取全文。
            //
            // 默认仍是全文（用户选的：兼容旧调用，别让现有行为突然变）。
            // **不去重**：相似条目全都返回，靠时间戳和摘要让模型自己判断
            // 「同一件事记两遍」（取新的）还是「同一件事的两个阶段」（都要）。
            const wantSummary = url.searchParams.get('summary') === '1'
            // v3（2026-11-14）：优先返回写入时存的**真摘要**（≤35 字）；
            // 老数据或没写摘要的流水才退回「正文截断 80 字」。
            // 真摘要的好处是它不会被截在句子中间、也不会丢掉技术名词 ——
            // 后者由 keywords 专门承担，所以两条都带上。
            const hits = wantSummary
              ? rows.map((r) => {
                  const kw = String(r.keywords ?? '').trim()
                  return {
                    id: r.id,
                    table: r.table,
                    topic: r.topic ?? null,
                    ts: r.ts ?? null,
                    excerpt: r.summary
                      ? String(r.summary).replace(/\s+/g, ' ')
                      : String(r.text ?? '').replace(/\s+/g, ' ').slice(0, 80),
                    ...(kw ? { keywords: kw.split('｜') } : {}),
                  }
                })
              : rows
            json(res, 200, {
              ok: true,
              query: q,
              scopedTo: crossProject ? 'all' : project || 'all',
              summary: wantSummary,
              ...(wantSummary
                ? { hint: '这是摘要。确认相关后再用 id 取全文。相似的多条请按 ts 判断是否同一件事。' }
                : {}),
              hits,
            })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/root/move',
        handler: async (req, res) => {
          try {
            // ⚠️ 最危险的写路由：误触发会真的搬走整个记忆目录。
            // 空 body 会让 target 变成空串 → 走 expandRoot 的默认值分支，
            // 等于「迁到默认位置」—— 必须显式拒绝非 POST。
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（迁移整个记忆目录）' })
            }
            const body = await readBody(req)
            const target = typeof body.root === 'string' ? body.root : ''
            // ⚠️ 2026-11-16 修：原来的校验是 `!isAbsolute(expandRoot(target))`，
            // 而 expandRoot 内部会 `resolve(value)` —— resolve 把**相对路径**
            // 也变成绝对路径，所以 isAbsolute 对它恒为 true。
            // 结果：任何字符串（"not-absolute"、"随便什么"）都能通过校验，
            // 然后真的执行迁移。实测把 cordis.patch.yml 和指针文件都写坏了。
            //
            // 正确做法：判断**用户传进来的原始值**是否绝对路径。
            // expandRoot 的职责是展开 `~` 这类简写，不是替用户补全相对路径。
            //
            // 注意 `~` 开头是合法的简写（expandRoot 会展开成 homedir），
            // 所以这里单独放行，不能一刀切要求原始值 isAbsolute。
            const rawTarget = target.trim()
            const looksAbsolute = isAbsolute(rawTarget) || rawTarget === '~' ||
              rawTarget.startsWith('~/') || rawTarget.startsWith('~\\')
            if (rawTarget === '' || !looksAbsolute) {
              return json(res, 400, { ok: false, error: '需要绝对路径（或用 ~ 开头的路径）' })
            }
            // 传 retargetLogs：迁移一完成就把日志落点切到新目录，
            // 之后的新日志直接写新位置，不用等重启。
            const result = await store.migrateRoot(target, retargetLogs)
            // ⚠️ 迁移只搬文件，不搬数据库连接。这里必须重新绑定，
            // 否则插件继续读写旧库（用户会看到"迁移后记忆空了"）。
            // 详见 rebindDbStore 的注释。
            const dbOk = rebindDbStore(result.root)
            diag('root-migrated', {
              to: result.root,
              moved: result.moved,
              logsCopied: result.logsCopied,
              dbRebound: dbOk,
              skipped: result.skippedEntries?.length ?? 0,
            })
            // ⚠️ 被跳过的条目必须单独记一条，且带完整路径 ——
            // 混在上面的计数里等于没说清「哪些没搬过来」。
            // copyTree 不复制 junction / 符号链接（理由见它的注释），
            // 静默跳过会让用户以为「都搬过去了」，回头找文件找不到。
            if ((result.skippedEntries?.length ?? 0) > 0) {
              diag('root-migrate-skipped', { count: result.skippedEntries.length, paths: result.skippedEntries })
            }
            const editor = ctx.get?.('configEditor')
            const entry = ctx.fiber?.entry
            if (editor === undefined || entry === undefined) {
              return json(res, 200, {
                ok: true,
                moved: result.moved,
                logsCopied: result.logsCopied,
                root: result.root,
                dbRebound: dbOk,
                // junction / 符号链接不会被复制，这里如实告诉前端
                skippedEntries: result.skippedEntries ?? [],
                // 数据库已切到新位置，但配置没写成 —— 重启后仍会读旧配置，
                // 所以要提示手动改 cordis.patch.yml。
                needsRestart: true,
                warning:
                  '已迁移数据并把数据库切到新位置，但无法写入配置；' +
                  '请手动修改 cordis.patch.yml 的 root 后重启。',
              })
            }
            await editor.edit(entry, (current) => ({ ...current, root: target }))
            json(res, 200, {
              ok: true,
              moved: result.moved,
              logsCopied: result.logsCopied,
              root: result.root,
              saved: true,
              dbRebound: dbOk,
              skippedEntries: result.skippedEntries ?? [],
              // 数据库连接已经热切到新位置，功能上立刻可用。
              // 但 state.json 里各项目的 dir 已被改写、store 的路径缓存
              // 也可能有残留，重启一次是最干净的确认方式 —— 所以仍提示。
              needsRestart: true,
              logDir: join(result.root, 'logs'),
              warning: dbOk
                ? '迁移完成。建议重启 DSH 以确保所有缓存都指向新位置。'
                : '文件已迁移，但新位置的数据库打不开，已回退文件模式。请重启 DSH 或检查目录权限。',
            })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/project/move',
        handler: async (req, res) => {
          try {
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（搬运项目目录）' })
            }
            const body = await readBody(req)
            const project = typeof body.project === 'string' ? body.project : ''
            const dir = typeof body.dir === 'string' ? body.dir : ''
            if (project.trim() === '' || dir.trim() === '') {
              return json(res, 400, { ok: false, error: '需要 project 与 dir' })
            }
            const result = await store.moveProject(slugify(project), dir)
            // 同 root/move：junction / 符号链接不会被复制，必须留痕
            if ((result.skippedEntries?.length ?? 0) > 0) {
              diag('project-move-skipped', { project: result.key, count: result.skippedEntries.length, paths: result.skippedEntries })
            }
            json(res, 200, { ok: true, ...result })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        kind: 'exact',
        path: '/api/dsh-memory/scope/rename',
        handler: async (req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 400, { ok: false, error: '当前为文件模式' })
            // ⚠️ 空 body 会让 from/to 都变成空串；改名涉及三表事务，
            // 误触发代价很高 —— 必须显式拒绝非 POST。
            if (req.method !== 'POST') {
              return json(res, 405, { ok: false, error: '只接受 POST（工作区改名有副作用）' })
            }
            const body = await readBody(req)
            const from = typeof body.from === 'string' ? body.from.trim() : ''
            const to = typeof body.to === 'string' ? body.to.trim() : ''
            if (from === '' || to === '') {
              return json(res, 400, { ok: false, error: '需要 from 与 to' })
            }

            if (body.dryRun === true) {
              // 干跑 = 只采「迁前快照」，不写库。
              //
              // 这里用的 snapshotScope 与 renameScope 内部**是同一个函数**
              // （2026-11-15 用户要求「迁移前整理数据量，迁移后报告是否一致」）——
              // 预览数字与迁移基线必须同源，否则会出现「预览 162、实际动 42」。
              //
              // 为什么给两套数字：同一个 scope 在不同入口读出三个数
              // （dryRun 全部行 / byScope 仅 active 的 rules+logs / archive 完全不进统计）。
              // 只给一个必然被误读。
              const before = dbStore.snapshotScope(from)
              // 目标区域现状 —— 决定这是「改名」还是「合并」
              const targetBefore = dbStore.snapshotScope(to)

              const occupied = {}
              for (const t of dbStore.SCOPE_TABLES) {
                occupied[t] = targetBefore.tables[t].all
              }
              const conflicts = Object.entries(occupied).filter(([, n]) => n > 0)
              const hasTarget = conflicts.length > 0

              return json(res, 200, {
                ok: true,
                dryRun: true,
                from,
                to,
                // 兼容旧字段（GUI 早期按 tables/total 取值）
                tables: Object.fromEntries(dbStore.SCOPE_TABLES.map((t) => [t, before.tables[t].all])),
                total: before.total.all,
                before,
                // 目标已有数据 ≠ 不能做，而是「会合并」。2026-11-15 用户明确：
                // 新建工作区再往里迁记忆是常见路径，必须支持。
                targetBefore,
                conflicts: hasTarget ? Object.fromEntries(conflicts) : null,
                willMerge: hasTarget,
                // 合并后的预计总量（迁移前就能算出来，给用户看「一共会变成多少」）
                expectAfter: {
                  tables: Object.fromEntries(
                    dbStore.SCOPE_TABLES.map((t) => [
                      t,
                      before.tables[t].all + targetBefore.tables[t].all,
                    ]),
                  ),
                  total: before.total.all + targetBefore.total.all,
                },
                // 只要有源数据就能做：目标为空 = 改名，目标非空 = 合并
                canRename: before.total.all > 0,
                // 顺带把「所有有数据的工作区」给 GUI 当下拉选项。
                // 不能让它用 /state 的 byScope —— 那个只数 active 的 rules+logs，
                // 会漏掉「全是停用条目」或「只有 archive」的工作区（2026-11-15 实测）。
                scopes: dbStore.listScopesWithData(),
              })
            }

            const result = dbStore.renameScope(from, to, {
              allowMerge: body.allowMerge === true,
            })
            diag('scope-renamed', {
              from: result.from,
              to: result.to,
              merged: result.merged,
              tables: result.tables,
              total: result.total,
              verified: result.verify?.ok,
            })

            // ---- state.json 同步 ----
            //
            // ## 先搞清楚：源键不一定是 `from`
            //
            // `state.projects` 的键来自 **cwd 的 basename**（目录名），不是 scope 名。
            // 所以「`from` 不在 projects 里」是**正常情况**，不是出错：
            // 用户把 `干杂活` 改名成 `SoftTest` 后，键是 `SoftTest`（目录名）、
            // 而 scope 也是 `SoftTest`，此时从 `干杂活` 找不到任何键。
            //
            // 2026-11-15 实测踩到：SoftTest→SoftTestX 之后改回来（SoftTestX→SoftTest），
            // 源键 `SoftTestX` 不存在 → 整段逻辑跳过 → `scope` 字段**残留旧值**，
            // 于是库里的 scope 叫 SoftTest、state 却还指 SoftTestX —— 数据看不见。
            //
            // 所以要按三个方向找源条目：**键 === from**、**键 === to**、
            // 或**某条目的 .scope === from**。找到哪个就改哪个，一个都没有才算无关联。
            //
            // ## 键该不该跟着改？答案是「不改」
            //
            // 键是目录名，改了它，下次开会话按目录名算出的 base 就查不到条目
            // → 建一个新的空 scope，数据全在旧名下永远见不到。这是最容易漏的一层。
            // 正确做法：**键保持目录名不动**，只更新 `.scope` 字段。
            //
            // 例外：`.scope` 恰好等于键时（即记忆名回到与目录名一致），
            // 就把字段删掉，让「缺省 = 跟随目录名」这条规则生效，避免留下无意义的冗余。
            let stateSynced = null
            try {
              // ⚠️ 2026-11-17：整段包进 store.serialize()。
              //
              // 这是「读 state → 改 projects → 写 state」。改名期间若别的会话
              // 恰好 registerProject（新项目第一次说话），它写回的 state 会
              // 覆盖掉我们刚改的 .scope —— 表现为「改名成功，但下次会话
              // 又按旧 scope 算，数据看不见」。正是 D13 那个坑的形态。
              //
              // 用 store.serialize 而不是自己造锁：必须是**同一把**队列，
              // 否则两把锁互不排斥，等于没锁。
              await store.serialize(async () => {
                const st = await store.readState()
                const projects = st.projects ?? {}

                // 依次尝试：键===from → 键===to → .scope===from
                let key = undefined
                if (projects[from] !== undefined) key = from
                else if (projects[to] !== undefined) key = to
                else {
                  for (const [k, v] of Object.entries(projects)) {
                    if (v && v.scope === from) { key = k; break }
                  }
                }

                if (key === undefined) return

                const entry = projects[key]
                if (key === to) {
                  // 记忆名回到了目录名 → 删掉映射字段，回到「缺省跟随」
                  delete entry.scope
                } else {
                  entry.scope = to
                }
                // 若另一侧残留同源键（历史遗留），清掉 —— 它的数据已经迁走了
                for (const other of new Set([from, to])) {
                  if (other !== key && projects[other] !== undefined) {
                    const o = projects[other]
                    if (o && (o.scope === from || o.scope === to || other === from)) delete projects[other]
                  }
                }
                await store.writeState(st)
                stateSynced = { key, scope: key === to ? null : to }
              })
            } catch (error) {
              logger.warn?.(`[dsh-memory] scope 改名后同步 state.json 失败：${error?.message ?? error}`)
            }

            json(res, 200, { ok: true, ...result, stateSynced })
          } catch (error) {
            json(res, 400, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
      {
        /**
         * 列出「有数据的工作区」—— 工作区改名页的下拉框数据源。
         *
         * 为什么不复用 `/state` 的 `db.byScope`：
         * 那个只统计 `status='active'` 的 rules + logs，也不看 archive。
         * 2026-11-15 实测：工作区 `design` 有 18 行 rules **全部停用**，
         * byScope 里根本没有它 —— 下拉框会漏掉这个有数据的工作区。
         * 这里按 `snapshotScope` 同一口径（三表全部行），
         * 保证「下拉框里有的 = 改名时确实会动的」。
         */
        kind: 'exact',
        path: '/api/dsh-memory/scope/list',
        handler: async (_req, res) => {
          try {
            if (!dbStoreExists()) return json(res, 200, { ok: true, scopes: [] })
            json(res, 200, { ok: true, scopes: dbStore.listScopesWithData() })
          } catch (error) {
            json(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      },
    ]

    const disposers = routes.map((route) => {
      try {
        const disposer = webServer.register(route)
        registeredRoutes.push(route.path)
        diag('route-registered', { path: route.path })
        return disposer
      } catch (error) {
        diag('route-FAILED', { path: route.path, message: String(error?.message ?? error) })
        return () => {}
      }
    })
    injected.effect(
      () => () => {
        for (const dispose of disposers) dispose()
      },
      'dsh-memory: routes',
    )
  })

  /**
   * 启动健康自检：确认所有挂载点都注册成功。
   *
   * 为什么需要它（2026-11-11 提出的问题）：
   * DSH 客户端升级可能改变内部 API（事件名、systemPrompt.context 签名、
   * slots 注册方式……）。这类变化**大多不报错** —— 插件照样"加载成功"，
   * 但某个能力悄无声息地失效了。今天已经踩过一次同类的：
   * assistant/message 的文本从 event.data.content 挪到了
   * event.data.message.content，结果标记写入全部失效且无任何日志。
   *
   * 所以这里在加载完成后主动清点：监听挂上了吗？注入注册了吗？
   * 命令和路由呢？缺一个就明确报警，而不是等人发现"记忆怎么不好用了"。
   *
   * 这只做**存在性**检查，不做行为验证 —— 判断"监听器注册了"容易，
   * 判断"签名还是老格式、能被正确调用"要靠实际跑一次。
   * 升级后仍建议真跑一轮（发一条带标记的消息）。
   */
  /**
   * 一行健康状态文本，给 /memory status 用。
   * 桌面版看不到 console，所以状态必须能从这里直接读出来。
   */
  const healthLine = (info) => {
    const h = info?.health
    if (h === undefined || h.checked !== true) return '健康自检：尚未运行'
    if (h.ok) return `健康自检：${h.total} 项全部就位`
    return `健康自检：⚠ ${h.failed.length}/${h.total} 项异常 → ${h.failed.join(', ')}`
  }

  const runHealthCheck = () => {
    try {
      const checks = []

      // 1. 事件监听：这四个缺一不可
      const expectedEvents = ['session/event', 'tools/result', 'agent/turn-stopping', 'agent/created']
      for (const name of expectedEvents) {
        const attached = attachedEvents.has(name)
        checks.push({ name: `event:${name}`, ok: attached })
      }

      // 2. 注入层
      checks.push({ name: 'inject:systemPrompt', ok: injectedPrompt === true })

      // 3. 命令与路由
      checks.push({ name: 'command:memory', ok: registeredCommand === true })
      // 路由数会随功能增长（数据库编辑接口让 3 条变 8 条），
      // 所以判断「至少有基础 3 条」而不是精确等于某个数 ——
      // 写死数量会让每次加路由都造成一次假报警。
      checks.push({
        name: 'routes',
        ok: registeredRoutes.length >= 3,
        detail: registeredRoutes,
      })

      // 4. 记忆存储
      if (dbStoreExists()) {
        // 数据库模式：连库可读即可，比检查目录更有意义
        let ok = false
        let detail = ''
        try {
          const st = dbStore.stats()
          ok = st.total >= 0
          detail = `${st.total} 条 · ${(st.dbSize / 1024).toFixed(0)}KB · schema v${st.schemaVersion}`
        } catch (e) {
          detail = String(e?.message ?? e)
        }
        checks.push({ name: 'db:readable', ok, detail })
      }
      // 5. 记忆根目录可访问（文件回退路径仍然需要）
      checks.push({ name: 'root:readable', ok: syncPathExists(store.root) })

      const failed = checks.filter((c) => !c.ok)

      // 把结论落到 healthState，供面板和 /memory status 读取
      healthState.checked = true
      healthState.ok = failed.length === 0
      healthState.total = checks.length
      healthState.failed = failed.map((c) => c.name)
      healthState.checkedAt = new Date().toISOString()
      healthState.detail = checks.map((c) => `${c.ok ? 'OK' : 'FAIL'} ${c.name}`)

      diag('health-check', {
        total: checks.length,
        failed: failed.length,
        detail: checks.map((c) => `${c.ok ? 'OK' : 'FAIL'} ${c.name}`),
      })

      if (failed.length > 0) {
        const names = failed.map((c) => c.name).join(', ')
        // 同时写一条纯文本结论进日志 —— logger 在桌面版里看不到，
        // 日志文件是唯一保证可查的地方。
        diag('health-check-verdict', `发现 ${failed.length} 项异常：${names}。如果刚升级过 DSH，很可能是内部 API 变了。记忆数据安全（${store.root}），但对应能力可能失效。`)
        logger.warn?.(
          `[dsh-memory] 健康自检发现 ${failed.length} 项异常：${names}\n` +
            `如果刚刚升级过 DSH，很可能是内部 API 变了。` +
            `记忆数据本身安全（在 ${store.root}），但对应能力可能失效。\n` +
            `排查：看 ${join(store.root, 'logs')} 里的 [health-check] 明细。`,
        )
      } else {
        diag('health-check-verdict', `通过：${checks.length} 项全部就位`)
        logger.info?.(`[dsh-memory] 健康自检通过：${checks.length} 项全部就位`)
      }
      return failed.length === 0
    } catch (error) {
      diag('health-check-ERROR', { message: String(error?.message ?? error) })
      return false
    }
  }

  diag('apply-complete', { tools: 'none' })

  // 等所有同步注册跑完再清点（events/commands/routes 都是同步注册的，
  // 放在下一个 tick 是为了让注入层等异步装配也完成）
  setTimeout(runHealthCheck, 600)

  // ---- 周期心跳（2026-11-16 22:35）----
  //
  // ## 为什么需要它
  //
  // 在此之前，插件**没有任何周期性写入**：`runHealthCheck` 只在 apply 后
  // 跑一次（上面那个 setTimeout）。于是日志文件会有长达数小时的空档 ——
  // 那既是"用户没操作"，也可能是"进程已经死了"，**事后无法区分**。
  // 2026-11-16 实测：日志里最长一段空档 465 分钟，正好是用户歇息那段。
  //
  // 心跳把这件事变可判定：**只要进程活着，日志每 5 分钟必然多一行**。
  // 于是"这段时间它活着吗"不再需要猜。
  //
  // ## 为什么写日志而不是写数据库
  //
  // `memory.db` 的 logs 表是**记忆**（会被 /search 检索、被 GUI 展示、
  // 按 topic 计数后每轮注入）。心跳若写进去，一天 288 条纯噪音会把
  // 记忆索引挤变形。诊断日志本来就是"给人事后看发生了什么"的地方，
  // 空档与心跳都属于它的语义范围。
  //
  // ## 为什么 5 分钟、为什么判死给 15 分钟
  //
  // 用户 2026-11-16 定的：更短能更早发现问题。
  // 5 分钟 × 3 倍容错 = 15 分钟，容忍一次调度延迟或短暂卡顿，
  // 又不会把"刚卡了一下"误判成"死了"。
  //
  // ## 注意 unref
  //
  // `timer.unref()` 让这个定时器**不阻止进程退出**。不调用的话，
  // 插件会让宿主进程无法正常关闭（Node 的事件循环会一直有待办定时器）。
  const HEARTBEAT_MS = 5 * 60 * 1000
  const heartbeat = () => {
    healthState.lastBeat = Date.now()
    // healthy 用 `healthState.checked && healthState.ok`，不是直接 `healthState.ok`。
    //
    // 为什么：首次心跳是在自检跑完**之前**触发（两个 setTimeout/setInterval
    // 都排在 apply 末尾，600ms 那次才跑自检）。此时 `ok` 还是初始值 false，
    // 直接写会留下 `[heartbeat] {"healthy":false}` 这种**误导性**记录 ——
    // 事后看到会以为"心跳时状态异常"，其实是"还没检查"。
    //   2026-11-16 22:36 实测踩到：重载后第一行就是 healthy:false。
    // healthy 只表达"心跳发生时自检是否通过"，未检查 ≠ 不健康。
    diag('heartbeat', { healthy: healthState.checked ? healthState.ok : null })
  }
  const timer = setInterval(heartbeat, HEARTBEAT_MS)
  timer.unref?.() // 不阻止进程退出（某些宿主环境可能没有 unref）
  heartbeat() // 立刻打一次：否则 apply 后要等满 5 分钟才有第一行

  // 挂在 effect 上，插件卸载/热重载时自动清理 ——
  // 否则每重载一次就多一个定时器，一天能堆出几十个。
  ctx.effect(() => () => clearInterval(timer), 'dsh-memory: heartbeat')
}
