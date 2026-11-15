# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
**插件包版本**（`package.json` 的 `version`）与 **数据库 schema 版本**
（`PRAGMA user_version`，当前 v5）是两个独立的东西，不要混。

---

## 1.1.0（2026-11-16）

> **相对 `1.0.1` 的完整差异。** `1.0.1` 发布于 2026-11-14T06:59Z，
> 不含以下任何内容；本版把「工作区改名」一整个功能、情绪判定修复、
> 测试体系自检三块一起带出去。

### 新增

- **工作区改名（`POST /api/dsh-memory/scope/rename`）**：把一个工作区（`scope`）在
  `rules` / `logs` / `archive` 三张表里的数据整体改挂到新名字下。
  **`scope` 不参与任何 FTS 索引**，所以是纯 `UPDATE`，不需要同步索引；
  `profile` / `emotion` 不分项目，不受影响。拒绝 `__global__` 与新旧同名。
- **合并（`allowMerge: true`）**（2026-11-15 用户追加要求）：目标工作区已有数据时，
  默认拒绝并提示「可勾选合并后重试」；传 `allowMerge: true` 则合并。
  **为什么必须有**：用户原话「这里允许合并，新建工作区然后再去迁移记忆的情况是很常见的」——
  先建工作区、在里面聊两句（产生了原文），再把旧工作区的记忆并进来，
  这是最常规的路径，旧实现会以「目标已被占用」直接堵死。
  **校验公式随合并调整**（这是最容易写错的地方）：
  ① 条数 = 源 + 目标原有；
  ② 源区归零；
  ③ 行集合 = 两者 id 的**并集**（`min(minA,minB)` / `max(maxA,maxB)`）。
  实测：`SoftTest`(162) 并入 `大白饭`(2) → `archive 106 = 104 + 2`、
  行集合 `211–1111`（源 `211–942` + 目标 `1110–1111`），9 项校验全过。
- **迁前/迁后数据量比对**（2026-11-15 用户要求「迁移前先整理待迁移区域的数据量，
  迁移后报告与迁移前是否一致」）：
  - `snapshotScope(scope)` 逐表采 `{all, active, minId, maxId}` —— **迁前预览与迁移内建基线用同一个函数**，
    杜绝「预览 162、实际动 42」的口径错位
  - 迁移后自动比对三项：**条数 / 旧区归零 / 行集合**，任一不过即报错并提示用备份回退
  - `dryRun` 同时给「全部行数」与「仅 active」两套数字，并单独标出 `archive`
    （原文层无 `status` 列，两值恒等 —— 这不是算错）
  - `dryRun` 还返回 `targetBefore`（目标区现状）与 `expectAfter`（合并后预计总量），
    GUI 能在**动手前**就把「会变成多少行」说清楚
- **工作区改名 GUI 页签（第七个页签「工作区」）**：下拉选源工作区 → 输入新名 →
  「预览影响」显示三张表各自的行数与 id 区间 → 「开始迁移」弹二次确认 →
  「确认迁移」后并排显示**迁前 / 迁后**对照与逐项校验结果。
  - 前端即时校验：空名 / 同名 / `__global__` / 字符集 / 长度超限
  - 强制「先预览再执行」两步 —— 改名**没有撤销按钮**，备份是唯一退路
  - **目标已有数据时不再报错**，而是显示「合并预览」：目标区现状 + 合并后预计总量，
    按钮变成「开始合并」，确认文案也改成「合并后共 N 行」
  - 结果卡片逐条列出 9 项校验（✓/✗），失败项标红；合并时表格多一列「目标原有」
- **`GET /api/dsh-memory/scope/list`**：列出有数据的工作区（下拉框数据源）。
  按 `snapshotScope` 同口径数三张表**全部行**，默认排除 `__global__`。
  ⚠️ **不能改用 `/state` 的 `byScope`**：它只数 `status='active'` 的 rules+logs，
  实测会漏掉 `design`（18 行 rules 全是停用状态），下拉框就少一个工作区。
- 存储层配套导出 `snapshotScope` / `renameScope` / `countScope` /
  `listScopesWithData` / `SCOPE_TABLES`。
