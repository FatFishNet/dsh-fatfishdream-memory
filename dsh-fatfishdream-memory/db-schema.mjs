/**
 * 记忆系统 schema 定义
 *
 * ============================================================
 * v2（2026-11-13）：单表拆成四张
 * ============================================================
 *
 * 为什么拆：v1 用单表 + kind 字段区分六种数据，取一类要同时写对
 * scope/kind/status 三个条件。用户的原话是「按功能区分的话」——
 * 这问法本身就说明问题：独立表让人直接知道去哪看，单表则把不同
 * 性质的数据混在一个容器里，只能靠「约定」区分，而约定是软的。
 *
 * 四张表的分界按**生命周期与访问方式**，不是按内容主题：
 *
 *   profile  用户画像   量极小(9)、人工维护、每轮注入、几乎不变
 *   rules    规则与偏好  量小(110)、人工维护、按项目注入、偶尔改
 *   emotion  情绪记录   自动录入、需复核、不注入、只增不改（除修正）
 *   logs     记忆流水   量大(257)、只追加、永不注入、只检索
 *
 * 四者的「写频率 / 读频率 / 是否注入 / 是否需复核」全都不同，
 * 放在一张表里只是被迫共用字段，没有真正的共性。
 */

/**
 * 当前 schema 版本
 *
 * v3（2026-11-14）：三层记忆 —— logs 加 summary（≤35 字）与 keywords，
 * 检索先用摘要+关键词命中，再回正文。
 * v4（2026-11-14）：新增 archive —— **原始对话归档**（user/assistant 原文，
 * 一条不丢），供追溯与全文检索；不注入、不进默认 /search。
 * v5（2026-11-14）：三件收尾 ——
 *   ① `emotion.confidence` 归一化为 high / low / legacy（此前中文『高置信』
 *      与 NULL 并存，统计 low 比例会静默算错）；
 *   ② emotion 退出检索池（它是「个人兴趣记录」，模板句会挤占结论层结果位，
 *      见 db-store.mjs 的 search() 注释）；
 *   ③ 删除 v1 的 entries 冷存档（用户在清空过历史后确认不再需要）。
 */
export const SCHEMA_VERSION = 5

/** CJK 分词：按字拆，供 FTS 索引与查询使用 */
export function segmentCjk(text) {
  return String(text ?? '')
    .replace(/[\u4e00-\u9fa5]/g, (c) => ` ${c} `)
    .replace(/\s+/g, ' ')
    .trim()
}

/** 查询词 → FTS5 MATCH 表达式（中文逐字 AND，英文保留整词） */
export function buildMatchQuery(query) {
  const segs = segmentCjk(query).split(' ').filter(Boolean)
  if (segs.length === 0) return null
  return segs.map((s) => `"${s.replace(/"/g, '')}"`).join(' AND ')
}

/**
 * 四张业务表。
 *
 * 共同的列刻意保持一致（id / status / ts / text / writer / review），
 * 这样 GUI 和检索层可以用同一套代码处理四种数据；差异列只在需要的表里。
 */
const CREATE_PROFILE = `
CREATE TABLE IF NOT EXISTS profile (
  id          INTEGER PRIMARY KEY,
  ts          TEXT,              -- 建立时间
  topic       TEXT,              -- 分类：称呼 / 工作习惯 / 交互偏好 / 取舍
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | stale | deleted
  writer      TEXT NOT NULL DEFAULT 'model',
  review      TEXT,              -- NULL | edited | retracted
  review_note TEXT,
  updated     TEXT
);
CREATE INDEX IF NOT EXISTS idx_profile_status ON profile(status, topic);
`

const CREATE_RULES = `
CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY,
  scope       TEXT NOT NULL DEFAULT '__global__',  -- '__global__' 或项目名
  kind        TEXT NOT NULL DEFAULT 'pref',        -- redline | pref | state | fact
  ts          TEXT,
  topic       TEXT,
  text        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  writer      TEXT NOT NULL DEFAULT 'model',
  review      TEXT,
  review_note TEXT,
  updated     TEXT
);
CREATE INDEX IF NOT EXISTS idx_rules_scope ON rules(scope, kind, status);
CREATE INDEX IF NOT EXISTS idx_rules_topic ON rules(topic);
`

/**
 * 情绪记录。
 *
 * 独立成表的核心理由：它由插件**自动**写入、可能误判、需要复核。
 * 与人为确认的画像/规则在信任等级上不同，混在一起容易被当成事实。
 */
