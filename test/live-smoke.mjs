/**
 * 真实 GitHub 冒烟：不经过 DSH，直接跑 host half 的检索链路。
 *   node test/live-smoke.mjs [查询词]
 * 会真的请求 api.github.com（匿名配额 10 次/分钟，这个脚本最多 3 次）。
 */

import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const query = process.argv[2] ?? 'browser'
const plugin = await import(pathToFileURL(join(process.cwd(), 'index.js')).href)

const routes = new Map()
plugin.apply({
  effect: (factory) => factory(),
  webServer: { register: (route) => (routes.set(route.path, route), () => {}) },
  get: () => undefined,
  logger: { info() {} },
})

const route = routes.get('/dsh-github-source/search.json')
const payload = await new Promise((resolve, reject) => {
  const res = {
    status: 0,
    writeHead(status) {
      this.status = status
    },
    end(body) {
      try {
        resolve(JSON.parse(String(body)))
      } catch (error) {
        reject(error)
      }
    },
  }
  const timer = setTimeout(() => reject(new Error('timeout')), 40000)
  route
    .handler({ method: 'GET', url: `/dsh-github-source/search.json?q=${encodeURIComponent(query)}&limit=20` }, res)
    .finally(() => clearTimeout(timer))
})

if (payload.ok !== true) {
  console.error('检索失败：', payload.error)
  process.exitCode = 1
} else {
  console.log(`查询：「${payload.query}」  候选 ${payload.stats.candidates}  展示 ${payload.items.length}`)
  console.log(`AI：${payload.ai.enabled ? '参与' : '未参与'}（${payload.ai.error ?? 'ok'}）`)
  console.log(`表达式：${payload.ai.queries.join(' | ')}`)
  console.log(`配额：${payload.rate?.remaining ?? '?'}/${payload.rate?.limit ?? '?'}`)
  console.log('--- 前 8 个结果 ---')
  for (const item of payload.items.slice(0, 8)) {
    console.log(
      `${item.installed ? '[已装] ' : ''}${item.fullName}  ★${item.stars}  score=${item.score}` +
        (item.suspect ? '  (疑似非 DSH)' : ''),
    )
    if (item.reason !== '') console.log(`    AI：${item.reason}`)
  }
}
