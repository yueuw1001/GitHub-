/**
 * GitHub源（Host half）
 *
 * 一次查询的流程：
 *   1. AI 规划：把用户的中文/口语化需求（如「浏览器自动化」）扩展成 GitHub 能命中的
 *      英文关键词与仓库搜索表达式（`ctx.llm`，使用对话默认模型；不可用时退回内置词典）；
 *   2. GitHub 检索：对 1~3 条查询调用 `api.github.com/search/repositories`，
 *      合并去重后按「DSH 相关性 + 关键词命中 + 星标 + 最近更新」打分；
 *   3. AI 复排：把候选（前 40 个）交给模型排序并给每个结果一句中文匹配理由；
 *   4. 本机已安装插件：扫描 `~/.dsh/profiles/<profile>/package.json`，给结果打「已安装」标记，
 *      同时单独提供「全部已安装插件」清单。
 *
 * 对外提供：
 *   GET /dsh-github-source/search.json?q=浏览器自动化[&refresh=1][&limit=60]
 *   GET /dsh-github-source/installed.json
 *
 * 只读、无凭据依赖；若环境变量里配置了 GITHUB_TOKEN 会自动带上以提高速率上限。
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SEARCH_PATH = '/dsh-github-source/search.json'
const INSTALLED_PATH = '/dsh-github-source/installed.json'

const GITHUB_API = 'https://api.github.com/search/repositories'
const USER_AGENT = 'dsh-github-source/1.0'
const CACHE_TTL_MS = 5 * 60 * 1000
const SEARCH_TIMEOUT_MS = 15000
const AI_TIMEOUT_MS = 25000
const DEFAULT_LIMIT = 60
const MAX_LIMIT = 100
const MAX_QUERIES = 3
const AI_RERANK_POOL = 24
const REASONING_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const ENRICH_LIMIT = 15
const RAW_TIMEOUT_MS = 8000
const RATE_WINDOW_MS = 60 * 1000
const RATE_MAX = 12
const AI_WEB_RESULTS = 10
const AI_WEB_TIMEOUT_MS = 25000

/** github.com 的这些一级路径不是仓库。 */
const RESERVED_GITHUB_OWNERS = new Set([
  'about', 'account', 'apps', 'blog', 'codespaces', 'collections', 'contact', 'dashboard',
  'explore', 'features', 'issues', 'login', 'marketplace', 'new', 'notifications', 'orgs',
  'pricing', 'pulls', 'readme', 'search', 'security', 'settings', 'signup', 'site',
  'sponsors', 'topics', 'trending', 'users',
])

const EXAMPLE_CHIPS = ['浏览器自动化', 'dsh-builtin-browser', '语音输入', '插件市场', '股票行情', 'MCP']
const BUILD = 'github-source/1.0.0+20261025f'

/** 中文需求 -> 英文关键词：AI 不可用时的兜底词典（按最长匹配优先）。 */
const ZH_TERMS = [
  ['浏览器', 'browser automation playwright'],
  ['网页', 'web page automation'],
  ['截图', 'screenshot'],
  ['语音', 'voice speech'],
  ['朗读', 'speech tts'],
  ['翻译', 'translation translator'],
  ['股票', 'stock market'],
  ['行情', 'market quotes'],
  ['基金', 'fund etf'],
  ['新闻', 'news'],
  ['搜索', 'web search'],
  ['记忆', 'memory'],
  ['笔记', 'notes'],
  ['知识库', 'knowledge base'],
  ['文档', 'document'],
  ['办公', 'office docx xlsx pptx'],
  ['表格', 'spreadsheet excel'],
  ['幻灯', 'slides presentation'],
  ['图片', 'image picture'],
  ['绘图', 'drawing diagram'],
  ['图表', 'chart'],
  ['视频', 'video'],
  ['音频', 'audio'],
  ['音乐', 'music'],
  ['终端', 'terminal shell'],
  ['命令行', 'cli command'],
  ['文件', 'file'],
  ['代码', 'code'],
  ['数据库', 'database sql'],
  ['通知', 'notification'],
  ['邮件', 'email'],
  ['日历', 'calendar'],
  ['天气', 'weather'],
  ['地图', 'map'],
  ['办公自动化', 'office automation'],
  ['插件市场', 'plugin market marketplace'],
  ['主题', 'theme'],
  ['侧边栏', 'sidebar'],
  ['工作流', 'workflow'],
  ['定时', 'schedule cron'],
  ['多智能体', 'multi agent team'],
  ['智能体', 'agent'],
  ['模型', 'model llm'],
  ['上下文', 'context'],
  ['压缩', 'compaction'],
  ['费用', 'cost billing usage'],
  ['余额', 'balance'],
  ['爬虫', 'crawler scrape'],
  ['自动化', 'automation'],
  ['微信', 'wechat'],
  ['飞书', 'feishu lark'],
  ['钉钉', 'dingtalk'],
  ['手机', 'phone mobile'],
  ['远程', 'remote'],
  ['部署', 'deploy'],
  ['测试', 'test'],
  ['监控', 'monitor'],
  ['日志', 'log'],
]