- **`resolveProjectKey` 现在返回 `{key, name, scope}`**：`key` 是目录名、`scope` 是记忆名。
  写入 / 检索 / 注入一律用 `scope`，否则改名后新数据会写回旧 scope。

### 修复

- **⚠️ 擦除器的全局 CSS 打断了其他面板的滚动条**（2026-11-15，用户报「每次改动功能
  全局 skills 滚动条就失效」）：擦除器给「擦完只剩空白」的元素打
  `data-dsh-mem-blank`，配套一条全局 `display: none !important`；旧判据只有
  `el !== document.body`，于是滚动容器里的子元素被隐藏 → 容器 `scrollHeight`
  塌成 0 → 滚动条消失，且 `!important` 无法覆盖。
  **修法**：打标记前加 `isSafeToCollapse(el)` 三道守卫 ——
  ① tag 白名单（排除 `main`/`section`/`ul`/`table` 等骨架）；
  ② **祖先里有 `overflow: auto/scroll` 一律拒绝**（本次事故的直接防线）；
  ③ 高度 > 4px 拒绝（被 flex/grid 撑开的占位块）。
  回归守卫：`selfcheck-dom-strip.mjs` §6（5 条源码断言）+
  新增 `selfcheck-collapse-guard.mjs`（15 条行为断言，用 DOM 替身真跑判据）。
- **擦除器回传通道补上**（TODO 里挂了很久）：新增 `reportDomDiagnostics()`，
  回传被打标记的元素、能滚但不动的容器、head 里注入的 style 条数。
  入口挂在 `window.__dshMemoryReportDom`，不自动跑（遍历全文档成本高）。
- **`<style>` 重复注入**：`blankStyleInstalled` 是模块级布尔，禁用→启用会重置它，
  但标签还在 head 里，每重载一次多一条。现在注入前先 `querySelector` 查重。

- **`renameScope` 没有事务**：原来逐表 `UPDATE`，第 2 张表失败就只改了一半，
  而界面还报「迁移完成」。现在包在 `BEGIN` / `COMMIT` / `ROLLBACK` 里。
- **改名到已有数据的名字会静默合并**：两批数据混在一起后无法拆开。现在直接拒绝。
- **改名后下次开会话「变回旧名」**：`resolveProjectKey` 原来只按 cwd 的 basename 算 key，
  目录名没改的用户改名后会被建一个**新的空 scope**，而数据在旧名下永远见不到。
  现在靠 `state.projects[key].scope` 持久化映射解决。
- **`state.json` 同步的条件 bug**：原来要求 `to` 不存在才清理旧键，
  而 `to` 被插件自动登记过时条件不成立 → 旧键永远删不掉，`overview()` 会列出两个工作区。
  现在按「键 === from / 键 === to / 某条目 .scope === from」三个方向反查源条目。
- **死代码**：`entry.dir = store.projectDir ? ...` 恒真回退 —— `store` 从未导出 `projectDir`。
- **`selfcheck-paging` 的封顶断言依赖数据量**：原来断言「最多的项目 `total === 100`」，
  等于要求库里必有项目超过 100 条，数据掉下来就红。改为先查真实条数再断言
  `total === min(真实, 100)`，与用户数据解耦。
- **`diag-julianday` 断链**：`docs/TESTING.md` 与 `db-store.mjs` 注释里都指向一个
  已被清理掉的一次性脚本。改为指向 `selfcheck-ts-sort.mjs` 第 1 节里固化下来的断言。
- **`.dsh-handoff/` 未被忽略**：交接文档里有本机绝对路径（仓库是公开的），
  已加进 `.gitignore`。

### 测试

- 新增 `_dbpreview/selfcheck-scope-rename.mjs`（**84 项断言**）：自建临时库覆盖
  `snapshotScope` 口径、正常改名九项校验、六条异常路径、**事务回滚**
  （用 SQLite 触发器模拟第二张表失败，断言第一张表没被改走）、`activeOnly`、源码级约束。
- 全量回归由 29 个脚本增至 **33 个**，清单从此只在 `run-all.mjs` 的 `SCRIPTS`
  里维护一份（此前文档与命令各有一份，加脚本时漏改过好几次）。

