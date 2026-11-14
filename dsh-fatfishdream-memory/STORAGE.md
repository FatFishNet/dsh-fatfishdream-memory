# 存储说明

这份文档讲**数据存在哪、长什么样、怎么备份和迁移**。
怎么用插件见 [README.md](README.md)；想改代码看仓库的 `docs/`。

一句话版本：**一个 SQLite 文件 + 一个 `policy.md` + 一堆诊断日志**，
全部在「记忆根目录」里。没有服务、没有外部依赖、没有云端同步。

---

## 1. 记忆根目录里有什么

```
<记忆根目录>/
├── memory.db                ← 唯一数据库（四张业务表 + 原文归档 + FTS）
├── memory.db-wal            ← WAL 日志（运行时存在，正常，别手动删）
├── memory.db-shm            ← WAL 共享内存（同上）
├── policy.md                ← 行为规则（每轮注入；**唯一会在运行时读写的 .md**）
├── state.json               ← 项目登记表 + 上次整理日期 + 待判队列
└── logs/
    └── YYYY-MM-DD.log       ← 插件诊断日志（不是记忆，可随时删）
```

| 文件 | 是记忆吗 | 能删吗 | 说明 |
|---|---|---|---|
| `memory.db` | ✅ **全部记忆都在这里** | 删了就全没了 | 单文件 SQLite，WAL 模式 |
| `policy.md` | ✅ 行为规则 | 删了插件会重建一份默认的 | 不进数据库，避免和 `rules` 抢注入预算 |
| `state.json` | ⚠️ 辅助 | 删了会重新登记项目 | 项目名 ↔ 目录映射、`lastConsolidate` |
| `logs/` | ❌ 诊断 | 可以 | 排查问题用；`diag()` 写的就是它 |

> `state.json` 里**没有记忆正文**，只有项目映射。真正的数据全在 `memory.db`。

---

## 2. 根目录怎么定（四级选址）

`cordis.patch.yml` 里 **`root` 刻意留空** —— 写死开发机路径会随包分发，
造成「没 D 盘就启动失败」「记忆被塞进用户从没指定过的位置」这类故障。

留空后按下面四级顺序找，找到即停：

```
1. 配置里手写的明确路径（留空 = 跳过；写 'auto' 也跳过）
2. 指针文件 ~/.dsh/memory-root.json —— 上次实际用过的目录
3. 磁盘上已有的同名目录 dsh-fatfishdream-memory/（兼容没有指针的老安装）
4. 首次安装：优先 D 盘 → 其他非系统盘按剩余空间 → 都没有才落「文档」目录
```

几个细节：

- **指针文件是权威**。GUI 里迁移目录后会重写它；下次启动按它走，路径不会跳。
- 指针指向的路径不可用（盘离线 / 目录被删）时，**不报错**，继续往下探测并重新写指针。
- 系统盘上两个历史位置也会被认（`<系统盘>\dsh-fatfishdream-memory`、`<用户文档>\dsh-fatfishdream-memory`），
  否则老用户的记忆会「凭空消失」。
- 落在系统盘时日志里会有一条提示（重装系统会丢），但不阻止使用。

**固定某台机器的位置**：用 GUI「存储设置」页迁移，它会写指针文件。
那是用户自己的决定，不该由包作者在 `cordis.patch.yml` 里替他决定。

---

## 3. `memory.db` 的结构

- **单文件 SQLite**，WAL 模式（并发读写更好，代价是多两个 `-wal` / `-shm` 临时文件）
- 版本用 `PRAGMA user_version` 管理，当前 **schema v5**
- **零第三方依赖**：用 Node 内置的 `node:sqlite`（SQLite 3.53.x）
- 五张表（四张业务表 + 一张原文层）+ 五个 FTS5 虚拟表

### 3.1 五张表

| 表 | 主键 | 关键列 | 写入者 | 注入 | 检索 |
|---|---|---|---|---|---|
| `profile` | `id` | `topic, text, status, review, updated` | 用户（GUI） | ✅ 每轮 | ✅ |
| `rules` | `id` | `scope, kind, topic, text, status, review` | 用户（GUI） | ✅ 按项目 | ✅ |
| `emotion` | `id` | `cls, quote, evidence, confidence, score, text` | 插件自动 | ❌ | ❌ |
| `logs` | `id` | `scope, topic, summary, keywords, text` | 模型（标记） | ❌ | ✅ |
| `archive` | `id` | `ts, scope, role, text, session_id, turn, step` | 插件自动 | ❌ | 仅 `/archive` |

