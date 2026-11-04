import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Store } from '../src/db.js';
import { Throttle } from '../src/throttle.js';
import { TradingView } from '../src/tradingview.js';
import { createTools } from '../src/tools.js';
import { config as baseConfig } from '../src/config.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));

const config = { ...baseConfig, dbPath: ':memory:', snippetChars: 120, harvestMaxScripts: 200 };

/** Records every URL requested and replays fixtures, so no network is touched. */
function fakeHttp(routes) {
  const calls = [];
  return {
    calls,
    async warmUp() {},
    async getJson(url) {
      calls.push(url);
      for (const [pattern, value] of routes) {
        if (url.includes(pattern)) {
          if (value instanceof Error) throw value;
          return typeof value === 'function' ? value(url) : value;
        }
      }
      throw new Error(`No fake route for ${url}`);
    },
    async getText(url) {
      calls.push(url);
      return '<html>PUB;5bbd9e495f604c3682671a0e8920a188 and USER;747343354ba641a1973907f549b1cd10</html>';
    },
  };
}

function build(routes) {
  const store = new Store(':memory:');
  const throttle = new Throttle(config, { sleep: async () => {}, countToday: () => 0 });
  const http = fakeHttp(routes);
  const tv = new TradingView({ config, http, store });
  const tools = createTools({ config, tv, store, throttle, http });
  return { store, throttle, http, tv, tools };
}

describe('Store', () => {
  let store;
  beforeEach(() => {
    store = new Store(':memory:');
  });

  it('upserts a script idempotently', () => {
    const s = { script_id_part: 'PUB;a', name: 'One', author: 'bob', likes: 5, open_source: true };
    store.upsertScript(s);
    store.upsertScript({ ...s, likes: 9 });
    expect(store.stats().scripts).toBe(1);
    expect(store.getScript('PUB;a').likes).toBe(9);
  });

  it('stores and retrieves source, defaulting to the newest version', () => {
    store.upsertScript({ script_id_part: 'PUB;a', name: 'One', open_source: true });
    store.putSource({ script_id_part: 'PUB;a', version: '1', source: '//@version=5', pine_version: 5 });
    expect(store.hasSource('PUB;a')).toBe(true);
    expect(store.getSource('PUB;a', '1').source).toBe('//@version=5');
    expect(store.getSource('PUB;a').source).toBe('//@version=5');
    expect(store.getSource('PUB;missing')).toBe(null);
  });

  it('counts requests per UTC day for the budget', () => {
    const day1 = Date.parse('2026-07-25T10:00:00Z');
    const day2 = Date.parse('2026-07-26T10:00:00Z');
    store.logRequest({ host: 'h', path: '/a', status: 200, ms: 5 }, day1);
    store.logRequest({ host: 'h', path: '/b', status: 200, ms: 5 }, day1);
    store.logRequest({ host: 'h', path: '/c', status: 200, ms: 5 }, day2);
    expect(store.countRequestsToday(day1)).toBe(2);
    expect(store.countRequestsToday(day2)).toBe(1);
  });

  it('expires cached listings past the TTL', () => {
    const t0 = 1_000_000;
    store.putCachedSearch('k', 'search', {}, { total: 1, items: [] }, t0);
    expect(store.getCachedSearch('k', 5000, t0 + 1000)).not.toBe(null);
    expect(store.getCachedSearch('k', 5000, t0 + 9000)).toBe(null);
  });

  it('merges cookie jars and expires them', () => {
    store.putCookieJar('h', 'a=1; b=2', 1000);
    expect(store.getCookieJar('h', 5000, 2000)).toBe('a=1; b=2');
    expect(store.getCookieJar('h', 500, 2000)).toBe(null);
  });
});