### 新增（测试体系自检，2026-11-16）

- **`_dbpreview/run-all.mjs`**：全量回归 runner，`TOTAL=n FAIL=k` 汇总格式固定，
  支持 `--verbose` / `--only a,b`。**脚本清单的唯一真相**。
- **`_dbpreview/lib-spawn-capture.mjs`**：捕获子进程输出的沙箱安全层。
  受限权限（`workspace-write` / `read-only`）下程序不能开命名管道，
  `spawnSync(...,{encoding:'utf8'})` 默认 `stdio:'pipe'` 会拿回 `EPERM`、`status=null`。
  旧代码 `const code = r.status ?? -1` 把「没跑起来」算成「全部失败」，
  曾报出假红 `TOTAL=32 FAIL=32`（实际 32/32 全绿）。
  现在遇 `EPERM` 自动退回**临时文件捕获**，并把 `ERROR`（没启动）与
  `FAIL`（真失败）**分开计数** —— 前者不进 `FAIL=`，但整体 exit≠0。
- **`_dbpreview/meta-mutation-test.mjs`**：变异测试，改坏代码看测试红不红。
  **16 个变异，当前 16/16 KILLED（100%）**。三项中断保护：
  ① 启动查 `.mutbak` 残留则拒绝运行（残留 = 生产文件可能仍是坏的）；
  ② 恢复后 **sha256 校验**（此前注释声称校验、代码里没有，是没兑现的承诺）；
  ③ `--dry-run` 只列出会改哪里、不动文件。
- **`_dbpreview/meta-audit-coverage.mjs`**：覆盖率审计，区分 `CALLED`（真调用）/
  `NAMED`（只在按名字定位的断言里出现 → 等于没测）/ `NONE`。
- **`_dbpreview/selfcheck-collapse-guard.mjs`**（18 项）：擦除器守卫判据，
  用 DOM 替身真跑 `isSafeToCollapse`。
- **`_dbpreview/selfcheck-pure-utils.mjs`**（39 项）：`parseJson`（BOM）/
  `isInside` / `isSafeSlug` / `slugify` / 日期。
- **`_dbpreview/selfcheck-emotion-limiter.mjs`**（10 项）：后置限定词降权。
  **不复刻逻辑** —— 从源码抽出 `analyzeEmotion` 函数体 + 注入闭包依赖，
  用 `new Function` **直接执行真实代码**（既有两个情绪测试都是抄一份逻辑测副本，
  改源码不会变红，属假覆盖）。
- `jsconfig.json` + `types/node-globals.d.ts`：启用 `checkJs`。**刻意不装
  `@types/node`** —— 那会破坏零依赖。

### 修复（2026-11-16）

- **情绪误判：后置限定词完全没被看见**。词典词是「成功了」（喜悦 0.8），
  而用户原话是「…就已经**成功了一半**，如何看懂代码是另一回事」。
  `成功了一半` 的字符序列**含有** `成功了` 这个子串 → `indexOf` 命中 → 记成
  「用户表达喜悦（高置信 0.8）」。但那是方法论陈述，「一半」明确表示未完成。
  **根因**：`modifierBefore()` 只看命中词**前面** 3 个字，而中文的
  「一半 / 一点 / 部分」这类削弱语大量出现在**后面**，于是这类句子永远按满强度记。
  **修法**：新增 `POST_LIMITERS` + `limiterAfter()`（看词**后面**紧跟的字，
  一半/部分 → 0.45，一点/一些 → 0.5，**只降不升**），并乘在 `capScore`
  **之前**（`capScore` 用**基础强度**判断弱信号，之后再乘不改它的强弱身份）。
  实测：「成功了一半」0.8 → **0.36**；对照「太好了，终于成功了」仍是 0.8 strong。
- **「部分搞定了」同样漏判**（0.8 strong）：「部分」在命中词**前面**，
  而原 `DIMINISHERS` 只有「稍微 / 有点」这类**程度**词，没有**完成度**词。
  补 `部分 / 一半 / 局部 / 大半` factor 0.45 ——
  程度轻微（有点开心）与完成度部分（部分搞定）是两回事，后者更该降权。
