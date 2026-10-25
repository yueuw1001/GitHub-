/**
 * Host half 自测：假 ctx + 假 GitHub / 假 LLM，不联网。
 *
 * 覆盖：
 *   1. 无 LLM → 内置词典降级检索；结果按 DSH 相关度排序，非 DSH 仓库排最后；
 *   2. 已安装插件识别：包名命中（dsh-builtin-browser）+ 仓库地址命中（wqty123/dsh-browser）；
 *   3. 有 LLM → AI 规划检索词 + AI 复排理由进入结果；
 *   4. GitHub 全失败 → ok:false 且 items 为空；
 *   5. installed.json 列出 profile 里全部插件与版本。
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url)
const plugin = await import(new URL('index.js', root))

/* ------------------------------------------------------------------ */
/* 夹具：一个临时 DSH_HOME，里面只有一个 desktop profile                 */
/* ------------------------------------------------------------------ */

const home = await mkdtemp(join(tmpdir(), 'dsh-github-source-test-'))
const profileDir = join(home, 'profiles', 'desktop')
await mkdir(profileDir, { recursive: true })
await writeFile(
  join(profileDir, 'package.json'),
  JSON.stringify(
    {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {
        '@deepseek-ai/dsh-base': '0.2.1-rc.1',
        'dsh-builtin-browser': '0.4.13',
        'dsh-stock-analyzer': 'link:C:/somewhere/stock-analyzer',
      },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', 'dsh-builtin-browser'],
        },
      },
    },
    null,
    2,
  ),
)
await mkdir(join(profileDir, 'node_modules', 'dsh-builtin-browser'), { recursive: true })
await writeFile(
  join(profileDir, 'node_modules', 'dsh-builtin-browser', 'package.json'),
  JSON.stringify({
    name: 'dsh-builtin-browser',
    version: '0.4.13',
    description: 'Shared real browser plugin for DeepSeek Harness',
    repository: { type: 'git', url: 'git+https://github.com/wqty123/dsh-browser.git' },
  }),
)
await mkdir(join(profileDir, 'node_modules', 'dsh-stock-analyzer'), { recursive: true })
await writeFile(
  join(profileDir, 'node_modules', 'dsh-stock-analyzer', 'package.json'),
  JSON.stringify({
    name: 'dsh-stock-analyzer',
    version: '1.3.0',
    description: 'A股个股智能分析',
  }),
)

process.env.DSH_HOME = home

/* ------------------------------------------------------------------ */
/* 假 GitHub 响应                                                       */
/* ------------------------------------------------------------------ */

const repoBrowser = {
  full_name: 'wqty123/dsh-browser',
  name: 'dsh-browser',
  owner: { login: 'wqty123' },
  html_url: 'https://github.com/wqty123/dsh-browser',
  description: 'Shared real browser plugin for DeepSeek Harness',
  stargazers_count: 144,
  forks_count: 9,
  language: 'JavaScript',
  license: { spdx_id: 'MIT' },
  pushed_at: new Date().toISOString(),
  topics: ['browser', 'deepseek-harness', 'dsh-plugin'],
  archived: false,
}
const repoMarket = {
  full_name: 'dsh-market/dsh-market',
  name: 'dsh-market',
  owner: { login: 'dsh-market' },
  html_url: 'https://github.com/dsh-market/dsh-market',
  description: 'DSH 可视化插件市场',
  stargazers_count: 8669,
  forks_count: 339,
  language: 'TypeScript',
  license: { spdx_id: 'MIT' },
  pushed_at: new Date().toISOString(),
  topics: ['deepseek-harness', 'dsh-plugin'],
  archived: false,
}
const repoPicgo = {
  full_name: 'Molunerfinn/PicGo',
  name: 'PicGo',
  owner: { login: 'Molunerfinn' },
  html_url: 'https://github.com/Molunerfinn/PicGo',
  description: 'The Ultimate Image Uploader for Efficient Creators',
  stargazers_count: 27401,
  forks_count: 2333,
  language: 'TypeScript',
  license: { spdx_id: 'MIT' },
  pushed_at: new Date().toISOString(),
  topics: ['image', 'electron'],
  archived: false,
}
const repoPlaywright = {
  full_name: 'microsoft/playwright',
  name: 'playwright',
  owner: { login: 'microsoft' },
  html_url: 'https://github.com/microsoft/playwright',
  description: 'Playwright is a framework for Web Testing and Automation',
  stargazers_count: 68000,
  forks_count: 3800,
  language: 'TypeScript',
  license: { spdx_id: 'Apache-2.0' },
  pushed_at: new Date().toISOString(),
  topics: ['browser', 'automation', 'testing'],
  archived: false,
}
const repoVoice = {
  full_name: 'someone/dsh-voice',
  name: 'dsh-voice',
  owner: { login: 'someone' },
  html_url: 'https://github.com/someone/dsh-voice',
  description: 'Voice input plugin for DeepSeek Harness',
  stargazers_count: 12,
  forks_count: 1,
  language: 'TypeScript',
  license: null,
  pushed_at: new Date().toISOString(),
  topics: ['dsh-plugin'],
  archived: false,
}

