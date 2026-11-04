#!/usr/bin/env node
/**
 * indicator_fetch — local MCP server for discovering TradingView indicators and
 * strategies and pulling their Pine source for backtesting.
 *
 *   claude mcp add indicator_fetch -s user -- node /ABS/PATH/indicator_fetch/src/server.js
 *
 * No TradingView account or cookie is required: every endpoint used here is public.
 * All outbound traffic is paced, capped and circuit-broken (see throttle.js).
 */

// node:sqlite is stable enough for our use but still emits an experimental warning.
// It would otherwise appear in the client's stderr on every start.
const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/i.test(data.message)) {
    return false;
  }
  return emit.call(this, name, data, ...rest);
};

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { config } from './config.js';
import { Store } from './db.js';
import { Throttle } from './throttle.js';
import { HttpClient } from './http.js';
import { TradingView } from './tradingview.js';
import { createTools } from './tools.js';

const store = new Store(config.dbPath);
const throttle = new Throttle(config, { countToday: () => store.countRequestsToday() });
const http = new HttpClient({ config, throttle, store });
const tv = new TradingView({ config, http, store });
const tools = createTools({ config, tv, store, throttle, http });

const server = new McpServer({ name: 'indicator_fetch', version: '1.0.0' });

/** Wrap a plain async impl as an MCP tool handler returning JSON text content. */
function wrap(fn, { warm = false } = {}) {
  return async (args) => {
    try {
      if (warm) await http.warmUp();
      const out = await fn(args || {});
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      // 网络层失败（status 0）在国内网络环境下最常见，给出可操作的中文提示
      const offlineHint =
        err?.status === 0
          ? '　【提示】无法连接 TradingView。请确认网络可访问 tradingview.com；' +
            '该域名在中国大陆需要代理/VPN 才能访问，DevSidecar 这类加速工具无法绕过。'
          : '';
      return {
        content: [
          { type: 'text', text: `错误：${err?.message ?? String(err)}${offlineHint}` },
        ],
        isError: true,
      };
    }
  };
}

const SCRIPT_TYPE = z
  .enum(['indicators', 'strategies', 'libraries', 'all'])
  .optional()
  .describe('按类型过滤：indicators=指标、strategies=策略、libraries=函数库、all=全部。不填则不过滤。');

const SORT = z
  .enum(['latest_popular', 'recent_extended'])
  .optional()
  .describe('排序方式：latest_popular（默认，按知名度优先）、recent_extended（最新发布优先）。');

server.tool(
  'search_scripts',
  '按主题搜索 TradingView 上公开的指标与策略，例如“趋势跟踪”“剥头皮”“订单块”“均值回归”“成交量分布”。' +
    '主题搜索由 TradingView 官方人工整理，效果远好于自由关键词匹配。' +
    '支持中文主题词，会自动翻译为 TradingView 的英文主题；也可直接传英文主题。' +
    '省略 query 则返回热门/趋势榜单。结果只包含开源脚本，因此列出的每个脚本都能用 get_script_source 取回 Pine 源码。' +
    '返回的是描述摘要（snippet），不是完整描述。',
  {
    query: z
      .string()
      .optional()
      .describe('主题词，例如“趋势跟踪”或 "trend following"。中文会自动翻译，并转为连字符 slug。'),
    script_type: SCRIPT_TYPE,
    sort: SORT,
    page: z.number().int().min(1).max(50).optional().describe('页码，从 1 开始，每页 24 条。'),
  },
  wrap(tools.search_scripts, { warm: true })
);

server.tool(
  'list_editors_picks',
  'TradingView 编辑精选（editors\' picks）：官方人工挑选的高质量社区脚本。' +
    '当你想要经过验证、质量可靠的指标，而不是大范围撒网时，这是最好的起点。',
  {
    script_type: SCRIPT_TYPE,
    sort: SORT,
    page: z.number().int().min(1).max(50).optional().describe('页码，从 1 开始，每页 24 条。'),
  },
  wrap(tools.list_editors_picks, { warm: true })
);

server.tool(
  'list_author_scripts',
  '列出一个 TradingView 作者发布的全部公开脚本，例如 "TraderlifestyleYT"、"LuxAlgo"、' +
    '"ZenAndTheArtOfTrading"。当你有偏好的作者、想看他全部作品时使用。可用 query 进一步筛选。',
  {
    username: z.string().describe('TradingView 用户名（不区分大小写，其余需完全一致）。'),
    query: z.string().optional().describe('在该作者脚本内做进一步筛选的可选关键词。'),
    page: z.number().int().min(1).max(50).optional().describe('页码，从 1 开始。'),
  },
  wrap(tools.list_author_scripts, { warm: true })
);

