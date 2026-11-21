window.__ModuleLoader__.load({
  id: 'dsh-fatfishdream-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const API_STATE = '/api/dsh-memory/state'
    const API_ENTRIES = '/api/dsh-memory/entries'
    const API_UPDATE = '/api/dsh-memory/entry/update'
    const API_DELETE = '/api/dsh-memory/entry/delete'
    const API_STATUS = '/api/dsh-memory/entry/status'
    const API_CREATE = '/api/dsh-memory/entry/create'
    const API_UPGRADE = '/api/dsh-memory/entry/upgrade-global'
    const API_HEARTBEAT = '/api/dsh-memory/heartbeat'
    const API_PERSONA = '/api/dsh-memory/persona-check'

    /**
     * 本地日期 `YYYY-MM-DD`。
     *
     * ## 为什么需要它，而不是随手写 `toISOString().slice(0,10)`
     *
     * `toISOString()` 按规范**永远输出 UTC**，与机器时区无关。
     * 本机是 UTC+8，所以**每天本地 00:00–08:00 这 8 小时**里，
     * UTC 还停在**前一天** —— 用 `toISOString()` 取的「今天」会整整差一天。
     *
     * 2026-11-20 05:23 实测（正好落在那个窗口里）：
     *
     *     「今天」按钮   → 2026-11-19   应为 2026-11-20
     *     「近 7 天」to  → 2026-11-19   应为 2026-11-20
     *     「近 7 天」from→ 2026-11-12   应为 2026-11-13
     *
     * 表现不是「差 8 小时」，而是**点「今天」筛出昨天**：
     * 当天写的流水一条都看不见，反而看到昨天的 520 条。
     *
     * ## 这不是新增的取舍，是补齐遗漏的那一层
     *
     * 存储层早就是本地时间了 —— `db-store.mjs` 的 `nowIso()`（2026-11-14 统一）、
     * `index.js` 的 `diagTimestamp()` 与 `localDay()`（2026-11-18 改）**都**用
     * `getFullYear/getMonth/getDate`。只有 `client.js` 的日期筛选还留着
     * `toISOString()`，于是**后端与本地的口径在前端断开**。
     *
     * 所以这里**刻意与 `index.js` 的 `localDay()` 逐字同口径**（同样三个 getter），
     * 不要换成 `toLocaleDateString()` —— 那会引入 locale 依赖，
     * 某些地区输出 `2026/11/20`，与 `<input type="date">` 要求的 `YYYY-MM-DD` 不符。
     *
     * @param {Date} [date] 默认当前时刻；传参是为了可测（回归里注入固定时刻）
     * @returns {string} 形如 `2026-11-20`
     */
    const localDayStr = (date = new Date()) => {
      const p = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
    }

    /**
     * 人称规范提示。
     *
     * 为什么需要：记忆的写者和读者是模型，但 GUI 里看它的是人。
     * 中文「我」依附于说话人，三方视角一混就读错 ——
     * 「用户称呼我为大肥鱼」在人眼里会变成「用户自己叫大肥鱼」。
     */
    const PERSONA_NORM = {
      title: '人称规范',
      rules: [
        '指人类 → 一律写「用户」',
        '指 AI 自己 → 一律写「AI」',
        '禁用：「我」「你」「本助手」「这个模型」',
      ],
      note: '「AI」指的就是这个助手本身。你把她定义为「她」—— 女性第三人称。所以记忆里的「AI」不是别人，也不是用户。',
      examples: [
        { bad: '用户称呼我为「大肥鱼」', good: '用户称呼 AI 为「大肥鱼」' },
        { bad: '用户不喜欢我在小任务上读源码', good: '用户不喜欢 AI 在小任务上读源码' },
      ],
      shape: [
        '画像以「用户」作主语：「用户很穷，不希望浪费 token」',
        '规则用动词开头、不带主语：「先给方案，确认后再改代码」',
        '判断法：删掉主语后句子还成立吗？成立→规则，不成立→画像',
      ],
    }
    const API_SEARCH = '/api/dsh-memory/search'
    const API_ROOT_MOVE = '/api/dsh-memory/root/move'
    // 工作区改名（2026-11-15）。POST 一次，dryRun:true 只报数不写库。
    const API_SCOPE_RENAME = '/api/dsh-memory/scope/rename'
    // 有数据的工作区列表。**不能用 /state 的 byScope** —— 那个只数 active 的
    // rules+logs，会漏掉「全是停用条目」的工作区（2026-11-15 实测 design 就是）。
    const API_SCOPE_LIST = '/api/dsh-memory/scope/list'
    // v5：库体积分层。**不在 /state 里** —— 它要扫全库页，100MB 库约 160ms，
    // 放在每次切页签都拉的 /state 里会卡主线程。存储设置页按需拉一次。
    const API_STATS_BREAKDOWN = '/api/dsh-memory/stats-breakdown'

    /** 只用主题语义 token，不写死颜色，随明暗主题自适应。 */
    const S = {
      page: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '20px 24px',
        height: '100%',
        overflowY: 'auto',
        boxSizing: 'border-box',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      },
      header: { display: 'flex', alignItems: 'baseline', gap: '12px', flexWrap: 'wrap' },
      h1: { fontSize: '18px', fontWeight: 600, margin: 0 },
    // 标题旁的版本号：小一号、弱化色，不抢标题。
    // 用 --dsw-alias-label-secondary 与 sub 同一个 token（AGENTS 15：不假设 token 存在，
    // 这个 token 在 S.sub 里已经用着，属于已验证可用的）。
    ver: {
      fontSize: '12px',
      color: 'var(--dsw-alias-label-secondary)',
      fontVariantNumeric: 'tabular-nums',
    },
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        background: 'var(--dsw-alias-bg-layer-1)',
      },
      title: { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      sub: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 240px',
        minWidth: '140px',
        padding: '7px 10px',
        fontSize: '13px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        boxSizing: 'border-box',
      },
      select: {
        padding: '7px 10px',
        fontSize: '13px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
      },
      btn: {
        padding: '6px 12px',
        fontSize: '12px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
      },
      primary: {
        background: 'transparent',
        color: 'var(--dsw-alias-brand-primary)',
        border: '1px solid var(--dsw-alias-brand-primary)',
        fontWeight: '600',
      },
      /**
       * 禁用态按钮。
       *
       * 为什么必须单独定义：`<button disabled>` 只阻止点击，**不会自己变灰**
       * （浏览器默认样式被上面的 S.btn 覆盖了）。不补这一条，
       * 分页的首/末页按钮看起来和可点的一模一样，用户会反复点。
       */
      btnDisabled: {
        opacity: 0.45,
        cursor: 'not-allowed',
      },
      pagination: {
        display: 'flex',
        gap: '8px',
        alignItems: 'center',
        flexWrap: 'wrap',
        marginTop: '10px',
        paddingTop: '10px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      /**
       * 删除按钮。
       *
       * 不用红色：删除不是常规操作，把它做成显眼的红按钮会让它看起来像是
       * 主要动作之一。这里用弱化的灰色文字 + 悬停才显现，放在所有按钮最右。
       * 而且删除本身是软删除，可恢复 —— 没有不可逆的风险，更不需要红色强调。
       */
      danger: {
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        border: '1px solid transparent',
        fontSize: '11px',
        padding: '5px 8px',
      },
      item: {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        padding: '10px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
      },
      itemHead: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' },
      idTag: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--dsw-font-mono, monospace)',
      },
      badge: {
        fontSize: '11px',
        padding: '1px 6px',
        borderRadius: '4px',
        border: '1px solid var(--dsw-alias-border-l1)',
        color: 'var(--dsw-alias-label-secondary)',
      },
      /** 时间标签：比 badge 更淡，放在条目头部右侧 */
      timeTag: {
        fontSize: '11px',
        color: 'var(--dsw-alias-label-secondary)',
        fontFamily: 'var(--dsw-font-mono, monospace)',
        whiteSpace: 'nowrap',
      },
      text: { fontSize: '13px', lineHeight: 1.65, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-word' },
      textarea: {
        width: '100%',
        minHeight: '64px',
        padding: '8px 10px',
        fontSize: '13px',
        lineHeight: 1.6,
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        resize: 'vertical',
        boxSizing: 'border-box',
      },
      err: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)' },
      ok: { fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
      /** 人称规范卡片：比普通卡片更淡，不抢注意力 */
      normCard: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px',
        padding: '10px 14px',
        background: 'var(--dsw-alias-bg-base)',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      },
      normTitle: { fontSize: '13px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      empty: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', padding: '8px 0' },
      tabs: { display: 'flex', gap: '4px', flexWrap: 'wrap' },
      tab: {
        padding: '6px 12px',
        fontSize: '12px',
        borderRadius: '7px',
        border: '1px solid transparent',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      tabActive: {
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
    }

    /**
     * ISO 时间戳 → 好读的本地时间。
     *
     * 近两天用「今天 / 昨天 HH:MM」，更早显示完整日期。
     * 记忆是长期数据，看到「3 个月前」这种相对说法没有意义，
     * 所以超过两天一律给绝对时间。
     */
    const fmtTime = (iso) => {
      if (!iso) return ''
      try {
        const d = new Date(iso)
        if (Number.isNaN(d.getTime())) return ''
        const p = (n) => String(n).padStart(2, '0')
        const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
        const now = new Date()
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
        const diffDays = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000)
        if (diffDays === 0) return `今天 ${hm}`
        if (diffDays === 1) return `昨天 ${hm}`
        const sameYear = d.getFullYear() === now.getFullYear()
        const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`
        return sameYear ? `${md} ${hm}` : `${d.getFullYear()}-${md} ${hm}`
      } catch {
        return ''
      }
    }

    const KIND_LABEL = {
      redline: '红线',
      pref: '偏好',
      state: '现状',
      fact: '事实',
      log: '流水',
      emotion: '情绪',
      profile: '画像',
      rules: '规则',
      logs: '流水',
    }

    /**
     * 页签 → 数据表。
     *
     * v2 拆成四张表后，每个页签直接对应一张表 ——
     * 这比 v1 用 kind + scope 组合筛选清楚得多。
     */
    const TAB_TABLE = {
      profile: 'profile',    // 用户画像
      rules: 'rules',        // 规则与偏好
      emotion: 'emotion',    // 情绪记录
      log: 'logs',           // 记忆流水
    }

    /**
     * 工作区改名的前端校验（不请求后端，输入时即时反馈）。
     *
     * 为什么放前端也放后端：前端为了「边打字边提示」，后端为了「不信任客户端」。
     * 但**两边规则必须一致**，否则会出现「界面说可以、点了报错」。
     * 后端真正的判据在 `renameScope`（含目标占用检查，那个必须查库才能知道）。
     *
     * @returns {string} 空串 = 通过；否则是给人看的原因
     */
    function validateScopeName(next, current) {
      const v = String(next ?? '').trim()
      if (v === '') return '新名字不能为空'
      if (v === current) return '新名字与当前工作区相同'
      // __global__ 是保留值：改了会破坏「全局规则跨项目」的语义
      if (v === '__global__') return '__global__ 是保留值，不能作为工作区名'
      // 字符集：只允许字母/数字/中文/-/_，避免各种奇怪字符导致 slug 行为不可预期
      if (!/^[A-Za-z0-9\u4e00-\u9fa5_-]+$/.test(v)) {
        return '只能用字母、数字、中文、下划线或连字符'
      }
      if (v.length > 60) return '名字太长了（上限 60 字符）'
      return ''
    }

    async function post(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return await response.json()
    }

    /**
     * 单条记忆。
     *
     * 设计要点（来自讨论结论）：
     *   - 可编辑内容（直接改字）
     *   - 可标记撤回 / 删除（区分「说过但当时不算」与「记错了」）
     *   - 项目规则可升级为全局；全局不提供降级（信息扩散单向可控）
     */
    /** 单条记忆。table 表示它在哪张表 —— v2 拆表后 id 各表独立编号。 */
    function EntryRow({ item, table, onChanged, onMessage }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(item.text)
      const [busy, setBusy] = React.useState(false)
      // 三层记忆（2026-11-14）：流水列表默认只显示 summary（短，一屏能看更多），
      // 点开才显示全文。其他表没有摘要，行为不变。
      const [expanded, setExpanded] = React.useState(false)
      const hasSummary = table === 'logs'
        && typeof item.summary === 'string' && item.summary.trim() !== ''

      const save = async () => {
        if (draft.trim() === '' || draft.trim() === item.text) {
          setEditing(false)
          return
        }
        setBusy(true)
        try {
          const r = await post(API_UPDATE, { id: item.id, table, text: draft.trim() })
          if (r.ok) {
            onMessage({ kind: 'ok', text: `#${item.id} 已修改` })
            setEditing(false)
            onChanged()
          } else {
            onMessage({ kind: 'err', text: r.error ?? '修改失败' })
          }
        } catch (e) {
          onMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      const remove = async () => {
        setBusy(true)
        try {
          const r = await post(API_DELETE, { id: item.id, table })
          if (r.ok) {
            onMessage({ kind: 'ok', text: `#${item.id} 已删除（软删除，可恢复）` })
            onChanged()
          } else {
            onMessage({ kind: 'err', text: r.error ?? '删除失败' })
          }
        } catch (e) {
          onMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      const upgrade = async () => {
        setBusy(true)
        try {
          const r = await post(API_UPGRADE, { id: item.id })
          if (r.ok) {
            onMessage({ kind: 'ok', text: `#${item.id} 已升级为全局规则` })
            onChanged()
          } else {
            onMessage({ kind: 'err', text: r.error ?? '升级失败' })
          }
        } catch (e) {
          onMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      /**
       * 停用 / 启用。
       *
       * 为什么单独有这个按钮：「升级为全局」不可逆是刻意的（防误扩散），
       * 但人会点错。停用让条目不再注入，同时保留在库里可随时恢复 ——
       * 比删除少一分心理负担，比无操作多一条退路。
       */
      const toggleActive = async () => {
        const next = item.status === 'active' ? 'stale' : 'active'
        setBusy(true)
        try {
          const r = await post(API_STATUS, { id: item.id, table, status: next })
          if (r.ok) {
            onMessage({ kind: 'ok', text: next === 'stale' ? `#${item.id} 已停用（不再注入）` : `#${item.id} 已启用` })
            onChanged()
          } else {
            onMessage({ kind: 'err', text: r.error ?? '操作失败' })
          }
        } catch (e) {
          onMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      const isGlobal = item.scope === '__global__'
      // 只有 rules 表里的项目级条目能升级为全局
      const canUpgrade = table === 'rules' && !isGlobal
      const inactive = item.status !== 'active'

      return h(
        'div',
        { style: inactive ? { ...S.item, opacity: 0.62 } : S.item },
        h(
          'div',
          { style: S.itemHead },
          h('span', { style: S.idTag }, `#${item.id}`),
          h('span', { style: S.badge }, KIND_LABEL[item.kind] ?? item.kind),
          item.scope !== '__global__' ? h('span', { style: S.badge }, item.scope) : null,
          isGlobal ? h('span', { style: S.badge }, '全局') : null,
          item.writer === 'plugin' ? h('span', { style: S.badge }, '自动记录') : null,
          item.status === 'stale' ? h('span', { style: S.badge }, '已停用') : null,
          item.review ? h('span', { style: S.badge }, item.review === 'retracted' ? '已撤回' : '已修改') : null,
          // 时间放在头部最右侧，方便一眼看到「什么时候进来的」。
          // 旧条目不显示 —— 迁移前的 .md 里本来就没记时间，不编造。
          h(
            'span',
            { style: { ...S.timeTag, marginLeft: 'auto' } },
            item.ts ? fmtTime(item.ts) : '迁移前的记录',
          ),
        ),
        editing
          ? h('textarea', {
              style: S.textarea,
              value: draft,
              onChange: (e) => setDraft(e.target.value),
            })
          : hasSummary && !expanded
            ? h(
                'div',
                {
                  style: { ...S.text, cursor: 'pointer' },
                  title: '点击展开全文',
                  onClick: () => setExpanded(true),
                },
                item.summary,
                h('span', { style: { ...S.timeTag, marginLeft: '6px' } }, '…（点击展开全文）'),
              )
            : h('div', { style: S.text }, item.text),
        h(
          'div',
          { style: S.row },
          editing
            ? [
                h('button', { key: 's', style: { ...S.btn, ...S.primary }, onClick: save, disabled: busy }, '保存'),
                h('button', { key: 'c', style: S.btn, onClick: () => { setEditing(false); setDraft(item.text) } }, '取消'),
              ]
            : h('button', { style: S.btn, onClick: () => setEditing(true) }, '修改'),
          // 有摘要的流水才需要「展开 / 收起」；其他表没有摘要，不出现这个按钮
          hasSummary && !editing
            ? h(
                'button',
                { style: S.btn, onClick: () => setExpanded((v) => !v) },
                expanded ? '收起' : '展开全文',
              )
            : null,
          h(
            'button',
            { style: S.btn, onClick: toggleActive, disabled: busy },
            item.status === 'active' ? '停用' : '启用',
          ),
          canUpgrade
            ? h('button', { style: { ...S.btn, ...S.primary }, onClick: upgrade, disabled: busy }, '升级为全局规则')
            : null,
          // 删除放在最右且弱化 —— 它不是常规操作，软删除可恢复，不需要红色警示
          h('button', { style: { ...S.btn, ...S.danger }, onClick: remove, disabled: busy }, '删除'),
        ),
      )
    }

    /** 新增条目的表单：规则可指定全局/项目；画像只有全局概念 */
    function AddRuleForm({ scopes, knownScopes, defaultScope, isProfile, onAdded, onMessage, onCancel }) {
      const [text, setText] = React.useState('')
      const [scope, setScope] = React.useState(defaultScope || '__global__')
      const [kind, setKind] = React.useState('pref')
      const [busy, setBusy] = React.useState(false)
      // 工作区下拉的选项集：**所有已知工作区** ∪ 已有规则的工作区。
      //
      // ⚠️ 2026-11-18 修（用户报告「添加规则时无法指定工作区」）：
      // 原来只用 `scopes`（= `listScopes('rules')` 的结果，即**已有 active 规则的
      // 工作区**）。于是**一个还没有规则的工作区在表单里根本没有选项** ——
      // 这正是「给某工作区建第一条规则」这个最该能做的动作做不到。
      // 用户实测：6 个工作区里只有 2 个可选。
      //
      // 用 useMemo 缓存：下拉选项在打字时不该重算（objects 每次 render 都是新的）。
      const scopeOptions = React.useMemo(() => {
        const merged = new Set()
        for (const name of knownScopes ?? []) {
          if (name && name !== '__global__') merged.add(name)
        }
        for (const s of scopes ?? []) {
          if (s && s.scope && s.scope !== '__global__') merged.add(s.scope)
        }
        // __global__ 已在上面单独渲染为第一项，这里排除，避免重复
        return [...merged].sort((a, b) => a.localeCompare(b))
      }, [knownScopes, scopes])

      const submit = async () => {
        const body = text.trim()
        if (!body) {
          onMessage({ kind: 'err', text: '内容不能为空' })
          return
        }
        setBusy(true)
        try {
          const payload = isProfile
            ? { text: body, table: 'profile' }
            : { text: body, scope, kind }
          const r = await post(API_CREATE, payload)
          if (r.ok) {
            // 人称规范提示：写了「我」或「你」时当场提醒，不阻止保存
            const personaWarn =
              Array.isArray(r.persona) && r.persona.length > 0
                ? `。注意：含禁用词「${r.persona.map((x) => x.word).join('、')}」，建议改成「${r.persona[0].suggest}」`
                : ''
            onMessage({
              kind: 'ok',
              text:
                (isProfile
                  ? '已添加画像条目（对所有项目生效）'
                  : `已添加${scope === '__global__' ? '全局规则' : `「${scope}」的项目规则`}`) + personaWarn,
            })
            setText('')
            onAdded()
          } else {
            onMessage({ kind: 'err', text: r.error ?? '添加失败' })
          }
        } catch (e) {
          onMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      return h(
        'div',
        { style: S.card },
        h('div', { style: S.title }, isProfile ? '新增画像条目' : '新增规则'),
        h(
          'div',
          { style: S.sub },
          isProfile
            ? '画像描述「用户是谁」和「我们怎么协作」，对所有项目生效。' +
              '它不该装具体项目的技术约定 —— 那些进规则。'
            : '全局规则会影响所有项目；项目规则只在那一个项目注入。' +
              '拿不准时选项目 —— 规则被误当全局，会在其他项目造成实际损害。',
        ),
        h('textarea', {
          style: S.textarea,
          value: text,
          placeholder: isProfile
            ? '一条只说一件事，例如：用户偏好先看方案再动手，不喜欢我直接改代码'
            : '一条规则只写一件事，写清「必须做什么 / 不能做什么」以及为什么',
          onChange: (e) => setText(e.target.value),
        }),
        h(
          'div',
          { style: S.row },
          isProfile
            ? null
            : h(
                'select',
                { style: S.select, value: scope, onChange: (e) => setScope(e.target.value) },
                h('option', { value: '__global__' }, '全局（所有项目）'),
                ...scopeOptions.map((name) => h('option', { key: name, value: name }, `项目：${name}`)),
                // 没有任何已知工作区时，至少让人知道「为什么没有项目可选」。
                // 否则下拉里只有「全局」一项，看起来像界面坏了。
                scopeOptions.length === 0
                  ? h('option', { value: '', disabled: true }, '（还没有登记过工作区）')
                  : null,
              ),
          isProfile
            ? null
            : scope === '__global__'
              ? h('span', { style: S.sub }, '全局规则统一记为「偏好」')
              : h(
                  'select',
                  { style: S.select, value: kind, onChange: (e) => setKind(e.target.value) },
                  h('option', { value: 'pref' }, '偏好'),
                  h('option', { value: 'redline' }, '红线（必须遵守）'),
                  h('option', { value: 'state' }, '现状'),
                ),
          h('button', { style: { ...S.btn, ...S.primary }, onClick: submit, disabled: busy }, busy ? '添加中…' : '添加'),
          h('button', { style: S.btn, onClick: onCancel }, '取消'),
        ),
      )
    }

    /** 人称规范卡片：默认折叠，点开看详细规则 */
    function PersonaNormCard({ onCheck, checking }) {
      const [open, setOpen] = React.useState(false)
      return h(
        'div',
        { style: S.normCard },
        h(
          'div',
          { style: S.row },
          h('span', { style: S.normTitle }, `📐 ${PERSONA_NORM.title}`),
          h('span', { style: S.sub, flex: 1 }, '指人类用「用户」，指 AI 用「AI」；禁用「我」「你」'),
          h('button', { style: S.btn, onClick: () => setOpen((v) => !v) }, open ? '收起' : '看规则'),
          h(
            'button',
            { style: { ...S.btn, ...S.primary }, onClick: onCheck, disabled: checking },
            checking ? '检查中…' : '检查现有条目',
          ),
        ),
        open
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px' } },
              ...PERSONA_NORM.rules.map((r, i) => h('div', { key: `r${i}`, style: S.sub }, `· ${r}`)),
              h(
                'div',
                {
                  key: 'note',
                  style: {
                    ...S.sub,
                    padding: '6px 10px',
                    borderRadius: '6px',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                  },
                },
                `📌 ${PERSONA_NORM.note}`,
              ),
              h('div', { style: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '4px 0' } }),
              ...PERSONA_NORM.examples.map((e, i) =>
                h(
                  'div',
                  { key: `e${i}`, style: S.sub },
                  `❌ ${e.bad}`,
                  h('br'),
                  `✅ ${e.good}`,
                ),
              ),
              h('div', { style: { height: '1px', background: 'var(--dsw-alias-border-l1)', margin: '4px 0' } }),
              ...PERSONA_NORM.shape.map((r, i) => h('div', { key: `s${i}`, style: S.sub }, `· ${r}`)),
            )
          : null,
      )
    }

    function MemoryPanel() {
      const [tab, setTab] = React.useState('rules')
      const [entries, setEntries] = React.useState([])
      const [scopes, setScopes] = React.useState([])
      // ---- 所有已知工作区（2026-11-18 新增）----
      //
      // ⚠️ 为什么必须有这个、不能继续用 `scopes`：
      // `scopes` 来自 entries 响应的 `listScopes(table)`，它统计的是
      // **已经有 active 规则的 scope** —— 于是「还没有任何规则的工作区」
      // 根本不会出现在下拉框里，用户就**永远无法从 GUI 给那个工作区建第一条规则**。
      // 2026-11-18 用户实测报的就是这个（原话：「GUI里目前无法筛选项目规则
      // 并且添加规则时无法指定工作区」）：库里真实有 6 个工作区，下拉框只有
      // `__global__` 和 `dsh-skill-switch-main`（因为只有这俩有规则数据），
      // 用户自己的工作区 dsh-fatfishdream-memory / SoftTest / ForzaOverlay /
      // design 全都选不到。
      //
      // 这是典型的鸡生蛋：数据源取自「已有数据」，而界面正是用来产生数据的。
      // 所以改成取**所有已知工作区**：`/state` 的 projects ∪ `/scope/list`
      // 的有数据工作区。两个接口各自覆盖一类「登记过但还没有该类数据」
      // 与「有数据但 project 表里没有了」的情形，取并集才不会漏。
      const [knownScopes, setKnownScopes] = React.useState([])
      const [kind, setKind] = React.useState('')
      // 默认「仅全局」：一进来就看到全部项目的一百多条会让人懵，
      // 而且多数时候想改的是全局规则。看某个项目再手动切。
      const [scope, setScope] = React.useState('__global__')
      const [query, setQuery] = React.useState('')
      // 时间范围（只对情绪记录 / 记忆流水 有意义）
      const [fromDate, setFromDate] = React.useState('')
      const [toDate, setToDate] = React.useState('')
      // 流水页的项目筛选。空串 = 全部项目。
      // 与规则页的 scope 分开存：规则页默认「仅全局」，流水页默认「全部」——
      // 因为流水没有全局概念，一进来就筛掉大部分会让人以为记录丢了。
      const [logScope, setLogScope] = React.useState('')
      // ---- 流水页分页（2026-11-13）----
      //
      // 为什么分页而不是「一次取 300 条」：流水只增不减，界面若一次拉全量，
      // 每切一次页签就重新查一遍大结果集；而人几乎不会往下翻。
      // 现在固定每页 30 条，且可翻范围只到**最近 100 条**（约 4 页）——
      // 更早的内容仍在库里，靠 /memory search 检索，不占界面资源。
      //
      // 这两个常量前后端要一致：cap 会上传给后端，limit 是每页条数。
      const PAGE_SIZE = 30
      const MAX_VIEWABLE = 100
      const [page, setPage] = React.useState(0)
      // 后端返回的「可翻总条数」（已按 MAX_VIEWABLE 封顶），用于算页数
      const [total, setTotal] = React.useState(0)
      // 默认只看 active；勾选后把已停用的也列出来，便于恢复
      const [showInactive, setShowInactive] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [info, setInfo] = React.useState(null)
      const [rootDraft, setRootDraft] = React.useState('')
      const [adding, setAdding] = React.useState(false)
      // 心跳（每轮收尾语）：存在 policy.md，不在数据库里
      const [heartbeat, setHeartbeat] = React.useState('')
      const [heartbeatDraft, setHeartbeatDraft] = React.useState('')
      const [heartbeatSaving, setHeartbeatSaving] = React.useState(false)
      // 人称规范检查结果
      const [personaIssues, setPersonaIssues] = React.useState(null)
      const [checkingPersona, setCheckingPersona] = React.useState(false)

      // ---- 工作区改名（第七页签，2026-11-15）----
      //
      // 流程刻意做成「预览 → 确认 → 执行」三步，不能一键到底：
      // 改名**没有撤销按钮**，备份是唯一退路。所以强制先看一眼要动多少条。
      const [wsFrom, setWsFrom] = React.useState('')
      const [wsTo, setWsTo] = React.useState('')
      // dryRun 的结果：{before, conflicts, canRename}
      const [wsPreview, setWsPreview] = React.useState(null)
      // 真迁移的结果：{ok, tables, total, verify, before, after}
      const [wsResult, setWsResult] = React.useState(null)
      const [wsBusy, setWsBusy] = React.useState(false)
      // 二次确认弹窗：存下预览数据，等用户点「确认迁移」
      const [wsConfirming, setWsConfirming] = React.useState(false)
      // 有数据的工作区列表（下拉数据源）。用专用接口，不用 /state 的 byScope ——
      // 后者只数 active 的 rules+logs，会漏掉「全部停用」或「只有 archive」的工作区。
      const [wsScopes, setWsScopes] = React.useState([])

      const load = React.useCallback(async () => {
        setBusy(true)
        try {
          const table = TAB_TABLE[tab]
          if (!table) {
            setBusy(false)
            return
          }
          const params = new URLSearchParams()
          params.set('table', table)
          // 流水页分页：每页 PAGE_SIZE 条，可翻范围只到最近 MAX_VIEWABLE 条。
          // 其他页签维持原来的「一次取一批」（它们量小，不值得分页）。
          if (tab === 'log') {
            params.set('limit', String(PAGE_SIZE))
            params.set('offset', String(page * PAGE_SIZE))
            params.set('cap', String(MAX_VIEWABLE))
          } else {
            params.set('limit', '300')
          }
          if (tab === 'rules') {
            if (kind) params.set('kind', kind)
            if (scope) params.set('scope', scope)
          }
          // 流水按项目筛。后端 listEntries 对 logs 表支持 scope 过滤，
          // 只是以前这边没传。
          if (tab === 'log' && logScope) params.set('scope', logScope)
          // 勾选「显示已停用」时取全部状态，再在前端区分
          //
          // ⚠️ 2026-11-20 修：**勾选时必须显式传 `status=all`**。
          //
          // 原来只有「不勾」这一支：
          //     if (!showInactive) params.set('status', 'active')
          // 勾选时**什么都不传** —— 而后端 `status: q.get('status') || 'active'`
          // 在缺省时回落成 'active'，于是「显示已停用的」永远列不出停用条目。
          //
          // 这个 bug 的形态值得记：**后端在 2026-11-16 就修好了**（见 index.js
          // `/entries` 路由里那段长注释，专门解释了「不能靠传 undefined」），
          // 但**前端那一半从来没接上** —— 所以修了半年，用户在界面上依然看不到。
          //
          // 实测（2026-11-20，本机）：
          //     不传 status → total=8，8 条全是 active
          //     status=all  → total=9，多出 1 条 stale（正是用户停用的那条）
          //
          // 教训：修「读写两端」的 bug 时，**两端都要改**，
          // 只改一端会得到一个「代码说修好了、行为没变」的状态。
          if (showInactive) {
            params.set('status', 'all')
          } else {
            params.set('status', 'active')
          }
          if (query.trim()) params.set('q', query.trim())
          // 时间范围只对情绪/流水生效（规则与画像没有可靠时间）
          if (tab === 'emotion' || tab === 'log') {
            if (fromDate) params.set('from', fromDate)
            if (toDate) params.set('to', toDate)
          }

          const response = await fetch(`${API_ENTRIES}?${params.toString()}`)
          const payload = await response.json()
          if (payload.ok) {
            setEntries(payload.entries ?? [])
            setScopes(payload.scopes ?? [])
            setTotal(Number(payload.total) || 0)
            setMessage(null)
          } else {
            setMessage({ kind: 'err', text: payload.error ?? '读取失败' })
          }
        } catch (e) {
          setMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setBusy(false)
        }
      }, [tab, kind, scope, query, showInactive, fromDate, toDate, logScope, page])

      const loadInfo = React.useCallback(async () => {
        try {
          const r = await fetch(API_STATE)
          const p = await r.json()
          if (p.ok) {
            setInfo(p)
            setRootDraft((prev) => (prev === '' ? p.root ?? '' : prev))
            if (p.heartbeat !== undefined && p.heartbeat !== null) {
              setHeartbeat(p.heartbeat)
              setHeartbeatDraft((prev) => (prev === '' ? p.heartbeat : prev))
            }
          }
        } catch {}
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      // 筛选条件一变，页码必须归零。
      // 否则在第 4 页切到只有 1 页的项目，会停在越界的 offset 上，
      // 界面显示「没有匹配的条目」—— 看起来像数据丢了。
      // 切页签同理。
      React.useEffect(() => {
        setPage(0)
      }, [tab, logScope, fromDate, toDate, query, showInactive, scope, kind])

      React.useEffect(() => {
        void loadInfo()
      }, [loadInfo])

      // v5：库体积分层 —— **只在切到「存储设置」页签时才拉**。
      // 它背后是一次全库页扫描（100MB 约 160ms），不该跟着每次切页签付。
      const [breakdown, setBreakdown] = React.useState(null)
      React.useEffect(() => {
        if (tab !== 'settings') return undefined
        let alive = true
        void (async () => {
          try {
            const r = await fetch(API_STATS_BREAKDOWN)
            const p = await r.json()
            if (alive && p.ok) setBreakdown(p)
          } catch {
            /* 拿不到就退回只显示总量，不弹错 */
          }
        })()
        return () => { alive = false }
      }, [tab])

      // 工作区列表：**只在切到「工作区」页签时拉**，与体积分层同一个思路。
      React.useEffect(() => {
        if (tab !== 'workspace') return undefined
        let alive = true
        void (async () => {
          try {
            const r = await fetch(API_SCOPE_LIST)
            const p = await r.json()
            if (alive && p.ok) setWsScopes(p.scopes ?? [])
          } catch {
            /* 拉不到就空列表，不弹错 */
          }
        })()
        return () => { alive = false }
      }, [tab])

      // 所有已知工作区：**只在 规则页 / 新增规则表单 需要时拉一次**。
      // 与 wsScopes（工作区改名页）分开存：那一个要求「改名时确实会动的」，
      // 这一个要求「界面上能选到的」，口径不同，不能混用同一个 state。
      React.useEffect(() => {
        if (!(tab === 'rules' || tab === 'profile')) return undefined
        let alive = true
        void (async () => {
          try {
            // 两个来源取并集，缺一个都会漏：
            //   /state 的 projects  —— 登记过的工作区（哪怕一条数据都没有）
            //   /scope/list        —— 有数据的工作区（哪怕 project 表里已经没有了）
            const [stateResp, listResp] = await Promise.all([
              fetch(API_STATE).then((r) => r.json()).catch(() => null),
              fetch(API_SCOPE_LIST).then((r) => r.json()).catch(() => null),
            ])
            const set = new Set()
            for (const p of stateResp?.projects ?? []) {
              if (p && typeof p.scope === 'string' && p.scope !== '' && p.scope !== '__global__') set.add(p.scope)
            }
            for (const s of listResp?.scopes ?? []) {
              const name = typeof s === 'string' ? s : s?.scope
              if (typeof name === 'string' && name !== '' && name !== '__global__') set.add(name)
            }
            if (alive) setKnownScopes([...set].sort((a, b) => a.localeCompare(b)))
          } catch {
            /* 拉不到就只有「已有规则的工作区」可选，不弹错 —— 那仍是可用状态 */
          }
        })()
        return () => { alive = false }
      }, [tab])

      const moveRoot = async () => {
        const target = rootDraft.trim()
        if (!target) {
          setMessage({ kind: 'err', text: '请填写绝对路径' })
          return
        }
        setBusy(true)
        try {
          const r = await post(API_ROOT_MOVE, { root: target })
          if (r.ok) {
            setMessage({ kind: 'ok', text: r.warning ?? `已迁移到 ${r.root}` })
            void loadInfo()
          } else {
            setMessage({ kind: 'err', text: r.error ?? '迁移失败' })
          }
        } catch (e) {
          setMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setBusy(false)
        }
      }

      const health = info?.health
      const dbMode = info?.db?.ok === true

      /** 扫描人称问题 */
      const checkPersona = async () => {
        setCheckingPersona(true)
        try {
          const r = await fetch(API_PERSONA)
          const p = await r.json()
          if (p.ok) {
            setPersonaIssues(p.issues ?? [])
            setMessage({
              kind: p.count > 0 ? 'err' : 'ok',
              text: p.count > 0 ? `发现 ${p.count} 条含禁用词，见下方列表` : '没有发现人称问题',
            })
            if (p.count === 0) setPersonaIssues([])
          } else {
            setMessage({ kind: 'err', text: p.error ?? '检查失败' })
          }
        } catch (e) {
          setMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setCheckingPersona(false)
        }
      }

      /** 保存心跳（每轮收尾语）。传 override 可直接保存指定值（用于「清除」）。 */
      const saveHeartbeat = async (override) => {
        const value = typeof override === 'string' ? override : heartbeatDraft
        setHeartbeatSaving(true)
        try {
          const r = await post(API_HEARTBEAT, { text: value })
          if (r.ok) {
            setHeartbeat(r.text ?? '')
            if (typeof override !== 'string') setHeartbeatDraft(r.text ?? '')
            setMessage({ kind: 'ok', text: r.text ? '收尾语已保存，下一轮生效' : '收尾语已清除' })
          } else {
            setMessage({ kind: 'err', text: r.error ?? '保存失败' })
          }
        } catch (e) {
          setMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setHeartbeatSaving(false)
        }
      }

      const tabBtn = (key, label) =>
        h(
          'button',
          {
            style: tab === key ? { ...S.tab, ...S.tabActive } : S.tab,
            onClick: () => setTab(key),
          },
          label,
        )

      // ---- 工作区改名：预览（dryRun）----
      //
      // 只报数不写库。用户在这里看清「要动多少条、有没有冲突」，
      // 再决定要不要点「开始迁移」。这一步不能省 —— 改名没有撤销。
      const previewRename = async () => {
        const err = validateScopeName(wsTo, wsFrom)
        if (err) {
          setMessage({ kind: 'err', text: err })
          return
        }
        if (!wsFrom) {
          setMessage({ kind: 'err', text: '请先选择要改名的工作区' })
          return
        }
        setWsBusy(true)
        setWsResult(null)
        try {
          const r = await post(API_SCOPE_RENAME, { from: wsFrom, to: wsTo.trim(), dryRun: true })
          if (r.ok) {
            setWsPreview(r)
            if (!r.canRename) {
              setMessage({ kind: 'err', text: '该工作区没有数据，无需迁移。' })
            } else if (r.willMerge) {
              // 目标已有数据 = 合并，不是错误。
              // 2026-11-15 用户明确：「新建工作区然后再去迁移记忆的情况是很常见的」。
              setMessage({
                kind: 'ok',
                text:
                  `「${wsTo.trim()}」已有 ${r.targetBefore?.total?.all ?? 0} 行数据，` +
                  `确认后会合并成 ${r.expectAfter?.total ?? 0} 行。确认无误后点「开始合并」。`,
              })
            } else {
              setMessage({ kind: 'ok', text: '预览完成。确认无误后点「开始迁移」。' })
            }
          } else {
            setWsPreview(null)
            setMessage({ kind: 'err', text: r.error ?? '预览失败' })
          }
        } catch (e) {
          setMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setWsBusy(false)
        }
      }

      // ---- 工作区改名：真迁移 ----
      //
      // 后端在同一个事务里改三张表，改完自己采两次快照比对
      // （条数守恒 / 旧区归零 / 行集合未变），任何一项不过就报错。
      // 所以前端拿到 verify.ok === true 才能说「成功」。
      const doRename = async () => {
        setWsBusy(true)
        setWsConfirming(false)
        try {
          // allowMerge 由预览阶段的结果决定：目标非空 = 用户已经看到「合并」预览，
          // 点确认即表示同意合并。后端仍会再判一次（不信任客户端）。
          const allowMerge = wsPreview?.willMerge === true
          const r = await post(API_SCOPE_RENAME, { from: wsFrom, to: wsTo.trim(), allowMerge })
          if (r.ok) {
            setWsResult(r)
            setMessage({
              kind: 'ok',
              text: r.merged
                ? `已合并：${r.from} → ${r.to}。迁后校验 ${r.verify?.checks?.length ?? 0} 项全部通过。`
                : `已改名：${r.from} → ${r.to}。迁后校验 ${r.verify?.checks?.length ?? 0} 项全部通过。`,
            })
            // 名字变了，列表与下拉都要重新拉
            void load()
            void loadInfo()
            // 重新拉工作区列表（改名后列表顺序会变）
            try {
              const lr = await fetch(API_SCOPE_LIST)
              const lp = await lr.json()
              if (lp.ok) setWsScopes(lp.scopes ?? [])
            } catch {}
            // 改名后当前选中的旧名字已经不存在，重置表单免得误导
            setWsFrom('')
            setWsTo('')
            setWsPreview(null)
          } else {
            setMessage({ kind: 'err', text: r.error ?? '迁移失败' })
          }
        } catch (e) {
          setMessage({ kind: 'err', text: String(e?.message ?? e) })
        } finally {
          setWsBusy(false)
        }
      }

      /**
       * 工作区页签（第七个，2026-11-15）。
       *
       * 这个页面解决一个具体事故：用户把工作区 `干杂活` 改名成 `SoftTest`，
       * 但库里 129 条数据仍挂在旧 scope 上 —— 查新名字一条都查不到。
       * 而「改名」在这套系统里要同时处理三层：数据库 scope、state.json 的键映射、
       * 以及工作区目录名。这一页只做第一层（改数据库 scope），
       * 映射关系由后端自动写进 state.json 的 `.scope` 字段。
       *
       * 设计上刻意保守：
       *   - 下拉只列**有数据**的工作区（空的不该出现在这里）
       *   - 强制「先预览、再确认」两步，因为改名没有撤销按钮
       *   - 预览里把三张表的数字**分开列**（rules/logs/archive），
       *     并注明 archive 是原文层 —— 只给一个总数会被读成「记忆条目」
       */
      function renderWorkspace() {
        // 有数据的工作区列表来自专用接口 `/scope/list`（按 snapshotScope 同口径数三表全部行）。
        // ⚠️ 不要改用 `info.db.byScope` —— 那个只数 active 的 rules+logs，
        // 2026-11-15 实测会漏掉「rules 全是停用条目」的 design（18 行）。
        const wsList = wsScopes

        const rows = [
          h('div', { key: 'head', style: S.title }, '工作区改名'),
          h(
            'div',
            { key: 'desc', style: S.sub },
            '把某个工作区的全部记忆改挂到新名字下。只改数据库里的归属（scope），' +
              '不动磁盘目录。用户画像与情绪记录不分工作区，不受影响。',
          ),
          h(
            'div',
            { key: 'warn', style: { ...S.sub, color: 'var(--dsw-alias-state-warning-primary, inherit)' } },
            '⚠️ 改名没有撤销按钮。迁移前请确认已备份（_dbbackup/），迁移后可用备份回退。',
          ),

          // ---- 当前工作区（下拉）----
          h(
            'div',
            { key: 'row1', style: S.row },
            h(
              'select',
              {
                style: { ...S.select, flex: '1 1 280px', minWidth: '180px' },
                value: wsFrom,
                onChange: (e) => {
                  setWsFrom(e.target.value)
                  // 换了源工作区，旧的预览结果就失效了 —— 留着会误导
                  setWsPreview(null)
                  setWsResult(null)
                },
              },
              h('option', { value: '' }, '选择要改名的工作区…'),
              ...wsList.map((s) =>
                h('option', { key: s.scope, value: s.scope }, `${s.scope}（${s.total} 行）`),
              ),
            ),
          ),

          // ---- 新名字 ----
          h(
            'div',
            { key: 'row2', style: S.row },
            h('input', {
              style: { ...S.input, flex: '1 1 280px' },
              value: wsTo,
              spellCheck: false,
              placeholder: '新名字（不是路径）',
              onChange: (e) => {
                setWsTo(e.target.value)
                setWsPreview(null)
                setWsResult(null)
              },
            }),
            h(
              'button',
              {
                style: { ...S.btn, ...S.primary, ...(wsBusy || !wsFrom || !wsTo.trim() ? S.btnDisabled : {}) },
                onClick: previewRename,
                disabled: wsBusy || !wsFrom || !wsTo.trim(),
              },
              wsBusy ? '处理中…' : '预览影响',
            ),
          ),

          // ---- 实时校验提示（不请求后端）----
          (() => {
            const err = wsFrom && wsTo.trim() ? validateScopeName(wsTo, wsFrom) : ''
            return err ? h('div', { key: 'vld', style: S.err }, err) : null
          })(),
        ]

        // ---- 预览结果 ----
        if (wsPreview) {
          const b = wsPreview.before
          const tb = wsPreview.targetBefore
          const total = b?.total ?? { all: 0, active: 0 }
          const willMerge = wsPreview.willMerge === true
          const expect = wsPreview.expectAfter
          rows.push(
            h(
              'div',
              { key: 'preview', style: S.card },
              h('div', { style: S.title }, willMerge ? '合并预览' : '待迁移区域的数据量'),
              h(
                'div',
                { style: S.sub },
                willMerge
                  ? `把「${wsPreview.from}」合并进已有工作区「${wsPreview.to}」。` +
                      `目标区现有的数据会**原样保留**，源工作区的数据会并入，最终合成一个工作区。`
                  : `工作区「${wsPreview.from}」→「${wsPreview.to}」。` +
                      `以下数字是**迁移前的基线**，迁移后会逐项比对。`,
              ),
              // 三张表分开列：只给总数会被读成「记忆条目」
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '6px' } },
                ...['rules', 'logs', 'archive'].map((t) => {
                  const v = b?.tables?.[t]
                  if (!v) return null
                  const label =
                    t === 'rules' ? '规则与偏好' : t === 'logs' ? '记忆流水' : '原文归档'
                  const note = t === 'archive' ? '（原文层，无启用/停用概念）' : ''
                  return h(
                    'div',
                    { key: t, style: { ...S.sub, fontVariantNumeric: 'tabular-nums' } },
                    `${label} ${t}：${v.all} 行` +
                      (t === 'archive' ? '' : `（其中启用 ${v.active}）`) +
                      ` · id ${v.minId ?? '—'}–${v.maxId ?? '—'}${note}`,
                  )
                }),
              ),
              h(
                'div',
                { style: { ...S.sub, marginTop: '6px', fontWeight: 600 } },
                `源工作区合计 ${total.all} 行`,
              ),

              // ---- 合并时额外展开目标区现状 + 合并后总量 ----
              willMerge
                ? h(
                    'div',
                    {
                      key: 'mergeInfo',
                      style: { marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
                    },
                    h('div', { style: S.title }, '目标工作区现状'),
                    h(
                      'div',
                      { style: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' } },
                      ...['rules', 'logs', 'archive'].map((t) => {
                        const v = tb?.tables?.[t]
                        if (!v) return null
                        const label = t === 'rules' ? '规则与偏好' : t === 'logs' ? '记忆流水' : '原文归档'
                        return h(
                          'div',
                          { key: `tb-${t}`, style: { ...S.sub, fontVariantNumeric: 'tabular-nums' } },
                          `${label} ${t}：${v.all} 行 · id ${v.minId ?? '—'}–${v.maxId ?? '—'}`,
                        )
                      }),
                    ),
                    h(
                      'div',
                      { style: { ...S.sub, marginTop: '6px', fontWeight: 600 } },
                      `目标区现有 ${tb?.total?.all ?? 0} 行`,
                    ),
                    // 合并后的预计总量：迁移前就能算，给用户一个明确预期
                    h(
                      'div',
                      { style: { ...S.ok, marginTop: '8px', fontWeight: 600 } },
                      `合并后合计：${expect?.total ?? 0} 行` +
                        `（${total.all} 迁入 + ${tb?.total?.all ?? 0} 原有）`,
                    ),
                    h(
                      'div',
                      { style: { ...S.sub, marginTop: '4px' } },
                      '⚠️ 合并后两批数据无法再拆开。如果还要分开，请先用备份回退。',
                    ),
                  )
                : null,
              h(
                'div',
                { key: 'confirmRow', style: { ...S.row, marginTop: '10px' } },
                h(
                  'button',
                  {
                    style: {
                      ...S.btn,
                      ...S.primary,
                      ...(wsBusy || !wsPreview.canRename ? S.btnDisabled : {}),
                    },
                    onClick: () => setWsConfirming(true),
                    disabled: wsBusy || !wsPreview.canRename,
                  },
                  willMerge ? '开始合并' : '开始迁移',
                ),
                h(
                  'button',
                  { style: S.btn, onClick: () => setWsPreview(null) },
                  '取消',
                ),
              ),
            ),
          )
        }

        // ---- 二次确认（弹在页面里，不用 window.confirm）----
        //
        // 为什么不用 window.confirm：DSH 桌面端是 Electron，
        // 原生弹窗会阻塞渲染进程，而且样式与主题不一致。
        if (wsConfirming) {
          const willMerge = wsPreview?.willMerge === true
          const expectTotal = wsPreview?.expectAfter?.total ?? wsPreview?.before?.total?.all ?? 0
          rows.push(
            h(
              'div',
              { key: 'confirm', style: { ...S.card, borderColor: 'var(--dsw-alias-state-error-primary)' } },
              h('div', { style: S.title }, willMerge ? '确认合并？' : '确认迁移？'),
              h(
                'div',
                { style: S.sub },
                willMerge
                  ? `将把「${wsFrom}」的 ${wsPreview?.before?.total?.all ?? 0} 行数据合并进「${wsTo.trim()}」` +
                      `（目标现有 ${wsPreview?.targetBefore?.total?.all ?? 0} 行），合并后共 ${expectTotal} 行。` +
                      '此操作不可撤销。'
                  : `将把「${wsFrom}」的全部数据改名为「${wsTo.trim()}」，共 ` +
                      `${wsPreview?.before?.total?.all ?? 0} 行。此操作不可撤销。`,
              ),
              h(
                'div',
                { style: { ...S.row, marginTop: '8px' } },
                h(
                  'button',
                  { style: { ...S.btn, ...S.primary, ...(wsBusy ? S.btnDisabled : {}) }, onClick: doRename, disabled: wsBusy },
                  wsBusy ? '处理中…' : willMerge ? '确认合并' : '确认迁移',
                ),
                h('button', { style: S.btn, onClick: () => setWsConfirming(false) }, '再想想'),
              ),
            ),
          )
        }

        // ---- 结果（含迁前/迁后比对）----
        if (wsResult) {
          const checks = wsResult.verify?.checks ?? []
          const before = wsResult.before
          const targetBefore = wsResult.targetBefore
          const afterTo = wsResult.after?.to
          const wasMerged = wsResult.merged === true
          rows.push(
            h(
              'div',
              { key: 'result', style: S.card },
              h(
                'div',
                { style: S.title },
                wasMerged
                  ? `合并完成：${wsResult.from} → ${wsResult.to}`
                  : `迁移完成：${wsResult.from} → ${wsResult.to}`,
              ),
              h(
                'div',
                { style: S.sub },
                wasMerged
                  ? `迁入 ${wsResult.total} 行，目标原有 ${targetBefore?.total?.all ?? 0} 行，` +
                      `合并后共 ${afterTo?.total?.all ?? '?'} 行。迁后校验 ${checks.length} 项` +
                      (wsResult.verify?.ok ? '全部通过。' : '未通过，见下。')
                  : `共迁移 ${wsResult.total} 行。迁后校验 ${checks.length} 项` +
                      (wsResult.verify?.ok ? '全部通过。' : '未通过，见下。'),
              ),
              // 迁前 vs 迁后并排：这就是用户要的「报告是否一致」
              // 合并时多一列「目标原有」，因为迁后 = 迁入 + 原有
              h(
                'div',
                {
                  style: {
                    display: 'grid',
                    gridTemplateColumns: wasMerged ? 'auto 1fr 1fr 1fr' : 'auto 1fr 1fr',
                    gap: '4px 12px',
                    marginTop: '8px',
                    fontSize: '12px',
                    fontVariantNumeric: 'tabular-nums',
                  },
                },
                h('div', { style: { ...S.sub, fontWeight: 600 } }, '表'),
                h('div', { style: { ...S.sub, fontWeight: 600 } }, '源工作区'),
                wasMerged ? h('div', { style: { ...S.sub, fontWeight: 600 } }, '目标原有') : null,
                h('div', { style: { ...S.sub, fontWeight: 600 } }, '迁后合并'),
                ...['rules', 'logs', 'archive'].flatMap((t) => {
                  const bv = before?.tables?.[t]
                  const av = afterTo?.tables?.[t]
                  if (!bv) return []
                  const tv = targetBefore?.tables?.[t]
                  return [
                    h('div', { key: `${t}-n`, style: S.sub }, t),
                    h('div', { key: `${t}-b`, style: S.sub }, `${bv.all} 行（id ${bv.minId ?? '—'}–${bv.maxId ?? '—'}）`),
                    wasMerged
                      ? h('div', { key: `${t}-t`, style: S.sub }, `${tv?.all ?? 0} 行（id ${tv?.minId ?? '—'}–${tv?.maxId ?? '—'}）`)
                      : null,
                    h('div', { key: `${t}-a`, style: S.sub }, `${av?.all ?? '?'} 行（id ${av?.minId ?? '—'}–${av?.maxId ?? '—'}）`),
                  ]
                }),
              ),
              // 逐项校验结果：失败项要红着标出来
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '2px', marginTop: '8px' } },
                ...checks.map((c, i) => {
                  const label =
                    c.check === 'old-empty'
                      ? '旧区归零'
                      : c.check.startsWith('id-range')
                        ? '行集合'
                        : '条数'
                  const detail = c.detail ? `（${c.detail}）` : ''
                  return h(
                    'div',
                    { key: `c${i}`, style: c.ok ? S.ok : S.err },
                    `${c.ok ? '✓' : '✗'} ${c.table} ${label}${detail}：期望 ${c.want} → 实际 ${c.got}`,
                  )
                }),
              ),
              wsResult.stateSynced
                ? h(
                    'div',
                    { style: { ...S.sub, marginTop: '8px' } },
                    `state.json 已记录映射：目录「${wsResult.stateSynced.key}」→ 记忆名「${
                      wsResult.stateSynced.scope ?? wsResult.stateSynced.key
                    }」。下次打开该项目会自动读到新名字。`,
                  )
                : null,
              h(
                'div',
                { style: { ...S.sub, marginTop: '8px' } },
                '注入层每轮都重新解析 scope（无会话级缓存），所以这个会话的下一条消息就会读到新名字下的记忆，不需要重开会话。',
              ),
            ),
          )
        }

        return h('div', { style: S.wrap }, ...rows)
      }

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.header },
          h('h1', { style: S.h1 }, '大肥鱼的梦'),
          // 版本号来自 /state 的 versions.plugin（宿主从 package.json 读），
          // **不要在这里写死** —— 发版时必忘改，界面上就会一直显示旧版本。
          info?.versions?.plugin
            ? h('span', { style: S.ver }, `v${info.versions.plugin}`)
            : null,
          h(
            'span',
            { style: S.sub },
            health?.checked
              ? health.ok
                ? `运行正常 · ${health.total} 项检查全部就位`
                : `⚠ ${health.failed.length} 项异常：${health.failed.join('、')}`
              : '健康自检尚未运行',
          ),
        ),
        health?.checked && !health.ok
          ? h('div', { style: S.err }, `异常项：${health.failed.join('、')}。排查看日志里的 [health-check] 明细。`)
          : null,
        h(
          'div',
          { style: S.tabs },
          tabBtn('profile', '用户画像'),
          tabBtn('rules', '规则与偏好'),
          tabBtn('emotion', '情绪记录'),
          tabBtn('log', '记忆流水'),
          tabBtn('workspace', '工作区改名'),
          tabBtn('heartbeat', '收尾语'),
          tabBtn('settings', '存储设置'),
        ),

        message === null
          ? null
          : h('div', { style: message.kind === 'ok' ? S.ok : S.err }, message.text),

        tab === 'settings'
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.title }, '记忆根目录'),
              h(
                'div',
                { style: S.sub },
                '所有记忆都在这个目录下的 SQLite 数据库里。' +
                  '约定：尽量不放在系统盘（C:）。整体迁移会复制数据并切换配置，旧目录不会自动删除。',
              ),
              h(
                'div',
                { style: S.row },
                h('input', {
                  style: S.input,
                  value: rootDraft,
                  spellCheck: false,
                  placeholder: 'D:\\FatFishDream-memory',
                  onChange: (e) => setRootDraft(e.target.value),
                }),
                h(
                  'button',
                  { style: { ...S.btn, ...S.primary }, onClick: moveRoot, disabled: busy },
                  busy ? '迁移中…' : '迁移到这里',
                ),
              ),
              h('div', { style: S.sub }, `当前库：${info?.db?.path ?? '—'}`),
              info?.db?.size ? h('div', { style: S.sub }, `库体积：${(info.db.size / 1024).toFixed(0)} KB · ${info.db.total ?? 0} 条 · schema v${info.db.schemaVersion ?? '?'}`) : null,

              // ---- 体积分层（v5） ----
              // 为什么要有：只给一个「库体积 100 MB」会被读成「记忆条目爆了」，
              // 而实际上原文层（archive）占一部分、空闲页还占一块。
              // 拆开之后用户才知道该不该动手清理。
              breakdown && breakdown.total
                ? h(
                    'div',
                    { style: { ...S.sub, marginTop: 8 } },
                    h('div', { style: S.title }, '体积构成'),
                    ...[
                      ['结论层（画像/规则/情绪/流水）', breakdown.core, breakdown.pct?.core],
                      ['原文归档（archive）', breakdown.archive, breakdown.pct?.archive],
                      ['系统（schema 等）', breakdown.system, breakdown.pct?.system],
                      ['空闲页（VACUUM 可回收）', breakdown.free, breakdown.pct?.free],
                    ].map(([label, bytes, pct]) =>
                      h(
                        'div',
                        { key: label, style: { fontSize: 12, marginTop: 2 } },
                        `${label}：${((bytes ?? 0) / 1024).toFixed(0)} KB（${pct ?? 0}%）`,
                      ),
                    ),
                    breakdown.freePages > 0
                      ? h(
                          'div',
                          { style: { ...S.sub, fontSize: 12, marginTop: 4 } },
                          `有 ${breakdown.freePages} 个空闲页，清理过数据但没 VACUUM 时会积在这里。`,
                        )
                      : null,
                    breakdown.unavailable
                      ? h('div', { style: { ...S.sub, fontSize: 12 } }, '（当前 SQLite 未编入 dbstat，只能显示总量）')
                      : null,
                  )
                : null,

              // ---- 心跳（每轮收尾语）已独立成「收尾语」页签 ----
            )
          : tab === 'workspace'
          ? renderWorkspace()
          : tab === 'heartbeat'
          ? h(
              'div',
              { style: S.card },
              h('div', { style: S.title }, '每轮收尾语（心跳）'),
              h(
                'div',
                { style: S.sub },
                '每轮回复的最后一行固定加上这句话，用来确认本轮执行完整。' +
                  '只填这句话本身即可，留空则不添加。',
              ),
              h(
                'div',
                { style: S.row, alignItems: 'flex-start' },
                h('input', {
                  style: { ...S.input, flex: '1 1 320px', maxWidth: '460px' },
                  value: heartbeatDraft,
                  spellCheck: false,
                  maxLength: 30,
                  placeholder: '例如：你可爱的大肥鱼一直都在，等待下一轮任务',
                  onChange: (e) => setHeartbeatDraft(e.target.value),
                }),
                h(
                  'button',
                  { style: { ...S.btn, ...S.primary }, onClick: saveHeartbeat, disabled: heartbeatSaving },
                  heartbeatSaving ? '保存中…' : '保存',
                ),
                h(
                  'button',
                  {
                    style: S.btn,
                    onClick: () => {
                      setHeartbeatDraft('')
                      void saveHeartbeat('')
                    },
                    disabled: heartbeatSaving || !heartbeat,
                  },
                  '清除',
                ),
              ),
              // 字数是用户最关心的信息，直接摆在输入框下面
              h(
                'div',
                { style: S.sub },
                `已输入 ${String(heartbeatDraft).length} / 30 字（上限 80 字节，约 26 个汉字）` +
                  (heartbeat ? ` · 当前生效：「${heartbeat}」` : ' · 当前未设置'),
              ),
              h(
                'div',
                { style: S.sub },
                '为什么存在 policy.md 而不进数据库：它是「每轮必须执行、不可被截断」的行为规则，' +
                  '与偏好不同账。混进数据库会和偏好共享预算，可能被静默挤掉。' +
                  '多行文本会被自动合并成一行 —— 收尾语只能是一句话。',
              ),
            )
          : h(
              'div',
              { style: S.card },
              // 人称规范只在「画像」和「规则」两个页签出现 ——
              // 这两个页签的内容是模型写的，需要这套规范约束。
              tab === 'profile' || tab === 'rules'
                ? h(PersonaNormCard, { onCheck: checkPersona, checking: checkingPersona })
                : null,
              // 人称问题清单（检查后才有）
              personaIssues !== null && personaIssues.length > 0
                ? h(
                    'div',
                    { style: S.normCard },
                    h('div', { style: S.normTitle }, `⚠️ ${personaIssues.length} 条含禁用词`),
                    h(
                      'div',
                      { style: S.sub },
                      '只是提示，不影响使用。改的时候把「我」改成「AI」、把「你」改成「用户」。',
                    ),
                    ...personaIssues.slice(0, 20).map((it) =>
                      h(
                        'div',
                        {
                          key: `${it.table}-${it.id}`,
                          style: { ...S.sub, display: 'flex', gap: '8px', alignItems: 'baseline' },
                        },
                        h('span', { style: S.idTag }, `${it.table}#${it.id}`),
                        h('span', { style: S.badge }, it.hits.join('/')),
                        h('span', { style: { flex: 1 } }, it.text.slice(0, 60)),
                      ),
                    ),
                    personaIssues.length > 20
                      ? h('div', { style: S.sub }, `…还有 ${personaIssues.length - 20} 条`)
                      : null,
                    h(
                      'button',
                      { style: S.btn, onClick: () => setPersonaIssues(null) },
                      '关闭列表',
                    ),
                  )
                : null,
              // 「新增」入口只在这两个页签出现：
              //   规则与偏好 → 新增规则（可选全局/项目）
              //   用户画像   → 新增画像条目（只有全局概念）
              // 情绪记录与记忆流水是只读/半只读视图，不该在这里新增。
              tab === 'rules' || tab === 'profile'
                ? adding
                  ? h(AddRuleForm, {
                      scopes,
                      knownScopes,
                      isProfile: tab === 'profile',
                      defaultScope: tab === 'profile' ? '__global__' : scope || '__global__',
                      onAdded: () => {
                        setAdding(false)
                        void load()
                        void loadInfo()
                      },
                      onMessage: setMessage,
                      onCancel: () => setAdding(false),
                    })
                  : h(
                      'div',
                      { style: S.row },
                      h(
                        'button',
                        { style: { ...S.btn, ...S.primary }, onClick: () => setAdding(true) },
                        tab === 'profile' ? '＋ 新增画像条目' : '＋ 新增规则',
                      ),
                      h(
                        'span',
                        { style: S.sub },
                        tab === 'profile'
                          ? '画像只描述用户本人与协作方式，不分项目'
                          : '可指定全局或某个项目',
                      ),
                    )
                : null,
              h(
                'div',
                { style: S.row },
                h('input', {
                  style: S.input,
                  value: query,
                  spellCheck: false,
                  placeholder: '检索关键词（中文按字匹配）…',
                  onChange: (e) => setQuery(e.target.value),
                }),
                tab === 'rules'
                  ? h(
                      'select',
                      { style: S.select, value: scope, onChange: (e) => setScope(e.target.value) },
                      // 全局也要显示条数 —— 否则它会显得像是空的，
                      // 而其他项目都有数字。全局条数含 rules 里的全局规则 + profile 里的画像。
                      h(
                        'option',
                        { value: '__global__' },
                        (() => {
                          const g = scopes.find((s) => s.scope === '__global__')
                          return g ? `仅全局规则（${g.n}）` : '仅全局规则'
                        })(),
                      ),
                      h('option', { value: '' }, '全部项目'),
                      // ⚠️ 2026-11-18 改为「所有已知工作区」，不再只列 entries 返回的 scopes。
                      //
                      // 原实现只列 `listScopes('rules')` 的结果 = **已经有 active 规则
                      // 的工作区**。后果：还没建过规则的工作区不在下拉里 →
                      // GUI 无法筛选到它、也无法给它建第一条规则（鸡生蛋）。
                      // 用户实测报告：「GUI里目前无法筛选项目规则」
                      // （当时库里 6 个工作区，下拉只有 2 项）。
                      //
                      // 条数仍然来自 `scopes`（entries 响应），**给了才显示**：
                      // 没建过规则的工作区显示成「name」而不是「name（0）」，
                      // 避免和「有 0 条 active 但其实是停用」混淆。
                      ...knownScopes.map((name) => {
                        const hit = scopes.find((s) => s.scope === name)
                        return h(
                          'option',
                          { key: name, value: name },
                          hit ? `${name}（${hit.n}）` : name,
                        )
                      }),
                      // 兜底：库里有规则、但既不在 projects 也不在 scope/list 里的
                      // 异常 scope（比如手工改库留下的）。不列出来就选不到、也看不见。
                      ...scopes
                        .filter(
                          (s) =>
                            s.scope !== '__global__' &&
                            s.scope !== '' &&
                            !knownScopes.includes(s.scope),
                        )
                        .map((s) => h('option', { key: s.scope, value: s.scope }, `${s.scope}（${s.n}）`)),
                    )
                  : null,
                tab === 'rules'
                  ? h(
                      'select',
                      { style: S.select, value: kind, onChange: (e) => setKind(e.target.value) },
                      h('option', { value: '' }, '全部类型'),
                      h('option', { value: 'redline' }, '红线'),
                      h('option', { value: 'pref' }, '偏好'),
                      h('option', { value: 'state' }, '现状'),
                    )
                  : null,
                h(
                  'label',
                  { style: { ...S.sub, display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' } },
                  h('input', {
                    type: 'checkbox',
                    checked: showInactive,
                    onChange: (e) => setShowInactive(e.target.checked),
                  }),
                  '显示已停用的',
                ),
              ),
              // 流水页的项目下拉：与时间筛选同一行，因为两者都是「缩小范围」的操作。
              //
              // 选项**不带条数**：这里是看流水，不是看规则。带了数字反而会让人
              // 以为那是规则数（尤其「干杂活」有 19 条流水但 0 条规则），
              // 而真正需要的是「挑一个项目」这个动作本身。
              // 筛完之后的条数由下方「共 N 条」统一显示，不必在每个选项里重复。
              tab === 'log'
                ? h(
                    'div',
                    { style: S.row },
                    h('span', { style: S.sub }, '项目：'),
                    h(
                      'select',
                      {
                        style: S.select,
                        value: logScope,
                        onChange: (e) => setLogScope(e.target.value),
                      },
                      h('option', { value: '' }, '全部项目'),
                      ...scopes
                        .filter((s) => s.scope !== '__global__')
                        .map((s) => h('option', { key: s.scope, value: s.scope }, s.scope)),
                    ),
                    logScope
                      ? h(
                          'button',
                          { style: S.btn, onClick: () => setLogScope('') },
                          '清除',
                        )
                      : null,
                  )
                : null,
              // 时间筛选：只给有可靠时间的两个页签（情绪 / 流水）。
              // 规则与画像的 ts 多为迁移前的 NULL，按时间筛会全部漏掉。
              tab === 'emotion' || tab === 'log'
                ? h(
                    'div',
                    { style: S.row },
                    h('span', { style: S.sub }, '时间：'),
                    h('input', {
                      type: 'date',
                      style: { ...S.select, width: '150px' },
                      value: fromDate,
                      onChange: (e) => setFromDate(e.target.value),
                    }),
                    h('span', { style: S.sub }, '至'),
                    h('input', {
                      type: 'date',
                      style: { ...S.select, width: '150px' },
                      value: toDate,
                      onChange: (e) => setToDate(e.target.value),
                    }),
                    h(
                      'button',
                      {
                        style: S.btn,
                        onClick: () => {
                          // ⚠️ 不要写回 `new Date().toISOString().slice(0,10)`：
                          //    那是 UTC 日期，本地 00:00–08:00 会差一整天，
                          //    表现是「点『今天』筛出昨天」。见 localDayStr 的注释。
                          const today = localDayStr()
                          setFromDate(today)
                          setToDate(today)
                        },
                      },
                      '今天',
                    ),
                    h(
                      'button',
                      {
                        style: S.btn,
                        onClick: () => {
                          // ⚠️ 这里原来连着两处 `toISOString()`：
                          //    · `setDate(d.getDate() - 7)` 改的是**本地**日期，
                          //      紧接着 `toISOString()` 又按 **UTC** 取 —— 等于混算两次；
                          //    · `toDate` 直接用 UTC 的「今天」，本地凌晨会取到昨天。
                          //    现在两处都走 localDayStr，与后端 nowIso/localDay 同口径。
                          const d = new Date()
                          d.setDate(d.getDate() - 7)
                          setFromDate(localDayStr(d))
                          setToDate(localDayStr())
                        },
                      },
                      '近 7 天',
                    ),
                    fromDate || toDate
                      ? h(
                          'button',
                          {
                            style: S.btn,
                            onClick: () => {
                              setFromDate('')
                              setToDate('')
                            },
                          },
                          '清除',
                        )
                      : null,
                  )
                : null,
              h(
                'div',
                { style: S.sub },
                busy
                  ? '读取中…'
                  : (tab === 'log'
                      ? `共 ${total} 条可翻（只显示最近 ${MAX_VIEWABLE} 条，更早的用 /memory search 检索）` +
                        `，当前第 ${page + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页`
                      : `共 ${entries.length} 条`) +
                    (tab === 'profile'
                      ? '。画像描述用户本人与协作方式，对所有项目生效。'
                      : '') +
                    (tab === 'emotion' ? '。自动识别的情绪可能有误，可直接删除或修改。' : '') +
                    (tab === 'rules'
                      ? '。项目规则可升级为全局；全局规则不能降级 —— 全局会影响所有项目。'
                      : '') +
                    ((tab === 'emotion' || tab === 'log') && (fromDate || toDate)
                      ? `（时间范围 ${fromDate || '最早'} ~ ${toDate || '现在'}，无时间的旧记录不计入）`
                      : ''),
              ),
              entries.length === 0
                ? h('div', { style: S.empty }, busy ? '' : '没有匹配的条目。')
                : entries.map((item) =>
                    h(EntryRow, {
                      key: `${TAB_TABLE[tab]}-${item.id}`,
                      item,
                      table: TAB_TABLE[tab],
                      onChanged: () => {
                        void load()
                        void loadInfo()
                      },
                      onMessage: setMessage,
                    }),
                  ),
              // 分页控件：只在流水页且确实有多页时出现。
              // 放列表下方而不是上方 —— 操作顺序是「先看内容，再决定翻不翻」。
              tab === 'log' && total > PAGE_SIZE
                ? h(
                    'div',
                    { style: S.pagination },
                    h(
                      'button',
                      {
                        style: page === 0 || busy ? { ...S.btn, ...S.btnDisabled } : S.btn,
                        disabled: busy || page === 0,
                        onClick: () => setPage((p) => Math.max(0, p - 1)),
                      },
                      '‹ 上一页',
                    ),
                    h(
                      'span',
                      { style: S.sub },
                      `第 ${page + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))} 页` +
                        `（共 ${total} 条）`,
                    ),
                    h(
                      'button',
                      {
                        style:
                          busy || (page + 1) * PAGE_SIZE >= total
                            ? { ...S.btn, ...S.btnDisabled }
                            : S.btn,
                        disabled: busy || (page + 1) * PAGE_SIZE >= total,
                        onClick: () => setPage((p) => p + 1),
                      },
                      '下一页 ›',
                    ),
                    page > 0
                      ? h(
                          'button',
                          { style: S.btn, disabled: busy, onClick: () => setPage(0) },
                          '回到最新',
                        )
                      : null,
                  )
                : null,
            ),
      )
    }

    /** 左侧栏的图标按钮：只需要一个图标，点击后由 main 面板接管 */
    function SidebarIcon({ size }) {
      const s = size || 18
      return h(
        'svg',
        {
          width: s,
          height: s,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        // 一个「鱼」的简笔：椭圆身体 + 尾鳍 + 眼
        h('path', { d: 'M3 12c3-4 7-6 11-6 3 0 5 2 6 4-1 2-3 4-6 4-4 0-8-2-11-6z' }),
        h('path', { d: 'M20 10c1.5-1 2.5-2.5 3-4-1.5 0-3 .5-4 1.5' }),
        h('circle', { cx: 7, cy: 11, r: 0.8, fill: 'currentColor', stroke: 'none' }),
      )
    }

    // ---- 界面侧：把记忆标记从对话渲染里擦掉 ----
    //
    // 为什么放在客户端（2026-11-13 定案）：
    //   标记是唯一的写入通道（硬约束 1 禁止注册工具），而 DSH 的对话渲染
    //   把 HTML 注释当纯文本吐出来 —— 渲染器里那行是
    //   `case "html": return r.omitHtml ? null : e.value`，而对话消息
    //   （ui-chat 的 AssistantMarkdown）调 MarkdownText 时没传 omitHtml。
    //   插件读的是 session 事件原文，与 DOM 显示完全解耦 ——
    //   所以在浏览器里擦掉那层「显示壳」上的字，原文与入库都不受影响。
    //
    // 为什么不选别的路：
    //   - 链接引用定义（CommonMark 可隐形）：实测写错就退化成可见段落，
    //     且要求前置空行、禁半角双引号、多行压成一行 —— 每轮都要写对，不可靠。
    //   - 接管 conversation.chat.node：能彻底解决，但要重写整条 assistant
    //     渲染（ReasoningRow、工具卡片、流式态都在 ui-chat 私有域里）。
    //
    // ⚠️ 只删「完整的 HTML 注释」且跳过 code/pre：
    //   回复正文里讲解格式时写的 `` `<!--mem-log` `` 是 inlineCode 片段，
    //   删了会把说明文字吃掉。同理不想碰代码块里的示例。
    /**
     * 要擦掉的完整标记。
     *
     * ⚠️ 2026-11-13 实测踩到：最初写成 `/<!--mem-(?:log|fact|note|fix)[\s\S]*?-->/g`
     * 跨段匹配，结果把我自己讲解格式的那句
     *   写法是 `<!--mem-log` 加内容 `-->`
     * 里的两个行内代码片段连成了一条「完整标记」，整句说明被吃光。
     *
     * 修法：要求标记**从行首开始**（允许前面有空白），并且不允许跨越反引号。
     * 这同时符合真实标记的写法（永远独占一行起头）。
     */
    const MEM_STRIP_RE = /^[ \t]*<!--mem-(?:log|fact|note|fix)\b[^`]*?-->[ \t]*$/gm

    /**
     * 「**假装是标记的命令式注释**」—— 2026-11-21 用户实报。
     *
     * ## 现场
     *
     * 另一个工作区（ForzaOverlay）的模型把「写记忆」写成了**一段 HTML 注释里的命令**：
     *
     *     <!-- 记忆写入命令：& .\.dsh-fatfishdream-memory\log.ps1 "正文" "闲聊" -->
     *
     * 它**既没进库、也没被擦掉**，就这么原样露在界面上。
     *
     * ## 为什么两个环节都放过了它（不是 bug，是各自都没覆盖）
     *
     *   · 解析（`index.js` 的 `MEM_MARKER_RE`）要求 `<!--mem-log` **紧贴**，
     *     这条开头是 `<!--` + **空格** + 中文，且**根本不含 `mem-log`** → 不命中 → 不进库
     *   · 擦除（`MEM_STRIP_RE`）同样只认 `mem-*` 形式 → 不命中 → 原样显示
     *
     * 实测三个形态（2026-11-21）：
     *
     * | 写法 | 解析 | 擦除 |
     * |---|---|---|
     * | `<!--mem-log topic=x` ⏎ 正文 ⏎ `-->` | ✅ | ✅ |
     * | `<!--mem-log topic=x -->`（单行、无正文） | ❌ | ✅ |
     * | `<!-- 记忆写入命令：… -->`（本条） | ❌ | ❌ |
     *
     * ## 判据：擦的是「形态」，不是「内容」
     *
     * 条件收得很紧，宁可漏也不误伤：
     *   ① `<!--` **后紧跟空白**（真实标记是紧贴的 `<!--mem-`）
     *   ② 整块**独占一行**（起止都在同一行，`^…$`）
     *   ③ 行内**不含反引号**（讲解格式时写的 `` `<!--…-->` `` 是行内代码）
     *   ④ 中间内容**至少 2 个字符**（`<!---->` / `<!-- -->` 这类空壳不在此列）
     *
     * ⚠️ 为什么不连内容一起判（比如只擦含「log.ps1」的）：
     *    那会把范围绑死在**当前**的误用写法上。用户看到的是这一条，
     *    但下一个工作区的模型可能写成 `<!-- 记忆：POST /api/... -->`。
     *    **按 `<!--` + 空白 + 独占行**这个形态判，才能覆盖同类。
     */
    const MEM_COMMENT_LIKE_RE = /^[ \t]*<!--[ \t]+[^`\n]{2,}?-->[ \t]*$/gm

    /**
     * 流式输出时「还没写完的标记」。
     *
     * ⚠️ 为什么不用「藏起来等写完再放出来」：2026-11-13 试过用 display:none
     * 的 span 包住半截标记，等 `-->` 补齐后恢复 —— 但 DOM 不会自动把内容从
     * 隐藏壳里拿出来，结果标记内容永久消失。那比露出一行字严重得多。
     *
     * 改成本正则的语义：**未闭合的标记整段擦掉**。
     * 安全性来自 MEM_STRIP_RE 的同一约束 —— 真实的标记永远独占一行起头，
     * 所以「行首的 <!--mem-xxx」后面跟的东西一定属于标记本身，不是正文。
     * 擦掉它不会伤到任何正常内容；写完后 MEM_STRIP_RE 会接手。
     */
    const MEM_PARTIAL_RE = /^[ \t]*<!--mem-(?:l(?:og)?|f(?:act|ix)?|n(?:ote)?)?[\s\S]*$/m

    /**
     * 折叠统计：用来说明「守卫到底有没有在起作用」。
     *
     * 为什么要记 counters 而不是只记结果：
     *   2026-11-15 修「滚动条被擦除器打断」之后，光看代码不能确认问题真的解决了。
     *   两个数字一对比就知道方向对不对：
     *
     *     marked  逐渐增长 = 对话区里仍有空段被收掉（正常，视觉上无害）
     *     blocked 也在增长 = 守卫真的拦下了东西（说明旧逻辑本来会误伤）
     *     blocked 恒为 0     = **守卫根本没被触发**，问题不在「藏错地方」，
     *                          得换方向查（比如 CSS 选择器、别的插件、别的注入）
     *
     * 这正是「别猜，要有证据」的落地方式 —— 用户报的是现象，
     * 我们需要的是一组能证伪的数字。
     */
    const collapseStats = {
      marked: 0,
      blocked: 0,
      tags: {},        // 被打标记的元素 tag 分布
      blockedBy: {},   // 被拦下的原因分布
    }

    /**
     * 擦掉一段 DOM 里所有完整的 mem 标记。
     *
     * @param {Node} root - 起始节点（含其子树）
     * @param {{skipPartial?: boolean}} [opts] - 见下
     * @returns {number} 擦掉的标记条数
     *
     * ⚠️ 2026-11-16 加 `skipPartial`（切会话闪烁，第六代修复）：
     *
     * 用户原话：「每次切会话的时候 会一闪而过」——「每次」，不是偶发。
     *
     * 根因（这次是准的）：MutationObserver 回调是**微任务**，本应在浏览器
     * 绘制之前跑完。但旧代码收到回调只做 `schedule()` → `setTimeout(400ms)`，
     * 于是代码**主动把擦除推迟到了绘制之后**。切会话时整段历史被重新挂载
     * （实测历史里有 34 条带完整标记的消息），那一帧你必然看到原文。
     *
     * 为什么当初要等 400ms：流式输出时文字逐字变化，每帧擦一次会让整个
     * 对话区反复抖动（第四代事故）。但那个问题**只存在于未闭合的标记**：
     *
     *   流式中的标记：`<!--mem-log topic=x` ← 没有 `-->`，还在长
     *   历史里的标记：`<!--mem-log topic=x … -->` ← 完整、静态、不会再变
     *
     * 所以切分点很清楚：**完整标记可以立刻擦（它不会再变），
     * 未闭合的必须等（它还在长）**。`skipPartial` 就是这个切分开关，
     * 只有同步快擦那条路径会传它。
     *
     * 默认 `false` = 保持旧行为，谁都不传就一切照旧。
     */
    function stripMemMarkers(root, opts = {}) {
      if (!root || root.isConnected === false) return 0
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const v = node.nodeValue
            // ⚠️ 2026-11-21 扩：原来只认 `<!--mem-`，于是「命令式注释」整个被跳过，
            //    连 `closest('code, pre')` 那层保护都没机会生效 —— 它根本没被选中。
            //    现在「像标记」或「像注释」都进候选，具体擦不擦由两个正则各自把关。
            if (!v) return NodeFilter.FILTER_REJECT
            if (v.indexOf('<!--') === -1) return NodeFilter.FILTER_REJECT
            // 反引号行内代码与代码块里的示例一律不碰
            const el = node.parentElement
            if (el && el.closest('code, pre')) return NodeFilter.FILTER_REJECT
            return NodeFilter.FILTER_ACCEPT
          },
        },
      )
      const targets = []
      let n
      while ((n = walker.nextNode())) targets.push(n)

      let removed = 0
      for (const node of targets) {
        const before = node.nodeValue
        // 先擦完整的（可能一条回复里有多条）
        let after = before.replace(MEM_STRIP_RE, '')
        removed += (before.match(MEM_STRIP_RE) || []).length
        // ★ 2026-11-21：再擦「假装是标记的命令式注释」（`<!-- 记忆写入命令：… -->`）。
        //
        // ⚠️ 必须**在完整标记之后**、**在未闭合尾巴之前**处理：
        //   · 放在完整标记之前 → 不会冲突（两个正则的起头条件互斥），
        //     但语义上「真标记优先」更清楚；
        //   · 放在未闭合尾巴之后 → 那一步可能已经把 `-->` 之前的内容吃掉，
        //     这条注释就再也匹配不上完整形态了。
        const commentHits = after.match(MEM_COMMENT_LIKE_RE) || []
        if (commentHits.length > 0) {
          after = after.replace(MEM_COMMENT_LIKE_RE, '')
          removed += commentHits.length
        }
        // 再擦没闭合的尾巴（流式输出中途）
        //
        // ⚠️ `skipPartial` 时跳过：同步快擦只处理**已经完整**的标记。
        // 未闭合的还在变，此刻擦掉它会让下一段文字"跳"一下 —— 那正是
        // 第四代抖动事故的成因。留给 400ms 那条延迟路径处理。
        if (opts.skipPartial !== true) {
          const partial = MEM_PARTIAL_RE.exec(after)
          if (partial) {
            after = after.slice(0, partial.index) + after.slice(partial.index + partial[0].length)
            removed += 1
          }
        }
        if (after === before) continue
        node.nodeValue = after
        // ⚠️ 2026-11-14 修：**不要 el.remove()**。
        //
        // 旧写法：擦完若元素变空就 `el.remove()`，想消掉多出来的空行。
        // 但那是在 React 管理的 DOM 上**删节点** —— React 的 reconciliation
        // 发现自己的节点没了，会重新插入，擦除器下一帧再删……
        // 表现为「每轮回复结尾一直闪烁才停」。
        // （当时的 100ms 抑制窗口挡不住：React 重渲染可能晚于 100ms。
        //   第五代把那条时间窗整个删掉了 —— 现在只在「静止」后才扫，
        //   这个变量已经不存在，留着这句只为记住为什么不用 el.remove。）
        //
        // 现在改成「打标记 + CSS 隐藏」：不删节点、不改结构，React 察觉不到。
        //
        // ============================================================
        // ⚠️ 2026-11-15 收窄（用户报「改功能后全局 skills 滚动条失效」）
        // ============================================================
        //
        // 旧判据只有 `el !== document.body`，等于「除 body 外全都可以隐藏」。
        // 而这条属性配的是全局 CSS `display: none !important`，一旦打到
        // 某个滚动容器的子节点上，容器 scrollHeight 塌成 0，滚动条就消失，
        // 且 !important 无法用别的样式覆盖回来。
        //
        // 现在加三道守卫，宁可留下一个空行（视觉上无害），
        // 也绝不隐藏一个可能承载布局的元素：
        //
        //   ① 必须是**行内语义元素**（p / span / div 这类文本容器）。
        //      排除掉 main / section / ul / li / table / 自定义容器 ——
        //      它们是布局骨架，隐藏一个就可能塌掉整块可滚动区域。
        //   ② 不能是「有尺寸的块」。空 div 若被 flex/grid 分配了高度，
        //      它就是布局占位；隐藏它会改变兄弟节点位置。
        //   ③ 不能处在任何 overflow:auto/scroll 的祖先里。
        //      这条最关键：滚动容器的内部结构一律不碰。
        const el = node.parentElement
        if (
          el &&
          el !== document.body &&
          el !== document.documentElement &&
          after.trim() === '' &&
          el.textContent.trim() === '' &&
          el.children.length === 0 &&
          !el.hasAttribute('data-dsh-mem-blank') &&
          isSafeToCollapse(el)
        ) {
          el.setAttribute('data-dsh-mem-blank', '')
          ensureBlankStyle()
          collapseStats.marked++
          collapseStats.tags[el.tagName] = (collapseStats.tags[el.tagName] ?? 0) + 1
        } else if (el && after.trim() === '' && el.textContent.trim() === '' &&
                   el.children.length === 0 && !el.hasAttribute('data-dsh-mem-blank')) {
          // 走到这里 = 本来会打标记，但被守卫拦下了。
          // 记下来：如果这个数字一直是 0，说明守卫根本没起作用，
          // 问题不在「藏错了」，得换方向查。
          collapseStats.blocked++
          const why = el === document.body ? 'body'
            : el === document.documentElement ? 'documentElement'
            : !isSafeToCollapse(el) ? 'unsafe'
            : 'other'
          collapseStats.blockedBy[why] = (collapseStats.blockedBy[why] ?? 0) + 1
        }
      }
      return removed
    }

    /**
     * 判断一个「已擦空的元素」能不能安全地 `display:none` 掉。
     *
     * ## 为什么需要这个函数（2026-11-15）
     *
     * 用户报「每次改动功能，全局 skills 的滚动条都失效」。
     * 根因：擦除器给「擦完只剩空白」的元素打 `data-dsh-mem-blank`，
     * 而配套 CSS 是 `display: none !important` —— **全局生效、无法覆盖**。
     *
     * 旧判据只有 `el !== document.body`，其余一律隐藏。于是：
     *   滚动容器 A（overflow:auto）
     *     └─ 某个子元素 B 被擦成空 → 打标记 → display:none
     *        → A 的 scrollHeight 塌陷 → **滚动条消失**
     *
     * ## 判据设计：宁可少隐藏，也不塌布局
     *
     * 隐藏一个空行收益很小（视觉上少一条缝），
     * 而隐藏错一个布局元素代价很大（整块区域滚不动）。
     * 所以这里全部用「保守拒绝」：
     *
     *   ① 只允许行内语义元素。main/section/ul/li/table/nav/aside 这类
     *      是骨架，绝不是「一段文字的空壳」。
     *   ② 不能处在任何 overflow:auto/scroll 的祖先里 —— 滚动容器内部一律不碰。
     *   ③ 不能有实际尺寸。被 flex/grid 分配了高度的空 div 是布局占位。
     *
     * @param {Element} el 已确认「擦完为空、无子元素」的候选元素
     * @returns {boolean} true 才允许打标记
     */
    function isSafeToCollapse(el) {
      try {
        // ① 白名单：只碰文本容器。用 tag 白名单而不是黑名单 ——
        //    黑名单永远列不全，白名单列不全时只是「少隐藏一个」，安全方向是对的。
        const SAFE_TAGS = ['P', 'SPAN', 'DIV', 'BR', 'CODE', 'EM', 'STRONG', 'LI']
        if (!SAFE_TAGS.includes(el.tagName)) return false

        // 但 LI 只在它不在列表容器里时才安全？不必细究 ——
        // 下面第 ② 条（滚动祖先）已经覆盖了绝大多数危险场景。

        // ② 祖先里有滚动容器 → 一律不碰。
        //    这一条是本次问题的直接防线：skills 面板就是一个滚动容器。
        //
        //    但**不能只看 overflow**。2026-11-15 实测顾虑：
        //      - 有些容器靠 `overflow-y: auto` 的类名生效，computed 能读到 → 覆盖到
        //      - 但另一些用 `max-height` + `overflow: hidden` 做裁剪，
        //        或者滚动发生在**更外层的父级**（本元素只是个 flex 子项）
        //    所以除 overflow 外，再加一条「祖先有受限高度」的判断：
        //    只要某个祖先的高度是受限的（maxHeight / height 不是 auto），
        //    它内部元素的显隐就可能改变滚动量 —— 一律不碰。
        let p = el.parentElement
        let guard = 0
        while (p && p !== document.body && guard++ < 50) {
          const cs = getComputedStyle(p)
          if (cs.overflowY === 'auto' || cs.overflowY === 'scroll' ||
              cs.overflow === 'auto' || cs.overflow === 'scroll') {
            return false
          }
          // 祖先被限高（max-height / height 有值）且自身允许滚动或裁剪
          const limitedHeight =
            (cs.maxHeight && cs.maxHeight !== 'none') ||
            (cs.height && cs.height !== 'auto' && cs.height !== '0px')
          if (limitedHeight && (cs.overflowY === 'hidden' || cs.overflow === 'hidden')) {
            return false
          }
          p = p.parentElement
        }

        // ③ 有实际高度 = 被布局分配了空间，隐藏会改变布局。
        //
        //    ⚠️ 高度和宽度不能用同一个阈值（2026-11-15 验证脚本发现）：
        //    行内元素 `<span>` 只含空白时，高度约等于行高（可能 2px 残留），
        //    但**宽度仍可能是几十像素**（空白字符的宽度）。
        //    如果按宽度也卡 4px，就会把正常的空 span 全拒掉 ——
        //    那等于这个逐行收拢功能完全失效。
        //
        //    判据修正：
        //      - 高度 > 4px  → 拒绝（说明被 flex/grid 撑开，是占位块）
        //      - 宽度不参与判断（行内元素天然有宽度）
        //      - 例外：<br> 有行高但无内容，允许
        const rect = el.getBoundingClientRect()
        if (rect.height > 4 && el.tagName !== 'BR') return false

        return true
      } catch {
        // 任何异常都按「不安全」处理 —— 少隐藏一个不会有问题
        return false
      }
    }

    /**
     * 注入一条样式：把「擦完只剩空白」的段落视觉上收掉。
     *
     * 为什么用 CSS 而不是删 DOM：见 stripMemMarkers 里的说明 ——
     * 删 React 管的节点会触发重渲染循环，表现为闪烁。
     * CSS 只影响显示，不改变 DOM 结构，React 不会察觉。
     */
    let blankStyleInstalled = false
    function ensureBlankStyle() {
      if (blankStyleInstalled) return
      blankStyleInstalled = true
      // 复用已有那条，别重复注入。
      //
      // 2026-11-15 修：`blankStyleInstalled` 是模块级布尔，禁用→启用插件会重置它，
      // 而 <style> 标签还留在 head 里 —— 每重载一次就多一条相同规则。
      // 虽然重复的 CSS 不影响渲染结果，但会让 DOM 诊断里的 style 计数虚高，
      // 也给「到底注入了什么」制造噪音。
      if (document.querySelector('style[data-dsh-memory="blank-collapse"]')) return
      const style = document.createElement('style')
      style.dataset.dshMemory = 'blank-collapse'
      // ⚠️ 这是一条**全局** CSS（注入 document.head，永不撤除）。
      // 它的选择器会命中文档里任何带该属性的元素，不限于对话区。
      //
      // 所以「能打上这个属性」这件事必须由 isSafeToCollapse 严格把关 ——
      // 单靠选择器收窄是不够的（CSS 没法表达「这个元素在滚动容器里」）。
      style.textContent = `
        /* 擦除器把标记抹掉后，可能留下只含空白的段落 / 分隔空节点 */
        [data-dsh-mem-blank] { display: none !important; }
      `
      document.head.appendChild(style)
    }

    /**
     * 把 DOM 诊断结果回传到服务端日志（排查「滚动条失效」用）。
     *
     * 为什么要走这条路：浏览器端看不到服务端日志，DevTools 又要用户手动开。
     * `/api/dsh-memory/client-report` 路由早就存在但一直空着（TODO 里记着），
     * 现在给它接上真正的内容。
     *
     * 报告什么：**当前所有被打上 data-dsh-mem-blank 的元素**，以及它们
     * 祖先链上的关键特征（tag / 是否有 overflow / 是否滚动容器）。
     * 这些正是判断「标记打到了不该打的地方」所需的信息。
     */
    function reportDomDiagnostics() {
      const out = {
        url: location.pathname,
        marks: [],
        scrollHosts: [],
        styles: 0,
        // 折叠统计：判断守卫是否真的在起作用（见 collapseStats 的注释）
        collapse: { ...collapseStats },
      }
      try {
        // 1) 所有被打上标记的元素 —— 这是冲突的直接证据
        const marked = document.querySelectorAll('[data-dsh-mem-blank]')
        for (const el of Array.from(marked).slice(0, 30)) {
          const cs = getComputedStyle(el)
          out.marks.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 80),
            display: cs.display,
            h: el.getBoundingClientRect().height,
            // 它的父元素是不是滚动容器？如果是，就能解释滚动条消失
            parentOverflow: el.parentElement ? getComputedStyle(el.parentElement).overflowY : null,
            parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
          })
        }

        // 2) 当前页面上「本来能滚动、现在滚不动」的容器
        //    scrollHeight > clientHeight 说明内容够高，但若子节点被 display:none 撑没了，
        //    这里会表现为 scrollHeight ≈ clientHeight。
        const all = document.querySelectorAll('*')
        let checked = 0
        for (const el of all) {
          if (checked >= 40) break
          const cs = getComputedStyle(el)
          if (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') continue
          checked++
          out.scrollHosts.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || '').toString().slice(0, 60),
            id: el.id || null,
            clientH: el.clientHeight,
            scrollH: el.scrollHeight,
            // 关键：这个滚动容器里有没有被我们隐藏的子元素
            hiddenInside: el.querySelectorAll('[data-dsh-mem-blank]').length,
          })
        }

        // 3) head 里我们注入了多少条 style（重载会堆积）
        out.styles = document.querySelectorAll('style[data-dsh-memory]').length
      } catch (e) {
        out.error = String(e?.message ?? e)
      }

      const qs = new URLSearchParams({
        dom: '1',
        state: 'dom-diagnostics',
        detail: JSON.stringify(out),
      })
      fetch(`/api/dsh-memory/client-report?${qs.toString()}`).catch(() => {})
    }

    // 暴露到 window 供手动触发（用户在 DevTools 里敲一行即可回传当前结构）。
    // 不自动跑：DOM 诊断会遍历全文档，不该在每次装载时都付这个成本。
    if (typeof window !== 'undefined') {
      window.__dshMemoryReportDom = reportDomDiagnostics
    }

    /**
     * 装上 DOM 擦除器：首屏擦一遍，之后**等页面静止**再擦。
     *
     * ⚠️ 2026-11-14 改（方案 A，第五代）：流式期间**一个字节都不碰 DOM**。
     *
     * 前四代都栽在同一处，证据在 `_backup-local/old-plugin-backups-20261113/`
     * 与更早的 `_upgrade-backup/client.js`（那一份干脆没有擦除器，标记原样露出）：
     *
     *   ① 跨段正则 `/<!--mem-…[\s\S]*?-->/g` → 把讲解格式的行内代码连成一条，
     *      整句说明被吃掉；
     *   ② 流式半截用 `display:none` 的 span 包住 → DOM 不会把内容从隐藏壳里拿出来，
     *      标记内容**永久消失**；
     *   ③ 擦完 `el.remove()` 删空元素 → React reconciliation 发现节点没了就重插，
     *      擦除器下一帧再删 → **每轮回复结尾一直闪**；
     *   ④ 改成 `data-dsh-mem-blank` + CSS 隐藏 → 不再删节点了，但**改文本仍然改高度**，
     *      叠加 100ms 抑制窗口，高度以 ~10Hz 来回变 → **整个对话区在抖、滚动条跳**。
     *
     * 结论：病根不是「怎么擦」，是「在 React 正在写的那块 DOM 上擦」。
     * 所以这一代改的是**时机**：只在「最后一次变化之后安静了 QUIET_MS」才扫一次。
     * 代价是流式期间末尾那几行标记会短暂可见，结束后一次性擦净 —— 高度只跳一次，不抖。
     * 这与 `selfcheck-dom-strip.mjs`「只敲到 `<!--mem` 时不擦，宁可闪一下也不误伤正文」
     * 是同一个取舍方向。
     *
     * @returns {() => void} 卸载函数
     */
    function installMarkerScrubber() {
      let total = 0
      let firstStripLogged = false
      /** 静止判定的定时器；null 表示没排队 */
      let timer = null
      /** 本轮「持续有变化」的起点，用于兜底上限 */
      let pendingSince = 0
      let observer = null

      /** 安静多久之后才擦（毫秒） */
      const QUIET_MS = 400
      /**
       * 兜底上限：页面一直有人在改（长回复流式输出几十秒）时不能无限等，
       * 否则标记会一直露在界面上。最多忍这么久就强制擦一次。
       */
      const MAX_DEFER_MS = 3000

      /**
       * 这个节点里有没有标记痕迹。
       *
       * 为什么要先判断再排队：页面平时一直在变（计时器、状态栏、光标），
       * 如果任何 mutation 都重置静止计时，「静止」永远等不到 ——
       * 那就又退回第四代的行为了。
       */
      const hasMarker = (node) => {
        if (!node) return false
        // ★ 2026-11-21：**必须同时认「命令式注释」**。
        //
        // ## 这是同一天撞到的第三次「改了一端、另一端没接上」
        //
        // 我改了 `acceptNode`、加了 `MEM_COMMENT_LIKE_RE`、接进了擦除循环 ——
        // 但**漏了这个**。用户实测：DevTools 里擦除器装了、`首屏擦除 0 处`，
        // 而正文里的 `<!-- 测试 -->` 照样露着。
        //
        // 原因：MutationObserver 收到新消息时**先问这里**
        // （`if (hasCompleteMarker(n)) fastStrip(n)`）。
        // 这里只认 `<!--mem-` → 返回 false → **根本没走到擦除那一步**。
        //
        // 我在「擦什么」上做对了，却死在「要不要擦」上。
        // 判据（以后同类改动都要过）：**改了筛选条件，就把所有"先判断"的地方找齐** ——
        // 本项目至少有四处：`acceptNode` / `hasMarker` / `hasCompleteMarker` / 两个正则。
        if (node.nodeType === 3) {
          const v = node.nodeValue ?? ''
          return v.includes('<!--mem-') || v.includes('<!-- ')
        }
        if (node.nodeType === 1) {
          const v = node.textContent ?? ''
          return v.includes('<!--mem-') || v.includes('<!-- ')
        }
        return false
      }

      /**
       * 这个节点里有没有**已闭合**的标记（含 `-->`）。
       *
       * 与 `hasMarker` 的区别就是「完不完面」。用途见下面 `fastStrip`。
       *
       * ⚠️ 2026-11-21：`<!-- `（带空格）那一支是给「命令式注释」用的。
       *    不加它，新消息永远不会走 fastStrip —— 而 fastStrip 是**切会话的主路径**。
       */
      const COMPLETE_MARKER_HINT = /(?:<!--mem-(?:log|fact|note|fix)\b|<!-- )[^`]*?-->/
      const hasCompleteMarker = (node) => {
        if (!node) return false
        if (node.nodeType === 3) return COMPLETE_MARKER_HINT.test(node.nodeValue ?? '')
        if (node.nodeType === 1) return COMPLETE_MARKER_HINT.test(node.textContent ?? '')
        return false
      }

      /** 同步快擦的统计，只用于日志，不参与任何判据 */
      let fastStripped = 0

      /**
       * 同步快擦：**只擦完整标记，立刻执行，不排队**（2026-11-16，第六代）。
       *
       * ## 为什么它必须是同步的
       *
       * MutationObserver 的回调是微任务 —— 它在**浏览器绘制之前**执行。
       * 只要在回调里直接改 DOM，这一帧画出来就已经是干净的，用户看不到原文。
       * 旧代码在回调里只 `schedule()`（setTimeout 400ms），等于主动放弃了这个
       * 免费的时间窗，所以「每次切会话必闪」。
       *
       * ## 为什么只擦完整的
       *
       * 见 `stripMemMarkers` 的 `skipPartial` 注释：未闭合的标记还在变，
       * 此刻擦掉会让文字"跳"一下（第四代抖动事故）。完整标记是静态的。
       *
       * ## 安全性（全部沿用既有判据，一条都没放宽）
       *
       * 1. 仍然走 `stripMemMarkers` —— 里面 `MEM_STRIP_RE` 要求标记**独占行首**，
       *    正文里提到标记写法（行内、反引号里）不会误伤。
       * 2. 仍然跳过 `code` / `pre`。
       * 3. 仍然只改 `node.nodeValue`，**不删节点、不加全局 CSS** ——
       *    React 察觉不到，不会触发 reconciliation 重建。
       * 4. 打 `data-dsh-mem-blank` 前仍过 `isSafeToCollapse` 三道守卫。
       *
       * ## 失败就退回老路
       *
       * 任何异常都吞掉并 `schedule()`，让 400ms 那条路径兜底。
       * 宁可慢几百毫秒，也不能让擦除器把会话搞坏。
       */
      const fastStrip = (node) => {
        try {
          if (!node || !node.isConnected) return
          // 先记下「看到完整标记的那一刻」的节点数，便于事后判断快擦到底有没有跑。
          const n = stripMemMarkers(node, { skipPartial: true })
          if (n > 0) {
            fastStripped += n
            total += n
            // ⚠️ 2026-11-16：这条日志是**第六代是否真的生效**的唯一现场证据。
            //
            // 为什么需要它：`client-scrubber` 回传只在装载时报一次，之后不再报，
            // 所以「切会话时快擦有没有跑」在日志里完全看不见 —— 只能靠用户肉眼判断。
            // 而肉眼判断「闪没闪」是不可靠的（几十毫秒的事）。
            // 有了这条，用户切几次会话后，`fastStripped` 涨没涨就能给结论：
            //   涨了   → 快擦在工作，闪烁窗口已被消除
            //   恒为 0 → MutationObserver 根本没拿到完整标记节点，得换方向查
            console.log(`[dsh-memory] 快擦生效：+${n} 处（累计 ${fastStripped}）`)
            // 同时回传给 Host —— 用户看不到浏览器控制台，但我在日志里能查到。
            //
            // ⚠️ 必须带 `dom=1`：`/client-report` 只有在这个参数为 '1' 时才
            // 解析 `detail` 并写 `client-dom-report` 诊断；不带的话只留一行
            // `client-scrubber`，统计数字就丢了。
            // 也不能带 `stripped`（那是给旧回传用的），这里只用 state + detail。
            try {
              const qs = new URLSearchParams({
                dom: '1',
                state: 'fast-strip',
                detail: JSON.stringify({ n, fastStripped, total }),
              })
              fetch(`/api/dsh-memory/client-report?${qs.toString()}`).catch(() => {})
            } catch {
              /* 回传失败不影响擦除 */
            }
            // 丢掉我们自己刚制造的 mutation，否则会立刻排一轮 400ms 的
            // 无用扫描（第四代的自激循环就是这么来的）。
            try {
              observer?.takeRecords()
            } catch {
              /* takeRecords 不可用时忽略 */
            }
          }
        } catch {
          // 兜底：快擦失败就当没发生，交给延迟路径
          schedule()
        }
      }

      /** 真正扫一次（全量） */
      const pass = () => {
        timer = null
        pendingSince = 0
        // ⚠️ 这里**必须全量重扫**，不能只处理 mutation 记下的节点。
        //
        // 2026-11-13 实测踩到：流式回复时 React 频繁重建文本节点，
        // MutationObserver 回调里拿到的 Node 引用等到下一帧已经脱离文档
        // （isConnected === false），stripMemMarkers 开头那句守卫会把它跳过 ——
        // 表现就是「首屏擦掉了，新回复却擦不到」。日志实锤：
        //   first mount: withMark=1 stripped=1（擦到了）
        //   之后的流式回复：永远擦不到
        //
        // 全量扫描的成本：单次约 2300 个文本节点；现在**只在静止后跑**，
        // 摊到每次回复只有一两次，比原来每帧一次低两个数量级。
        const before = total
        total += stripMemMarkers(document.body)
        if (total > before) {
          if (!firstStripLogged) {
            firstStripLogged = true
            console.log(`[dsh-memory] 擦除器生效：已擦除 ${total} 处标记`)
          }
          // 刚才是我们自己改的 DOM，把这些 mutation 丢掉，免得立刻又排一轮
          // （第四代的自激循环就是从这一步开始的）。
          try {
            observer?.takeRecords()
          } catch {
            /* takeRecords 不可用时忽略 */
          }
        }
      }

      /**
       * 排队：每次「带标记的变化」都重置静止计时，安静满 QUIET_MS 才真扫；
       * 若页面一直在变，最多 MAX_DEFER_MS 就强制扫一次。
       */
      const schedule = () => {
        const now = Date.now()
        if (pendingSince === 0) pendingSince = now
        if (timer !== null) clearTimeout(timer)
        const waited = now - pendingSince
        const wait = Math.max(0, Math.min(QUIET_MS, MAX_DEFER_MS - waited))
        timer = setTimeout(pass, wait)
      }

      // document.body 在某些装载时机可能还没就绪 —— 等它出现再开始，
      // 否则首次全量扫描会静默跳过（表现为「擦除器装了但没作用」）。
      const start = () => {
        total += stripMemMarkers(document.body)
        if (total > 0) firstStripLogged = true
        console.log(
          `[dsh-memory] 擦除器已装载（首屏擦除 ${total} 处；之后等静止再擦）`,
        )
        observer = new MutationObserver((records) => {
          // 只有「这批变化里真的出现了标记」才处理。
          // 为什么必须这样筛：页面平时一直在变（计时器、状态栏、光标），
          // 无条件排队会不停重置静止计时，「安静」永远等不到 —— 那就退回第四代了。
          // 也不缓存节点引用（React 会重建文本节点），只看这一批记录里的证据。
          //
          // ⚠️ 2026-11-16 改（第六代）：**完整标记走同步快擦，不等 400ms。**
          //
          // 这是「每次切会话一闪而过」的修复点。切会话时 React 重新挂载整段
          // 历史，addedNodes 里带着 34 条已闭合的标记 —— 它们不会再变，
          // 没有任何理由等 400ms。这里在回调里**同步**擦掉，因为是微任务，
          // 早于浏览器绘制，所以那一帧画出来就是干净的。
          //
          // 未闭合的（流式输出中途）仍然交给 `schedule()` 走老的延迟路径 ——
          // 那条路径是为了避免逐字擦除导致对话区抖动，不能动。
          let needSchedule = false
          for (const r of records) {
            if (r.type === 'characterData') {
              // 文本节点变化只可能是流式输出改字 → 一律走延迟，不抢跑
              if (hasMarker(r.target)) needSchedule = true
              continue
            }
            for (const n of r.addedNodes) {
              // 先看有没有**完整**标记：有就立刻擦（这是切会话的主路径）
              if (hasCompleteMarker(n)) fastStrip(n)
              // 擦完再判断还有没有残留（未闭合的、或 fastStrip 没覆盖到的）
              if (hasMarker(n)) needSchedule = true
            }
          }
          if (needSchedule) schedule()
        })
        observer.observe(document.body, { childList: true, subtree: true, characterData: true })
      }

      if (document.body) {
        start()
      } else {
        document.addEventListener('DOMContentLoaded', () => { start() }, { once: true })
      }

      return () => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        observer?.disconnect()
        observer = null
        if (total > 0) console.log(`[dsh-memory] 已从界面擦除 ${total} 处记忆标记`)
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 装载探针：可借此在 DevTools 里确认这一半到底有没有被执行。
        // 2026-11-13 排查时发现：控制台里只有别的插件在打印，本插件一行都没有，
        // 因此无法区分「没装载」和「装载了但逻辑没生效」。
        console.log(
          `[dsh-memory] client 半体装载，擦除器 ${
            typeof MutationObserver === 'function' ? '开始安装' : '不可用（无 MutationObserver）'
          }`,
        )

        ctx.effect(
          () => installMarkerScrubber(),
          'dsh-memory: marker scrubber',
        )

        ctx.effect(() => {
          // 左侧栏图标：id 用 'dsh-memory'，与下面 main 面板的 key 一致，
          // 这样点击图标时主区域就切到我们的面板。
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              { name: 'sidebar.panellist', id: 'dsh-memory', order: 20, label: '大肥鱼的梦' },
              SidebarIcon,
            ),
          )
        }, 'dsh-memory: sidebar icon')

        ctx.effect(() => {
          // 主面板：key 必须与 sidebar id 相同
          ctx.slots.inject('main', () =>
            ctx.slots.register({ name: 'main', key: 'dsh-memory' }, MemoryPanel),
          )
        }, 'dsh-memory: main panel')
      },
    }
  },
})