const repoHomonym = {
  full_name: 'HaoJieJin/dsh-builtin-browser',
  name: 'dsh-builtin-browser',
  owner: { login: 'HaoJieJin' },
  html_url: 'https://github.com/HaoJieJin/dsh-builtin-browser',
  description: '同名插件：内置虚拟显示与自愈 CDP 桥',
  stargazers_count: 0,
  forks_count: 0,
  language: 'TypeScript',
  license: null,
  pushed_at: new Date().toISOString(),
  topics: ['dsh-plugin', 'browser'],
  archived: false,
}

const calls = []
const realFetch = globalThis.fetch
function stubFetch(items) {
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    const parsed = new URL(String(url))
    if (parsed.hostname === 'raw.githubusercontent.com') {
      const [, owner, repo] = parsed.pathname.split('/')
      if (`${owner}/${repo}`.toLowerCase() === 'wqty123/dsh-browser') {
        return new Response(
          JSON.stringify({
            name: 'dsh-builtin-browser',
            version: '0.4.13',
            description: 'Shared real browser plugin for DeepSeek Harness',
            dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('Not Found', { status: 404 })
    }
    const q = parsed.searchParams.get('q') ?? ''
    const filtered = items.filter((item) => {
      const haystack = `${item.full_name} ${item.description} ${item.topics.join(' ')}`.toLowerCase()
      if (q.startsWith('topic:dsh-plugin')) return item.topics.includes('dsh-plugin')
      if (q.includes('voice')) return haystack.includes('voice')
      if (q.includes('browser')) return haystack.includes('browser')
      return haystack.includes('dsh')
    })
    return new Response(JSON.stringify({ total_count: filtered.length, items: filtered }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-remaining': '57',
        'x-ratelimit-limit': '60',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      },
    })
  }
}

/* ------------------------------------------------------------------ */
/* 假 ctx / res                                                         */
/* ------------------------------------------------------------------ */

function makeContext(routes, { llm = null, web = null, account = null } = {}) {
  return {
    effect(factory) {
      const dispose = factory()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    get(name) {
      if (name === 'llm') return llm
      if (name === 'web') return web
      if (name === 'deepseekAccount') return account
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) }
      }
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
  }
}

function call(route, url, method = 'GET') {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      headers: {},
      writeHead(status, headers) {
        this.status = status
        this.headers = headers
      },
      end(body) {
        resolve({
          status: this.status,
          headers: this.headers,
          json: typeof body === 'string' && body !== '' ? JSON.parse(body) : null,
        })
      },
    }
    route.handler({ method, url }, res)
  })
}

function fakeLlm({ plan, rerank }) {
  return {
    async *stream(options) {
      const system = String(options?.system ?? '')
      const text = system.includes('筛选助手') ? JSON.stringify(rerank) : JSON.stringify(plan)
      // 模拟分块输出，顺便验证 text-delta 累积
      for (const piece of text.match(/.{1,17}/gs) ?? []) {
        yield { type: 'text-delta', index: 0, text: piece }
      }
    },
  }
}

let passed = 0
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

/* ------------------------------------------------------------------ */
/* 1. 无 LLM：词典降级                                                  */
/* ------------------------------------------------------------------ */

console.log('host.test.mjs')
const routes = new Map()
plugin.apply(makeContext(routes))

assert.equal(plugin.name, 'dsh-github-source')
assert.deepEqual(plugin.inject, ['webServer'])
assert.ok(routes.has('/dsh-github-source/search.json'))
assert.ok(routes.has('/dsh-github-source/installed.json'))

