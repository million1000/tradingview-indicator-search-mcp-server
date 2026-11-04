/**
 * TradingView endpoint layer: URL construction, caching, and normalisation.
 *
 * Two search surfaces exist and they are not equally good:
 *   - slug routes (/scripts/<slug>/) are curated and give genuinely on-topic results
 *   - /api/v1/scripts/?q= has poor relevance, so it is used only for `by=<username>`
 */
import { TV_ORIGIN, FACADE_ORIGIN } from './config.js';
import { parseSlugFeed, parseAuthorFeed, parseFacade, slugify, ACCESS_OPEN } from './parse.js';
import { HttpError } from './http.js';

/** Callers may pass singular or plural; the API wants plural. */
const TYPE_MAP = {
  indicator: 'indicators',
  indicators: 'indicators',
  strategy: 'strategies',
  strategies: 'strategies',
  library: 'libraries',
  libraries: 'libraries',
  all: 'all',
};

export function normalizeScriptType(t) {
  if (!t) return null;
  const key = String(t).toLowerCase();
  return TYPE_MAP[key] ?? null;
}

export class TradingView {
  constructor({ config, http, store }) {
    this.config = config;
    this.http = http;
    this.store = store;
  }

  // ---- listings ----------------------------------------------------------

  /**
   * Topical/keyword search, or the top feed when `query` is omitted.
   * `script_access=open` is always sent, so protected scripts never appear.
   */
  async searchScripts({ query = null, scriptType = null, sort = null, page = 1 } = {}) {
    const slug = query ? slugify(query) : null;
    if (query && !slug) {
      throw new Error(
        `查询词“${query}”无法生成可用的主题 slug（只接受英文字母和数字）。` +
          `请使用英文主题，或使用内置中文主题词（如“趋势跟踪”“剥头皮”）。`
      );
    }
    return this.#slugFeed({
      segment: slug,
      page,
      scriptType,
      sort,
      kind: 'search',
      label: slug ?? 'top',
    });
  }

  async editorsPicks({ scriptType = null, sort = null, page = 1 } = {}) {
    return this.#slugFeed({
      segment: 'editors-picks',
      page,
      scriptType,
      sort,
      kind: 'editors_picks',
      label: 'editors-picks',
    });
  }

  async #slugFeed({ segment, page, scriptType, sort, kind, label }) {
    const type = normalizeScriptType(scriptType);
    if (scriptType && !type) {
      throw new Error(
        `未知的 script_type "${scriptType}"（Unknown script_type）。` +
          `可用值：indicators（指标）、strategies（策略）、libraries（库）、all（全部）。`
      );
    }

    const parts = ['/scripts'];
    if (segment) parts.push(segment);
    if (page && page > 1) parts.push(`page-${page}`);
    const pathname = `${parts.join('/')}/`;

    const url = new URL(pathname, TV_ORIGIN);
    url.searchParams.set('component-data-only', '1');
    if (type) url.searchParams.set('script_type', type);
    if (sort) url.searchParams.set('sort', sort);
    url.searchParams.set('script_access', 'open');

    const cacheKey = `${kind}:${url.pathname}?${url.searchParams.toString()}`;
    const cached = this.store?.getCachedSearch(cacheKey, this.config.listingTtlMs);
    if (cached) return { ...cached.payload, from_cache: true };

    const refererPath = segment ? `/scripts/${segment}/` : '/scripts/';
    let json;
    try {
      json = await this.http.getJson(url.toString(), {
        referer: new URL(refererPath, TV_ORIGIN).toString(),
      });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(
          `TradingView 上没有“${label}”这个主题页面。主题需为连字符形式（hyphenated）的 ` +
            `单个概念，例如 "trend-following"、"scalping"、"order-blocks"；` +
            `中文主题词（趋势跟踪、剥头皮、订单块等）也受支持。请换一个更宽泛或不同表述的主题。`
        );
      }
      throw err;
    }

    const parsed = parseSlugFeed(json);
    const result = this.#finalise(parsed, { page, kind, label, type, sort });
    this.store?.putCachedSearch(cacheKey, kind, { page, type, sort, label }, result);
    return result;
  }

  /** Scripts published by one author, via the JSON API. */
  async authorScripts({ username, query = '', page = 1, perPage = 24 } = {}) {
    if (!username) throw new Error('username 不能为空');
    const url = new URL('/api/v1/scripts/', TV_ORIGIN);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(Math.min(Math.max(perPage, 1), 24)));
    url.searchParams.set('by', username);
    url.searchParams.set('q', query ?? '');

    const cacheKey = `author:${url.searchParams.toString()}`;
    const cached = this.store?.getCachedSearch(cacheKey, this.config.listingTtlMs);
    if (cached) return { ...cached.payload, from_cache: true };

    let json;
    try {
      json = await this.http.getJson(url.toString(), {
        referer: `${TV_ORIGIN}/u/${encodeURIComponent(username)}/`,
      });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 400 || err.status === 404)) {
        throw new Error(
          `TradingView 拒绝了这个用户名“${username}”。用户名不区分大小写，但其余字符必须完全一致，` +
            `例如 "TraderlifestyleYT"。`
        );
      }
      throw err;
    }

    const parsed = parseAuthorFeed(json);
    const result = this.#finalise(parsed, { page, kind: 'author', label: username });
    this.store?.putCachedSearch(cacheKey, 'author', { username, query, page }, result);
    return result;
  }

  /**
   * Drop protected scripts, persist the rest, and attach result metadata.
   * Filtered items are counted rather than silently dropped.
   */
  #finalise(parsed, meta) {
    const open = parsed.items.filter((i) => i.script_access === ACCESS_OPEN);
    const filtered = parsed.items.length - open.length;
    if (this.store) this.store.upsertScripts(open);
    return {
      ...meta,
      total: parsed.total,
      returned: open.length,
      filtered_protected: filtered,
      has_more: parsed.has_more,
      heading: parsed.heading ?? null,
      items: open,
      from_cache: false,
    };
  }

  // ---- source ------------------------------------------------------------

  /**
   * Fetch Pine source. Cache-first: sources are immutable for a given version, so a
   * cached hit costs no request at all.
   */
  async getSource({ scriptIdPart, version = 'last', force = false } = {}) {
    if (!scriptIdPart) throw new Error('script_id_part 不能为空');
    if (!/^(PUB|USER);[A-Za-z0-9]+$/i.test(scriptIdPart)) {
      throw new Error(
        `“${scriptIdPart}”不是合法的 script_id_part。正确格式形如 "PUB;<哈希>"，` +
          `每个搜索结果里都带有这个字段。仅提供图表 URL 是不够的：请改用 chart_url 参数，系统会自动解析。`
      );
    }

    if (!force) {
      const hit = this.store?.getSource(scriptIdPart, version);
      if (hit) {
        return {
          ok: true,
          from_cache: true,
          script_id_part: scriptIdPart,
          version: hit.version,
          script_name: hit.script_name,
          kind: hit.kind,
          pine_version: hit.pine_version,
          source: hit.source,
          source_chars: hit.source?.length ?? 0,
        };
      }
    }

    const known = this.store?.getScript(scriptIdPart);
    if (known && known.open_source === 0) {
      return {
        ok: false,
        protected: true,
        script_id_part: scriptIdPart,
        reason:
          '该脚本为闭源脚本（仅限邀请或受保护）。TradingView 从不公开其 Pine 代码，' +
          '因此无法获取，也不会再重试。',
      };
    }

    const url = `${FACADE_ORIGIN}/pine-facade/get/${encodeURIComponent(scriptIdPart)}/${encodeURIComponent(
      String(version)
    )}?no_4xx=true`;

    let json;
    try {
      json = await this.http.getJson(url, {
        origin: TV_ORIGIN,
        referer: `${TV_ORIGIN}/`,
        sameSite: 'same-site',
        xhr: false,
      });
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        this.store?.markProtected(scriptIdPart);
        return {
          ok: false,
          protected: true,
          script_id_part: scriptIdPart,
          reason: 'TradingView 拒绝提供源码（闭源或仅限邀请）。',
        };
      }
      if (err instanceof HttpError && err.status === 404) {
        throw new Error(
          `未找到 ${scriptIdPart} 的 "${version}" 版本，可尝试 version "last"。`
        );
      }
      throw err;
    }

    const parsed = parseFacade(json, { scriptIdPart });
    if (!parsed.ok) {
      this.store?.markProtected(scriptIdPart);
      return { ...parsed, from_cache: false };
    }

    this.store?.putSource({
      script_id_part: scriptIdPart,
      version: parsed.version ?? version,
      source: parsed.source,
      pine_version: parsed.pine_version,
      kind: parsed.kind,
      script_name: parsed.script_name,
    });

    return { ...parsed, from_cache: false };
  }
}
