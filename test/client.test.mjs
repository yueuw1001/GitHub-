/**
 * Client half 自测：把真正的 client.js 装进假的 window.__ModuleLoader__，
 * 用真正的 React 做服务端渲染，检查面板与卡片能渲染出关键内容；
 * 再用假 ctx.slots 检查左侧栏入口与中央面板的注册参数。
 */

import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = process.cwd()
const registration = { value: null }
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration.value = value
    },
  },
}

await import(pathToFileURL(join(root, 'client.js')).href)

const bundle = registration.value
assert.ok(bundle !== null, 'client.js 必须向 __ModuleLoader__ 注册')
assert.equal(bundle.id, 'dsh-github-source')

const exportsObject = bundle.factory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})

const { PanelRoot, RepoCard, InstalledRow, AiPanel, SidebarIcon } = exportsObject.__test
assert.deepEqual(exportsObject.inject, ['slots'])

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`  FAIL ${name}`)
    console.error(error)
    process.exitCode = 1
  }
}

console.log('client.test.mjs')

test('面板能渲染标题、搜索框与示例入口', () => {
  const html = renderToStaticMarkup(React.createElement(PanelRoot))
  assert.ok(html.includes('GitHub源'), '缺少标题')
  assert.ok(html.includes('用 AI 找插件'), '缺少搜索按钮')
  assert.ok(html.includes('placeholder="例如：浏览器自动化 / 语音输入 / dsh-builtin-browser"'), '缺少占位文案')
  assert.ok(html.includes('GitHub 检索'))
  assert.ok(html.includes('已安装'))
  assert.ok(html.includes('dsh-builtin-browser'), '示例里应包含 dsh-builtin-browser')
  assert.ok(html.includes('topic:dsh-plugin'), '应提供「全部 dsh 插件」入口')
  assert.ok(html.includes('<style>'), '样式应内联注入')
  assert.ok(html.includes('--dsw-alias-bg-base'), '应使用主题 token')
})

test('仓库卡片渲染安装命令、已安装徽标、AI 理由', () => {
  const html = renderToStaticMarkup(
    React.createElement(RepoCard, {
      repo: {
        fullName: 'wqty123/dsh-browser',
        name: 'dsh-browser',
        url: 'https://github.com/wqty123/dsh-browser',
        description: 'Shared real browser plugin for DeepSeek Harness',
        stars: 144,
        language: 'JavaScript',
        updatedAt: new Date().toISOString(),
        topics: ['browser', 'dsh-plugin'],
        archived: false,
        suspect: false,
        installed: true,
        dshVerified: true,
        aiDirect: true,
        version: '0.4.13',
        reason: '就是浏览器自动化插件，已装',
        installGithub: 'dsh plugin --profile desktop add github:wqty123/dsh-browser',
      },
      install: 'dsh plugin --profile desktop add dsh-builtin-browser',
    }),
  )
  assert.ok(html.includes('wqty123/dsh-browser'))
  assert.ok(html.includes('已安装'))
  assert.ok(html.includes('AI 直搜'))
  assert.ok(html.includes('已核对 dsh 包'))
  assert.ok(html.includes('v0.4.13'))
  assert.ok(html.includes('就是浏览器自动化插件，已装'))
  assert.ok(html.includes('dsh plugin --profile desktop add dsh-builtin-browser'))
  assert.ok(html.includes('复制安装命令'))
  assert.ok(html.includes('复制 GitHub 命令'), '没有 npm 包名时应能复制 GitHub 形式')
  assert.ok(html.includes('在浏览器打开'))
  assert.ok(!html.includes('target="_blank"'), '仓库链接不应再强制打开外部标签页')
  assert.ok(html.includes('144'))
  assert.ok(html.includes('dsh-plugin'))
})

test('非 DSH 仓库带「疑似非 DSH 插件」标记', () => {
  const html = renderToStaticMarkup(
    React.createElement(RepoCard, {
      repo: {
        fullName: 'Molunerfinn/PicGo',
        name: 'PicGo',
        url: 'https://github.com/Molunerfinn/PicGo',
        description: 'The Ultimate Image Uploader',
        stars: 27401,
        language: 'TypeScript',
        updatedAt: null,
        topics: [],
        archived: false,
        suspect: true,
        installed: false,
        reason: '',
      },
      install: 'dsh plugin --profile desktop add PicGo',
    }),
  )
  assert.ok(html.includes('疑似非 DSH 插件'))
  assert.ok(html.includes('无主题标签'))
})