describe('Store.queryCorpus', () => {
  let store;
  beforeEach(() => {
    store = new Store(':memory:');
    store.upsertScript({
      script_id_part: 'PUB;a',
      name: 'Supertrend Pro',
      author: 'alice',
      script_type: 'strategy',
      likes: 100,
      open_source: true,
      description: 'A trend following strategy',
    });
    store.putSource({
      script_id_part: 'PUB;a',
      version: '1',
      source: 'strategy("x")\nta.supertrend(3, 10)',
      pine_version: 5,
    });
    store.upsertScript({
      script_id_part: 'PUB;b',
      name: 'RSI Basic',
      author: 'bob',
      script_type: 'indicator',
      likes: 10,
      open_source: true,
      description: 'A mean reversion oscillator',
    });
  });

  it('full-text matches names and descriptions', () => {
    expect(store.queryCorpus({ query: 'supertrend' }).map((r) => r.script_id_part)).toEqual(['PUB;a']);
    expect(store.queryCorpus({ query: 'reversion' }).map((r) => r.script_id_part)).toEqual(['PUB;b']);
  });

  it('finds literal code tokens the FTS tokeniser would split', () => {
    const hits = store.queryCorpus({ sourceContains: 'ta.supertrend' });
    expect(hits.map((r) => r.script_id_part)).toEqual(['PUB;a']);
  });

  it('filters by type, author and likes, and sorts by likes', () => {
    expect(store.queryCorpus({ scriptType: 'strategy' })).toHaveLength(1);
    expect(store.queryCorpus({ author: 'ALICE' })).toHaveLength(1);
    expect(store.queryCorpus({ minLikes: 50 })).toHaveLength(1);
    expect(store.queryCorpus({}).map((r) => r.likes)).toEqual([100, 10]);
  });

  it('can restrict to scripts whose source is stored', () => {
    expect(store.queryCorpus({ withSourceOnly: true })).toHaveLength(1);
  });
});

describe('TradingView listings', () => {
  it('builds the right URL for page 1 and later pages', async () => {
    const { tv, http } = build([['/scripts/', load('slug-feed-scalping.json')]]);
    await tv.searchScripts({ query: 'trend following' });
    await tv.searchScripts({ query: 'trend following', page: 3, scriptType: 'strategies' });

    expect(http.calls[0]).toContain('/scripts/trend-following/?');
    expect(http.calls[0]).not.toContain('page-');
    expect(http.calls[0]).toContain('script_access=open');
    expect(http.calls[1]).toContain('/scripts/trend-following/page-3/');
    expect(http.calls[1]).toContain('script_type=strategies');
  });

  it('accepts singular script types and rejects unknown ones', async () => {
    const { tv, http } = build([['/scripts/', load('slug-feed-scalping.json')]]);
    await tv.searchScripts({ query: 'x', scriptType: 'strategy' });
    expect(http.calls[0]).toContain('script_type=strategies');
    await expect(tv.searchScripts({ query: 'x', scriptType: 'nonsense' })).rejects.toThrow(
      /Unknown script_type/
    );
  });

  it('omits the slug entirely for the top feed', async () => {
    const { tv, http } = build([['/scripts/', load('slug-feed-general.json')]]);
    await tv.searchScripts({});
    expect(http.calls[0]).toContain('/scripts/?');
  });

  it('serves the second identical call from cache without a request', async () => {
    const { tv, http } = build([['/scripts/', load('slug-feed-scalping.json')]]);
    const a = await tv.searchScripts({ query: 'scalping' });
    const b = await tv.searchScripts({ query: 'scalping' });
    expect(a.from_cache).toBe(false);
    expect(b.from_cache).toBe(true);
    expect(http.calls).toHaveLength(1);
  });

  it('persists every listed script into the corpus', async () => {
    const { tv, store } = build([['/scripts/', load('slug-feed-scalping.json')]]);
    const res = await tv.searchScripts({ query: 'scalping' });
    expect(store.stats().scripts).toBe(res.returned);
  });

  it('filters protected scripts out and reports how many', async () => {
    const feed = load('slug-feed-scalping.json');
    feed.data.ideas.data.items[0].script_access = 2;
    feed.data.ideas.data.items[1].script_access = 3;
    const { tv } = build([['/scripts/', feed]]);
    const res = await tv.searchScripts({ query: 'scalping' });
    expect(res.filtered_protected).toBe(2);
    expect(res.items.every((i) => i.open_source)).toBe(true);
  });

  it('explains a 404 slug in terms the caller can act on', async () => {
    const err = Object.assign(new Error('HTTP 404'), { status: 404, name: 'HttpError' });
    Object.setPrototypeOf(err, (await import('../src/http.js')).HttpError.prototype);
    const { tv } = build([['/scripts/', err]]);
    await expect(tv.searchScripts({ query: 'not a real topic' })).rejects.toThrow(/hyphenated/);
  });

  it('parses the author feed and targets the right endpoint', async () => {
    const { tv, http } = build([['/api/v1/scripts/', load('author-feed.json')]]);
    const res = await tv.authorScripts({ username: 'TraderlifestyleYT' });
    expect(res.total).toBe(8);
    expect(http.calls[0]).toContain('by=TraderlifestyleYT');
    expect(res.items[0].author).toBe('TraderlifestyleYT');
  });
});