const CREATE_EMOTION = `
CREATE TABLE IF NOT EXISTS emotion (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  cls         TEXT,              -- 爱意 / 夸赞 / 吐槽 / 低落 ...
  quote       TEXT NOT NULL,     -- 用户原话
  evidence    TEXT,              -- 命中的词 + 得分
  confidence  TEXT,              -- 高置信 / 低置信
  score       REAL,
  text        TEXT NOT NULL,     -- 拼好的整行（便于统一展示）
  status      TEXT NOT NULL DEFAULT 'active',
  review      TEXT,              -- NULL | retracted | edited
  review_note TEXT,
  writer      TEXT NOT NULL DEFAULT 'plugin'
);
CREATE INDEX IF NOT EXISTS idx_emotion_ts ON emotion(ts);
CREATE INDEX IF NOT EXISTS idx_emotion_status ON emotion(status, review);
`

/**
 * 记忆流水。
 *
 * 独立成表最没有争议：257 条占原有数据的 2/3，只追加、永不更新、
 * 永不注入、只按关键词/时间检索。它和另外三张表没有任何共同字段需求。
 *
 * ⚠️ 这里的 v2 建表语句**保持原样不要改**（迁移文件是不可变历史）。
 * v3 新增的两列 summary / keywords 由 MIGRATIONS[2] 用 ALTER 补上 ——
 * 空库也会依次跑 v2、v3，所以两条路径的最终结构完全一致。
 */
const CREATE_LOGS = `
CREATE TABLE IF NOT EXISTS logs (
  id       INTEGER PRIMARY KEY,
  scope    TEXT NOT NULL DEFAULT '__global__',
  ts       TEXT,
  topic    TEXT,
  text     TEXT NOT NULL,
  status   TEXT NOT NULL DEFAULT 'active',
  writer   TEXT NOT NULL DEFAULT 'model'
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
CREATE INDEX IF NOT EXISTS idx_logs_scope ON logs(scope, status);
CREATE INDEX IF NOT EXISTS idx_logs_topic ON logs(topic);
`

/**
 * 原始对话归档（v4，2026-11-14）。
 *
 * 为什么加：用户明确要求「记忆就是完整的，而不是取舍」——
 * 模型对「该不该记」的判断本身会丢信息。于是把 user/assistant 的原文
 * **一条不落地**存下来，作为不可变的底层档案：
 *
 *   - 不注入（否则每轮上下文会爆）；
 *   - 不进默认 `/search`（否则检索结果被原文淹没）；
 *   - 只通过 `/api/dsh-memory/archive` 按项目/时间/关键词回溯。
 *
 * `logs` 仍是模型写的「结论层」，`archive` 是「原文层」；
 * 两者互补，不是替代关系。
 */
const CREATE_ARCHIVE = `
CREATE TABLE IF NOT EXISTS archive (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '__global__',
  role        TEXT NOT NULL,        -- user | assistant
  text        TEXT NOT NULL,
  session_id  TEXT,
  turn        INTEGER,
  step        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_archive_ts ON archive(ts);
CREATE INDEX IF NOT EXISTS idx_archive_scope ON archive(scope, ts);
CREATE INDEX IF NOT EXISTS idx_archive_role ON archive(role, ts);
`