- **`/state` 的 `rootReason` 恒为空串**：`index.js` 里写着
  `rootReason: store.rootReason`，但 `db-store.mjs` **从未有该字段** →
  永远是 `undefined`。导致自检脚本想验证「指针优先级」时拿不到任何证据，
  只好写了一句恒真断言（见下条）。已让 `createStore` 保存并 getter 暴露。
- **测试里的恒真断言**：`selfcheck-dir-name.mjs` 曾有一句
  `check('指针优先级最高，改常量不会移动已有安装', true)` —— 无条件 `pass++`，
  声称验两件事，实际一件都没验。与 `reportBudget` 静默失效两天是**同一种病**
  （断言在，测的东西不在）。现改为按 `/state` 的**真实 `reason`** 判断走了哪一级
  （`configured` / `pointer` / `discovered-on-X` / `first-install-X`），未知值判失败；
  拿不到就**如实报「拿不到」并记失败**，不退回恒真。
  **同时定下规矩**（已写入 `AGENTS.md` 速查）：断言里不写字面量 `true`；
  分支内的「已满足」也要写成可失败的表达式；没有断言可写时**不产生断言**，
  只打印「本段不适用」——把一个恒假断言改成恒真断言，同样是假覆盖。
- **注入补一条：正文不要写空行**（用户报「标记出现再消失，底部空出一大块」）。
  标记在流式输出时以原文短暂可见；擦除器擦掉文字后，标记里的
  **每个空行会留下一个空段落**，仍占行高与段间距。
  实测最近 8 条流水：每条 1~5 个空行、合计约 120~320px。
  `usageLines` 与 `POLICY_TEMPLATE` 都加了这条
  （**只改 `usageLines` 才对老用户生效** —— 模板只在首次安装时生成 `policy.md`）。
  **未动 `client.js` 的隐藏判据**，因此不会重演滚动条事故。
- **⚠️ 情绪不豁免记流水**（2026-11-16 用户实报，本版最重要的行为修正）：
  用户指出的问题、提出的需求、讲的做事偏好，**一律要记流水**，
  即使那条消息同时被判成情绪。**emotion 表与 logs 表是两条独立通道**，
  判成情绪不影响写 `mem-log`。
  **实测漏记三条**（情绪记录 #26 / #27 / #29）：
  - 「你缺少实用的技能包」→ 命中「宝贝」判爱意，技术反馈丢失
  - 「你有可爱的手手，漂亮的眼睛。只是你用的少」→ 命中「漂亮」判夸赞，
    用户其实在说「我有多模态能力但用得少」
  - 「走正规流程想想你刚才回复的是什么」→ 命中「想你」判爱意，其实是**指令**
  这三条的真实内容都是技术反馈，**下一个会话完全不知道用户提过**。
  同一个坑 2026-11-14 已踩过一次（用户自述性格与做插件的原因，判成「情感交流」没记）。
  **机制上并没有互斥**（`analyzeEmotion` 只写 emotion 表，不拦 `mem-log`），
  所以这是模型判断错误而非代码缺陷 —— 因此把判据直接写进每轮注入，
  而不是指望下次自己想明白。
  `usageLines` 增加「## 什么时候必须记（情绪不豁免）」小节，
  `POLICY_TEMPLATE` 同步（新装用户），并给出可执行判据：
  **这条会让下一个会话的我少走一次弯路吗？会 → 记。**
  回归守卫：`verify-injection-consistency.mjs` §9（3 条模板断言）+
  两个新变异（注入侧、模板侧各一），删掉任一处都会变红。

### 文档

- 按符号名重算 `docs/项目地图.md` 全部行号（`db-store.mjs` 1126 → 1297、
  `index.js` 4302 → 4407，两个文件的行号整体变了）。
  2026-11-16 又重算一轮（`index.js` 加 `rootReason` / 情绪限定词 / 空行规则后
  整体下移）：113 处引用 0 落空，逐条按符号名现算，**不平移旧行号**。