stubFetch([repoBrowser, repoMarket, repoPicgo, repoVoice, repoPlaywright, repoHomonym])

await test('无 LLM 时降级为词典检索，且结果按 DSH 相关度排序', async () => {
  const result = await call(routes.get('/dsh-github-source/search.json'), '/dsh-github-source/search.json?q=browser')
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  assert.equal(result.json.ai.enabled, false)
  assert.match(String(result.json.ai.error), /LLM 服务不可用|没有可用的默认模型/)
  assert.ok(result.json.items.length >= 3, `items: ${result.json.items.length}`)
  const names = result.json.items.map((item) => item.fullName)
  const browserIndex = names.indexOf('wqty123/dsh-browser')
  const playwrightIndex = names.indexOf('microsoft/playwright')
  assert.ok(browserIndex >= 0, `缺少 dsh-browser：${names.join(', ')}`)
  assert.ok(playwrightIndex > browserIndex, `非 DSH 仓库应排在 DSH 仓库之后：${names.join(', ')}`)
  assert.equal(result.json.items[0].suspect, false)
  assert.equal(result.json.items.find((item) => item.fullName === 'microsoft/playwright').suspect, true)
})

await test('已安装识别：仓库地址命中，且安装命令用仓库 package.json 里的真实包名', async () => {
  const result = await call(routes.get('/dsh-github-source/search.json'), '/dsh-github-source/search.json?q=browser')
  const browser = result.json.items.find((item) => item.fullName === 'wqty123/dsh-browser')
  assert.equal(browser.installed, true)
  assert.equal(browser.packageName, 'dsh-builtin-browser')
  assert.equal(browser.dshVerified, true)
  assert.equal(browser.version, '0.4.13')
  assert.equal(result.json.profile, 'desktop')
  assert.match(browser.install, /dsh plugin --profile desktop add dsh-builtin-browser$/)
  assert.match(browser.installNpm, /dsh plugin --profile desktop add dsh-builtin-browser$/)
  assert.match(browser.installGithub, /github:wqty123\/dsh-browser$/)

  // 同名但不同仓库的「dsh-builtin-browser」不能被误判为已安装；
  // 读不到 package.json 时主命令退回 github: 形式，避免把仓库名当包名。
  const homonym = result.json.items.find((item) => item.fullName === 'HaoJieJin/dsh-builtin-browser')
  assert.ok(homonym !== undefined, '缺少同名仓库夹具')
  assert.equal(homonym.installed, false)
  assert.match(homonym.install, /github:HaoJieJin\/dsh-builtin-browser$/)
})

await test('installed.json 列出全部已安装插件与版本', async () => {
  const result = await call(routes.get('/dsh-github-source/installed.json'), '/dsh-github-source/installed.json')
  assert.equal(result.json.ok, true)
  assert.equal(result.json.profile, 'desktop')
  const names = result.json.plugins.map((item) => item.name)
  assert.ok(names.includes('dsh-builtin-browser'))
  assert.ok(names.includes('dsh-stock-analyzer'))
  assert.ok(names.includes('@deepseek-ai/dsh-base'))
  const browser = result.json.plugins.find((item) => item.name === 'dsh-builtin-browser')
  assert.equal(browser.version, '0.4.13')
  assert.equal(browser.builtin, false)
  assert.equal(browser.repo, 'https://github.com/wqty123/dsh-browser')
  const stock = result.json.plugins.find((item) => item.name === 'dsh-stock-analyzer')
  assert.equal(stock.local, true)
  assert.deepEqual(result.json.examples, ['浏览器自动化', 'dsh-builtin-browser', '语音输入', '插件市场', '股票行情', 'MCP'])
})

await test('缓存命中时 cached=true', async () => {
  const before = calls.length
  const result = await call(routes.get('/dsh-github-source/search.json'), '/dsh-github-source/search.json?q=browser')
  assert.equal(result.json.cached, true)
  assert.equal(calls.length, before, '缓存命中不应再请求 GitHub')
})

await test('refresh=1 绕过缓存', async () => {
  const before = calls.length
  const result = await call(
    routes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=browser&refresh=1',
  )
  assert.equal(result.json.cached, false)
  assert.ok(calls.length > before, '强制刷新应重新请求 GitHub')
})

