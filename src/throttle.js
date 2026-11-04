/**
 * The rate-limit gate. Every outbound request in this server passes through
 * `Throttle.run()`, so no tool can bypass pacing by accident.
 *
 * Guarantees:
 *   - strictly sequential (concurrency of exactly 1, process-wide)
 *   - randomised delay between requests, never a fixed interval
 *   - a longer "human break" every N requests
 *   - a circuit breaker that stops all traffic after repeated 429/403
 *   - a hard daily request budget
 *
 * Timing dependencies are injectable so the tests can drive it without real waits.
 */

export class CircuitOpenError extends Error {
  constructor(msUntilReset) {
    const mins = Math.ceil(msUntilReset / 60000);
    super(
      `TradingView 限流熔断器已触发（circuit is OPEN）。因为连续被拦截，所有请求暂停约 ${mins} 分钟，` +
        `以避免 IP 被封。期间可以改用 query_corpus 对已缓存的脚本做离线检索。`
    );
    this.name = 'CircuitOpenError';
    this.retryAfterMs = msUntilReset;
  }
}

export class BudgetExceededError extends Error {
  constructor(budget) {
    super(
      `已达到每日请求上限 ${budget} 次。这是防止死循环的安全限制。额度在 UTC 00:00 重置；` +
        `如果确实需要更多，可调高环境变量 IF_DAILY_BUDGET。`
    );
    this.name = 'BudgetExceededError';
  }
}

export class Throttle {
  #queue = Promise.resolve();
  // Tracked separately from #lastRequestAt: a timestamp of 0 is a legitimate value
  // (notably under an injected test clock), so it cannot double as "never ran".
  #hasRun = false;
  #lastRequestAt = 0;
  #sinceBreak = 0;
  #consecutiveBlocks = 0;
  #openUntil = 0;
  #served = 0;

  /**
   * @param {object} config
   * @param {{now?:()=>number, sleep?:(ms:number)=>Promise<void>, random?:()=>number,
   *          countToday?:()=>number}} [deps]
   */
  constructor(config, deps = {}) {
    this.config = config;
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
    this.countToday = deps.countToday ?? (() => 0);
  }

  get isOpen() {
    return this.now() < this.#openUntil;
  }

  /** Queue `fn`, run it once pacing allows. Rejections propagate to the caller only. */
  async run(fn) {
    const task = this.#queue.then(() => this.#execute(fn));
    // Swallow on the chain itself, otherwise one failure would poison every
    // subsequent queued request and surface as an unhandled rejection.
    this.#queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  async #execute(fn) {
    if (this.isOpen) throw new CircuitOpenError(this.#openUntil - this.now());
    if (this.countToday() >= this.config.dailyBudget) {
      throw new BudgetExceededError(this.config.dailyBudget);
    }
    await this.#waitTurn();
    return fn();
  }

  async #waitTurn() {
    const gap = this.#jitter(this.config.minDelayMs, this.config.maxDelayMs);
    const elapsed = this.now() - this.#lastRequestAt;
    if (this.#hasRun && elapsed < gap) {
      await this.sleep(gap - elapsed);
    }

    if (this.config.breakEvery > 0 && this.#sinceBreak >= this.config.breakEvery) {
      this.#sinceBreak = 0;
      await this.sleep(this.#jitter(this.config.breakMinMs, this.config.breakMaxMs));
    }

    this.#sinceBreak += 1;
    this.#served += 1;
    this.#hasRun = true;
    this.#lastRequestAt = this.now();
  }

  #jitter(min, max) {
    if (max <= min) return min;
    return Math.round(min + this.random() * (max - min));
  }

  /** Record a block (429/403). Trips the breaker once they stack up. */
  noteBlocked() {
    this.#consecutiveBlocks += 1;
    if (this.#consecutiveBlocks >= this.config.breakerThreshold) {
      this.#openUntil = this.now() + this.config.breakerCooldownMs;
      this.#consecutiveBlocks = 0;
      return true;
    }
    return false;
  }

  /** Record a clean response, clearing the consecutive-block streak. */
  noteOk() {
    this.#consecutiveBlocks = 0;
  }

  status() {
    return {
      circuit_open: this.isOpen,
      circuit_reopens_in_ms: this.isOpen ? this.#openUntil - this.now() : 0,
      consecutive_blocks: this.#consecutiveBlocks,
      requests_this_process: this.#served,
      requests_today: this.countToday(),
      daily_budget: this.config.dailyBudget,
      requests_until_break: Math.max(0, this.config.breakEvery - this.#sinceBreak),
    };
  }
}