- 同步过期的规模数字：路由 19 条、注入约 5100 字节 / 约 1130 token。
- `docs/TESTING.md` 新增「受限权限下的假红」小节（EPERM 判据表），
  `meta-mutation-test` 的三项中断保护与 `--dry-run` 用法。
- `docs/维护手册.md` §3.3 补记 EPERM 的**后果**（此前只记「stdout 捕获为空」，
  没记「会让 `run-all` 报 32 全红」，所以没人联想到回归命令）。
- `AGENTS.md` 速查从 8 条增至 **10 条**：新增「受限权限捕获 EPERM」与
  「断言里不许写字面量 `true`」，两条都带判据与根因。



---

## 1.0.1 — 2026-11-14

### 修复

- **⚠️ 擦除器的全局 CSS 打断了其他面板的滚动条**（2026-11-15，用户报「每次改动功能
  全局 skills 滚动条就失效」）：擦除器给「擦完只剩空白」的元素打
  `data-dsh-mem-blank`，配套一条全局 `display: none !important`；旧判据只有
  `el !== document.body`，于是滚动容器里的子元素被隐藏 → 容器 `scrollHeight`
  塌成 0 → 滚动条消失，且 `!important` 无法覆盖。
  **修法**：打标记前加 `isSafeToCollapse(el)` 三道守卫 ——
  ① tag 白名单（排除 `main`/`section`/`ul`/`table` 等骨架）；
  ② **祖先里有 `overflow: auto/scroll` 一律拒绝**（本次事故的直接防线）；
  ③ 高度 > 4px 拒绝（被 flex/grid 撑开的占位块）。
  回归守卫：`selfcheck-dom-strip.mjs` §6（5 条源码断言）+
  新增 `selfcheck-collapse-guard.mjs`（15 条行为断言，用 DOM 替身真跑判据）。
- **擦除器回传通道补上**（TODO 里挂了很久）：新增 `reportDomDiagnostics()`，
  回传被打标记的元素、能滚但不动的容器、head 里注入的 style 条数。
  入口挂在 `window.__dshMemoryReportDom`，不自动跑（遍历全文档成本高）。
- **`<style>` 重复注入**：`blankStyleInstalled` 是模块级布尔，禁用→启用会重置它，
  但标签还在 head 里，每重载一次多一条。现在注入前先 `querySelector` 查重。

- **包内 README 的发布状态写错了**：`1.0.0` 打出去的 `README.md` 里写着
  「尚未发布到 npm / 当前从 GitHub 安装」——而它当时已经发布。
  npm 的包内容不可变，所以只能发新版本修正；安装说明同时改为
  **npm 优先、GitHub 备选**。
- **`.gitignore` 补 `.npmrc` / `.pnpmrc`**：`npm login` 默认写用户目录，
  但带 `--location=project` 时会在仓库里生成明文 `_authToken` 文件。

## 1.0.0 — 2026-11-14

首个公开发布。开源前做过的修复也一并记在这里。

### 新增

- **检索按表轮取**：`search()` 从「三表 bm25 混排」改为**组内按 bm25、组间按
  `profile → rules → logs` 轮流各取一条**。
  原因：bm25 是各表语料各自算的，跨表比大小没有意义
  （实测 `q=大肥鱼` 时 `logs -7.928` 会压在 `profile -4.668` 前面）。
  代价是同一张表会连续出现，这是正常的。
- **解析层记账**：带上 `mem-log` 标记却一条都没落库时，新增
  `[marker-unmatched]`（正则零匹配）与 `[marker-dropped]`（有匹配但全被跳过，
  带 `reason` 与 `topicRaw`）两条诊断。此前这类失败是**完全静默**的 ——
  实测一天 108 次成功写入、0 次写入失败，却有 5 轮（4.6%）「写了但没进库」。
- **`version` 显示**：GUI 面板标题旁显示插件版本号，来源是 `package.json`
  （不是硬编码，避免发版忘改后一直显示旧版本）。
- **`engines.dsh`**：声明 `>=0.2.2-rc.3`。
- 包内 `README.md` / `STORAGE.md`：面向使用者的说明（装法、标记语法、
  端点字段名、存储结构、备份与迁移）。