const state = {
  cache: new Map(),
  installedCache: null,
  hits: [],
  lastError: null,
  /** AI 直搜已确认可用的通道：'web' | 'account'（成功一次后优先复用）。 */
  searchMode: null,
}

const INSTALLED_TTL_MS = 60 * 1000

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload, method = 'GET') {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(method === 'HEAD' ? undefined : body)
}

function errorText(error) {
  if (error === null || error === undefined) return '未知错误'
  if (error instanceof Error) return error.message || String(error)
  return String(error)
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function rateLimitHit() {
  const now = Date.now()
  state.hits = state.hits.filter((at) => now - at < RATE_WINDOW_MS)
  if (state.hits.length >= RATE_MAX) return false
  state.hits.push(now)
  return true
}

/* ------------------------------------------------------------------ */
/* 本机 profile / 已安装插件                                            */
/* ------------------------------------------------------------------ */

function dshHome() {
  const configured = (process.env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

/** 读一个包目录的 package.json（失败返回 null）。 */
async function readPackageJson(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function repoUrlOf(pkg) {
  const repository = pkg?.repository
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const cleaned = raw
    .trim()
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/\.git$/, '')
  return /^https?:\/\//.test(cleaned) ? cleaned : null
}

/** `https://github.com/owner/repo` -> `owner/repo`（小写）；非 GitHub 返回 null。 */
function repoSlug(url) {
  if (typeof url !== 'string') return null
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/?#]+)/i.exec(url)
  if (match === null) return null
  return `${match[1]}/${match[2]}`.toLowerCase()
}

/**
 * 扫描所有 profile，汇总已安装插件（去重，按 profile 归并）。
 * @returns {Promise<{profiles: string[], activeProfile: string|null, plugins: object[]}>}
 */
async function readInstalled() {
  const profilesRoot = join(dshHome(), 'profiles')
  const entries = await readdir(profilesRoot, { withFileTypes: true }).catch(() => [])
  const profiles = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(profilesRoot, entry.name)
    const pkg = await readPackageJson(dir)
    if (pkg === null) continue
    profiles.push({ name: entry.name, dir, pkg })
  }
  profiles.sort(
    (left, right) =>
      (right.pkg?.dsh?.profile?.bundles?.length ?? 0) - (left.pkg?.dsh?.profile?.bundles?.length ?? 0),
  )
  const activeProfile = profiles[0]?.name ?? null

  const map = new Map()
  for (const profile of profiles) {
    const dependencies = profile.pkg?.dependencies ?? {}
    const bundles = Array.isArray(profile.pkg?.dsh?.profile?.bundles) ? profile.pkg.dsh.profile.bundles : []
    const names = new Set([...Object.keys(dependencies), ...bundles])
    for (const name of names) {
      const builtin = name.startsWith('@deepseek-ai/')
      const spec = typeof dependencies[name] === 'string' ? dependencies[name] : ''
      let existing = map.get(name)
      if (existing === undefined) {
        existing = {
          name,
          builtin,
          spec,
          profiles: [],
          version: null,
          description: '',
          repo: null,
        }
        map.set(name, existing)
      }
      if (!existing.profiles.includes(profile.name)) existing.profiles.push(profile.name)
      if (existing.spec === '' && spec !== '') existing.spec = spec
    }
  }

  // 读每个包自己的 package.json，补版本 / 描述 / 仓库地址。
  const activeDir = profiles[0]?.dir ?? null
  const plugins = [...map.values()]
  await Promise.all(
    plugins.map(async (plugin) => {
      for (const profile of profiles) {
        const pkg = await readPackageJson(join(profile.dir, 'node_modules', plugin.name))
        if (pkg === null) continue
        plugin.version = typeof pkg.version === 'string' ? pkg.version : plugin.version
        plugin.description = typeof pkg.description === 'string' ? pkg.description : plugin.description
        plugin.repo = repoUrlOf(pkg) ?? plugin.repo
        break
      }
      plugin.local = typeof plugin.spec === 'string' && plugin.spec.startsWith('link:')
      plugin.inActiveProfile = activeDir !== null && plugin.profiles.includes(profiles[0].name)
    }),
  )

  plugins.sort((left, right) => {
    if (left.builtin !== right.builtin) return left.builtin ? 1 : -1
    return left.name.localeCompare(right.name)
  })

  return {
    profiles: profiles.map((profile) => profile.name),
    activeProfile,
    plugins,
  }
}

/** 带 60 秒缓存的 readInstalled（每次检索都要用，磁盘扫描不该重复）。 */
async function readInstalledCached(force = false) {
  if (!force && state.installedCache !== null && Date.now() - state.installedCache.at < INSTALLED_TTL_MS) {
    return state.installedCache.value
  }
  const value = await readInstalled()
  state.installedCache = { at: Date.now(), value }
  return value
}

/* ------------------------------------------------------------------ */
/* AI（失败即降级，绝不阻断检索）                                        */
/* ------------------------------------------------------------------ */

function defaultRoute(ctx) {
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection === null || typeof selection !== 'object') return null
    const provider = typeof selection.provider === 'string' ? selection.provider : ''
    const model = typeof selection.model === 'string' ? selection.model : ''
    if (provider === '' || model === '') return null
    return { provider, model }
  } catch {
    return null
  }
}

