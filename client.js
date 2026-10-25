/**
 * GitHub源（Client half）
 *
 * 在 Web 界面注册：
 *   - 左侧栏入口（`sidebar.panellist`，id = dsh-github-source）
 *   - 中央面板（`main`，key = dsh-github-source）
 *
 * 面板做两件事：
 *   1. 「GitHub 检索」：输入需要的插件功能或名称 → 后端由 AI 扩展检索词并搜索 GitHub，
 *      按相关度排序列出全部结果，给出安装命令；
 *   2. 「已安装」：列出本机 profile 里的全部插件（含 dsh-builtin-browser 之类的已装插件）。
 *
 * 数据都来自 Host 的 /dsh-github-source/*.json，面板不直连 GitHub。
 */

window.__ModuleLoader__.load({
  id: 'dsh-github-source',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const SEARCH_API = '/dsh-github-source/search.json'
    const INSTALLED_API = '/dsh-github-source/installed.json'
    const PANEL_ID = 'dsh-github-source'

    const DEFAULT_EXAMPLES = ['浏览器自动化', 'dsh-builtin-browser', '语音输入', '插件市场', '股票行情', 'MCP']

    /** apply 时保存的客户端 ctx，供可选服务（uiWorkspace / sidebarRight）按需查找。 */
    let moduleCtx = null

    function service(name) {
      try {
        if (moduleCtx !== null && typeof moduleCtx.get === 'function') {
          const value = moduleCtx.get(name)
          return value === null ? undefined : value
        }
      } catch {
        /* 可选服务：调用方自行降级 */
      }
      return undefined
    }

    /** 从会话列表里挑一个最该承载浏览器面板的会话（与工作台同一套打分）。 */
    function sessionIdFrom(sessions) {
      const byId = sessions !== null && sessions !== undefined && sessions.byId ? sessions.byId : {}
      const ids = sessions !== null && sessions !== undefined && Array.isArray(sessions.ids)
        ? sessions.ids
        : Object.keys(byId)
      let fallback = ''
      let best = ''
      let bestScore = -1
      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]
        if (typeof id !== 'string' || id === '') continue
        const view = byId[id] || {}
        if (fallback === '') fallback = id
        const retained = view.retainedBy || {}
        let score = 0
        if (retained.mainView > 0) score += 10
        for (const key in retained) {
          if (typeof retained[key] === 'number' && retained[key] > 0) score += 1
        }
        if (score > bestScore) {
          bestScore = score
          best = id
        }
      }
      return best || fallback
    }

    /**
     * 用内置浏览器打开一个页面：优先走 dsh-builtin-browser 公布的
     * `globalThis.__dshBuiltinBrowser.openPanel(sessionId, url)`（桌面端就是官方侧栏里
     * 那个浏览器面板），随后把会话切到前台让面板可见；服务不可用时退回 sidebarRight，
     * 再不行才用外部窗口。
     * @returns {ok:boolean, external?:boolean, sessionId?:string, reason?:string}
     */
    function openInternal(url, sessions) {
      const target = typeof url === 'string' ? url : ''
      if (!/^https?:\/\//i.test(target)) return { ok: false, reason: '只支持 http(s) 地址' }
      const api = typeof globalThis !== 'undefined' ? globalThis.__dshBuiltinBrowser : undefined
      const sessionId = sessionIdFrom(sessions)
      if (api !== undefined && typeof api.openPanel === 'function' && /^session-/.test(sessionId)) {
        let result = null
        try {
          result = api.openPanel(sessionId, target)
        } catch (error) {
          result = { ok: false, reason: String((error && error.message) || error) }
        }
        if (result !== null && result.ok === true) {
          try {
            const workspace = service('uiWorkspace')
            if (workspace && typeof workspace.openSession === 'function') workspace.openSession(sessionId)
          } catch {
            /* 面板已打开；切会话失败不影响 */
          }
          return { ok: true, sessionId, created: result.created === true }
        }
      }
      try {
        const sidebarRight = service('sidebarRight')
        if (sidebarRight && typeof sidebarRight.openTab === 'function') {
          sidebarRight.openTab('browser', { params: { url: target } })
          return { ok: true, via: 'sidebarRight' }
        }
      } catch {
        /* 没有在屏会话时 openTab 会拒绝，落到外部窗口 */
      }
      try {
        if (typeof globalThis !== 'undefined' && globalThis.window && typeof globalThis.window.open === 'function') {
          const opened = globalThis.window.open(target, '_blank', 'noopener,noreferrer')
          if (opened) return { ok: true, external: true }
        }
      } catch {
        /* 浏览器拦截 */
      }
      return { ok: false, reason: '内置浏览器与外部窗口都不可用' }
    }

    /* ------------------------------------------------------------------ */
    /* 小工具                                                              */
    /* ------------------------------------------------------------------ */

    function formatStars(value) {
      const stars = Number(value) || 0
      if (stars >= 10000) return `${(stars / 1000).toFixed(0)}k`
      if (stars >= 1000) return `${(stars / 1000).toFixed(1)}k`
      return String(stars)
    }

    function formatDate(value) {
      if (typeof value !== 'string' || value === '') return '—'
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (number) => String(number).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    function relativeDays(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const days = Math.floor((Date.now() - date.getTime()) / 86400000)
      if (days <= 0) return '今天更新'
      if (days < 30) return `${days} 天前更新`
      if (days < 365) return `${Math.floor(days / 30)} 个月前更新`
      return `${Math.floor(days / 365)} 年前更新`
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        /* 落到 execCommand */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', 'readonly')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch {
        return false
      }
    }

    async function getJson(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }

    /* ------------------------------------------------------------------ */
    /* 组件                                                                */
    /* ------------------------------------------------------------------ */

    function GithubIcon(props) {
      return h(
        'svg',
        {
          width: 15,
          height: 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21' }),
      )
    }

    function SearchIcon(props) {
      return h(
        'svg',
        {
          width: props?.size ?? 15,
          height: props?.size ?? 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none' },
        },
        h('circle', { cx: 10.5, cy: 10.5, r: 6.5 }),
        h('path', { d: 'M15.6 15.6 21 21' }),
      )
    }

    function StarIcon() {
      return h(
        'svg',
        {
          width: 12,
          height: 12,
          viewBox: '0 0 24 24',
          fill: 'currentColor',
          'aria-hidden': 'true',
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.7l5.9-.9z' }),
      )
    }

    function RepoCard(props) {
      const repo = props.repo
      const [copied, setCopied] = useState(null)
      const timer = useRef(null)

      useEffect(
        () => () => {
          if (timer.current !== null) clearTimeout(timer.current)
        },
        [],
      )

      const install = props.install ?? repo.install ?? ''
      const installGithub = repo.installGithub ?? ''
      const openRepo = (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        if (typeof props.onOpen === 'function') {
          props.onOpen(repo.url)
          return
        }
        // 没有外部提供的打开器：直接用内置浏览器（拿不到会话就退回外部窗口）。
        openInternal(repo.url, null)
      }
      const copy = async (text, tag) => {
        const ok = await copyText(text)
        setCopied(ok ? tag : 'failed')
        if (timer.current !== null) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(null), 1800)
      }

      return h(
        'article',
        { className: 'gs-repo' + (repo.installed ? ' is-installed' : '') },
        h(
          'div',
          { className: 'gs-repo-top' },
          h(
            'div',
            { className: 'gs-repo-id' },
            h(
              'a',
              {
                className: 'gs-repo-name',
                href: repo.url,
                onClick: openRepo,
                title: '在内置浏览器打开 GitHub 仓库',
              },
              h(GithubIcon, null),
              h('span', null, repo.fullName),
            ),
            h(
              'div',
              { className: 'gs-badges' },
              repo.installed ? h('span', { className: 'gs-badge is-ok' }, '已安装') : null,
              repo.aiDirect === true ? h('span', { className: 'gs-badge is-ai' }, 'AI 直搜') : null,
              repo.dshVerified === true ? h('span', { className: 'gs-badge is-ok' }, '已核对 dsh 包') : null,
              repo.version ? h('span', { className: 'gs-badge' }, `v${repo.version}`) : null,
              repo.suspect ? h('span', { className: 'gs-badge is-warn' }, '疑似非 DSH 插件') : null,
              repo.archived ? h('span', { className: 'gs-badge is-warn' }, '已归档') : null,
              repo.language !== null ? h('span', { className: 'gs-badge' }, repo.language) : null,
            ),
          ),
          h(
            'div',
            { className: 'gs-repo-star', title: 'GitHub 星标' },
            h(StarIcon, null),
            h('span', null, formatStars(repo.stars)),
          ),
        ),
        repo.description !== '' ? h('p', { className: 'gs-repo-desc' }, repo.description) : null,
        repo.reason !== '' ? h('p', { className: 'gs-repo-reason' }, h('span', { className: 'gs-reason-tag' }, 'AI'), repo.reason) : null,
        h(
          'div',
          { className: 'gs-repo-meta' },
          repo.topics.length > 0
            ? h(
                'div',
                { className: 'gs-topics' },
                repo.topics.slice(0, 6).map((topic) =>
                  h('span', { className: 'gs-topic', key: topic }, topic),
                ),
              )
            : h('span', { className: 'gs-muted' }, '无主题标签'),
          h('span', { className: 'gs-updated' }, relativeDays(repo.updatedAt) || formatDate(repo.updatedAt)),
        ),
        h(
          'div',
          { className: 'gs-repo-actions' },
          h(
            'code',
            { className: 'gs-install', title: installGithub !== '' && installGithub !== install ? `${install}\n${installGithub}` : install },
            install,
          ),
          h(
            'button',
            {
              className: 'gs-btn gs-btn-ghost',
              type: 'button',
              onClick: () => void copy(install, 'primary'),
            },
            copied === 'primary' ? '已复制' : copied === 'failed' ? '复制失败' : '复制安装命令',
          ),
          installGithub !== '' && installGithub !== install
            ? h(
                'button',
                {
                  className: 'gs-btn gs-btn-ghost',
                  type: 'button',
                  title: installGithub,
                  onClick: () => void copy(installGithub, 'github'),
                },
                copied === 'github' ? '已复制' : '复制 GitHub 命令',
              )
            : null,
          h(
            'a',
            {
              className: 'gs-btn gs-btn-ghost gs-btn-open',
              href: repo.url,
              onClick: openRepo,
              title: '用 dsh-builtin-browser 在侧栏内部打开',
            },
            '在浏览器打开',
          ),
        ),
      )
    }

    /** 把结果分成「AI 直接搜索命中」和「GitHub API 检索」两组。 */
    function partitionItems(items) {
      const list = Array.isArray(items) ? items : []
      return {
        direct: list.filter((item) => item !== null && item !== undefined && item.aiDirect === true),
        rest: list.filter((item) => item === null || item === undefined || item.aiDirect !== true),
      }
    }

    function InstalledRow(props) {
      const plugin = props.plugin
      return h(
        'li',
        { className: 'gs-inst-row' },
        h(
          'div',
          { className: 'gs-inst-main' },
          h(
            'div',
            { className: 'gs-inst-name-line' },
            h('span', { className: 'gs-inst-name' }, plugin.name),
            plugin.version !== null ? h('span', { className: 'gs-badge' }, `v${plugin.version}`) : null,
            plugin.local ? h('span', { className: 'gs-badge' }, '本地链接') : null,
            plugin.builtin ? h('span', { className: 'gs-badge' }, 'DSH 内置') : null,
          ),
          plugin.description !== ''
            ? h('p', { className: 'gs-inst-desc' }, plugin.description)
            : h('p', { className: 'gs-inst-desc gs-muted' }, '（该包没有 description）'),
        ),
        h(
          'div',
          { className: 'gs-inst-side' },
          plugin.profiles.length > 1
            ? h('span', { className: 'gs-muted' }, plugin.profiles.join(' / '))
            : null,
          plugin.repo !== null
            ? h(
                'a',
                {
                  className: 'gs-mini-link',
                  href: plugin.repo,
                  title: '在内置浏览器打开仓库',
                  onClick: (event) => {
                    if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
                    if (typeof props.onOpen === 'function') props.onOpen(plugin.repo)
                    else openInternal(plugin.repo, null)
                  },
                },
                '仓库',
              )
            : null,
        ),
      )
    }

    function AiPanel(props) {
      const ai = props.ai
      const stats = props.stats
      const web = ai.web ?? null
      return h(
        'div',
        { className: 'gs-ai' },
        h(
          'div',
          { className: 'gs-ai-head' },
          h('span', { className: 'gs-ai-dot' + (ai.enabled ? ' is-on' : '') }),
          h('span', { className: 'gs-ai-title' }, ai.enabled ? 'AI 参与检索' : '规则检索（AI 不可用）'),
          h('span', { className: 'gs-muted gs-ai-stats' }, `候选 ${stats.candidates} · 展示 ${stats.shown} · GitHub 命中 ${stats.githubTotal}`),
        ),
        h(
          'div',
          { className: 'gs-ai-line' },
          h('span', { className: 'gs-ai-label' }, 'AI 直搜'),
          h(
            'span',
            { className: 'gs-muted' },
            web !== null && web.enabled === true
              ? `已用${web.via === 'account' ? '账号令牌直搜' : '网页搜索'}直接找 ${web.sources} 条线索，合并出 ${stats.aiDirect ?? 0} 个 GitHub 仓库`
              : `不可用${web !== null && web.error ? `：${web.error}` : '（宿主未配置网页搜索）'}`,
          ),
        ),
        ai.keywords.length > 0
          ? h(
              'div',
              { className: 'gs-ai-line' },
              h('span', { className: 'gs-ai-label' }, '检索词'),
              h(
                'div',
                { className: 'gs-chips' },
                ai.keywords.map((keyword) => h('span', { className: 'gs-chip', key: keyword }, keyword)),
              ),
            )
          : null,
        ai.queries.length > 0
          ? h(
              'div',
              { className: 'gs-ai-line' },
              h('span', { className: 'gs-ai-label' }, 'GitHub 表达式'),
              h(
                'div',
                { className: 'gs-chips' },
                ai.queries.map((query) => h('code', { className: 'gs-query', key: query }, query)),
              ),
            )
          : null,
        ai.note !== ''
          ? h('p', { className: 'gs-ai-note' }, h('span', { className: 'gs-ai-label' }, 'AI 判断'), ai.note)
          : null,
        web !== null && typeof web.content === 'string' && web.content !== ''
          ? h(
              'p',
              { className: 'gs-ai-note' },
              h('span', { className: 'gs-ai-label' }, '直搜摘要'),
              web.content.slice(0, 500),
            )
          : null,
        ai.error !== null && ai.error !== ''
          ? h('p', { className: 'gs-ai-error' }, `AI 降级：${ai.error}`)
          : null,
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'gs-empty' },
        h('div', { className: 'gs-empty-icon' }, h(SearchIcon, { size: 26 })),
        h('div', { className: 'gs-empty-title' }, props.title),
        h('div', { className: 'gs-empty-hint' }, props.hint),
      )
    }

    function App(props) {
      const [input, setInput] = useState('')
      const [activeQuery, setActiveQuery] = useState('')
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [data, setData] = useState(null)
      const [tab, setTab] = useState('search')
      const [installed, setInstalled] = useState(null)
      const [installedError, setInstalledError] = useState(null)
      const [installedLoading, setInstalledLoading] = useState(true)
      const [notice, setNotice] = useState(null)
      const inputRef = useRef(null)
      const noticeTimer = useRef(null)

      // 会话列表由 slot runtime 以标准 props 提供（与工作台同一条注入路径）；
      // 没有它时 openInternal 会退回 sidebarRight / 外部窗口。
      const sessions =
        props !== null && props !== undefined && typeof props.useSessions === 'function'
          ? props.useSessions((state) => state)
          : null

      useEffect(
        () => () => {
          if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        },
        [],
      )

      const showNotice = (text) => {
        setNotice(text)
        if (noticeTimer.current !== null) clearTimeout(noticeTimer.current)
        noticeTimer.current = setTimeout(() => setNotice(null), 3200)
      }

      const openRepo = (url) => {
        const result = openInternal(url, sessions)
        if (result.ok === true) {
          showNotice(result.external === true ? '内置浏览器不可用，已改用外部窗口打开' : '已在内置浏览器（侧栏）打开')
        } else {
          showNotice(`打开失败：${result.reason ?? '未知原因'}`)
        }
      }

      const examples = installed?.examples ?? DEFAULT_EXAMPLES
      const profile = installed?.profile ?? data?.profile ?? null
      const installedPlugins = installed?.plugins ?? []
      const community = useMemo(
        () => installedPlugins.filter((plugin) => !plugin.builtin),
        [installedPlugins],
      )
      const builtins = useMemo(
        () => installedPlugins.filter((plugin) => plugin.builtin),
        [installedPlugins],
      )
      const installedNames = useMemo(
        () => new Set(installedPlugins.map((plugin) => plugin.name)),
        [installedPlugins],
      )

      const loadInstalled = async () => {
        setInstalledLoading(true)
        setInstalledError(null)
        try {
          const json = await getJson(INSTALLED_API)
          if (json?.ok !== true) throw new Error(json?.error ?? '读取已安装插件失败')
          setInstalled(json)
        } catch (cause) {
          setInstalledError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setInstalledLoading(false)
        }
      }

      useEffect(() => {
        void loadInstalled()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const runSearch = async (value, refresh) => {
        const query = String(value ?? '').trim()
        if (query === '' || loading) return
        setInput(query)
        setActiveQuery(query)
        setTab('search')
        setLoading(true)
        setError(null)
        try {
          const url = `${SEARCH_API}?q=${encodeURIComponent(query)}&limit=100${refresh === true ? '&refresh=1' : ''}`
          const json = await getJson(url)
          if (json?.ok !== true) throw new Error(json?.error ?? 'GitHub 检索失败')
          setData(json)
        } catch (cause) {
          setData(null)
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          setLoading(false)
        }
      }

      const submit = (event) => {
        if (event !== undefined && typeof event.preventDefault === 'function') event.preventDefault()
        void runSearch(input, false)
      }

      const items = data?.items ?? []
      const groups = partitionItems(items)
      const itemsWithInstall = items

      return h(
        'div',
        { className: 'gs-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'gs-inner' },
          h(
            'header',
            { className: 'gs-hero' },
            h(
              'div',
              { className: 'gs-hero-main' },
              h(
                'h1',
                { className: 'gs-title' },
                h('span', { className: 'gs-title-dot' }),
                'GitHub源',
              ),
              h(
                'p',
                { className: 'gs-sub' },
                '输入你需要的插件功能或名称 —— AI 会把需求改写成检索词，去 GitHub 找相关的 DSH 插件，并把命中结果全部列出来。',
              ),
            ),
            h(
              'div',
              { className: 'gs-hero-side' },
              h('span', { className: 'gs-kpi' }, '已装插件 ', h('b', null, String(community.length))),
              h('span', { className: 'gs-kpi' }, '内置包 ', h('b', null, String(builtins.length))),
              profile !== null ? h('span', { className: 'gs-kpi' }, 'profile ', h('b', null, profile)) : null,
            ),
          ),
          h(
            'form',
            { className: 'gs-search', onSubmit: submit },
            h(
              'div',
              { className: 'gs-search-box' },
              h(SearchIcon, { size: 16 }),
              h('input', {
                ref: inputRef,
                className: 'gs-input',
                value: input,
                placeholder: '例如：浏览器自动化 / 语音输入 / dsh-builtin-browser',
                onChange: (event) => setInput(event.target.value),
                disabled: loading,
                'aria-label': '插件功能或名称',
              }),
            ),
            h(
              'button',
              { className: 'gs-btn gs-btn-primary', type: 'submit', disabled: loading || input.trim() === '' },
              loading ? 'AI 检索中…' : '用 AI 找插件',
            ),
          ),
          h(
            'div',
            { className: 'gs-examples' },
            h('span', { className: 'gs-examples-label' }, '试试：'),
            examples.map((example) =>
              h(
                'button',
                {
                  className: 'gs-chip gs-chip-btn',
                  key: example,
                  type: 'button',
                  disabled: loading,
                  onClick: () => void runSearch(example, false),
                },
                example,
              ),
            ),
            h(
              'button',
              {
                className: 'gs-chip gs-chip-btn gs-chip-all',
                type: 'button',
                disabled: loading,
                onClick: () => void runSearch('topic:dsh-plugin', false),
                title: '按 GitHub 主题 topic:dsh-plugin 检索，按星标排序列出全部插件',
              },
              '全部 dsh 插件（topic:dsh-plugin）',
            ),
          ),
          notice !== null
            ? h('div', { className: 'gs-notice', role: 'status' }, notice)
            : null,
          h(
            'div',
            { className: 'gs-tabs', role: 'tablist' },
            h(
              'button',
              {
                className: 'gs-tab' + (tab === 'search' ? ' is-active' : ''),
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'search',
                onClick: () => setTab('search'),
              },
              'GitHub 检索',
              data !== null ? h('span', { className: 'gs-tab-num' }, String(data?.items?.length ?? 0)) : null,
            ),
            h(
              'button',
              {
                className: 'gs-tab' + (tab === 'installed' ? ' is-active' : ''),
                type: 'button',
                role: 'tab',
                'aria-selected': tab === 'installed',
                onClick: () => setTab('installed'),
              },
              '已安装',
              h('span', { className: 'gs-tab-num' }, String(community.length)),
            ),
          ),
          tab === 'search'
            ? h(
                'section',
                { className: 'gs-section' },
                data !== null ? h(AiPanel, { ai: data.ai, stats: data.stats }) : null,
                data !== null
                  ? h(
                      'div',
                      { className: 'gs-result-head' },
                      h(
                        'div',
                        { className: 'gs-result-title' },
                        `“${data.query}” 的 GitHub 结果`,
                        h('span', { className: 'gs-muted' }, ` 按相关度排序，共 ${data.items.length} 个`),
                        data.cached ? h('span', { className: 'gs-badge' }, '缓存') : null,
                      ),
                      h(
                        'div',
                        { className: 'gs-result-actions' },
                        h(
                          'button',
                          {
                            className: 'gs-btn gs-btn-ghost',
                            type: 'button',
                            disabled: loading,
                            onClick: () => void runSearch(activeQuery, true),
                          },
                          '强制刷新',
                        ),
                      ),
                    )
                  : null,
                error !== null
                  ? h(
                      'div',
                      { className: 'gs-error' },
                      h('div', { className: 'gs-error-title' }, '检索失败'),
                      h('p', { className: 'gs-error-text' }, error),
                      h(
                        'button',
                        { className: 'gs-btn gs-btn-ghost', type: 'button', onClick: () => void runSearch(activeQuery, true) },
                        '重试',
                      ),
                    )
                  : null,
                loading
                  ? h(
                      'div',
                      { className: 'gs-loading' },
                      h('span', { className: 'gs-spinner' }),
                      h('span', null, 'AI 正在扩展检索词并搜索 GitHub…（首次可能要十几秒）'),
                    )
                  : null,
                !loading && error === null && data === null
                  ? h(EmptyState, {
                      title: '还没有检索',
                      hint: '输入功能（如「浏览器自动化」）或插件名（如「dsh-builtin-browser」），点「用 AI 找插件」。也可以展开「已安装」看本机已有插件。',
                    })
                  : null,
                !loading && error === null && data !== null && items.length === 0
                  ? h(EmptyState, {
                      title: '没有命中',
                      hint: `GitHub 上没有找到与「${data.query}」相关的 DSH 插件。换个更短的功能词试试，比如只写「browser」。`,
                    })
                  : null,
                !loading && itemsWithInstall.length > 0
                  ? h(
                      React.Fragment,
                      null,
                      groups.direct.length > 0
                        ? h(
                            'div',
                            { className: 'gs-group-head' },
                            h('span', { className: 'gs-group-title' }, `AI 直接搜索命中（${groups.direct.length}）`),
                            h('span', { className: 'gs-muted' }, '网页搜索直接给出的仓库，优先展示'),
                          )
                        : null,
                      groups.direct.length > 0
                        ? h(
                            'div',
                            { className: 'gs-repos' },
                            groups.direct.map((repo) =>
                              h(RepoCard, {
                                key: repo.fullName,
                                repo,
                                install: repo.install,
                                onOpen: openRepo,
                              }),
                            ),
                          )
                        : null,
                      groups.rest.length > 0 && groups.direct.length > 0
                        ? h(
                            'div',
                            { className: 'gs-group-head' },
                            h('span', { className: 'gs-group-title' }, `GitHub 检索结果（${groups.rest.length}）`),
                          )
                        : null,
                      groups.rest.length > 0
                        ? h(
                            'div',
                            { className: 'gs-repos' },
                            groups.rest.map((repo) =>
                              h(RepoCard, {
                                key: repo.fullName,
                                repo,
                                install: repo.install,
                                onOpen: openRepo,
                              }),
                            ),
                          )
                        : null,
                    )
                  : null,
                data !== null && data.warnings?.length > 0
                  ? h(
                      'ul',
                      { className: 'gs-warn' },
                      data.warnings.map((warning) => h('li', { key: warning }, warning)),
                    )
                  : null,
                data !== null
                  ? h(
                      'p',
                      { className: 'gs-foot' },
                      `结果来自 GitHub 公开搜索（${data.generatedAt?.slice(0, 19).replace('T', ' ') ?? ''}）` +
                        (data.rate?.remaining !== null && data.rate?.remaining !== undefined
                          ? ` · API 剩余配额 ${data.rate.remaining}/${data.rate.limit ?? '?'}`
                          : '') +
                        ' · 安装命令中的 profile 为当前检测到的 profile，可按需替换。',
                    )
                  : null,
              )
            : null,
          tab === 'installed'
            ? h(
                'section',
                { className: 'gs-section' },
                h(
                  'div',
                  { className: 'gs-result-head' },
                  h(
                    'div',
                    { className: 'gs-result-title' },
                    '本机已安装插件',
                    h('span', { className: 'gs-muted' }, ` ${community.length} 个` + (profile !== null ? ` · profile ${profile}` : '')),
                  ),
                  h(
                    'button',
                    { className: 'gs-btn gs-btn-ghost', type: 'button', disabled: installedLoading, onClick: () => void loadInstalled() },
                    installedLoading ? '读取中…' : '刷新',
                  ),
                ),
                installedError !== null
                  ? h(
                      'div',
                      { className: 'gs-error' },
                      h('div', { className: 'gs-error-title' }, '读取已安装插件失败'),
                      h('p', { className: 'gs-error-text' }, installedError),
                    )
                  : null,
                community.length > 0
                  ? h(
                      'ul',
                      { className: 'gs-inst-list' },
                      community.map((plugin) => h(InstalledRow, { key: plugin.name, plugin, onOpen: openRepo })),
                    )
                  : !installedLoading && installedError === null
                    ? h(EmptyState, { title: '没有社区插件', hint: '当前 profile 里只有 DSH 内置包。' })
                    : null,
                builtins.length > 0
                  ? h(
                      'details',
                      { className: 'gs-builtin' },
                      h('summary', null, `DSH 内置包（${builtins.length}）`),
                      h(
                        'ul',
                        { className: 'gs-inst-list' },
                        builtins.map((plugin) => h(InstalledRow, { key: plugin.name, plugin, onOpen: openRepo })),
                      ),
                    )
                  : null,
                h(
                  'p',
                  { className: 'gs-foot' },
                  '数据来自本机 profile 的 package.json 与 node_modules 包信息；「已安装」标记与 GitHub 检索结果按包名匹配。',
                ),
              )
            : null,
        ),
      )
    }

    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error !== null) {
          return h(
            'div',
            { className: 'gs-page' },
            h('style', null, CSS),
            h(
              'div',
              { className: 'gs-empty' },
              h('div', { className: 'gs-empty-title' }, '面板渲染失败'),
              h('div', { className: 'gs-empty-hint' }, String(this.state.error?.message ?? this.state.error)),
            ),
          )
        }
        return this.props.children
      }
    }

    function PanelRoot(props) {
      return h(Boundary, null, h(App, props))
    }

    function SidebarIcon(props) {
      const size = Number(props?.size) || 20
      const active = props?.active === true
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', opacity: active ? 1 : 0.82 },
        },
        h('circle', { cx: 10.2, cy: 10.2, r: 6.2 }),
        h('path', { d: 'M15.1 15.1 21 21' }),
        h('path', { d: 'M8.2 10.2h4' }),
        h('path', { d: 'M10.2 8.2v4' }),
      )
    }

    /* ------------------------------------------------------------------ */
    /* 样式（只使用主题 token）                                             */
    /* ------------------------------------------------------------------ */

    const CSS = `
.gs-page{height:100%;overflow-y:auto;overflow-x:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);}
.gs-inner{max-width:1100px;margin:0 auto;padding:22px 30px 60px;display:flex;flex-direction:column;gap:13px;box-sizing:border-box;}
.gs-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;padding:2px 2px 0;}
.gs-hero-main{min-width:0;flex:1 1 420px;}
.gs-title{display:flex;align-items:center;gap:9px;margin:0;font-size:20px;font-weight:600;letter-spacing:.01em;}
.gs-title-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);}
.gs-sub{margin:7px 0 0;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);max-width:78ch;}
.gs-hero-side{display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;}
.gs-kpi{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.gs-kpi b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;}
.gs-search{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.gs-search-box{position:relative;display:flex;align-items:center;gap:8px;flex:1 1 300px;min-width:0;height:38px;padding:0 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);box-sizing:border-box;transition:border-color .12s ease,box-shadow .12s ease;}
.gs-search-box:focus-within{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);}
.gs-input{flex:1 1 auto;min-width:0;height:100%;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;}
.gs-input::placeholder{color:var(--dsw-alias-label-secondary);}
.gs-input:disabled{opacity:.65;}
.gs-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;padding:0 15px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;line-height:1;cursor:pointer;text-decoration:none;white-space:nowrap;box-sizing:border-box;transition:background .12s ease,border-color .12s ease,opacity .12s ease;}
.gs-btn:hover{background:var(--dsw-alias-bg-layer-2);}
.gs-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.gs-btn:disabled{opacity:.55;cursor:default;}
.gs-btn-primary{height:38px;padding:0 20px;border-color:transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);font-weight:600;}
.gs-btn-primary:hover{background:var(--dsw-alias-label-primary);opacity:.88;}
.gs-btn-ghost{height:28px;padding:0 11px;font-size:12px;}
.gs-examples{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}
.gs-examples-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.gs-notice{display:flex;align-items:center;gap:8px;padding:7px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--dsw-alias-border-l1));border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1));font-size:12px;color:var(--dsw-alias-label-primary);animation:gs-fade .18s ease;}
@keyframes gs-fade{from{opacity:0}to{opacity:1}}
.gs-btn-open{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,var(--dsw-alias-border-l1));}
.gs-chips{display:flex;flex-wrap:wrap;gap:6px;}
.gs-chip{display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-primary);white-space:nowrap;}
.gs-chip-btn{cursor:pointer;font-family:inherit;transition:background .12s ease;}
.gs-chip-btn:hover{background:var(--dsw-alias-bg-layer-2);}
.gs-chip-btn:disabled{opacity:.55;cursor:default;}
.gs-chip-all{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 42%,var(--dsw-alias-border-l1));}
.gs-tabs{display:flex;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:0;}
.gs-tab{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border:none;border-bottom:2px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;cursor:pointer;transition:color .12s ease,border-color .12s ease;}
.gs-tab:hover{color:var(--dsw-alias-label-primary);}
.gs-tab.is-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600;}
.gs-tab-num{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:999px;padding:1px 6px;}
.gs-section{display:flex;flex-direction:column;gap:10px;min-height:240px;}
.gs-ai{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;}
.gs-ai-head{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;flex-wrap:wrap;}
.gs-ai-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none;}
.gs-ai-dot.is-on{background:var(--dsw-alias-brand-primary);}
.gs-ai-stats{margin-left:auto;font-weight:400;font-size:11.5px;}
.gs-ai-line{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;}
.gs-ai-label{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);padding-top:3px;}
.gs-query{display:inline-flex;padding:3px 8px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-all;}
.gs-ai-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}
.gs-ai-note .gs-ai-label{margin-right:6px;padding-top:0;}
.gs-ai-error{margin:0;font-size:11.5px;color:var(--dsw-alias-state-warn-primary);}
.gs-result-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:2px;}
.gs-result-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.gs-result-actions{display:flex;gap:6px;}
.gs-muted{color:var(--dsw-alias-label-secondary);font-weight:400;font-size:11.5px;}
.gs-repos{display:flex;flex-direction:column;gap:8px;}
.gs-group-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-top:2px;padding:0 2px;}
.gs-group-title{font-size:12.5px;font-weight:650;color:var(--dsw-alias-label-primary);}
.gs-repo{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;display:flex;flex-direction:column;gap:7px;min-width:0;box-sizing:border-box;transition:border-color .12s ease;}
.gs-repo:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,var(--dsw-alias-border-l1));}
.gs-repo.is-installed{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,var(--dsw-alias-border-l1));}
.gs-repo-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.gs-repo-id{min-width:0;display:flex;flex-direction:column;gap:5px;}
.gs-repo-name{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gs-repo-name:hover{color:var(--dsw-alias-brand-primary);}
.gs-badges{display:flex;flex-wrap:wrap;gap:4px;}
.gs-badge{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;white-space:nowrap;}
.gs-badge.is-ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,var(--dsw-alias-bg-layer-2));}
.gs-badge.is-ai{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2));}
.gs-badge.is-warn{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,var(--dsw-alias-bg-layer-2));}
.gs-repo-star{display:inline-flex;align-items:center;gap:4px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.gs-repo-desc{margin:0;font-size:12.5px;line-height:1.62;color:var(--dsw-alias-label-primary);word-break:break-word;}
.gs-repo-reason{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}
.gs-reason-tag{display:inline-flex;align-items:center;height:16px;padding:0 6px;margin-right:6px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);font-size:10px;font-weight:600;}
.gs-repo-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;}
.gs-topics{display:flex;flex-wrap:wrap;gap:4px;}
.gs-topic{display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);font-size:10.5px;color:var(--dsw-alias-label-secondary);}
.gs-updated{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.gs-repo-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:2px;}
.gs-install{flex:1 1 240px;min-width:0;padding:5px 9px;border-radius:7px;background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.gs-empty{min-height:260px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;box-sizing:border-box;}
.gs-empty-icon{display:grid;place-items:center;width:54px;height:54px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);margin-bottom:2px;}
.gs-empty-title{font-size:14px;font-weight:600;}
.gs-empty-hint{max-width:70ch;font-size:12px;line-height:1.7;text-align:center;color:var(--dsw-alias-label-secondary);}
.gs-loading{display:flex;align-items:center;gap:10px;padding:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);font-size:12.5px;color:var(--dsw-alias-label-secondary);}
.gs-spinner{width:16px;height:16px;border-radius:50%;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-brand-primary);animation:gs-spin .8s linear infinite;flex:none;}
@keyframes gs-spin{to{transform:rotate(360deg)}}
.gs-error{border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;box-sizing:border-box;}
.gs-error-title{font-size:13px;font-weight:650;color:var(--dsw-alias-state-error-primary);}
.gs-error-text{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-primary);word-break:break-word;}
.gs-warn{margin:0;padding-left:16px;font-size:11.5px;line-height:1.65;color:var(--dsw-alias-state-warn-primary);}
.gs-inst-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;}
.gs-inst-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);box-sizing:border-box;}
.gs-inst-row:last-child{border-bottom:none;}
.gs-inst-main{min-width:0;display:flex;flex-direction:column;gap:3px;}
.gs-inst-name-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.gs-inst-name{font-size:12.5px;font-weight:600;word-break:break-all;}
.gs-inst-desc{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;}
.gs-inst-side{flex:none;display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-secondary);}
.gs-mini-link{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:11px;}
.gs-mini-link:hover{text-decoration:underline;}
.gs-builtin{margin-top:2px;}
.gs-builtin summary{cursor:pointer;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding:6px 2px;}
.gs-foot{margin:4px 0 0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-secondary);}
@media (max-width:720px){
  .gs-inner{padding:16px 14px 44px;}
  .gs-hero-side{justify-content:flex-start;}
  .gs-ai-stats{margin-left:0;width:100%;}
  .gs-install{flex-basis:100%;}
}
@media (prefers-reduced-motion:reduce){
  .gs-spinner{animation:none;}
}
`

    /* ------------------------------------------------------------------ */
    /* 注册                                                                */
    /* ------------------------------------------------------------------ */

    return {
      inject: ['slots'],
      apply(ctx) {
        moduleCtx = ctx
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelRoot),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 41, label: () => 'GitHub源' },
            SidebarIcon,
          ),
        )
      },
      // 仅供 test/*.mjs 做渲染与注册自测，运行时忽略。
      __test: {
        PanelRoot,
        App,
        RepoCard,
        InstalledRow,
        SidebarIcon,
        AiPanel,
        CSS,
        openInternal,
        sessionIdFrom,
        partitionItems,
        setModuleCtx: (value) => {
          moduleCtx = value
        },
      },
    }
  },
})
