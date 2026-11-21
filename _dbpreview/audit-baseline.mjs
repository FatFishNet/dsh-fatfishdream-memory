/**
 * 完整自检的**已知问题基线**。
 *
 * 登记在这里 = 已知，不判红；不在基线里 = 新增，判红。
 * 基线里有、但本次没命中 = 已修复，可以删掉。
 *
 * ⚠️ 每一条的 note 必须能回答「为什么不修」或「什么时候修」。
 *    答不出来的，说明该去修代码，而不是往这里塞。
 *
 * ## 当前基线：29 条，全部来自 2026-11-16 第 7 轮审查
 *
 * 分三类处置：
 *   【待修】 确认是缺陷，排进第一批 / 第二批
 *   【设计】 刻意如此，不是缺陷（写明为什么）
 *   【误报】 规则形态匹配但语义安全（应改进规则，别长期靠基线压着）
 *
 * 生成方式：`node _dbpreview/audit-full.mjs --adopt`，然后人工填 note。
 */

export const KNOWN = [
  {
    hash: '980c117a67e9',
    ruleId: 'bare-json-parse',
    file: 'dsh-fatfishdream-memory/index.js',
    note: '【设计】index.js:65 读 package.json —— 包作者自己写的文件，不会有 BOM。代码里有注释说明为何刻意不用 parseJson（避免模块顶部常量依赖后文工具）',
  },
  {
    hash: 'ab1e09835422',
    ruleId: 'bare-json-parse',
    file: 'dsh-fatfishdream-memory/index.js',
    note: '【误报】index.js:430 是 parseJson() 内部的实现本身 —— 它剥掉 BOM 后调 JSON.parse',
  },
  {
    hash: '856cc3b7b2c9',
    ruleId: 'bare-json-parse',
    file: 'dsh-fatfishdream-memory/index.js',
    note: '【设计】index.js:4848 解析 URL query 里的 detail —— 来自 searchParams，非文件读写，BOM 场景不适用；且外层已有 catch 降级为 { parseError: true }',
  },
  {
    hash: '31007446ca68',
    ruleId: 'empty-catch-swallow',
    file: 'dsh-fatfishdream-memory/index.js',
    note: '【设计】index.js:3286 findTableById 逐表试探，抛错就试下一张 —— 「这张表没有这个 id」本来就是预期的控制流',
  },
  {
    hash: '723562d93b9d',
    ruleId: 'empty-catch-swallow',
    file: 'dsh-fatfishdream-memory/index.js',
    note: '【设计】index.js:4005 /memory status 里算「最后写入日」失败就不显示，不该因此让整个命令失败',
  },
  {
    hash: 'e0a76ace09b8',
    ruleId: 'empty-catch-swallow',
    file: 'dsh-fatfishdream-memory/client.js',
    note: '【设计】client.js 拉取收尾语失败时保持草稿 —— 面板不该因网络抖动变空白',
  },
  {
    hash: '21903f30fe67',
    ruleId: 'empty-catch-swallow',
    file: 'dsh-fatfishdream-memory/client.js',
    note: '【设计】client.js:975 改名后刷新工作区列表失败不影响改名结果本身',
  },
  {
    hash: '54627de624be',
    ruleId: 'empty-catch-swallow',
    file: 'dsh-fatfishdream-memory/db-store.mjs',
    note: '【设计】db-store.mjs:1181 stats 里取文件大小，取不到就不显示体积',
  },
  {
    hash: 'ecc3fa111b9e',
    ruleId: 'empty-catch-swallow',
    file: 'dsh-fatfishdream-memory/db-store.mjs',
    note: '【设计】db-store.mjs:1322 stats 里统计 archive 条数，旧 schema（v3）没有这张表，失败即 0',
  },
  {
    hash: '04b80641ad82',
    ruleId: 'empty-catch-swallow',
    file: 'dsh-fatfishdream-memory/db-store.mjs',
    note: '【设计】db-store.mjs:1324 stats 里取库文件大小，同 1181',
  },
]

export default { KNOWN }