/** 一次生成的最小思考档位：插件检索/复排只需要短输出，别把预算烧在思考上。 */
async function lowestReasoningEffort(llm, route) {
  if (llm === null || typeof llm.resolveModelInfo !== 'function') return undefined
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const efforts = info?.reasoning?.efforts
    if (!Array.isArray(efforts)) return undefined
    const ids = efforts
      .map((entry) => (entry !== null && typeof entry === 'object' ? entry.id : undefined))
      .filter((id) => typeof id === 'string' && id !== '')
    let best
    let bestRank = Number.POSITIVE_INFINITY
    for (const id of ids) {
      const rank = REASONING_ORDER.indexOf(id)
      if (rank < 0) continue
      if (rank < bestRank) {
        best = id
        bestRank = rank
      }
    }
    return best ?? ids[0]
  } catch {
    return undefined
  }
}

/** 用宿主 LLM 服务跑一次一次性生成，返回纯文本。 */
async function generate(ctx, { system, user, maxTokens = 700 }) {
  const llm = ctx.get('llm')
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    throw new Error('宿主 LLM 服务不可用')
  }
  const route = defaultRoute(ctx)
  if (route === null) throw new Error('没有可用的默认模型')
  const effort = await lowestReasoningEffort(llm, route)
  let text = ''
  const stream = llm.stream({
    provider: route.provider,
    model: route.model,
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    system,
    maxTokens,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    signal: AbortSignal.timeout(AI_TIMEOUT_MS),
  })
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text.trim()
}

/** 从模型输出里抠出第一个完整 JSON 对象。 */
function parseJsonLoose(text) {
  if (typeof text !== 'string') return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  const slice = text.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch {
    return null
  }
}

const PLAN_SYSTEM = [
  '你是 DSH（DeepSeek Harness）插件检索助手。',
  'DSH 插件是 npm 包，仓库通常带有 dsh-plugin / deepseek-harness 主题，或描述里出现 dsh / DeepSeek Harness。',
  '用户会用中文描述「需要什么功能的插件」，或直接给出插件名。',
  '你的任务：把需求改写成 2~3 条 GitHub 仓库搜索表达式（q 参数），让 api.github.com/search/repositories 能命中相关 DSH 插件。',
  '规则：',
  '1. 关键词用英文（中文词在 GitHub 上几乎搜不到）；插件名/包名原样保留。',
  '2. 每条表达式都要带一个 DSH 锚点（如 dsh、deepseek harness、dsh-plugin），再加 1~3 个功能词。',
  '3. 可用限定符：in:name,description,topics、topic:dsh-plugin；不要用引号、不要用 sort。',
  '4. 输出严格 JSON，不要代码块、不要解释：',
  '{"keywords":["英文关键词"],"queries":["检索表达式"],"reason":"一句话说明你怎么理解需求"}',
].join('\n')

