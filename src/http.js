/**
 * HTTP layer. Everything goes through the Throttle, carries a realistic browser
 * header set, and reuses a persisted cookie jar.
 *
 * Why the cookie jar matters: a real browser accumulates cookies within a session.
 * Sending none on every request is itself an anomaly, so we warm up against the site
 * once and reuse what it gives us.
 */
import { CircuitOpenError } from './throttle.js';
import { TV_ORIGIN } from './config.js';

/**
 * UA and its matching sec-ch-ua are chosen once per process and then held constant.
 * Rotating mid-session would look less human, not more: real browsers do not change
 * their user agent between requests.
 */
const AGENTS = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    ch: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    platform: '"macOS"',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    ch: '"Google Chrome";v="149", "Chromium";v="149", "Not?A_Brand";v="24"',
    platform: '"macOS"',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    ch: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    platform: '"Windows"',
  },
];

export class HttpError extends Error {
  constructor(status, url, body) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class HttpClient {
  #warmed = false;

  constructor({ config, throttle, store, fetchImpl, random = Math.random, sleep }) {
    this.config = config;
    this.throttle = throttle;
    this.store = store;
    this.fetch = fetchImpl ?? globalThis.fetch;
    this.random = random;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.agent = AGENTS[Math.floor(random() * AGENTS.length)] ?? AGENTS[0];
  }

  #baseHeaders() {
    return {
      'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      priority: 'u=1, i',
      'sec-ch-ua': this.agent.ch,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': this.agent.platform,
      'user-agent': this.agent.ua,
    };
  }

  #cookieHeader(host) {
    const jar = this.store?.getCookieJar(host, this.config.cookieMaxAgeMs);
    return jar ? { cookie: jar } : {};
  }

  #absorbCookies(host, res) {
    if (!this.store) return;
    let pairs = [];
    try {
      pairs = res.headers.getSetCookie?.() ?? [];
    } catch {
      pairs = [];
    }
    if (!pairs.length) return;
    const existing = this.store.getCookieJar(host, this.config.cookieMaxAgeMs) ?? '';
    const jar = new Map();
    for (const chunk of existing.split(';')) {
      const kv = chunk.trim();
      if (!kv) continue;
      const i = kv.indexOf('=');
      if (i > 0) jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    for (const raw of pairs) {
      const first = String(raw).split(';')[0].trim();
      const i = first.indexOf('=');
      if (i > 0) jar.set(first.slice(0, i), first.slice(i + 1));
    }
    const serialised = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (serialised) this.store.putCookieJar(host, serialised);
  }

  /**
   * Fetch the scripts landing page once per cookie lifetime so we carry a plausible
   * jar. Costs one request roughly twice a day.
   */
  async warmUp() {
    if (this.#warmed) return;
    this.#warmed = true;
    const host = new URL(TV_ORIGIN).host;
    if (this.store?.getCookieJar(host, this.config.cookieMaxAgeMs)) return;
    try {
      await this.#attempt(`${TV_ORIGIN}/scripts/`, {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'none',
        'upgrade-insecure-requests': '1',
      }, 'text');
    } catch {
      // A failed warm-up is not fatal; the endpoints work without cookies.
    }
  }

  /** GET a TradingView XHR endpoint and return parsed JSON. */
  async getJson(url, { referer, origin, sameSite = 'same-origin', xhr = true } = {}) {
    const headers = {
      accept: xhr ? '*/*' : 'application/json, text/javascript, */*; q=0.01',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': sameSite,
    };
    if (referer) headers.referer = referer;
    if (origin) headers.origin = origin;
    if (xhr) {
      headers['x-language'] = 'en';
      headers['x-requested-with'] = 'XMLHttpRequest';
    }
    return this.#withRetry(url, headers, 'json');
  }

  /** GET an HTML page and return the raw body, used to resolve pasted chart URLs. */
  async getText(url, { referer } = {}) {
    const headers = {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': referer ? 'same-origin' : 'none',
      'upgrade-insecure-requests': '1',
    };
    if (referer) headers.referer = referer;
    return this.#withRetry(url, headers, 'text');
  }

  async #withRetry(url, headers, as) {
    let lastErr;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
      try {
        return await this.#attempt(url, headers, as);
      } catch (err) {
        lastErr = err;
        if (err instanceof CircuitOpenError) throw err;

        const status = err instanceof HttpError ? err.status : 0;
        const blocked = status === 429 || status === 403;
        const transient = blocked || status >= 500 || status === 0;
        if (!transient) throw err; // 400/404 are real answers, not worth retrying

        if (blocked) {
          const tripped = this.throttle.noteBlocked();
          if (tripped) {
            throw new CircuitOpenError(this.config.breakerCooldownMs);
          }
        }
        if (attempt === this.config.maxRetries) break;

        const backoff = Math.min(
          this.config.backoffMaxMs,
          this.config.backoffBaseMs * 2 ** attempt
        );
        const wait = err.retryAfterMs ?? Math.round(backoff * (0.5 + this.random()));
        await this.sleep(wait);
      }
    }
    throw lastErr;
  }

  async #attempt(url, extraHeaders, as) {
    const u = new URL(url);
    return this.throttle.run(async () => {
      const started = Date.now();
      const headers = {
        ...this.#baseHeaders(),
        ...this.#cookieHeader(u.host),
        ...extraHeaders,
      };
      let res;
      try {
        res = await this.fetch(url, {
          method: 'GET',
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
      } catch (err) {
        this.store?.logRequest({
          host: u.host,
          path: u.pathname,
          status: 0,
          ms: Date.now() - started,
          outcome: 'network_error',
        });
        const wrapped = new HttpError(0, url, String(err?.message ?? err));
        throw wrapped;
      }

      this.#absorbCookies(u.host, res);
      const ms = Date.now() - started;
      this.store?.logRequest({
        host: u.host,
        path: u.pathname,
        status: res.status,
        ms,
        outcome: res.ok ? 'ok' : 'http_error',
      });

      if (!res.ok) {
        const body = await safeText(res);
        const err = new HttpError(res.status, url, body.slice(0, 400));
        const retryAfter = Number(res.headers.get('retry-after'));
        if (Number.isFinite(retryAfter) && retryAfter > 0) err.retryAfterMs = retryAfter * 1000;
        throw err;
      }

      this.throttle.noteOk();
      if (as === 'text') return safeText(res);

      const text = await safeText(res);
      try {
        return JSON.parse(text);
      } catch {
        throw new HttpError(res.status, url, `预期返回 JSON，实际收到：${text.slice(0, 200)}`);
      }
    });
  }
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