/** 四张表的 FTS 索引（contentless，需手动同步） */
const CREATE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS profile_fts USING fts5(text, topic, seg, content='', tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS rules_fts   USING fts5(text, topic, seg, content='', tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS emotion_fts USING fts5(text, topic, seg, content='', tokenize='unicode61');
CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts    USING fts5(text, topic, seg, content='', tokenize='unicode61');
`

/**
 * v3 的日志 FTS 表（5 列）。
 *
 * 列顺序**同时是 bm25 权重的顺序**，改动时必须同步 db-store 里的
 * `bm25(logs_fts, ...)` 参数 —— 权重个数少于列数会直接报错或错位加权。
 */
const LOGS_FTS_V3 = `
CREATE VIRTUAL TABLE logs_fts USING fts5(
  summary, keywords, text, topic, seg, content='', tokenize='unicode61'
);
`

/**
 * 迁移历史。
 *
 * v1 → v2 不做原地转换：v1 的 entries 表保留（作为可回退的历史），
 * 数据由 `_archive/legacy-migrations/db-migrate-v2.mjs` 复制进四张新表并校验条数
 * （已归档：旧 `syncFts` 位置参数签名，不要再运行）。
 * 这样即使拆表有 bug，旧数据仍在。
 *
 * **v5 起 entries 已被删除**（2026-11-14，用户确认历史流水都已清空过、不再需要）。
 * 备份在 `_dbbackup/memory.db.v3-2026-11-14T03-30` 等文件里仍可找到那 386 条。
 */
export const MIGRATIONS = [
  {
    version: 1,
    describe: 'v1：单表 entries（已废弃，仅保留数据）',
    up() {
      /* v1 由旧版本的 CREATE_TABLES 建立，这里不再创建 */
    },
  },
  {
    version: 2,
    describe: 'v2：拆为 profile / rules / emotion / logs 四张表',
    up(db) {
      db.exec(CREATE_PROFILE)
      db.exec(CREATE_RULES)
      db.exec(CREATE_EMOTION)
      db.exec(CREATE_LOGS)
      db.exec(CREATE_FTS)
    },
  },
  {
    version: 3,
    describe: 'v3：logs 加 summary / keywords，logs_fts 重建为 5 列',
    up(db) {
      // 1) 加列。SQLite 的 ALTER TABLE 只能加列，这里够用。
      db.exec('ALTER TABLE logs ADD COLUMN summary TEXT')
      db.exec('ALTER TABLE logs ADD COLUMN keywords TEXT')
      // 2) 老数据兜底：没有摘要就用正文前 40 字（设计决议 #3）。
      //    一次性写进库，而不是检索时实时截断 —— 实时截断会让
      //    summary 字段的值取决于查询时刻，无法测试也无法稳定排序。
      db.exec('UPDATE logs SET summary = substr(text, 1, 40) WHERE summary IS NULL')
      // 3) FTS5 **不能加列**（官方明确加列属于依赖未文档化行为），
      //    只能 DROP + CREATE + 把全部行重新 INSERT。
      //    漏这步 = 新表里查不到旧索引，表现为「加了字段后检索全空」。
      db.exec('DROP TABLE IF EXISTS logs_fts')
      db.exec(LOGS_FTS_V3)
      const rows = db.prepare('SELECT id, summary, keywords, text, topic FROM logs').all()
      const ins = db.prepare(
        'INSERT INTO logs_fts(rowid, summary, keywords, text, topic, seg) VALUES (?,?,?,?,?,?)',
      )
      for (const r of rows) ins.run(...[r.id, ...ftsValues('logs', r)])
    },
  },
  {
    version: 4,
    describe: 'v4：新增 archive 原始对话归档 + archive_fts',
    up(db) {
      db.exec(CREATE_ARCHIVE)
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(text, seg, content='', tokenize='unicode61')`,
      )
    },
  },
  {
    version: 5,
    describe: 'v5：confidence 归一化 + 移除 emotion 检索 + 删 v1 entries 冷存档',
    // 这个迁移会 DROP 表，需要迁移后 VACUUM 才能把空间还给文件系统
    drops: true,
    up(db) {
      // ---- ① confidence 归一化 ----
      // v4 之前写的是中文『高置信』，v4 起写 'high' / 'low'，远古行是 NULL。
      // 三种值并存会让「统计 low 比例」静默算错（= 'low' 匹配不到『低置信』和 NULL）。
      db.exec(`UPDATE emotion SET confidence='high' WHERE confidence='高置信'`)
      db.exec(`UPDATE emotion SET confidence='low'  WHERE confidence='低置信'`)
      db.exec(`UPDATE emotion SET confidence='legacy' WHERE confidence IS NULL`)

      // ---- ② 删 v1 entries 冷存档 ----
      // v2 拆表时刻意保留它「作为可回退的历史」（见本文件顶部注释）。
      // 2026-11-14 用户确认：那 386 条（含 11-13 的 257 条历史流水）已被主动
      // 清空过一次，不需要再留；_dbbackup 里有 5 份带这些数据的备份可回退。
      //
      // ⚠️ 这是**唯一**一处代码主动 DROP 用户数据的迁移。
      //
      // ⚠️ 顺序不能反（2026-11-14 干跑踩到）：
      //     `DROP TABLE entries_fts_data` 会抛
      //     `table entries_fts_data may not be dropped` ——
      //     `_data` / `_idx` / `_config` / `_docsize` 是 FTS5 虚拟表的**影子表**，
      //     只能通过 DROP 虚拟表本体 `entries_fts` 让 SQLite 自己连带清理。
      //     先删本体，再清理残留影子表（正常情况下已经没了，IF EXISTS 兜底）。
      db.exec('DROP TABLE IF EXISTS entries_fts')
      for (const suffix of ['_data', '_idx', '_config', '_docsize', '_content']) {
        db.exec(`DROP TABLE IF EXISTS "entries_fts${suffix}"`)
      }
      db.exec('DROP TABLE IF EXISTS entries')
    },
  },
]

// ---------------------------------------------------------------- FTS 同步

/** 四张表各自的 FTS 名（v4 起含 archive） */
export const FTS_TABLE = {
  profile: 'profile_fts',
  rules: 'rules_fts',
  emotion: 'emotion_fts',
  logs: 'logs_fts',
  archive: 'archive_fts',
}

/**
 * 每张 FTS 表的列，**顺序必须与建表语句一致**。
 *
 * v3：只有 logs 变了（5 列）。另外三张表保持 3 列不动 ——
 * 它们是规则/画像/情绪，内容短、没有摘要层，加列只会扩大改动面。
 * v4：archive 只有 text + seg（原文层不需要摘要）。
 */