test('已安装行展示版本、本地链接与 profile', () => {
  const html = renderToStaticMarkup(
    React.createElement(InstalledRow, {
      plugin: {
        name: 'dsh-builtin-browser',
        version: '0.4.13',
        description: 'Shared real browser plugin for DeepSeek Harness',
        repo: 'https://github.com/wqty123/dsh-browser',
        builtin: false,
        local: false,
        profiles: ['desktop'],
      },
    }),
  )
  assert.ok(html.includes('dsh-builtin-browser'))
  assert.ok(html.includes('v0.4.13'))
  assert.ok(html.includes('仓库'))

  const localHtml = renderToStaticMarkup(
    React.createElement(InstalledRow, {
      plugin: {
        name: 'dsh-stock-analyzer',
        version: '1.3.0',
        description: 'A股个股智能分析',
        repo: null,
        builtin: false,
        local: true,
        profiles: ['desktop', 'web'],
      },
    }),
  )
  assert.ok(localHtml.includes('本地链接'))
  assert.ok(localHtml.includes('desktop / web'))
})

test('AI 状态条区分「AI 参与」与「规则检索」', () => {
  const aiHtml = renderToStaticMarkup(
    React.createElement(AiPanel, {
      ai: {
        enabled: true,
        error: null,
        note: '最匹配的是 dsh-browser',
        keywords: ['browser', 'playwright'],
        queries: ['browser dsh in:name,description,topics'],
        reranked: 3,
        web: {
          enabled: true,
          sources: 3,
          content: '这几个仓库都在做 DSH 的浏览器自动化。',
          error: null,
          queries: ['DeepSeek Harness DSH 插件 浏览器自动化 github'],
        },
      },
      stats: { candidates: 12, shown: 12, githubTotal: 30, aiDirect: 3 },
    }),
  )
  assert.ok(aiHtml.includes('AI 参与检索'))
  assert.ok(aiHtml.includes('browser'))
  assert.ok(aiHtml.includes('browser dsh in:name,description,topics'))
  assert.ok(aiHtml.includes('最匹配的是 dsh-browser'))
  assert.ok(aiHtml.includes('已用网页搜索直接找 3 条线索'))
  assert.ok(aiHtml.includes('直搜摘要'))
  assert.ok(aiHtml.includes('这几个仓库都在做 DSH 的浏览器自动化。'))

  const fallbackHtml = renderToStaticMarkup(
    React.createElement(AiPanel, {
      ai: {
        enabled: false,
        error: '宿主 LLM 服务不可用',
        note: '',
        keywords: [],
        queries: [],
        reranked: 0,
      },
      stats: { candidates: 3, shown: 3, githubTotal: 4 },
    }),
  )
  assert.ok(fallbackHtml.includes('规则检索（AI 不可用）'))
  assert.ok(fallbackHtml.includes('AI 降级：宿主 LLM 服务不可用'))
})

test('侧边栏图标带 active / size 语义', () => {
  const html = renderToStaticMarkup(React.createElement(SidebarIcon, { size: 26, active: true }))
  assert.ok(html.includes('width="26"'))
  assert.ok(html.includes('height="26"'))
  assert.ok(html.includes('opacity:1'))
})