共同的约定：

- `status`：`active` / `stale` / `deleted`。**删除是软删除**（改 `status`），
  数据不会真的消失，所以误删可恢复。
- `review`：`NULL` / `edited` / `retracted`。`retracted` 的条目不再注入但仍可查。
- `writer`：`model` / `plugin` / 用户操作 —— 用来区分「人写的」和「自动录的」。
- `scope`：`__global__` 表示跨项目；其余是项目名。

### 3.2 FTS5 检索索引

每张可检索表配一个 **contentless** FTS5 虚表（`profile_fts` / `rules_fts` /
`emotion_fts` / `logs_fts` / `archive_fts`）。

**为什么要 contentless**：省一份正文副本。代价是**不能直接 `DELETE`**，
删数据必须走专门的 FTS 同步函数，否则会出现「表里没有但搜得到」。

**中文怎么切**：`unicode61` 分词器 + **把汉字逐字拆开**再送进索引。
原因是实测过：`trigram` 要求 ≥3 字符（2 字的中文词搜不到），
`unicode61` 裸用会把整段中文当一个词（任何子串都搜不到）。
逐字拆开后 2 字词能命中，代价是单字命中噪音略大。

**`logs_fts` 是 5 列**：`summary, keywords, text, topic, seg`。
列顺序**同时是 bm25 权重顺序**：

```
bm25(logs_fts, 3.0, 2.0, 1.0, 1.0, 1.0)
               ↑keywords 最精确，↑summary 次之
```

`seg` 列给 1 而不是 0 是必须的 —— 中文查询是**逐字**命中 `seg` 的，
权重给 0 会让所有中文命中同分，排序退化成入库顺序。

---

## 4. 版本与迁移

升级插件时如果发现库的 `user_version` 比代码支持的旧，会**自动迁移**，
不需要手动操作。迁移是不可变历史，代码在 `db-schema.mjs` 的 `MIGRATIONS` 里。

| 版本 | 做了什么 |
|---|---|
| v1 | 单表 `entries`（**已删除**，v5 时清理） |
| v2 | 拆成 `profile` / `rules` / `emotion` / `logs` 四张表 + FTS |
| v3 | `logs` 加 `summary` / `keywords`，`logs_fts` 重建为 5 列 |
| v4 | 新增 `archive`（原文层）+ `archive_fts` |
| v5 | `confidence` 归一化为 `high` / `low` / `legacy`；emotion 退出检索；删 `entries` |

**降级不安全**：如果库的版本比插件**新**，插件会拒绝打开并报
「记忆库版本比插件支持的更新，请升级插件」，而不是尝试读它。
这比静默读错好。

**备份再升级**：插件升级前建议手动备份一次（见 §6）。迁移会改真实数据，
虽然每条迁移都验证过，但用户的记忆不该赌。

---

## 5. 体积构成

库里不只有「你写的东西」，还有索引和空闲页。GUI「存储设置」页会显示四类：

| 分类 | 是什么 | 典型占比 |
|---|---|---|
| `core` | 四张业务表 + 它们的 FTS 与索引 | 30~50% |
| `archive` | 原文层 + `archive_fts` + 索引 | 40~60%（用得越久越大） |
| `system` | `sqlite_schema` 等系统对象 | < 1% |
| `free` | 空闲页（删过东西但没 `VACUUM` 就会留在这） | 0~15% |

四类之和**精确等于** `page_count × page_size` —— 空闲页必须显式算进去，
否则占比不到 100%（那个差值正是「删了没回收」的垃圾）。

**`archive` 会一直涨**：实测膨胀比约 6×（原文 + 索引），5000 轮左右约 118 MB。
目前**没有保留期或体积上限** —— 这是刻意的，理由见 README 的「存在哪」一节。
真要控制体积，先看 GUI 里的体积构成再决定，不要盲删。

---

## 6. 备份

**最稳的方式：关掉 DSH，把整个记忆根目录复制走。**

```
关闭 DSH → 复制 <记忆根目录> 到备份位置 → 再开 DSH
```