async function aiPlan(ctx, query) {
  const user = `用户想找的插件需求：「${query}」。请给出检索计划。`
  const text = await generate(ctx, { system: PLAN_SYSTEM, user, maxTokens: 600 })
  const parsed = parseJsonLoose(text)
  if (parsed === null) throw new Error('AI 返回的不是 JSON')
  const keywords = Array.isArray(parsed.keywords)
    ? parsed.keywords.filter((item) => typeof item === 'string' && item.trim() !== '').slice(0, 8)
    : []
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries
        .filter((item) => typeof item === 'string' && item.trim() !== '')
        .map((item) => item.replace(/["'\r\n]/g, ' ').replace(/\s+/g, ' ').trim())
        .filter((item) => item.length >= 3 && item.length <= 160)
        .slice(0, MAX_QUERIES)
    : []
  if (queries.length === 0) throw new Error('AI 没有给出可用的检索表达式')
  return {
    keywords,
    queries,
    reason: typeof parsed.reason === 'string' ? parsed.reason.trim().slice(0, 200) : '',
  }
}

const RERANK_SYSTEM = [
  '你是 DSH（DeepSeek Harness）插件筛选助手。',
  '输入是用户在 GitHub 上搜索插件得到的一批候选仓库（JSON 数组）。',
  '请按「与用户需求的相关程度」给 fullName 排序，并给每个仓库一句不超过 40 字的中文理由，说明它能满足什么需求、或为什么不太相关。',
  '只保留真正与 DSH 插件相关的仓库；明显不是 DSH 插件的，理由写「疑似非 DSH 插件」，排在最后。',
  '输出严格 JSON，不要代码块：',
  '{"order":["owner/repo"],"reasons":{"owner/repo":"理由"},"note":"一句话总评"}',
].join('\n')

async function aiRerank(ctx, query, candidates) {
  const attempts = [
    { pool: Math.min(AI_RERANK_POOL, candidates.length), desc: 140, maxTokens: 3000 },
    { pool: Math.min(10, candidates.length), desc: 90, maxTokens: 1600 },
  ]
  let lastError = new Error('AI 复排失败')
  for (const attempt of attempts) {
    try {
      const payload = candidates.slice(0, attempt.pool).map((item) => ({
        fullName: item.fullName,
        description: item.description.slice(0, attempt.desc),
        topics: item.topics.slice(0, 6),
        stars: item.stars,
      }))
      const text = await generate(ctx, {
        system: RERANK_SYSTEM,
        user: `用户需求：「${query}」\n候选：${JSON.stringify(payload)}`,
        maxTokens: attempt.maxTokens,
      })
      const parsed = parseJsonLoose(text)
      if (parsed === null) throw new Error('AI 复排返回的不是 JSON（可能被截断）')
      const order = Array.isArray(parsed.order)
        ? parsed.order.filter((item) => typeof item === 'string' && item.trim() !== '')
        : []
      const reasons = {}
      if (parsed.reasons !== null && typeof parsed.reasons === 'object' && !Array.isArray(parsed.reasons)) {
        for (const [key, value] of Object.entries(parsed.reasons)) {
          if (typeof value === 'string' && value.trim() !== '') reasons[key] = value.trim().slice(0, 120)
        }
      }
      if (order.length === 0) throw new Error('AI 复排没有给出顺序')
      return {
        order,
        reasons,
        note: typeof parsed.note === 'string' ? parsed.note.trim().slice(0, 300) : '',
      }
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/* ------------------------------------------------------------------ */
/* 检索词与打分                                                         */
/* ------------------------------------------------------------------ */

function splitTerms(query) {
  return query
    .replace(/[，,、;；/|]+/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
}

/** 内置词典：把中文需求映射成英文关键词。 */
function dictionaryExpand(query) {
  const english = []
  const chineseHits = []
  for (const [zh, en] of ZH_TERMS) {
    if (query.includes(zh)) {
      chineseHits.push(zh)
      for (const word of en.split(/\s+/)) if (!english.includes(word)) english.push(word)
    }
  }
  const ascii = splitTerms(query).filter((term) => /^[\x20-\x7e]+$/.test(term))
  const keywords = [...new Set([...ascii, ...english])].slice(0, 8)
  return { keywords, chineseHits }
}

/** AI 不可用时的检索表达式。 */
function fallbackQueries(query, keywords) {
  const quoted = keywords.slice(0, 3).join(' ')
  const raw = /^[\x20-\x7e\s]+$/.test(query) ? query.trim() : ''
  const anchor = raw !== '' ? raw : quoted
  if (anchor === '') return []
  const queries = []
  queries.push(`${anchor} dsh in:name,description,topics`)
  if (quoted !== '' && quoted !== anchor) queries.push(`${quoted} deepseek harness in:name,description,topics`)
  if (quoted !== '') queries.push(`topic:dsh-plugin ${quoted}`)
  return [...new Set(queries)].slice(0, MAX_QUERIES)
}

function githubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': '2022-11-28',
  }
  const token = (process.env.GITHUB_TOKEN ?? '').trim()
  if (token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

async function githubSearch(query, { perPage = DEFAULT_LIMIT } = {}) {
  const url = new URL(GITHUB_API)
  url.searchParams.set('q', query)
  url.searchParams.set('per_page', String(Math.min(MAX_LIMIT, Math.max(1, perPage))))
  url.searchParams.set('order', 'desc')
  url.searchParams.set('sort', 'stars')
  const response = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  })
  const rate = {
    remaining: response.headers.get('x-ratelimit-remaining'),
    limit: response.headers.get('x-ratelimit-limit'),
    reset: response.headers.get('x-ratelimit-reset'),
    resource: response.headers.get('x-ratelimit-resource'),
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = await response.json()
      detail = typeof body?.message === 'string' ? body.message : ''
    } catch {
      detail = ''
    }
    const error = new Error(
      `GitHub 搜索失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
    )
    error.status = response.status
    error.rate = rate
    throw error
  }
  const body = await response.json()
  const items = Array.isArray(body?.items) ? body.items : []
  return {
    items,
    totalCount: Number.isFinite(body?.total_count) ? body.total_count : items.length,
    rate,
  }
}

function normalizeRepo(item) {
  const topics = Array.isArray(item.topics)
    ? item.topics.filter((topic) => typeof topic === 'string').slice(0, 10)
    : []
  const description = typeof item.description === 'string' ? item.description : ''
  const name = typeof item.name === 'string' ? item.name : ''
  const owner = typeof item.owner?.login === 'string' ? item.owner.login : ''
  const fullName = typeof item.full_name === 'string' ? item.full_name : `${owner}/${name}`
  const haystack = `${fullName} ${description} ${topics.join(' ')}`.toLowerCase()
  return {
    fullName,
    name,
    owner,
    url: typeof item.html_url === 'string' ? item.html_url : `https://github.com/${fullName}`,
    description,
    stars: Number.isFinite(item.stargazers_count) ? item.stargazers_count : 0,
    forks: Number.isFinite(item.forks_count) ? item.forks_count : 0,
    language: typeof item.language === 'string' ? item.language : null,
    license: typeof item.license?.spdx_id === 'string' ? item.license.spdx_id : null,
    updatedAt: typeof item.pushed_at === 'string' ? item.pushed_at : null,
    archived: item.archived === true,
    topics,
    suspect: !/dsh|deepseek/.test(haystack),
  }
}

function scoreRepo(repo, tokens, aiOrder, aiReasons) {
  const haystack = `${repo.fullName} ${repo.description} ${repo.topics.join(' ')}`.toLowerCase()
  let score = 0
  for (const token of tokens) {
    const needle = token.toLowerCase().trim()
    if (needle.length < 2) continue
    if (haystack.includes(needle)) score += 2.2
  }
  if (repo.topics.some((topic) => topic === 'dsh-plugin' || topic === 'dsh-plugins')) score += 3
  if (repo.topics.includes('deepseek-harness') || repo.topics.includes('deepseek-harness-plugin')) score += 2.5
  if (/dsh/i.test(repo.name)) score += 2
  if (/deepseek[\s-]?harness|dsh\s*plugin/i.test(repo.description)) score += 2.5
  if (repo.dshVerified === true) score += 2
  score += Math.log10(Math.max(0, repo.stars) + 1)
  const updatedAt = repo.updatedAt === null ? Number.NaN : Date.parse(repo.updatedAt)
  if (Number.isFinite(updatedAt)) {
    const days = (Date.now() - updatedAt) / 86400000
    if (days < 30) score += 1.6
    else if (days < 120) score += 0.8
    else if (days > 730) score -= 0.8
  }
  if (repo.archived) score -= 3
  if (repo.suspect) score -= 2.5
  if (repo.aiDirect === true) score += 3.4
  if (aiOrder.has(repo.fullName)) score += Math.max(0, 6 - aiOrder.get(repo.fullName) * 0.35)
  repo.reason = aiReasons[repo.fullName] ?? ''
  return Math.round(score * 100) / 100
}

/**
 * 读仓库根目录的 package.json（raw.githubusercontent，不计入 GitHub API 配额）：
 * 拿到真实包名（安装命令不能猜）、版本，以及 `dsh` 字段（最硬的“这是 DSH 插件”证据）。
 * 只对展示出来的前若干个结果做，失败就跳过。
 */
async function enrichPackages(items) {
  const targets = items.slice(0, ENRICH_LIMIT)
  await Promise.all(
    targets.map(async (repo) => {
      try {
        const url = `https://raw.githubusercontent.com/${repo.fullName}/HEAD/package.json`
        const response = await fetch(url, {
          headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
          signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
        })
        if (!response.ok) return
        const pkg = await response.json()
        if (typeof pkg?.name === 'string' && pkg.name.trim() !== '') repo.packageName = pkg.name.trim()
        if (typeof pkg?.version === 'string' && pkg.version.trim() !== '') repo.version = pkg.version.trim()
        repo.dshVerified = pkg?.dsh !== undefined && pkg?.dsh !== null
        repo.dshClient = pkg?.dsh?.client !== undefined
        repo.dshBundle = pkg?.dsh?.bundle !== undefined
        if (repo.description === '' && typeof pkg?.description === 'string') repo.description = pkg.description
        if (repo.suspect && repo.dshVerified) repo.suspect = false
      } catch {
        /* package.json 拉不到就保留猜测 */
      }
    }),
  )
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

function installCommands(repo, profile) {
  const target = profile === null ? '<profile>' : profile
  const packageName =
    typeof repo.packageName === 'string' && repo.packageName.trim() !== ''
      ? repo.packageName.trim()
      : repo.installedPackageName ?? null
  const npm = packageName === null ? null : `dsh plugin --profile ${target} add ${packageName}`
  const github = `dsh plugin --profile ${target} add github:${repo.fullName}`
  // 没读到 package.json 时包名只能猜（仓库名 ≠ 包名，比如 dsh-browser → dsh-builtin-browser），
  // 所以宁可用 github: 形式的确定性命令。
  return { primary: npm ?? github, npm, github }
}

/** 从网页搜索结果里认出 GitHub 仓库地址。 */
function githubSlugFromUrl(url) {
  if (typeof url !== 'string' || url === '') return null
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return null
    const parts = parsed.pathname.split('/').filter((part) => part !== '')
    if (parts.length < 2) return null
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/, '')
    if (RESERVED_GITHUB_OWNERS.has(owner.toLowerCase())) return null
    if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null
    return { owner, repo, fullName: `${owner}/${repo}` }
  } catch {
    return null
  }
}

/** 两条自然语言查询并发跑一次搜索，并抽取 GitHub 仓库线索。 */
async function runWebQueries(searchFn, query) {
  const queries = [
    `DeepSeek Harness DSH 插件 ${query} github`,
    `dsh-plugin ${query} github`,
  ]
  const settled = await Promise.allSettled(
    queries.map((item) => Promise.resolve().then(() => searchFn(item, AbortSignal.timeout(AI_WEB_TIMEOUT_MS)))),
  )
  const hints = new Map()
  const errors = []
  let content = ''
  for (const result of settled) {
    if (result.status === 'rejected') {
      errors.push(errorText(result.reason))
      continue
    }
    if (content === '' && typeof result.value?.content === 'string') content = result.value.content.slice(0, 1200)
    const sources = Array.isArray(result.value?.sources) ? result.value.sources : []
    for (const source of sources) {
      const slug = githubSlugFromUrl(source?.url)
      if (slug === null) continue
      const key = slug.fullName.toLowerCase()
      if (hints.has(key)) continue
      hints.set(key, {
        fullName: slug.fullName,
        url: `https://github.com/${slug.fullName}`,
        title: typeof source.title === 'string' ? source.title : '',
        snippet: typeof source.snippet === 'string' ? source.snippet : '',
      })
    }
  }
  if (hints.size === 0 && errors.length === settled.length) {
    throw new Error(errors[0] ?? '网页搜索失败')
  }
  return { hints: [...hints.values()], content, errors, queries }
}

/** 把 Anthropic Messages 响应里的 web_search 结果映射成 `{sources, content}`。 */
function mapSearchResponse(response) {
  const blocks = Array.isArray(response?.content) ? response.content : []
  const snippets = new Map()
  const texts = []
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    if (typeof block.text === 'string' && block.text.trim() !== '') texts.push(block.text.trim())
    for (const cite of Array.isArray(block.citations) ? block.citations : []) {
      if (typeof cite?.url === 'string' && typeof cite?.cited_text === 'string' && !snippets.has(cite.url)) {
        snippets.set(cite.url, cite.cited_text)
      }
    }
  }
  const sources = []
  const seen = new Set()
  for (const block of blocks) {
    if (block?.type !== 'web_search_tool_result') continue
    for (const item of Array.isArray(block.content) ? block.content : []) {
      if (item?.type !== 'web_search_result' || typeof item.url !== 'string' || item.url === '') continue
      if (seen.has(item.url)) continue
      seen.add(item.url)
      sources.push({
        url: item.url,
        title: typeof item.title === 'string' ? item.title : undefined,
        snippet: snippets.get(item.url),
        publishedAt: typeof item.page_age === 'string' ? item.page_age : undefined,
      })
    }
  }
  return { sources, content: texts.join('\n').slice(0, 1200) }
}

/**
 * 用 DeepSeek 账号令牌直连 Messages API 的 web_search 工具。
 * 宿主自带的 ctx.web 走 `DEEPSEEK_API_KEY`（本机这把 key 已失效，会 401），
 * 但对话在用的 deepseek-account 令牌仍然可用，所以这里作为第二级兜底。
 */
async function accountSearchOnce(ctx, query, signal) {
  const account = ctx.get('deepseekAccount')
  if (account === undefined || account === null || typeof account.resolveToken !== 'function') {
    throw new Error('宿主没有 DeepSeek 账号服务（deepseekAccount 不可用）')
  }
  const base = (process.env.DEEPSEEK_SEARCH_BASE_URL || 'https://api.deepseek.com/anthropic/v1').replace(/\/+$/, '')
  const endpoint = `${base}/messages`
  const token = await account.resolveToken(endpoint)
  if (typeof token !== 'string' || token === '') throw new Error('DeepSeek 账号没有可用的搜索令牌')
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      'x-dsh-auth-token': token,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
      accept: 'application/json',
      'user-agent': USER_AGENT,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      max_tokens: 4096,
      messages: [
        { role: 'user', content: [{ type: 'text', text: `Perform a web search for the query: ${query}` }] },
      ],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      thinking: { type: 'disabled' },
    }),
    signal,
  })
  if (!response.ok) {
    let detail = ''
    try {
      const parsed = await response.json()
      detail = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message ?? parsed?.message ?? ''
    } catch {
      detail = ''
    }
    throw new Error(`账号直搜失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`)
  }
  return mapSearchResponse(await response.json())
}