server.tool(
  'get_script_source',
  '获取某个脚本的完整 Pine Script 源码，可直接用于回测或移植。' +
    '可以传搜索结果里的 script_id_part（形如 "PUB;<哈希>"），也可以直接粘贴 TradingView 的 chart_url 由本工具解析。' +
    '源码按版本永久缓存，重复调用不消耗请求。闭源脚本会返回明确的说明，而不是无用的内容。',
  {
    script_id_part: z.string().optional().describe('例如 "PUB;5bbd9e495f604c3682671a0e8920a188"。'),
    chart_url: z
      .string()
      .optional()
      .describe('例如 "https://www.tradingview.com/script/K0SEi3Ct-Some-Name/"。'),
    version: z.string().optional().describe('默认 "last"，几乎所有情况下都对。'),
    force: z.boolean().optional().describe('跳过缓存重新抓取，一般不需要。'),
  },
  wrap(tools.get_script_source, { warm: true })
);

server.tool(
  'harvest_scripts',
  '批量抓取大量脚本及其 Pine 源码，一次性存入本地语料库，例如“100 个趋势跟踪策略”。' +
    '这是搭建回测库的高效方式：网络开销只在这里付一次，之后用 query_corpus 纯离线检索。' +
    '每次调用在固定时间预算内运行并自动存档；如果返回 status="paused" 属正常情况，' +
    '用同一个 harvest_id 再调用一次即可继续。返回数量统计和小预览，不返回源码正文。',
  {
    source: z
      .enum(['search', 'editors_picks', 'author'])
      .optional()
      .describe('抓取来源：search（主题搜索，默认）、editors_picks（编辑精选）、author（指定作者）。'),
    query: z.string().optional().describe('主题词，source="search" 时使用（支持中文）。'),
    username: z.string().optional().describe('作者名，source="author" 时必填。'),
    script_type: SCRIPT_TYPE,
    sort: SORT,
    max_scripts: z.number().int().min(1).max(200).optional().describe('默认 100，上限 200。'),
    fetch_sources: z
      .boolean()
      .optional()
      .describe('默认 true。设为 false 只收集元数据，速度快很多。'),
    time_budget_ms: z
      .number()
      .int()
      .min(5000)
      .max(600000)
      .optional()
      .describe('本次调用的时间预算（毫秒），默认 120000。'),
    harvest_id: z.string().optional().describe('续跑一个已暂停的抓取任务。'),
  },
  wrap(tools.harvest_scripts, { warm: true })
);

server.tool(
  'query_corpus',
  '在本地已收集的语料中检索。零网络请求、即时返回，而且能搜索 Pine 源码内部——这是 TradingView 网站做不到的。' +
    'source_contains 用于精确代码片段（如 "ta.supertrend"、"strategy.entry"）；' +
    'query 用于对名称、作者、描述做全文检索。再次联网抓取前，先试这个。',
  {
    query: z.string().optional().describe('对名称、作者、描述、代码做全文检索（FTS5）。'),
    source_contains: z
      .string()
      .optional()
      .describe('在 Pine 代码内做字面量包含匹配，例如 "ta.supertrend"。'),
    script_type: z
      .enum(['indicator', 'strategy', 'library', 'all'])
      .optional()
      .describe('按类型过滤：indicator=指标、strategy=策略、library=库、all=全部。'),
    author: z.string().optional().describe('按作者名过滤。'),
    with_source_only: z.boolean().optional().describe('只返回已存有 Pine 源码的脚本。'),
    min_likes: z.number().int().min(0).optional().describe('最少点赞数（热度门槛）。'),
    limit: z.number().int().min(1).max(100).optional().describe('返回条数，默认 25。'),
    include_source: z
      .boolean()
      .optional()
      .describe('返回完整 Pine 代码。因源码体积大，会强制把 limit 压到 3。'),
  },
  wrap(tools.query_corpus)
);

server.tool(
  'fetch_status',
  '查看限流健康度与语料库规模：当日请求预算已用多少、熔断器是否触发、当前请求节奏设置，' +
    '以及本地已存了多少脚本和源码。不产生任何网络请求。',
  {},
  wrap(tools.fetch_status)
);

function shutdown() {
  try {
    store.close();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const transport = new StdioServerTransport();
await server.connect(transport);