describe('TradingView.getSource', () => {
  const routes = [['pine-facade', load('facade-open.json')]];

  it('fetches, stores, then serves from cache without another request', async () => {
    const { tv, http } = build(routes);
    const a = await tv.getSource({ scriptIdPart: 'PUB;5bbd9e495f604c3682671a0e8920a188' });
    expect(a.ok).toBe(true);
    expect(a.from_cache).toBe(false);
    expect(a.pine_version).toBe(6);

    const b = await tv.getSource({ scriptIdPart: 'PUB;5bbd9e495f604c3682671a0e8920a188' });
    expect(b.from_cache).toBe(true);
    expect(b.source).toBe(a.source);
    expect(http.calls).toHaveLength(1);
  });

  it('url-encodes the semicolon in the script id', async () => {
    const { tv, http } = build(routes);
    await tv.getSource({ scriptIdPart: 'PUB;5bbd9e495f604c3682671a0e8920a188' });
    expect(http.calls[0]).toContain('PUB%3B5bbd9e495f604c3682671a0e8920a188');
    expect(http.calls[0]).toContain('no_4xx=true');
  });

  it('rejects a malformed id before making any request', async () => {
    const { tv, http } = build(routes);
    await expect(tv.getSource({ scriptIdPart: 'K0SEi3Ct' })).rejects.toThrow(/不是合法的 script_id_part/);
    expect(http.calls).toHaveLength(0);
  });

  it('treats a refusal as protected and never retries it', async () => {
    const { tv, http, store } = build([['pine-facade', load('facade-protected.json')]]);
    const a = await tv.getSource({ scriptIdPart: 'PUB;ba544ec71a3945549669f3babb981424' });
    expect(a.ok).toBe(false);
    expect(a.protected).toBe(true);
    expect(store.getScript('PUB;ba544ec71a3945549669f3babb981424')?.open_source).toBe(0);

    const b = await tv.getSource({ scriptIdPart: 'PUB;ba544ec71a3945549669f3babb981424' });
    expect(b.ok).toBe(false);
    expect(http.calls).toHaveLength(1); // the second call cost nothing
  });
});

describe('tools', () => {
  it('search_scripts returns snippets, never full descriptions', async () => {
    const { tools } = build([['/scripts/', load('slug-feed-general.json')]]);
    const res = await tools.search_scripts({ query: 'trend following' });
    expect(res.items.length).toBeGreaterThan(0);
    for (const item of res.items) {
      expect(item).not.toHaveProperty('description');
      expect(item.description_snippet.length).toBeLessThanOrEqual(121);
    }
  });

  it('search_scripts flags the 1000-result cap', async () => {
    const { tools } = build([['/scripts/', load('slug-feed-general.json')]]);
    const res = await tools.search_scripts({});
    expect(res.note).toMatch(/数量上限是 1000 条/);
  });

  it('get_script_source resolves a pasted chart URL', async () => {
    const { tools } = build([['pine-facade', load('facade-open.json')]]);
    const res = await tools.get_script_source({
      chart_url: 'https://www.tradingview.com/script/K0SEi3Ct-TL-PbD-Shape-Pro/',
    });
    expect(res.ok).toBe(true);
    expect(res.script_id_part).toBe('PUB;5bbd9e495f604c3682671a0e8920a188');
    expect(res.source).toContain('@version=6');
  });

  it('get_script_source requires some identifier', async () => {
    const { tools } = build([]);
    await expect(tools.get_script_source({})).rejects.toThrow(/script_id_part 或 chart_url/);
  });

  it('query_corpus caps results hard when full source is requested', async () => {
    const { tools, store } = build([]);
    for (let i = 0; i < 10; i += 1) {
      store.upsertScript({
        script_id_part: `PUB;${i}`,
        name: `S${i}`,
        author: 'a',
        likes: i,
        open_source: true,
      });
      store.putSource({ script_id_part: `PUB;${i}`, version: '1', source: 'strategy("s")' });
    }
    const wide = tools.query_corpus({ limit: 50 });
    expect(wide.items).toHaveLength(10);
    expect(wide.items[0]).not.toHaveProperty('source');

    const deep = tools.query_corpus({ limit: 50, include_source: true });
    expect(deep.items).toHaveLength(3);
    expect(deep.items[0].source).toBe('strategy("s")');
  });
});