await test('空 q 返回 400', async () => {
  const result = await call(routes.get('/dsh-github-source/search.json'), '/dsh-github-source/search.json?q=')
  assert.equal(result.status, 400)
  assert.equal(result.json.ok, false)
})

/* ------------------------------------------------------------------ */
/* 2. 有 LLM：AI 规划 + AI 复排                                         */
/* ------------------------------------------------------------------ */

await test('AI 可用时使用 AI 检索词、AI 顺序与逐条理由', async () => {
  const aiRoutes = new Map()
  const llm = fakeLlm({
    plan: {
      keywords: ['browser', 'playwright', 'automation'],
      queries: ['browser automation dsh in:name,description,topics', 'dsh-plugin browser in:name,description,topics'],
      reason: '用户要的是能操作浏览器的 DSH 插件',
    },
    rerank: {
      order: ['wqty123/dsh-browser', 'dsh-market/dsh-market', 'Molunerfinn/PicGo'],
      reasons: {
        'wqty123/dsh-browser': '就是浏览器自动化插件，已装',
        'dsh-market/dsh-market': '插件市场，能顺带发现其它插件',
        'Molunerfinn/PicGo': '疑似非 DSH 插件',
      },
      note: '最匹配的是 dsh-browser',
    },
  })
  plugin.apply(makeContext(aiRoutes, { llm }))
  const result = await call(
    aiRoutes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=浏览器自动化&refresh=1',
  )
  assert.equal(result.json.ok, true)
  assert.equal(result.json.ai.enabled, true)
  assert.deepEqual(result.json.ai.keywords, ['browser', 'playwright', 'automation'])
  assert.equal(result.json.ai.queries[0], 'browser automation dsh in:name,description,topics')
  assert.equal(result.json.items[0].fullName, 'wqty123/dsh-browser')
  assert.equal(result.json.items[0].reason, '就是浏览器自动化插件，已装')
  assert.equal(result.json.ai.note, '最匹配的是 dsh-browser')
  assert.ok(result.json.ai.reranked >= 3)
})

await test('AI 输出坏 JSON 时自动降级，不影响检索', async () => {
  const aiRoutes = new Map()
  const llm = {
    async *stream() {
      yield { type: 'text-delta', index: 0, text: '抱歉，我无法完成。' }
    },
  }
  plugin.apply(makeContext(aiRoutes, { llm }))
  const result = await call(
    aiRoutes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=voice&refresh=1',
  )
  assert.equal(result.json.ok, true)
  assert.equal(result.json.ai.enabled, false)
  assert.ok(result.json.ai.error.includes('不是 JSON'))
  assert.ok(result.json.items.some((item) => item.fullName === 'someone/dsh-voice'))
})

/* ------------------------------------------------------------------ */
/* 3. AI 直接搜索（ctx.web）                                            */
/* ------------------------------------------------------------------ */

await test('AI 直接搜索：网页结果并入候选，命中已有的打标，新仓库补成候选', async () => {
  const webRoutes = new Map()
  const queries = []
  const web = {
    async search(request) {
      queries.push(request.query)
      return {
        content: '这几个仓库都在做 DSH 的浏览器自动化。',
        sources: [
          { url: 'https://github.com/wqty123/dsh-browser', title: 'dsh-browser', snippet: '真实浏览器插件' },
          { url: 'https://github.com/newkid/dsh-great-browser?tab=readme', title: 'dsh-great-browser', snippet: '网页搜索直接命中的新仓库' },
          { url: 'https://github.com/topics/dsh-plugin', title: '主题页', snippet: '不是仓库' },
          { url: 'https://example.com/not-github', title: '无关站点' },
        ],
        truncated: false,
      }
    },
  }
  plugin.apply(makeContext(webRoutes, { web }))
  const result = await call(
    webRoutes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=browser&refresh=1',
  )
  assert.equal(result.json.ok, true)
  assert.equal(result.json.ai.web.enabled, true)
  assert.equal(queries.length, 2, '应向网页搜索发 2 条查询')
  assert.equal(result.json.stats.aiDirect, 2, '应合并 2 个 GitHub 仓库（主题页/非 GitHub 被忽略）')

  const browser = result.json.items.find((item) => item.fullName === 'wqty123/dsh-browser')
  assert.equal(browser.aiDirect, true)
  assert.match(browser.install, /dsh-builtin-browser$/)

  const fresh = result.json.items.find((item) => item.fullName === 'newkid/dsh-great-browser')
  assert.ok(fresh !== undefined, 'AI 直搜的新仓库要出现在结果里')
  assert.equal(fresh.aiDirect, true)
  assert.equal(fresh.description, '网页搜索直接命中的新仓库')
  assert.match(fresh.install, /github:newkid\/dsh-great-browser$/)
  assert.equal(result.json.items.some((item) => item.fullName === 'topics/dsh-plugin'), false)

  // limit 很小时也要给 AI 直搜留名额，不能被高星结果挤掉。
  const small = await call(
    webRoutes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=browser&limit=1&refresh=1',
  )
  assert.equal(small.json.items.length, 1)
  assert.equal(small.json.items[0].aiDirect, true, 'limit=1 时应优先展示 AI 直搜命中')
})