为什么必须关着：WAL 模式下**运行中的 `memory.db` 单独拷可能缺最近的提交**
（数据在 `-wal` 里）。要连 `-wal` / `-shm` 一起拷，或者干脆整个目录拷。

**不关 DSH 的做法**：用 SQLite 的在线备份（`VACUUM INTO`），对运行中的库也一致。
把下面这段存成 `backup.mjs`，跟记忆根目录放在一起或者随便放：

```js
// 用法：node backup.mjs <记忆库路径> <输出文件>
import { DatabaseSync } from 'node:sqlite'
const [, , src, dst] = process.argv
if (!src || !dst) process.exit(1)
new DatabaseSync(src).exec(`VACUUM INTO '${dst.replace(/\\/g, '/')}'`)
console.log('已备份到', dst)
```

```bash
node backup.mjs "D:/dsh-fatfishdream-memory/memory.db" "D:/backup/memory-20261114.db"
```

`VACUUM INTO` 会顺带整理碎片，产物是一个干净的单文件，**可以直接拿去恢复**。
本机没有 `node` 在 PATH 时，用 DSH 自带的运行时：
`$env:ELECTRON_RUN_AS_NODE = 1`，再把命令换成 `& $env:DSH_NODE_EXECUTABLE backup.mjs ...`。

**恢复**：关 DSH → 用备份文件覆盖 `<记忆根目录>/memory.db`（同时删掉
`memory.db-wal` / `memory.db-shm`）→ 开 DSH。

---

## 7. 迁移（换盘 / 换电脑）

**换盘（同一台机器）**：用 GUI「存储设置」页的迁移功能，别手动搬文件。

它会做三件事：搬文件 → **重新绑定数据库连接** → 写指针文件。
第三件事很关键：只搬文件不重绑，插件会继续读写旧路径的库，
用户看到的现象是「迁移后记忆空了」。

**换电脑**：关 DSH → 复制整个记忆根目录 → 在新机器上放到同样的位置
（或任意位置后用 GUI 迁移/或让四级选址自己找到）→ 开 DSH。

**注意**：`state.json` 里记着项目名 ↔ 目录的映射，跨机器搬过去时
那些目录路径可能不存在（比如旧机器的 `D:\work\foo`），
这会表现为「项目还在列表里但目录打不开」—— 不影响记忆读写，按需重登记即可。

---

## 8. 数据安全红线

1. **不要用编辑器 / 脚本直接改 `memory.db`。**
   它是 SQLite 二进制，直写不是「被拒绝」，是**损坏数据库**（页结构、WAL、
   FTS 影子表都会不同步）。要改数据走 GUI，或走 HTTP 接口。
   反过来，**用 grep 之类去读它只会得到乱码**，看着像「记忆没了」——也别这么做。
2. **删除是软的。** `status='deleted'` 只是不再注入/默认不列出，行还在。
   真要物理删除，请在理解后果的前提下用 `VACUUM`（会重建整个库）。
3. **`archive` 只增不改。** 它是对账用的底层档案，不要手工改里面的原文 ——
   改了就没法用它判断「当时到底说了什么」。
4. **`emotion` 不进检索是有意的。** 它是「个人兴趣记录」不是知识，
   别把它塞回 `search` 的结果里（会把结论层挤掉）。
5. **删表必须 `VACUUM`。** SQLite 删表只是把页标为空闲，
   文件大小不会降 —— 要回收得显式 `VACUUM`。

---

## 9. 常见问题

**库会不会一直变大？**
会，主要是 `archive`。当前设计不做自动清理（记忆要完整）。先看 GUI 的体积构成，
再决定要不要手动归档/清理。

**能只删 `archive` 吗？**
能，但要连 `archive_fts` 一起清，否则「表里没有但搜得到」。目前没有内置入口，
属于已知待办。

**`memory.db` 只有 1 MB，正常吗？**
正常。四张业务表都很小（几百条就几十 KB），原文层增长慢。100 MB 才算大。

**为什么 `archive` 只从某个时间点开始有？**
原文归档是 v4 才上的功能，更早的对话没有回填 —— 这是演进代价，不是 bug。
所以查不到早期原文时，说「我没有这段记录」，别说「没发生过」。

**诊断日志能删吗？**
能。`logs/` 只是排查用的，删了不影响记忆。日志默认保留 3 个月。
