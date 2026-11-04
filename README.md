# TradingView Indicator Search MCP Server

> **中文文档：[README.zh-CN.md](README.zh-CN.md)** — 本仓已做中文汉化（中文主题词、中文工具说明与提示）。/ Chinese docs: see README.zh-CN.md.

**Search TradingView's public indicator and strategy library from Claude, Cursor, or any MCP client, and pull the full Pine Script source of any open-source script.**

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that turns
the entire public TradingView script library into a tool your AI coding agent can
query. Ask for "trend following strategies" or "everything by LuxAlgo", get back real
indicators with their Pine Script source, ready to read, adapt or backtest.

No TradingView account, API key, cookie or login required. Every endpoint used is public.

[![MCP](https://img.shields.io/badge/MCP-Model_Context_Protocol-blue)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-green)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-60_passing-brightgreen)](#development)
[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

---

## Contents

- [What this does](#what-this-does)
- [Quick start](#quick-start)
- [Install in Claude Code](#install-in-claude-code)
- [Install in Claude Desktop](#install-in-claude-desktop)
- [Install in Cursor](#install-in-cursor)
- [Tools](#tools)
- [Example prompts](#example-prompts)
- [How TradingView search actually works](#how-tradingview-search-actually-works)
- [Rate limiting and not getting banned](#rate-limiting-and-not-getting-banned)
- [Configuration](#configuration)
- [FAQ](#faq)
- [Development](#development)

---

## What this does

TradingView hosts hundreds of thousands of community-published indicators and
strategies written in Pine Script. Most are open source. This MCP server gives an AI
agent structured access to all of it:

- **Search by topic** — "trend following", "scalping", "order blocks", "mean reversion"
- **Browse editors' picks** — TradingView's hand-curated best scripts
- **Search by author** — every public script from a creator you follow
- **Fetch Pine Script source** — the complete code for any open-source script
- **Build a local library** — bulk-collect scripts into a SQLite corpus you can search
  offline, *including searching inside the Pine code itself*

That last point is the useful one. Once scripts are collected locally, you can find
every strategy that uses `ta.supertrend` or `strategy.entry` with a single instant
query. The TradingView website cannot do that.

## Quick start

```bash
git clone https://github.com/daviddme/tradingview-indicator-search-mcp-server.git
cd tradingview-indicator-search-mcp-server
npm install
```

Requires **Node.js 22.5 or newer** (it uses the built-in `node:sqlite`, so there is
no native module to compile and no database to install).

Then add it to your MCP client below.

## Install in Claude Code

```bash
claude mcp add tradingview -s user -- node "$(pwd)/src/server.js"
```

`-s user` makes it available in every project. Verify with:

```bash
claude mcp list
```

## Install in Claude Desktop

Edit `claude_desktop_config.json`:

- **macOS** — `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** — `%APPDATA%\Claude\claude_desktop_config.json`

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

> **Use the absolute path to `node`.** Desktop apps do not inherit your shell `PATH`,
> so a bare `"node"` fails with `spawn node ENOENT`. Find yours with `which node`.

Restart Claude Desktop.

## Install in Cursor

Edit `~/.cursor/mcp.json` with the same block as above, then restart Cursor.

Any MCP-compatible client works. The server speaks stdio, so it also runs in Windsurf,
Cline, Zed and others.

## Tools

| Tool | What it does |
|---|---|
| `search_scripts` | Search by topic: "trend following", "scalping", "order blocks". Omit the query for the top/trending feed |
| `list_editors_picks` | TradingView's hand-curated editors' picks, the highest quality per result |
| `list_author_scripts` | Every public script by one author |
| `get_script_source` | Full Pine Script source, by script ID or a pasted TradingView chart URL |
| `harvest_scripts` | Bulk-collect scripts and their source into the local corpus. Resumable |
| `query_corpus` | Search the local corpus offline, including full-text search inside Pine code |
| `fetch_status` | Rate-limit health and corpus size. Makes no network request |

## Example prompts

Once installed, just ask your agent in plain language:

> "Find me the top 10 trend-following strategies on TradingView and show me the Pine
> Script for the most popular one."

> "Harvest 100 scalping strategies, then show me which ones use ATR-based stop losses."

> "What indicators has LuxAlgo published recently?"

> "Get the source for https://www.tradingview.com/script/K0SEi3Ct-Some-Indicator/ and
> explain how its entry logic works."

> "Search my local corpus for every strategy that calls `strategy.exit` with a trailing
> stop."

**The efficient pattern** is to harvest once, then work offline:

```
harvest_scripts   query="trend following" script_type=strategies max_scripts=100
query_corpus      source_contains="strategy.entry" with_source_only=true
get_script_source script_id_part="PUB;..."
```

## How TradingView search actually works

Worth knowing, because it explains the tool design. TradingView exposes two search
surfaces and they are **not** equally good:

| Surface | Quality |
|---|---|
| Slug routes — `/scripts/trend-following/` | Curated and genuinely on-topic |
| JSON API — `/api/v1/scripts/?q=trend+following` | Poor relevance. Top result was "Split Volume + Signals" |

So topic search uses the slug routes, and the JSON API is used only for
`by=<username>` author lookups, which is the one thing it does well.

Undocumented filters compose with topics, and the API helpfully declares its own
query schema in every response under `data.ideas.params`:

- `script_type` — `indicators` | `strategies` | `libraries` | `all`
- `script_access` — `open` | `all`
- `sort` — `latest_popular` | `recent_extended`

Every script carries a `script_id_part` (`PUB;<hash>`) and `version`, which together
address the Pine source endpoint. Passing `last` as the version always resolves to the
current one.

## Rate limiting and not getting banned

This is the part most scrapers get wrong, so it is enforced at the lowest level:
**every outbound request passes through a single throttle and no tool can bypass it.**

- **Strictly sequential** — concurrency of exactly 1, process-wide. Never parallel
- **Randomised delays** of 1.5 to 4.5s between requests. A *fixed* interval is the
  clearest bot signature there is, so the gap is jittered every time
- **Human break pattern** — a 20 to 60s pause roughly every 25 requests
- **Persistent cookie jar** — real browsers accumulate cookies, and sending none on
  every request is itself anomalous. The server warms up once per 12h and reuses the jar
- **Stable browser identity** — user agent and its matching `sec-ch-ua` are chosen once
  per process and held constant, because real browsers do not change UA mid-session
- **Exponential backoff** on 429/403/5xx, honouring `Retry-After`
- **Circuit breaker** — after 3 consecutive blocks, all traffic stops for 15 minutes
  and tools return a clear error. Without this, a rate-limited agent retries straight
  into a hard ban. This is the single most important safeguard here
- **Daily budget** of 2000 requests, so a runaway agent loop cannot burn your IP overnight
- **Cache-first** — Pine source is immutable per version, so a cached source is never
  refetched. This cuts request volume more than everything else combined

Run `fetch_status` at any time to see budget use and breaker state.

> **Run this locally, on a residential connection.** Hosting it on a cloud provider
> puts requests on a datacenter IP, which sites like TradingView block far more
> aggressively than home connections, and a block would hit an egress IP you do not
> control.

## Configuration

All optional, all environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `IF_DB_PATH` | `data/indicator_fetch.db` | Corpus location |
| `IF_MIN_DELAY_MS` / `IF_MAX_DELAY_MS` | 1500 / 4500 | Delay window between requests |
| `IF_BREAK_EVERY` | 25 | Requests between long breaks |
| `IF_BREAK_MIN_MS` / `IF_BREAK_MAX_MS` | 20000 / 60000 | Long break window |
| `IF_DAILY_BUDGET` | 2000 | Hard daily request cap |
| `IF_BREAKER_THRESHOLD` | 3 | Consecutive blocks before the breaker trips |
| `IF_BREAKER_COOLDOWN_MS` | 900000 | How long the breaker stays open |
| `IF_LISTING_TTL_MS` | 21600000 | Listing cache lifetime. Source never expires |
| `IF_HARVEST_MAX` | 200 | Hard cap on scripts per harvest |
| `IF_SNIPPET_CHARS` | 300 | Description snippet length in listings |

Running several MCP clients at once is fine. They share one SQLite file (WAL mode, so
concurrent access is safe) and therefore share the daily request budget, which is
correct because they share one IP.

## FAQ

### Do I need a TradingView account or API key?

No. Every endpoint this uses is public and unauthenticated. There is no login, no API
key and no cookie to configure.

### Can it fetch invite-only or closed-source indicators?

No, and nothing can. TradingView never exposes the Pine source of protected scripts.
Searches filter them out by default so every result you see can actually be fetched.

### Does this work with Claude Desktop, Claude Code and Cursor?

Yes, all three, plus any other MCP client that speaks stdio. See the install sections
above. It does **not** work with claude.ai in the browser, which requires a publicly
hosted HTTPS connector rather than a local process.

### Will this get my IP banned by TradingView?

The whole design is built to avoid that: sequential requests, randomised human-like
delays, periodic breaks, a daily budget and a circuit breaker that halts everything
after repeated blocks. Run it locally rather than from a datacenter, and leave the
conservative defaults alone unless you have a reason.

### How many scripts can I collect?

TradingView caps broad result counts at 1000, so narrow topics give better coverage
than broad ones. A single `harvest_scripts` call is capped at 200 scripts by default,
and it is resumable, so larger libraries are built across several calls.

### Where is the data stored?

In a local SQLite file, `data/indicator_fetch.db` by default. Nothing is uploaded
anywhere. Change the location with `IF_DB_PATH`.

### Can I search inside the Pine Script code?

Yes, and this is the main reason to build a local corpus. `query_corpus` supports
full-text search over names, authors and descriptions, plus literal substring matching
inside the source with `source_contains`, which is what you want for code tokens like
`ta.supertrend` that a full-text tokeniser would split apart.

### Is scraping TradingView allowed?

This reads public pages the same way a browser does, at a much slower rate than a
person clicking around. You are responsible for your own use of it, including
TradingView's Terms of Service, and for respecting the licences of any Pine Script you
collect. Script authors retain copyright in their code.

## Development

```bash
npm test
```

60 tests, fully offline. Parsers run against real captured API payloads in
`test/fixtures/` (see [the fixtures note](test/fixtures/README.md) on what was
redacted for redistribution), and the throttle is tested with an injected clock so no
test ever waits.

```bash
npm run smoke
```

Live end-to-end check against TradingView. Makes about 5 real requests.

### Project layout

| File | Responsibility |
|---|---|
| `src/server.js` | MCP wiring and tool definitions |
| `src/tools.js` | Tool implementations and response shaping |
| `src/tradingview.js` | Endpoint construction, caching, normalisation |
| `src/http.js` | Headers, cookie jar, retry and backoff |
| `src/throttle.js` | The rate-limit gate, circuit breaker and budget |
| `src/db.js` | SQLite corpus and full-text search |
| `src/parse.js` | Pure parsers for the three response shapes |

## License

MIT. See [LICENSE](LICENSE).

Pine Script collected with this tool remains the copyright of its original authors on
TradingView. This project is not affiliated with or endorsed by TradingView. See
[NOTICE.md](NOTICE.md).

---

**Keywords:** TradingView MCP server, TradingView MCP, Model Context Protocol
TradingView, Pine Script MCP server, TradingView indicators API, Pine Script scraper,
TradingView strategy search, MCP server for trading, Claude TradingView integration,
Cursor TradingView MCP, AI trading indicators, TradingView Pine Script source code,
backtesting indicators with AI.