/**
 * AI 直接搜索：让 AI（宿主 `ctx.web` 的网页搜索 provider，或 DeepSeek 账号令牌直连
 * web_search 工具）按自然语言直接找插件，再把结果里的 github.com/owner/repo
 * 提取出来参与合并排序。全部失败时抛错，由调用方降级为纯 GitHub 检索。
 */
async function aiWebSearch(ctx, query) {
  const errors = []
  if (state.searchMode !== 'account') {
    const web = ctx.get('web')
    if (web !== undefined && web !== null && typeof web.search === 'function') {
      try {
        const result = await runWebQueries(
          (item, signal) => web.search({ query: item, maxResults: AI_WEB_RESULTS }, signal),
          query,
        )
        state.searchMode = 'web'
        return { ...result, via: 'web' }
      } catch (error) {
        errors.push(`ctx.web：${errorText(error)}`)
      }
    } else {
      errors.push('ctx.web 不可用')
    }
  }
  try {
    const result = await runWebQueries((item, signal) => accountSearchOnce(ctx, item, signal), query)
    state.searchMode = 'account'
    return { ...result, errors: [...result.errors, ...errors], via: 'account' }
  } catch (error) {
    errors.push(`账号直搜：${errorText(error)}`)
    throw new Error(errors.join('；'))
  }
}