### 变更

- **整理提醒的判据**：`agent/created` 的「距上次整理已 N 天」不再只看
  `state.lastConsolidate`（那个字段只有手动 `/memory consolidate` 才会写，
  模型写流水从不更新它，导致条件永远成立、每个新会话都提醒一次）。
  现在取「手动整理日期」与「最近一条流水日期」中较晚者。
  `/memory status` 增加一行「最近写入流水」。
- **擦除器调度（第五代）**：从「每帧扫描 + 100ms 抑制窗口」改为
  **流式期间完全不碰 DOM，安静 400ms 后扫一次**（`MAX_DEFER_MS = 3s` 兜底）。
  原因：擦除必然改变内容高度，在 React 正在写的那块 DOM 上反复擦，
  会让整个对话区抖动、滚动条跳。代价是流式时末尾几行标记短暂可见，
  结束后一次擦净 —— 高度只跳一次，这是**已确认接受**的取舍。

### 修复

- **⚠️ 擦除器的全局 CSS 打断了其他面板的滚动条**（2026-11-15，用户报「每次改动功能
  全局 skills 滚动条就失效」）：擦除器给「擦完只剩空白」的元素打
  `data-dsh-mem-blank`，配套一条全局 `display: none !important`；旧判据只有
  `el !== document.body`，于是滚动容器里的子元素被隐藏 → 容器 `scrollHeight`
  塌成 0 → 滚动条消失，且 `!important` 无法覆盖。
  **修法**：打标记前加 `isSafeToCollapse(el)` 三道守卫 ——
  ① tag 白名单（排除 `main`/`section`/`ul`/`table` 等骨架）；
  ② **祖先里有 `overflow: auto/scroll` 一律拒绝**（本次事故的直接防线）；
  ③ 高度 > 4px 拒绝（被 flex/grid 撑开的占位块）。
  回归守卫：`selfcheck-dom-strip.mjs` §6（5 条源码断言）+
  新增 `selfcheck-collapse-guard.mjs`（15 条行为断言，用 DOM 替身真跑判据）。
- **擦除器回传通道补上**（TODO 里挂了很久）：新增 `reportDomDiagnostics()`，
  回传被打标记的元素、能滚但不动的容器、head 里注入的 style 条数。
  入口挂在 `window.__dshMemoryReportDom`，不自动跑（遍历全文档成本高）。
- **`<style>` 重复注入**：`blankStyleInstalled` 是模块级布尔，禁用→启用会重置它，
  但标签还在 head 里，每重载一次多一条。现在注入前先 `querySelector` 查重。

- **包无法安装**：`package.json` 的 `files` 漏了 `db-store.mjs` 与 `db-schema.mjs`，
  发布出去会 `ERR_MODULE_NOT_FOUND`（插件整行不加载且可能无报错）。
- **图标与标题静默丢失**：`exports` 缺 `"./package.json"`，
  宿主读展示元数据会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED` 并被吞掉。
- **`locale` 描述过期**：文案里还写着「操作流水按月分片」（`.md` 时代的东西），
  实际早已是 SQLite 单库。
- **仓库根没有 `LICENSE`**：法律上等于「保留所有权利」，与 README 宣称的 MIT 矛盾。
- **`.vs/` 未被忽略**：Visual Studio 是 `.vs/`，不是 `.vscode/`，
  编辑器缓存（`slnx.sqlite`、`v18/.wsuo`）会被提交。
- **文档里的本机路径**：`docs/TESTING.md` 与 `_archive/` 里的一次性脚本
  含真实用户名路径，已改为 `$env:DSH_PROFILE_DIR` 或占位符。

### 已知限制（首版即存在，未修）

- macOS 未验证：选址逻辑假设 Windows 盘符体系，会静默落到怪路径。
- `archive`（原文层）只增不减，无保留期或体积上限（膨胀比约 6×）。
- 情绪识别靠词典 + 规则，理解不了反讽、客套、委婉否定。
- 检索是关键词匹配，不是语义 —— 换个说法就搜不到。
- 标记写法错误会静默丢（整条压成一行时正则完全不匹配）。
