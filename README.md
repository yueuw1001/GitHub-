# GitHub源（dsh-github-source）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）加一个**左侧栏入口**：
输入「我需要什么功能的插件」或插件名，**让 AI 直接搜索**并把相关的 DSH 插件全部列出来；
同时可以看到本机已安装的全部插件。点击结果会用 `dsh-builtin-browser` 在**内置侧栏浏览器**里打开仓库。

## 功能

| 面 | 说明 |
| --- | --- |
| 左侧栏 | 放大镜图标（id `dsh-github-source`，order 41），点击打开中央面板 |
| AI 直接搜索 | 两条自然语言查询（`DeepSeek Harness DSH 插件 <需求> github` / `dsh-plugin <需求> github`）交给网页搜索，从结果里认出 `github.com/owner/repo` 并并入候选。结果单独分组为「AI 直接搜索命中」，带 `AI 直搜` 徽标 |
| GitHub 检索 | 输入功能或名称 → AI 规划 2~3 条 GitHub 搜索表达式 → 合并去重 → AI 复排并给每个结果一句中文匹配理由 |
| 全部结果 | 每条查询取 100 个仓库、最多 3 条查询合并；面板按相关度排序列出全部命中，不做二次截断 |
| 已安装 | 扫描 `~/.dsh/profiles/*/package.json`，列出全部社区插件（名称 / 版本 / 描述 / 是否本地 link / 所在 profile），DSH 内置包折叠显示 |
| 安装命令 | 每个结果给出安装命令，一键复制：读到仓库根 `package.json` 时用真实包名（`add <name>`），读不到时退回确定性的 `add github:owner/repo`；两种形式各一个复制按钮 |
| 内部打开 | 点仓库名 / 「在浏览器打开」不跳系统浏览器：优先 `globalThis.__dshBuiltinBrowser.openPanel(sessionId, url)`（桌面端就是 dsh-builtin-browser 驱动的官方侧栏浏览器面板），随后 `uiWorkspace.openSession` 切到该会话让面板可见；不可用时退回 `sidebarRight.openTab('browser')`，最后才用外部窗口 |

打分 = 关键词命中 + `dsh-plugin` / `deepseek-harness` 主题 + 仓库名/描述里的 DSH 信号
+ 星标（log）+ 最近更新 − 归档/疑似非 DSH 插件 + AI 直搜命中奖励；有 AI 排序时再叠加 AI 名次奖励。
`limit` 很小时也会为 AI 直搜命中预留名额，它们不会被高星仓库挤掉。

## 安装

DSH 插件就是一个带 `dsh` 字段的 npm 包。从本仓库安装：

```powershell
dsh plugin --profile desktop add github:yueuw1001/GitHub-
```

或用本地目录（开发时）：

```powershell
dsh plugin --profile desktop add link:C:/path/to/dsh-github-source
```

然后把包名加进 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`：

```json
"bundles": [ "...", "dsh-github-source" ]
```

生效方式：

1. 刷新页面（Ctrl+R）→ 左侧栏出现「GitHub源」入口（客户端半）；
2. Host 半的路由还没挂上（`GET /dsh-github-source/installed.json` 404）时，重启一次 DSH。

> 开发提示：只改 `client.js` 不需要重启，刷新页面即可（boot manifest 的 `rev` 随文件内容变化）；
> 改 `index.js` 后需要重新挂载 Host 半。

## 使用

1. 打开左侧栏「GitHub源」；
2. 输入需求（如「浏览器自动化」「语音输入」）或插件名（如 `dsh-builtin-browser`），点「用 AI 找插件」；
3. 顶部「AI 直接搜索命中」是 AI 直接给出的仓库，下面是 GitHub API 检索结果；
4. 点「在浏览器打开」→ 在 DSH 内置浏览器面板里打开仓库，方便看 README 或装插件；
5. 「已安装」页签列出本机全部插件，可直接点「仓库」打开对应 GitHub 页面。

## 接口

```
GET /dsh-github-source/search.json?q=浏览器自动化[&limit=60][&refresh=1]
GET /dsh-github-source/installed.json
```

- `search.json` 读宿主 LLM 服务（`ctx.get('llm')`，用默认模型路由）。LLM 不可用、超时或返回
  非 JSON 时自动降级为内置中英词典 + 规则检索，接口不会失败。
- AI 直搜优先 `ctx.get('web').search(...)`；失败时用 `ctx.get('deepseekAccount').resolveToken(endpoint)`
  拿账号令牌，直连 `https://api.deepseek.com/anthropic/v1/messages`（`DEEPSEEK_SEARCH_BASE_URL` 可覆盖），
  发 `web_search_20250305` 工具请求。端点与令牌都由宿主服务提供，插件不读凭据文件。
- GitHub 搜索走 `api.github.com/search/repositories`，15s 超时、5 分钟内存缓存；设置了
  `GITHUB_TOKEN` 会自动带上（匿名配额 10 次/分钟）。单进程每分钟最多 12 次检索请求。
- `installed.json` 返回 `{ profile, profiles, plugins: [{name, version, description, repo, builtin, local, profiles}], examples }`。

## 降级链

| 能力 | 顺序 |
| --- | --- |
| 需求 → 检索词 | AI 规划 → 内置中英词典 + 规则表达式 |
| 找插件 | AI 直接搜索（`ctx.web` → DeepSeek 账号令牌 web_search）→ GitHub repositories API |
| 结果排序 | AI 语义复排 → 规则打分（主题/星标/更新/疑似非 DSH） |
| 打开仓库 | `__dshBuiltinBrowser.openPanel` → `sidebarRight.openTab('browser')` → 外部窗口 |

## 文件结构

```
index.js          Host half：AI 规划 / AI 直搜 / GitHub 检索 / 打分 / 已安装扫描 / 两个 JSON 路由
client.js         Client half：侧边栏图标 + 中央面板（React，仅用主题 token）
cordis.patch.yml  bundle patch（纯 insert，无 config）
icon.svg          包图标
test/             自测
```

## 自测

```powershell
cd dsh-github-source
npm install                       # 只装 devDependencies（react / react-dom），用于渲染自测
node test/host.test.mjs           # 假 ctx + 假 GitHub / 假 LLM / 假网页搜索，12 项
node test/client.test.mjs         # 假 window/module loader + 真 React 渲染 + 内部打开 + 分组，12 项
node test/live-smoke.mjs browser  # 真实 GitHub 冒烟（匿名配额 10 次/分钟）
```

## 已知限制

- GitHub 匿名搜索配额有限，密集检索会 429；已加 5 分钟缓存与本地限流；
- AI 直搜依赖宿主的网页搜索能力或 DeepSeek 账号令牌，两者都不可用时自动退回纯 GitHub 检索；
- 内置浏览器打开依赖 `dsh-builtin-browser` 已安装，且目标会话的侧栏已经挂载，否则退回外部窗口。

## License

[MIT](LICENSE)