async function search(ctx, query, { limit, refresh, installed }) {
  const cacheKey = query.toLowerCase()
  if (!refresh) {
    const cached = state.cache.get(cacheKey)
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) {
      return { ...cached.value, cached: true }
    }
  }

  const dictionary = dictionaryExpand(query)
  const webPromise = aiWebSearch(ctx, query).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: errorText(error) }),
  )
  let ai = {
    enabled: false,
    plan: null,
    rerank: null,
    error: null,
    queries: [],
    keywords: dictionary.keywords,
    note: '',
  }
  let queries = []
  const warnings = []

  try {
    const plan = await aiPlan(ctx, query)
    ai.enabled = true
    ai.plan = plan
    ai.keywords = plan.keywords.length > 0 ? plan.keywords : dictionary.keywords
    ai.note = plan.reason
    queries = plan.queries
  } catch (error) {
    ai.error = errorText(error)
    queries = fallbackQueries(query, dictionary.keywords)
    if (queries.length === 0) {
      queries = [`${query} dsh in:name,description,topics`]
    }
  }
  ai.queries = queries

  // 兜底再补一条「主题检索」，保证不会因为 AI 的表达式太窄而漏掉全网插件。
  if (queries.length < MAX_QUERIES) {
    const extra =
      dictionary.keywords.length > 0
        ? `topic:dsh-plugin ${dictionary.keywords.slice(0, 3).join(' ')}`
        : 'topic:dsh-plugin'
    if (!queries.includes(extra)) queries.push(extra)
  }

  const searched = await Promise.allSettled(
    queries.slice(0, MAX_QUERIES).map((expression) => githubSearch(expression, { perPage: limit })),
  )

  const merged = new Map()
  let totalCount = 0
  let rate = null
  const failures = []
  for (const result of searched) {
    if (result.status === 'rejected') {
      failures.push(errorText(result.reason))
      if (rate === null && result.reason?.rate) rate = result.reason.rate
      continue
    }
    totalCount += result.value.totalCount
    rate = result.value.rate
    for (const item of result.value.items) {
      const repo = normalizeRepo(item)
      if (!merged.has(repo.fullName)) merged.set(repo.fullName, repo)
    }
  }

  if (failures.length > 0 && failures.length < searched.length) {
    warnings.push(`有 ${failures.length} 条检索失败：${failures[0]}`)
  }

  /* ---- AI 直接搜索（网页搜索）命中合并 ---- */
  const webResult = await webPromise
  const webInfo = { enabled: false, via: null, count: 0, error: null, queries: [], content: '', sources: 0 }
  let aiDirectCount = 0
  if (webResult.ok === true) {
    webInfo.enabled = true
    webInfo.via = webResult.value.via ?? null
    webInfo.queries = webResult.value.queries
    webInfo.content = webResult.value.content
    webInfo.sources = webResult.value.hints.length
    if (webResult.value.errors.length > 0) webInfo.error = `部分网页搜索失败：${webResult.value.errors[0]}`
    const known = new Map([...merged.values()].map((repo) => [repo.fullName.toLowerCase(), repo]))
    for (const hint of webResult.value.hints) {
      aiDirectCount += 1
      const existing = known.get(hint.fullName.toLowerCase())
      if (existing !== undefined) {
        existing.aiDirect = true
        if (existing.reason === '') existing.reason = hint.snippet || hint.title
        if (existing.description === '') existing.description = hint.snippet || hint.title
        continue
      }
      const [owner, repoName] = hint.fullName.split('/')
      const skeleton = {
        fullName: hint.fullName,
        name: repoName,
        owner,
        url: hint.url,
        description: (hint.snippet || hint.title || '').slice(0, 400),
        stars: 0,
        forks: 0,
        language: null,
        license: null,
        updatedAt: null,
        archived: false,
        topics: [],
        suspect: false,
        aiDirect: true,
        reason: (hint.snippet || hint.title || '').slice(0, 200),
      }
      merged.set(hint.fullName, skeleton)
      known.set(hint.fullName.toLowerCase(), skeleton)
    }
  } else {
    webInfo.error = webResult.error
  }

  if (failures.length === searched.length && merged.size === 0) {
    const error = new Error(failures[0] ?? 'GitHub 搜索失败')
    error.rate = rate
    throw error
  }
  if (failures.length === searched.length && merged.size > 0) {
    warnings.push('GitHub 搜索全部失败，以下仅来自 AI 直接搜索')
  }

  const tokens = [...new Set([...splitTerms(query), ...ai.keywords])].filter((token) => token.length > 0)
  const aiOrder = new Map()
  const aiReasons = {}
  let rerankPool = [...merged.values()]
  let rerankCount = 0
  if (rerankPool.length > 0) {
    rerankPool.sort((left, right) => scoreRepo(right, tokens, new Map(), {}) - scoreRepo(left, tokens, new Map(), {}))
    const pool = rerankPool.slice(0, AI_RERANK_POOL)
    try {
      const reranked = await aiRerank(ctx, query, pool)
      ai.enabled = true
      ai.rerank = { order: reranked.order, note: reranked.note }
      ai.note = reranked.note !== '' ? reranked.note : ai.note
      rerankCount = reranked.order.length
      reranked.order.forEach((fullName, index) => aiOrder.set(fullName, index))
      Object.assign(aiReasons, reranked.reasons)
    } catch (error) {
      if (ai.error === null) ai.error = `复排未生效：${errorText(error)}`
    }
  }

  for (const repo of merged.values()) {
    repo.score = scoreRepo(repo, tokens, aiOrder, aiReasons)
    repo.installed = installed.has(repo.name) || installed.has(repo.fullName)
  }

  const sorted = [...merged.values()].sort((left, right) => right.score - left.score)
  // AI 直搜是「AI 直接给出的答案」：无论分数排到哪，都先给它们留出名额。
  const direct = sorted.filter((repo) => repo.aiDirect === true)
  const rest = sorted.filter((repo) => repo.aiDirect !== true)
  const reserved = Math.min(direct.length, limit)
  const items = [...direct.slice(0, reserved), ...rest.slice(0, Math.max(0, limit - reserved))]
  items.sort((left, right) => right.score - left.score)

  await enrichPackages(items)
  for (const repo of items) repo.score = scoreRepo(repo, tokens, aiOrder, aiReasons)
  items.sort((left, right) => right.score - left.score)

  const response = {
    ok: true,
    query,
    build: BUILD,
    ai: {
      enabled: ai.enabled,
      error: ai.error,
      note: ai.note,
      keywords: ai.keywords.slice(0, 8),
      queries: ai.queries,
      reranked: rerankCount,
      web: webInfo,
    },
    items,
    stats: {
      candidates: merged.size,
      shown: items.length,
      githubTotal: totalCount,
      installedMatches: items.filter((item) => item.installed).length,
      verified: items.filter((item) => item.dshVerified === true).length,
      aiDirect: aiDirectCount,
      queries: queries.length,
    },
    warnings,
    rate,
    cached: false,
    generatedAt: new Date().toISOString(),
  }

  state.cache.set(cacheKey, { at: Date.now(), value: response })
  return response
}

