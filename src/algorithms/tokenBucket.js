/**
 * Token Bucket Rate Limiter
 * =========================
 * Classic algorithm used by AWS API Gateway, Stripe, and most FAANG APIs.
 *
 * Concept:
 *   - A bucket holds up to `capacity` tokens.
 *   - Tokens are added at `refillRate` tokens/second (continuously).
 *   - Each request consumes `tokensPerRequest` tokens.
 *   - If the bucket has insufficient tokens → request is denied (429).
 *
 * Properties:
 *   ✓ Allows short bursts up to `capacity` requests
 *   ✓ Enforces sustained rate of `refillRate` req/s
 *   ✓ Smooth output (no thundering herd at window boundaries)
 *
 * Time complexity: O(1) per check
 * Space complexity: O(k) where k = number of unique keys
 */

"use strict";

class TokenBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacity         - Max tokens (burst size)
   * @param {number} opts.refillRate       - Tokens added per second
   * @param {number} [opts.tokensPerReq=1] - Tokens consumed per request
   * @param {object} store                 - Key-value store (MemoryStore or RedisStore)
   */
  constructor({ capacity, refillRate, tokensPerReq = 1 }, store) {
    if (capacity <= 0) throw new Error("capacity must be > 0");
    if (refillRate <= 0) throw new Error("refillRate must be > 0");

    this.capacity = capacity;
    this.refillRate = refillRate;       // tokens/second
    this.tokensPerReq = tokensPerReq;
    this.store = store;
    this.name = "token_bucket";
  }

  /**
   * Check and consume tokens for a given key.
   *
   * @param {string} key - Client identifier (IP, user ID, API key, etc.)
   * @returns {Promise<{allowed: boolean, remaining: number, retryAfter: number}>}
   */
  async check(key) {
    const storeKey = `tb:${key}`;
    const now = Date.now() / 1000; // seconds with fractional part

    const existing = await this.store.get(storeKey);

    let tokens, lastRefill;

    if (!existing) {
      // New key: start with full bucket
      tokens = this.capacity;
      lastRefill = now;
    } else {
      tokens = existing.tokens;
      lastRefill = existing.lastRefill;

      // Refill tokens based on elapsed time
      const elapsed = now - lastRefill;
      const newTokens = elapsed * this.refillRate;
      tokens = Math.min(this.capacity, tokens + newTokens);
      lastRefill = now;
    }

    if (tokens >= this.tokensPerReq) {
      tokens -= this.tokensPerReq;
      await this.store.set(storeKey, { tokens, lastRefill });
      return {
        allowed: true,
        remaining: Math.floor(tokens),
        retryAfter: 0,
        algorithm: this.name,
      };
    } else {
      await this.store.set(storeKey, { tokens, lastRefill });
      const deficit = this.tokensPerReq - tokens;
      const retryAfter = Math.ceil(deficit / this.refillRate * 1000); // ms
      return {
        allowed: false,
        remaining: 0,
        retryAfter,
        algorithm: this.name,
      };
    }
  }

  async reset(key) {
    await this.store.del(`tb:${key}`);
  }
}

module.exports = TokenBucket;