await test('没有网页搜索能力时 AI 直搜降级，不影响 GitHub 检索', async () => {
  const noWebRoutes = new Map()
  plugin.apply(makeContext(noWebRoutes))
  const result = await call(
    noWebRoutes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=browser&refresh=1',
  )
  assert.equal(result.json.ok, true)
  assert.equal(result.json.ai.web.enabled, false)
  assert.match(result.json.ai.web.error, /ctx\.web 不可用/)
  assert.equal(result.json.stats.aiDirect, 0)
  assert.ok(result.json.items.length > 0)
})

await test('ctx.web 401 时用 DeepSeek 账号令牌直连 web_search 兜底', async () => {
  const savedFetch = globalThis.fetch
  const accountRoutes = new Map()
  const seen = { tokens: [], texts: [] }
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.deepseek.com')) {
      seen.tokens.push(init?.headers?.['x-dsh-auth-token'])
      const body = JSON.parse(String(init?.body ?? '{}'))
      seen.texts.push(body?.messages?.[0]?.content?.[0]?.text ?? '')
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: '账号直搜摘要：找到了一个浏览器插件仓库。',
              citations: [
                { url: 'https://github.com/acct/dsh-browser-fork', cited_text: '账号令牌命中的仓库' },
              ],
            },
            {
              type: 'web_search_tool_result',
              content: [{ type: 'web_search_result', url: 'https://github.com/acct/dsh-browser-fork', title: 'dsh-browser-fork' }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return savedFetch(url, init)
  }
  const account = { async resolveToken() { return 'tok-123' } }
  plugin.apply(makeContext(accountRoutes, { account }))
  const result = await call(
    accountRoutes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=browser&refresh=1',
  )
  assert.equal(result.json.ok, true)
  assert.equal(result.json.ai.web.enabled, true)
  assert.equal(result.json.ai.web.via, 'account')
  assert.ok(result.json.stats.aiDirect >= 1)
  const found = result.json.items.find((item) => item.fullName === 'acct/dsh-browser-fork')
  assert.ok(found !== undefined, '账号直搜的仓库应出现在结果里')
  assert.equal(found.aiDirect, true)
  assert.equal(found.description, '账号令牌命中的仓库')
  assert.ok(seen.tokens.every((token) => token === 'tok-123'), '必须使用账号令牌鉴权')
  assert.ok(seen.texts.every((text) => text.includes('browser')), '请求里应带用户需求')
  globalThis.fetch = savedFetch
})

/* ------------------------------------------------------------------ */
/* 4. GitHub 全挂                                                       */
/* ------------------------------------------------------------------ */

await test('GitHub 全失败且没有 AI 直搜命中时 ok=false 并带错误，而不是抛异常', async () => {
  const failingRoutes = new Map()
  plugin.apply(makeContext(failingRoutes))
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 })
  const result = await call(
    failingRoutes.get('/dsh-github-source/search.json'),
    '/dsh-github-source/search.json?q=browser&refresh=1',
  )
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, false)
  assert.match(result.json.error, /GitHub 搜索失败（HTTP 403）/)
  assert.deepEqual(result.json.items, [])
})

/* ------------------------------------------------------------------ */
/* 收尾                                                                 */
/* ------------------------------------------------------------------ */

globalThis.fetch = realFetch
await rm(home, { recursive: true, force: true })

console.log(`\n${passed} 项通过${process.exitCode === 1 ? '，存在失败' : ''}`)