/* ------------------------------------------------------------------ */
/* 插件本体                                                             */
/* ------------------------------------------------------------------ */

export const name = 'dsh-github-source'
export const inject = ['webServer']

export function apply(ctx) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: SEARCH_PATH,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: '仅支持 GET', items: [] }, method)
          return
        }
        if (!rateLimitHit()) {
          sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试', items: [] }, method)
          return
        }
        try {
          const url = new URL(req.url ?? SEARCH_PATH, 'http://127.0.0.1')
          const query = (url.searchParams.get('q') ?? '').trim().slice(0, 200)
          if (query === '') {
            sendJson(res, 400, { ok: false, error: '请提供 q（功能或插件名）', items: [] }, method)
            return
          }
          const limit = clampInt(url.searchParams.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT)
          const refresh = url.searchParams.get('refresh') === '1'
          const installedInfo = await readInstalledCached()
          const installedRepos = new Map(
            installedInfo.plugins
              .map((plugin) => [repoSlug(plugin.repo), plugin.name])
              .filter(([slug]) => slug !== null),
          )
          // 只有读不到仓库地址的包才按「仓库名」兜底匹配：同名仓库不等于同一个插件
          // （GitHub 上确实存在多个叫 dsh-builtin-browser 的仓库）。
          const installedByName = new Set(
            installedInfo.plugins.filter((plugin) => plugin.repo === null).map((plugin) => plugin.name),
          )
          const installed = new Set(installedByName)
          const payload = await search(ctx, query, { limit, refresh, installed })
          const items = payload.items.map((item) => {
            const installedName = installedRepos.get(item.fullName.toLowerCase()) ?? null
            const repo = { ...item, installedPackageName: installedName }
            const install = installCommands(repo, installedInfo.activeProfile)
            return {
              ...repo,
              installed:
                installedName !== null ||
                installedByName.has(item.name) ||
                installedByName.has(item.fullName),
              install: install.primary,
              installNpm: install.npm,
              installGithub: install.github,
            }
          })
          sendJson(
            res,
            200,
            {
              ...payload,
              items,
              stats: { ...payload.stats, installedMatches: items.filter((item) => item.installed).length },
              profile: installedInfo.activeProfile,
              installedCount: installedInfo.plugins.filter((plugin) => !plugin.builtin).length,
            },
            method,
          )
        } catch (error) {
          state.lastError = errorText(error)
          sendJson(
            res,
            200,
            {
              ok: false,
              error: state.lastError,
              items: [],
              warnings: [],
              rate: error?.rate ?? null,
              stats: { candidates: 0, shown: 0, githubTotal: 0, installedMatches: 0, queries: 0 },
              generatedAt: new Date().toISOString(),
            },
            method,
          )
        }
      },
    }),
  )

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: INSTALLED_PATH,
      handler: async (req, res) => {
        const method = req.method ?? 'GET'
        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: '仅支持 GET' }, method)
          return
        }
        try {
          const info = await readInstalledCached(true)
          sendJson(
            res,
            200,
            {
              ok: true,
              build: BUILD,
              profile: info.activeProfile,
              profiles: info.profiles,
              plugins: info.plugins,
              examples: EXAMPLE_CHIPS,
              generatedAt: new Date().toISOString(),
            },
            method,
          )
        } catch (error) {
          sendJson(res, 200, { ok: false, error: errorText(error), plugins: [], examples: EXAMPLE_CHIPS }, method)
        }
      },
    }),
  )

  ctx.logger?.info?.(`[github-source] ready: ${SEARCH_PATH} / ${INSTALLED_PATH}`)
}
