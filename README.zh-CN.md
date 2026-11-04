# TradingView 指标搜索 MCP 服务器（中文汉化版）

> 本仓库是 [daviddme/tradingview-indicator-search-mcp-server](https://github.com/daviddme/tradingview-indicator-search-mcp-server) 的**中文汉化分支**。
> 汉化内容见文末「汉化说明」一节。上游代码遵循 MIT 协议。

从 Claude、Cursor、WorkBuddy 或任何支持 MCP 的客户端里，搜索 TradingView 公开的指标与策略库，并拉取任意开源脚本的完整 Pine Script 源码。

这个 MCP 服务器把 TradingView 庞大的公共脚本库变成了 AI 编程助手可以查询的工具。你说“找趋势跟踪策略”或“看看 LuxAlgo 最近发了什么”，它就会返回真实的指标条目及其 Pine 源码，可以直接阅读、改造或回测。

**不需要 TradingView 账号、API Key、Cookie 或登录**：所有用到的接口都是公开接口。

---

## 目录

- [它能做什么](#它能做什么)
- [快速开始](#快速开始)
- [在 Claude Code 中安装](#在-claude-code-中安装)
- [在 Claude Desktop 中安装](#在-claude-desktop-中安装)
- [在 WorkBuddy 中安装](#在-workbuddy-中安装)
- [在 Cursor 中安装](#在-cursor-中安装)
- [工具清单](#工具清单)
- [中文主题词](#中文主题词)
- [示例提问](#示例提问)
- [TradingView 的搜索到底怎么工作](#tradingview-的搜索到底怎么工作)
- [限流与避免被封](#限流与避免被封)
- [配置项](#配置项)
- [常见问题](#常见问题)
- [汉化说明](#汉化说明)

---

## 它能做什么

TradingView 上有几十万个社区发布的指标和策略，用 Pine Script 编写，其中大部分是开源的。本服务器让 AI 助手获得结构化访问能力：

- **按主题搜索** —— “趋势跟踪”“剥头皮”“订单块”“均值回归”
- **浏览编辑精选** —— TradingView 官方人工挑选的最佳脚本
- **按作者搜索** —— 某个创作者的每一个公开脚本
- **获取 Pine 源码** —— 任意开源脚本的完整代码
- **建立本地库** —— 批量收集脚本到 SQLite 语料库，之后可离线搜索，**包括在 Pine 代码内部搜索**

最后一点最有用：脚本收集到本地后，你可以用一条瞬间完成的查询找出所有用到 `ta.supertrend` 或 `strategy.entry` 的策略——这是 TradingView 网站本身做不到的。

## 快速开始

```bash
git clone https://github.com/daviddme/tradingview-indicator-search-mcp-server.git
cd tradingview-indicator-search-mcp-server
npm install
```

需要 **Node.js 22.5 或更高版本**（使用内置的 `node:sqlite`，无需编译原生模块，也无需安装数据库）。

启动（stdio 模式）：

```bash
npm start          # 等价于 node src/server.js
```

## 在 Claude Code 中安装

```bash
claude mcp add tradingview -s user -- node "$(pwd)/src/server.js"
```

`-s user` 让它在所有项目中可用。验证：

```bash
claude mcp list
```

## 在 Claude Desktop 中安装

编辑 `claude_desktop_config.json`：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/tradingview-indicator-search-mcp-server/src/server.js"]
    }
  }
}
```

**node 必须使用绝对路径**。桌面应用不继承你的 shell `PATH`，直接写 `node` 会报 `spawn node ENOENT`。用 `which node`（Windows：`where node`）查出实际路径。

改完重启 Claude Desktop。

## 在 WorkBuddy 中安装

本机已配置好，路径为 `C:\Users\Administrator\.workbuddy\mcp.json`：

```json
{
  "mcpServers": {
    "tradingview-indicator-search": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "E:\\GitHub开源工具类\\TradingView Indicator Search MCP Server\\src\\server.js"
      ],
      "env": {}
    }
  }
}
```

写入后需要在「连接器管理 → 自定义连接器」里对新服务器点「信任」才会生效。

## 在 Cursor 中安装

编辑 `~/.cursor/mcp.json`，写法和上面一致，然后重启 Cursor。

任何支持 MCP 的客户端都可以用。服务器走 stdio，因此在 Windsurf、Cline、Zed 等客户端中同样可运行。

## 工具清单

| 工具 | 作用 |
|---|---|
| `search_scripts` | 按主题搜索：“趋势跟踪”“剥头皮”“订单块”。省略 query 则返回热门榜单。**支持中文主题词** |
| `list_editors_picks` | TradingView 编辑精选，每个结果都是官方挑选的最高质量脚本 |
| `list_author_scripts` | 某个作者发布的全部公开脚本 |
| `get_script_source` | 按脚本 ID 或粘贴的图表 URL 获取完整 Pine 源码 |
| `harvest_scripts` | 批量收集脚本及其源码到本地库，可断点续跑 |
| `query_corpus` | 离线检索本地库，包括在 Pine 代码内部全文搜索 |
| `fetch_status` | 限流健康度与语料库规模。不发起网络请求 |

## 中文主题词

TradingView 的主题页只认英文连字符路由（`/scripts/trend-following/`），所以汉化版内置了中文→英文主题映射：直接说中文即可，服务器会自动翻译。

已收录的中文词（部分）：

| 中文 | 对应主题 |
|---|---|
| 趋势跟踪 / 趋势交易 | trend following |
| 剥头皮 / 短线交易 | scalping |
| 均值回归 | mean reversion |
| 订单块 / 订单流 | order blocks / order flow |
| 成交量分布 | volume profile |
| 聪明钱 / 价格行为 | smart money / price action |
| 超级趋势 | supertrend |
| 支撑阻力 | support resistance |
| 供需区 | supply demand |
| 一目均衡表 / 云图 | ichimoku cloud |
| 斐波那契回撤 | fibonacci retracement |
| 蜡烛图形态 / 图表形态 | candlestick patterns / chart patterns |
| 止损 / 追踪止损 | stop loss / trailing stop |
| 风险管理 / 仓位管理 | risk management / position sizing |

完整词表见 `src/i18n.js` 的 `TOPIC_ZH`。新增中文词只需加一行：键为中文，值为 TradingView 上真实存在的主题（转成连字符后 `/scripts/<值>/` 可访问）。

中文长句也能匹配，例如「帮我找超级趋势的指标」会命中 `supertrend`；匹配时取最长命中键，所以「趋势跟踪」不会被「趋势」抢先。

若中文词没有收录，会返回一条中文提示，列出可用词样例，不会静默失败。

## 示例提问

装好之后，直接用自然语言问就行：

- 「找出 TradingView 上最热门的 10 个趋势跟踪策略，并把最火那个的 Pine 源码给我看」
- 「抓 100 个剥头皮策略，然后告诉我哪些用了基于 ATR 的止损」
- 「LuxAlgo 最近发布了哪些指标？」
- 「获取 https://www.tradingview.com/script/K0SEi3Ct-Some-Indicator/ 的源码，并解释它的入场逻辑」
- 「在我的本地库里搜索所有调用 `strategy.exit` 并带移动止损的策略」

更高效的用法是「抓一次，之后离线」：

```
harvest_scripts  query="趋势跟踪"  script_type=strategies  max_scripts=100
query_corpus     source_contains="strategy.entry"  with_source_only=true
get_script_source script_id_part="PUB;..."
```

## TradingView 的搜索到底怎么工作

值得了解，因为这解释了工具的设计取舍。TradingView 有两套搜索入口，质量差别很大：

| 入口 | 质量 |
|---|---|
| Slug 路由 `/scripts/trend-following/` | 经过人工归类，结果确实切题 |
| JSON API `/api/v1/scripts/?q=` | 相关性差，只用于 `by=<用户名>` |

所以 `search_scripts` 走 slug 路由，`list_author_scripts` 才走 JSON API。这也是为什么主题词必须是「单个概念的英文短语」（或本汉化版收录的中文词），而不能是任意关键词组合。

所有列表请求都会带上 `script_access=open`，因此受保护（闭源）脚本永远不会出现在结果里——列表里的每一条都能取到源码。

## 限流与避免被封

抓取行为本身有风险，因此内置了多层保护（默认值偏保守，宁可慢一点也不要被封 IP）：

- 请求之间随机延迟 1.5–4.5 秒（固定间隔才是最明显的机器人特征）
- 每 25 次请求后长休息 20–60 秒
- 每个自然日（UTC）硬上限 2000 次请求，跨会话统计
- 连续 3 次遇到 429/403 触发熔断，冷却 15 分钟
- 指数退避重试，最大 4 次
- 启动时先访问站点获取 Cookie，模拟真实浏览器

`fetch_status` 可以随时查看这些状态。

## 配置项

全部可选，全部通过环境变量设置。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `IF_DB_PATH` | `data/indicator_fetch.db` | 语料库位置 |
| `IF_MIN_DELAY_MS` / `IF_MAX_DELAY_MS` | 1500 / 4500 | 请求间隔窗口（毫秒） |
| `IF_BREAK_EVERY` | 25 | 每多少次请求插入一次长休息 |
| `IF_BREAK_MIN_MS` / `IF_BREAK_MAX_MS` | 20000 / 60000 | 长休息窗口（毫秒） |
| `IF_DAILY_BUDGET` | 2000 | 每日请求硬上限 |
| `IF_BREAKER_THRESHOLD` | 3 | 连续被拦几次后熔断 |
| `IF_BREAKER_COOLDOWN_MS` | 900000 | 熔断持续时间 |
| `IF_LISTING_TTL_MS` | 21600000 | 列表缓存有效期（源码永不过期） |
| `IF_HARVEST_MAX` | 200 | 单次抓取的脚本数上限 |
| `IF_SNIPPET_CHARS` | 300 | 列表中描述摘要的长度 |

同时运行多个 MCP 客户端没问题：它们共享同一个 SQLite 文件（WAL 模式，可安全并发），因此也共享每日请求预算——这是合理的，因为它们共用同一个出口 IP。

## 常见问题

**需要 TradingView 账号或 API Key 吗？**
不需要。全部使用公开接口，无需登录、无需 Cookie。

**能拿到仅限邀请或闭源的指标吗？**
不能。TradingView 从不对外暴露这类脚本的 Pine 代码，这是技术限制，不是本工具的限制。遇到这类脚本会返回明确说明，不会返回垃圾数据。

**Claude Desktop、Claude Code、Cursor 都能用吗？**
能，任何支持 MCP 的客户端都可以。服务器走 stdio 传输。

**会被 TradingView 封 IP 吗？**
默认配置已考虑到这一点：随机延迟、定期长休息、每日硬上限、熔断器。只要不把延迟调到 0，风险很低。

**能收集多少脚本？**
单次抓取上限 200 个脚本（`IF_HARVEST_MAX`），但可以反复抓取累积到本地库，库本身没有上限。

**数据存在哪里？**
`data/indicator_fetch.db`（SQLite）。删掉这个文件就清空本地库。

**能在 Pine 代码内部搜索吗？**
能，这是 `query_corpus` 的 `source_contains` 参数，也是本工具相对网站的核心优势。前提是这些脚本的源码已经抓取到本地。

**抓取 TradingView 是否合规？**
请自行判断并遵守 TradingView 的服务条款。本项目仅供学习研究使用。

## 汉化说明

本分支在原版基础上做了以下改动，升级上游代码时请留意冲突：

| 文件 | 改动 |
|---|---|
| `src/i18n.js` | **新增**。中文主题词表 `TOPIC_ZH`（约 90 个词）、`translateTopic()` 翻译函数、集中管理的中文提示语 `MSG` |
| `src/server.js` | 7 个工具的名称说明、全部参数说明改为中文；错误前缀改为「错误：」 |
| `src/tools.js` | `search_scripts` / `harvest_scripts` 接入中文主题翻译（输出新增 `query_translated` 字段）；返回的 note、next_step 等提示改为中文；错误改为中文 |
| `src/tradingview.js` | 全部面向用户的错误提示改为中文（保留必要的英文关键词，如 `script_type`、`hyphenated`） |
| `test/integration.test.js` | 5 处断言从英文文案改为对应中文文案 |
| `test/i18n.test.js` | **新增**。中文翻译层的单元测试（精确匹配、包含匹配、最长键优先、英文放行、未知词报错） |

测试：`npx vitest run`（当前 51 项全部通过）。

**接口字段名（JSON 的 key）保持英文不变**，因为它们是 Agent 读取的数据契约，翻译会破坏兼容性；汉化只涉及描述、提示和错误文案。

## 开发

```bash
npm test          # vitest 全量测试
npm run smoke     # 真实网络冒烟测试（需要能访问 tradingview.com）
```

项目结构：

```
src/server.js       MCP 工具注册与 stdio 传输
src/tools.js        工具实现（返回纯对象，由 server 包装）
src/tradingview.js  TradingView 接口层：URL 构造、缓存、字段归一化
src/parse.js        三个响应格式的纯解析函数（无 I/O，便于测试）
src/http.js         HTTP 客户端：Cookie、重试、退避
src/throttle.js     限流、每日预算、熔断
src/db.js           SQLite 语料库：脚本、源码、缓存、抓取任务、FTS5
src/i18n.js         汉化层：中文主题词映射与中文提示语
```

## 许可证

MIT，与原项目一致。原项目版权归 daviddme 所有，见 `LICENSE` 与 `NOTICE.md`。