test('apply 注册左侧栏入口与中央面板', () => {
  const registrations = []
  const ctx = {
    slots: {
      inject(name, callback) {
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register(meta, component) {
        registrations.push({ meta, component })
        return () => {}
      },
    },
  }
  exportsObject.apply(ctx)
  const main = registrations.find((item) => item.meta.name === 'main')
  const sidebar = registrations.find((item) => item.meta.name === 'sidebar.panellist')
  assert.ok(main !== undefined, '缺少 main 注册')
  assert.equal(main.meta.key, 'dsh-github-source')
  assert.equal(main.component, PanelRoot)
  assert.ok(sidebar !== undefined, '缺少 sidebar.panellist 注册')
  assert.equal(sidebar.meta.id, 'dsh-github-source')
  assert.equal(sidebar.meta.order, 41)
  assert.equal(sidebar.meta.label(), 'GitHub源')
  assert.equal(sidebar.component, SidebarIcon)
})

/* ------------------------------------------------------------------ */
/* 内置浏览器打开                                                       */
/* ------------------------------------------------------------------ */

const { openInternal, sessionIdFrom, setModuleCtx, partitionItems } = exportsObject.__test

test('结果按「AI 直搜命中 / GitHub 检索」分组', () => {
  const groups = partitionItems([
    { fullName: 'a/one', aiDirect: true },
    { fullName: 'b/two' },
    { fullName: 'c/three', aiDirect: false },
    { fullName: 'd/four', aiDirect: true },
  ])
  assert.deepEqual(groups.direct.map((item) => item.fullName), ['a/one', 'd/four'])
  assert.deepEqual(groups.rest.map((item) => item.fullName), ['b/two', 'c/three'])
  assert.deepEqual(partitionItems(null), { direct: [], rest: [] })
})

test('会话选择优先 mainView 保留中的会话', () => {
  const sessions = {
    ids: ['session-a', 'session-b', 'session-c'],
    byId: {
      'session-a': { retainedBy: {} },
      'session-b': { retainedBy: { mainView: 1, browser: 1 } },
      'session-c': { retainedBy: { sidebar: 1 } },
    },
  }
  assert.equal(sessionIdFrom(sessions), 'session-b')
  assert.equal(sessionIdFrom(null), '')
  assert.equal(sessionIdFrom({ ids: [], byId: {} }), '')
})

test('openInternal 走 __dshBuiltinBrowser.openPanel 并切到该会话', () => {
  const calls = []
  const opened = []
  globalThis.__dshBuiltinBrowser = {
    openPanel(sessionId, url) {
      calls.push({ sessionId, url })
      return { ok: true, created: true, guestId: null }
    },
  }
  setModuleCtx({
    get(name) {
      if (name === 'uiWorkspace') {
        return { openSession: (sessionId) => opened.push(sessionId) }
      }
      return undefined
    },
  })
  const sessions = {
    ids: ['session-x'],
    byId: { 'session-x': { retainedBy: { mainView: 1 } } },
  }
  const result = openInternal('https://github.com/wqty123/dsh-browser', sessions)
  assert.deepEqual(result, { ok: true, sessionId: 'session-x', created: true })
  assert.deepEqual(calls, [{ sessionId: 'session-x', url: 'https://github.com/wqty123/dsh-browser' }])
  assert.deepEqual(opened, ['session-x'])
  delete globalThis.__dshBuiltinBrowser
  setModuleCtx(null)
})

test('openPanel 拒绝时退回 sidebarRight.openTab', () => {
  const tabs = []
  globalThis.__dshBuiltinBrowser = { openPanel: () => ({ ok: false, reason: 'no panel' }) }
  setModuleCtx({
    get(name) {
      if (name === 'sidebarRight') {
        return { openTab: (kind, options) => tabs.push({ kind, options }) }
      }
      return undefined
    },
  })
  const result = openInternal('https://github.com/dsh-market/dsh-market', {
    ids: ['session-x'],
    byId: { 'session-x': { retainedBy: { mainView: 1 } } },
  })
  assert.deepEqual(result, { ok: true, via: 'sidebarRight' })
  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].kind, 'browser')
  assert.equal(tabs[0].options.params.url, 'https://github.com/dsh-market/dsh-market')
  delete globalThis.__dshBuiltinBrowser
  setModuleCtx(null)
})

test('内置浏览器不可用时退回外部窗口；非 http(s) 直接拒绝', () => {
  const external = []
  globalThis.window.open = (url) => {
    external.push(url)
    return {}
  }
  setModuleCtx(null)
  const result = openInternal('https://github.com/example/repo', null)
  assert.deepEqual(result, { ok: true, external: true })
  assert.deepEqual(external, ['https://github.com/example/repo'])

  const refused = openInternal('javascript:alert(1)', null)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /http/)
  delete globalThis.window.open
})

console.log(`\n${passed} 项通过${process.exitCode === 1 ? '，存在失败' : ''}`)