describe('harvest_scripts', () => {
  const feed = () => load('slug-feed-scalping.json');

  it('collects listings and sources, then reports complete', async () => {
    const { tools, store } = build([
      ['/scripts/', (url) => (url.includes('page-') ? emptyFeed() : feed())],
      ['pine-facade', load('facade-open.json')],
    ]);
    const res = await tools.harvest_scripts({ query: 'scalping', max_scripts: 5 });
    expect(res.status).toBe('complete');
    expect(res.scripts_seen).toBe(5);
    expect(res.sources_stored).toBe(5);
    expect(store.stats().sources).toBe(5);
    expect(res.preview.length).toBeGreaterThan(0);
    expect(res.preview[0]).not.toHaveProperty('source');
  });

  it('pauses on the time budget and resumes from the same cursor', async () => {
    const { tools } = build([
      ['/scripts/', (url) => (url.includes('page-') ? emptyFeed() : feed())],
      ['pine-facade', load('facade-open.json')],
    ]);
    const first = await tools.harvest_scripts({
      query: 'scalping',
      max_scripts: 5,
      time_budget_ms: 5000,
      fetch_sources: false,
    });
    expect(first.scripts_seen).toBe(5);

    const resumed = await tools.harvest_scripts({ harvest_id: first.harvest_id });
    expect(resumed.harvest_id).toBe(first.harvest_id);
    expect(resumed.scripts_seen).toBe(5);
  });

  it('refuses an unknown harvest_id rather than starting over', async () => {
    const { tools } = build([]);
    await expect(tools.harvest_scripts({ harvest_id: 'nope' })).rejects.toThrow(/未知的 harvest_id/);
  });

  it('requires a username when harvesting an author', async () => {
    const { tools } = build([]);
    await expect(tools.harvest_scripts({ source: 'author' })).rejects.toThrow(/必须提供 username/);
  });

  it('never exceeds the configured hard cap', async () => {
    const { tools } = build([
      ['/scripts/', (url) => (url.includes('page-') ? emptyFeed() : feed())],
      ['pine-facade', load('facade-open.json')],
    ]);
    const res = await tools.harvest_scripts({
      query: 'scalping',
      max_scripts: 999,
      fetch_sources: false,
    });
    expect(res.scripts_seen).toBeLessThanOrEqual(200);
  });

  it('skips sources already cached instead of refetching them', async () => {
    const { tools, store, http } = build([
      ['/scripts/', (url) => (url.includes('page-') ? emptyFeed() : feed())],
      ['pine-facade', load('facade-open.json')],
    ]);
    const listed = load('slug-feed-scalping.json').data.ideas.data.items.slice(0, 3);
    for (const raw of listed) {
      store.putSource({ script_id_part: raw.script_id_part, version: '1', source: 'cached' });
    }
    const before = http.calls.length;
    const res = await tools.harvest_scripts({ query: 'scalping', max_scripts: 3 });
    const facadeCalls = http.calls.slice(before).filter((u) => u.includes('pine-facade'));
    expect(facadeCalls).toHaveLength(0);
    expect(res.status).toBe('complete');
  });
});

function emptyFeed() {
  return {
    data: { ideas: { data: { total: 0, items: [], next: null } } },
    meta: { heading: 'none' },
  };
}
