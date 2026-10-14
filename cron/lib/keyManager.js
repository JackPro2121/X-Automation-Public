/**
 * Multi-key API manager with automatic fallback.
 * When the primary key is exhausted (429/quota), rotates to the next key.
 * Reports key status for Slack notifications.
 *
 * Usage:
 *   const keys = createKeyManager('APIFY', [
 *     process.env.APIFY_API_KEY,
 *     process.env.APIFY_API_KEY_2,
 *     process.env.APIFY_API_KEY_3,
 *   ]);
 *   const result = await keys.execute(async (key) => fetchWithKey(key));
 *   console.log(keys.getStatus()); // for Slack reporting
 */

/**
 * @param {string} provider — label (e.g. 'APIFY')
 * @param {(string|undefined)[]} keyValues — array of env var values
 * @returns {KeyManager}
 */
export function createKeyManager(provider, keyValues) {
  return new KeyManager(provider, keyValues);
}

class KeyManager {
  constructor(provider, keyValues) {
    this.provider = provider;
    this.keys = keyValues.filter(Boolean);
    this.currentIndex = 0;
    // Track per-key health
    this.keyStatus = this.keys.map(() => ({
      exhausted: false,
      lastError: null,
      lastUsed: null,
      successCount: 0,
      failCount: 0,
    }));
  }

  get totalKeys() { return this.keys.length; }
  get availableKeys() { return this.keyStatus.filter(s => !s.exhausted).length; }

  /**
   * Execute a function with automatic key rotation on failure.
   * @param {(key: string) => Promise<any>} fn
   * @returns {Promise<any>}
   */
  async execute(fn) {
    if (this.keys.length === 0) {
      throw new Error(`[${this.provider}] No API keys configured`);
    }

    let lastError = null;

    for (let attempt = 0; attempt < this.keys.length; attempt++) {
      const idx = (this.currentIndex + attempt) % this.keys.length;
      const status = this.keyStatus[idx];

      // Skip exhausted keys
      if (status.exhausted) continue;

      const key = this.keys[idx];
      status.lastUsed = new Date().toISOString();

      try {
        const result = await fn(key);
        status.successCount++;
        status.lastError = null;
        // Move to this key for next call (sticky — prefer working key)
        this.currentIndex = idx;
        return result;
      } catch (err) {
        lastError = err;
        status.failCount++;
        status.lastError = err.message;
        console.warn(`  ⚠ [${this.provider}] Key #${idx + 1} failed: ${err.message}`);

        // Mark exhausted on rate limit / quota errors
        if (this.isExhaustedError(err)) {
          status.exhausted = true;
          console.warn(`  🔴 [${this.provider}] Key #${idx + 1} EXHAUSTED — will skip`);
        }
      }
    }

    throw new Error(`[${this.provider}] All ${this.keys.length} keys failed. Last error: ${lastError?.message}`);
  }

  /**
   * Check if error indicates key exhaustion (not a transient failure).
   */
  isExhaustedError(err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('429') ||
           msg.includes('401') ||     // Unauthorized — invalid/expired key
           msg.includes('402') ||
           msg.includes('403') ||        // Forbidden — key invalid or quota exhausted
           msg.includes('rate limit') ||
           msg.includes('quota') ||
           msg.includes('insufficient') ||
           msg.includes('too many requests') ||
           msg.includes('credit') ||
           msg.includes('forbidden');
  }

  /**
   * Get status report for Slack notifications.
   * @returns {{ provider: string, total: number, available: number, keys: object[] }}
   */
  getStatus() {
    return {
      provider: this.provider,
      total: this.totalKeys,
      available: this.availableKeys,
      keys: this.keyStatus.map((s, i) => ({
        index: i + 1,
        exhausted: s.exhausted,
        lastError: s.lastError ? s.lastError.substring(0, 80) : null,
        successes: s.successCount,
        failures: s.failCount,
        balance: s.balance || null,
        username: s.username || null,
        planId: s.planId || null,
        monthlyCredits: s.monthlyCredits || null,
      })),
    };
  }

  /**
   * Quick health check for all Apify keys.
   * Uses FREE /users/me endpoint (~1s per key, all in parallel).
   * Marks 403/quota keys as exhausted BEFORE scraping starts.
   * This prevents wasting 90s+ on dead keys during scraping.
   * @returns {Promise<void>}
   */
  async checkBalances() {
    if (this.provider !== 'APIFY') return;

    const checkPromises = this.keys.map(async (key, idx) => {
      // Skip already exhausted keys
      if (this.keyStatus[idx].exhausted) return;

      try {
        const res = await fetch(`https://api.apify.com/v2/users/me?token=${key}`, {
          signal: AbortSignal.timeout(8000)
        });
        if (res.ok) {
          const data = await res.json();
          const user = data.data;
          this.keyStatus[idx].username = user.username || user.email || 'unknown';
          this.keyStatus[idx].planId = user.plan?.id || 'FREE';
          this.keyStatus[idx].monthlyCredits = user.plan?.monthlyUsageCreditsUsd || 5;
          this.keyStatus[idx].maxMonthlyUsage = user.plan?.maxMonthlyUsageUsd || 10;
          const planDisplay = `${this.keyStatus[idx].planId} | $${this.keyStatus[idx].monthlyCredits}/mo`;
          console.log(`  💰 [APIFY] Key #${idx + 1} (${this.keyStatus[idx].username}): ${planDisplay}`);
        } else {
          // 401/402/403 = key exhausted — mark immediately, skip during scraping
          if (res.status === 403 || res.status === 402 || res.status === 401) {
            this.keyStatus[idx].exhausted = true;
            this.keyStatus[idx].username = 'exhausted';
            this.keyStatus[idx].planId = 'EXHAUSTED';
            console.log(`  🔴 [APIFY] Key #${idx + 1}: EXHAUSTED (${res.status}) — will skip`);
          } else {
            this.keyStatus[idx].username = 'error';
            this.keyStatus[idx].planId = 'unknown';
            console.log(`  ⚠ [APIFY] Key #${idx + 1}: Check failed (${res.status})`);
          }
        }
      } catch (err) {
        // Network error — don't mark exhausted (might be transient)
        this.keyStatus[idx].username = 'error';
        this.keyStatus[idx].planId = 'unknown';
        console.log(`  ⚠ [APIFY] Key #${idx + 1}: ${err.message}`);
      }
    });

    await Promise.all(checkPromises);

    const healthy = this.availableKeys;
    console.log(`  📊 Healthy keys: ${healthy}/${this.totalKeys}`);
  }
}
