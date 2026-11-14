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
    function AddRuleForm({ scopes, defaultScope, isProfile, onAdded, onMessage, onCancel }) {
      const [text, setText] = React.useState('')
      const [scope, setScope] = React.useState(defaultScope || '__global__')
      const [kind, setKind] = React.useState('pref')
      const [busy, setBusy] = React.useState(false)

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
                ...scopes
                  .filter((s) => s.scope !== '__global__')
                  .map((s) => h('option', { key: s.scope, value: s.scope }, `项目：${s.scope}`)),
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
          if (!showInactive) params.set('status', 'active')
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

      return h(
        'div',
        { style: S.page },
        h(
          'div',
          { style: S.header },
          h('h1', { style: S.h1 }, '大肥鱼的梦'),
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
                      ...scopes
                        .filter((s) => s.scope !== '__global__')
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
                          const today = new Date().toISOString().slice(0, 10)
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
                          const d = new Date()
                          d.setDate(d.getDate() - 7)
                          setFromDate(d.toISOString().slice(0, 10))
                          setToDate(new Date().toISOString().slice(0, 10))
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
    //   标记是唯一的写入通道（硬约束 2 禁止注册工具），而 DSH 的对话渲染
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
     * 擦掉一段 DOM 里所有完整的 mem 标记。
     *
     * @param {Node} root - 起始节点（含其子树）
     * @returns {number} 擦掉的标记条数
     */
    function stripMemMarkers(root) {
      if (!root || root.isConnected === false) return 0
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            const v = node.nodeValue
            if (!v || v.indexOf('<!--mem-') === -1) return NodeFilter.FILTER_REJECT
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
        // 再擦没闭合的尾巴（流式输出中途）
        const partial = MEM_PARTIAL_RE.exec(after)
        if (partial) {
          after = after.slice(0, partial.index) + after.slice(partial.index + partial[0].length)
          removed += 1
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
        const el = node.parentElement
        if (
          el &&
          el !== document.body &&
          after.trim() === '' &&
          el.textContent.trim() === '' &&
          el.children.length === 0 &&
          !el.hasAttribute('data-dsh-mem-blank')
        ) {
          el.setAttribute('data-dsh-mem-blank', '')
          ensureBlankStyle()
        }
      }
      return removed
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
      const style = document.createElement('style')
      style.dataset.dshMemory = 'blank-collapse'
      style.textContent = `
        /* 擦除器把标记抹掉后，可能留下只含空白的段落 / 分隔空节点 */
        [data-dsh-mem-blank] { display: none !important; }
      `
      document.head.appendChild(style)
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
        if (node.nodeType === 3) return (node.nodeValue ?? '').includes('<!--mem-')
        if (node.nodeType === 1) return (node.textContent ?? '').includes('<!--mem-')
        return false
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
          // 只有「这批变化里真的出现了标记」才排队。
          // 为什么必须这样筛：页面平时一直在变（计时器、状态栏、光标），
          // 无条件排队会不停重置静止计时，「安静」永远等不到 —— 那就退回第四代了。
          // 也不缓存节点引用（React 会重建文本节点），只看这一批记录里的证据。
          for (const r of records) {
            if (r.type === 'characterData') {
              if (hasMarker(r.target)) return schedule()
              continue
            }
            for (const n of r.addedNodes) if (hasMarker(n)) return schedule()
          }
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