export const FTS_COLUMNS = {
  profile: ['text', 'topic', 'seg'],
  rules: ['text', 'topic', 'seg'],
  emotion: ['text', 'topic', 'seg'],
  logs: ['summary', 'keywords', 'text', 'topic', 'seg'],
  archive: ['text', 'seg'],
}

/**
 * 一行数据 → 按 FTS_COLUMNS 顺序排好的值数组。
 *
 * `seg` 是 CJK 逐字切分列：unicode61 把整段中文当成一个词，
 * 只有把它拆成单字才能按字检索。所以 seg 必须包含**所有**可检索文本 ——
 * 摘要和关键词里的中文（如「行号重算」）不并进来就永远搜不到。
 */
function ftsValues(table, row) {
  const text = String(row?.text ?? '')
  const summary = String(row?.summary ?? '')
  const keywords = String(row?.keywords ?? '')
  const values = {
    summary,
    keywords,
    text,
    topic: String(row?.topic ?? ''),
    seg: segmentCjk([summary, keywords, text].filter(Boolean).join(' ')),
  }
  return FTS_COLUMNS[table].map((c) => values[c])
}

/**
 * 同步 FTS 索引。
 *
 * 参数用**对象**而不是位置参数：v3 起 logs 有 5 列、其余表 3 列，
 * 位置参数很容易把 summary 传成 topic 而无人察觉（FTS 错位不会报错）。
 * 旧脚本若仍传字符串，按「只有 text」处理。
 *
 * contentless 表（content=''）不能 DELETE，必须用 'delete' 命令并带原值。
 * 更新时先按旧值 delete 再插新值。
 */
export function syncFts(db, table, id, row, oldRow = null) {
  const fts = FTS_TABLE[table]
  if (!fts) throw new Error(`未知的记忆表：${table}`)
  const cols = FTS_COLUMNS[table]
  // rowid 也要占一个占位符：漏掉它就是「5 values for 6 columns」，
  // 而且只在真正写入时才炸 —— 建表、迁移、只读查询全都看不出来。
  const ph = new Array(cols.length + 1).fill('?').join(',')
  const asRow = (v) => (v !== null && typeof v === 'object' ? v : { text: v })
  if (oldRow !== null && oldRow !== undefined) {
    db.prepare(
      `INSERT INTO ${fts}(${fts}, rowid, ${cols.join(',')}) VALUES('delete', ${ph})`,
    ).run(id, ...ftsValues(table, asRow(oldRow)))
  }
  db.prepare(
    `INSERT INTO ${fts}(rowid, ${cols.join(',')}) VALUES (${ph})`,
  ).run(id, ...ftsValues(table, asRow(row)))
}

/** 删除时清理 FTS */
export function removeFts(db, table, id, row = null) {
  const fts = FTS_TABLE[table]
  if (!fts) return
  const cols = FTS_COLUMNS[table]
  const ph = new Array(cols.length + 1).fill('?').join(',')
  db.prepare(
    `INSERT INTO ${fts}(${fts}, rowid, ${cols.join(',')}) VALUES('delete', ${ph})`,
  ).run(id, ...ftsValues(table, row ?? {}))
}

/**
 * 打开数据库并升到最新 schema。
 * 版本比代码新时抛错 —— 让用户升级插件，而不是用旧代码操作新库。
 */
export function openMemoryDb(DatabaseSync, dbPath) {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL;')
  // NORMAL：进程崩溃不丢数据（WAL 重放），只有断电可能丢最近几秒
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA busy_timeout = 5000;')

  const current = db.prepare('PRAGMA user_version').get().user_version ?? 0
  if (current > SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `记忆库版本（${current}）比插件支持的（${SCHEMA_VERSION}）新，请升级插件`,
    )
  }
  // 迁移里若有 DROP TABLE，删掉的是**页**不是文件 —— 不 VACUUM 的话体积一分不省，
  // 只是变成可复用的空页（`dbstat` 里能看出来，`db.size` 看不出来）。
  // 2026-11-14 v5 删 entries 时实测：1312 KB → 1348 KB（反而涨了），
  // 加上这一步后才真正回落。只在**确实删过表**时跑，别让每次启动都付 VACUUM 的代价。
  let dropped = false
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue
    db.exec('BEGIN')
    try {
      m.up(db)
      if (m.drops === true) dropped = true
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new Error(`schema 迁移到 v${m.version} 失败：${e.message}`)
    }
  }
  if (dropped) {
    try {
      db.exec('VACUUM')
    } catch {
      /* VACUUM 失败不该阻止启动：数据已经对了，只是没回收空间 */
    }
  }
  return db
}
