/**
 * Tool implementations. Each returns a plain object; the server wraps it as MCP
 * text content.
 *
 * Response-size discipline matters here. Descriptions run to thousands of characters
 * and sources to tens of thousands, so listings return snippets and bulk operations
 * return manifests. Full source is only ever returned when explicitly asked for, a
 * few at a time.
 */
import crypto from 'node:crypto';
import { toListing, extractIdFromChartUrl } from './parse.js';
import { TV_ORIGIN } from './config.js';
import { translateTopic, MSG, TOPIC_HINT_ZH } from './i18n.js';

const PUB_ID_RE = /(PUB|USER);[0-9a-fA-F]{32}/g;

export function createTools({ config, tv, store, throttle, http }) {
  const listing = (items) => items.map((i) => toListing(i, config.snippetChars));

  /** Resolve a pasted chart URL to a script_id_part, using the corpus before the network. */
  async function resolveChartUrl(chartUrl) {
    const slug = extractIdFromChartUrl(chartUrl);
    if (!slug) {
      throw new Error(
        `无法从 "${chartUrl}" 中解析出脚本 ID。正确格式类似：` +
          `https://www.tradingview.com/script/K0SEi3Ct-Some-Name/`
      );
    }

    const row = store.db
      .prepare('SELECT script_id_part FROM scripts WHERE chart_url LIKE ? LIMIT 1')
      .get(`%/script/${slug}%`);
    if (row?.script_id_part) return row.script_id_part;

    // Not seen before: the chart page embeds the id, so one HTML fetch resolves it.
    const html = await http.getText(`${TV_ORIGIN}/script/${slug}/`);
    const matches = [...String(html).matchAll(PUB_ID_RE)].map((m) => m[0]);
    const pub = matches.find((m) => m.startsWith('PUB;')) ?? matches[0];
    if (!pub) {
      throw new Error(`无法把 ${chartUrl} 解析为 script_id_part。`);
    }
    return pub;
  }

  return {
    // ---------------------------------------------------------------- search
    async search_scripts({ query, script_type, sort, page = 1 } = {}) {
      const topic = translateTopic(query);
      const res = await tv.searchScripts({
        query: topic.query,
        scriptType: script_type,
        sort,
        page,
      });
      return {
        query: query ?? null,
        query_translated: topic.translated ? topic.query : undefined,
        topic: res.label,
        page,
        total_available: res.total,
        returned: res.returned,
        has_more: res.has_more,
        from_cache: res.from_cache,
        note: res.total >= 1000 ? MSG.cappedNote : undefined,
        topic_hint: query ? undefined : TOPIC_HINT_ZH,
        items: listing(res.items),
      };
    },

    async list_editors_picks({ script_type, sort, page = 1 } = {}) {
      const res = await tv.editorsPicks({ scriptType: script_type, sort, page });
      return {
        feed: 'editors-picks',
        page,
        total_available: res.total,
        returned: res.returned,
        has_more: res.has_more,
        from_cache: res.from_cache,
        items: listing(res.items),
      };
    },

    async list_author_scripts({ username, query = '', page = 1 } = {}) {
      const res = await tv.authorScripts({ username, query, page });
      return {
        author: username,
        page,
        total_available: res.total,
        returned: res.returned,
        filtered_protected: res.filtered_protected,
        has_more: res.has_more,
        from_cache: res.from_cache,
        items: listing(res.items),
      };
    },

    // ---------------------------------------------------------------- source
    async get_script_source({ script_id_part, chart_url, version = 'last', force = false } = {}) {
      let id = script_id_part;
      if (!id && chart_url) id = await resolveChartUrl(chart_url);
      if (!id) throw new Error(MSG.needIdOrUrl);

      const res = await tv.getSource({ scriptIdPart: id, version, force });
      if (!res.ok) return res;

      const meta = store.getScript(id);
      return {
        ok: true,
        script_id_part: id,
        name: res.script_name ?? meta?.name ?? null,
        author: meta?.author ?? null,
        script_type: res.script_type ?? meta?.script_type ?? null,
        version: res.version,
        pine_version: res.pine_version,
        source_chars: res.source_chars ?? res.source?.length ?? 0,
        from_cache: res.from_cache,
        chart_url: meta?.chart_url ?? null,
        source: res.source,
      };
    },

    // --------------------------------------------------------------- harvest
    /**
     * Bulk collection. Works within a wall-clock budget and checkpoints as it goes,
     * so a long harvest is resumed by calling again with the returned harvest_id
     * rather than restarting.
     */
    async harvest_scripts({
      source = 'search',
      query,
      username,
      script_type,
      sort,
      max_scripts = 100,
      fetch_sources = true,
      time_budget_ms,
      harvest_id,
    } = {}) {
      const deadline = Date.now() + (time_budget_ms ?? config.harvestTimeBudgetMs);
      const cap = Math.min(max_scripts, config.harvestMaxScripts);

      let harvest;
      if (harvest_id) {
        harvest = store.getHarvest(harvest_id);
        if (!harvest) throw new Error(MSG.unknownHarvest(harvest_id));
        if (harvest.status === 'complete') {
          return { harvest_id, status: 'complete', note: MSG.alreadyComplete, ...summarise(harvest) };
        }
      } else {
        // 中文主题词在这里同样需要翻译成 TradingView 主题
        const topic = translateTopic(query);
        const spec = {
          source,
          query: topic.query,
          username,
          script_type,
          sort,
          cap,
          fetch_sources,
        };
        if (source === 'search' && !query) {
          // Allowed: an empty query harvests the top feed.
        }
        if (source === 'author' && !username) {
          throw new Error(MSG.authorRequired);
        }
        harvest = store.createHarvest(crypto.randomUUID().slice(0, 8), spec);
      }

      const spec = harvest.spec;
      const cursor = harvest.cursor;
      cursor.page ??= 1;
      cursor.seen ??= [];
      cursor.pending ??= [];
      cursor.done_listing ??= false;

      let scriptsSeen = harvest.scripts_seen ?? 0;
      let sourcesStored = harvest.sources_stored ?? 0;
      let listingErrors = 0;

      const timeLeft = () => Date.now() < deadline;

      while (timeLeft()) {
        // Phase 1: page through the listing.
        if (!cursor.done_listing && cursor.seen.length < spec.cap) {
          let res;
          try {
            res =
              spec.source === 'author'
                ? await tv.authorScripts({ username: spec.username, page: cursor.page })
                : spec.source === 'editors_picks'
                  ? await tv.editorsPicks({
                      scriptType: spec.script_type,
                      sort: spec.sort,
                      page: cursor.page,
                    })
                  : await tv.searchScripts({
                      query: spec.query,
                      scriptType: spec.script_type,
                      sort: spec.sort,
                      page: cursor.page,
                    });
          } catch (err) {
            listingErrors += 1;
            cursor.done_listing = true;
            store.updateHarvest(harvest.id, {
              cursor,
              scripts_seen: scriptsSeen,
              sources_stored: sourcesStored,
              status: 'paused',
              note: `Listing stopped: ${err.message}`,
            });
            throw err;
          }

          for (const item of res.items) {
            if (cursor.seen.length >= spec.cap) break;
            if (cursor.seen.includes(item.script_id_part)) continue;
            cursor.seen.push(item.script_id_part);
            if (spec.fetch_sources && !store.hasSource(item.script_id_part)) {
              cursor.pending.push(item.script_id_part);
            }
          }
          scriptsSeen = cursor.seen.length;
          cursor.page += 1;
          if (!res.has_more || cursor.seen.length >= spec.cap) cursor.done_listing = true;

          store.updateHarvest(harvest.id, {
            cursor,
            scripts_seen: scriptsSeen,
            sources_stored: sourcesStored,
            status: 'running',
          });
          continue;
        }

        // Phase 2: fill in sources one at a time.
        if (spec.fetch_sources && cursor.pending.length) {
          const next = cursor.pending.shift();
          try {
            const got = await tv.getSource({ scriptIdPart: next });
            if (got.ok) sourcesStored += 1;
          } catch (err) {
            store.updateHarvest(harvest.id, {
              cursor,
              scripts_seen: scriptsSeen,
              sources_stored: sourcesStored,
              status: 'paused',
              note: `Source fetch stopped: ${err.message}`,
            });
            throw err;
          }
          store.updateHarvest(harvest.id, {
            cursor,
            scripts_seen: scriptsSeen,
            sources_stored: sourcesStored,
            status: 'running',
          });
          continue;
        }

        break;
      }

      const complete = cursor.done_listing && (!spec.fetch_sources || cursor.pending.length === 0);
      const saved = store.updateHarvest(harvest.id, {
        cursor,
        scripts_seen: scriptsSeen,
        sources_stored: sourcesStored,
        status: complete ? 'complete' : 'paused',
      });

      const preview = store
        .queryCorpus({ limit: 20 })
        .filter((r) => cursor.seen.includes(r.script_id_part))
        .map((r) => ({
          script_id_part: r.script_id_part,
          name: r.name,
          author: r.author,
          script_type: r.script_type,
          likes: r.likes,
          has_source: Boolean(r.has_source),
        }));

      return {
        harvest_id: saved.id,
        status: saved.status,
        scripts_seen: scriptsSeen,
        sources_stored: sourcesStored,
        sources_pending: cursor.pending.length,
        listing_errors: listingErrors,
        next_step:
          saved.status === 'complete' ? MSG.harvestDone : MSG.harvestPaused(saved.id),
        preview,
      };
    },

    // ---------------------------------------------------------------- corpus
    query_corpus({
      query,
      source_contains,
      script_type,
      author,
      with_source_only = false,
      min_likes = 0,
      limit = 25,
      include_source = false,
    } = {}) {
      const effectiveLimit = include_source ? Math.min(limit, 3) : Math.min(limit, 100);
      const rows = store.queryCorpus({
        query,
        sourceContains: source_contains,
        scriptType: script_type,
        author,
        withSourceOnly: with_source_only || Boolean(source_contains),
        minLikes: min_likes,
        limit: effectiveLimit,
      });

      return {
        matched: rows.length,
        limit_applied: effectiveLimit,
        include_source,
        note: include_source ? MSG.includeSourceCap : MSG.includeSourceHint,
        corpus: store.stats(),
        items: rows.map((r) => ({
          script_id_part: r.script_id_part,
          name: r.name,
          author: r.author,
          script_type: r.script_type,
          likes: r.likes,
          symbol: r.symbol,
          interval: r.interval,
          chart_url: r.chart_url,
          pine_version: r.pine_version,
          has_source: Boolean(r.has_source),
          source_chars: r.source_chars ?? 0,
          description_snippet: r.description ? r.description.replace(/\s+/g, ' ').slice(0, config.snippetChars) : '',
          ...(include_source && r.has_source
            ? { source: store.getSource(r.script_id_part)?.source ?? null }
            : {}),
        })),
      };
    },

    // ---------------------------------------------------------------- status
    fetch_status() {
      return {
        throttle: throttle.status(),
        corpus: store.stats(),
        pacing: {
          delay_between_requests_ms: [config.minDelayMs, config.maxDelayMs],
          long_break_every_n_requests: config.breakEvery,
          long_break_ms: [config.breakMinMs, config.breakMaxMs],
          circuit_breaker_after_consecutive_blocks: config.breakerThreshold,
          circuit_cooldown_ms: config.breakerCooldownMs,
        },
      };
    },
  };
}

function summarise(harvest) {
  return {
    scripts_seen: harvest.scripts_seen,
    sources_stored: harvest.sources_stored,
  };
}
