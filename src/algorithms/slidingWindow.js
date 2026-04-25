/**
 * Sliding Window Counter Rate Limiter
 * =====================================
 * Used by Cloudflare, Nginx, and Google's Apigee.
 *
 * Concept:
 *   Approximates a sliding window by weighting the previous window's count
 *   based on how much of it overlaps with the current window.
 *
 *   count = prevCount × (1 - elapsed/windowMs) + currCount
 *
 *   This avoids the "burst at boundary" problem of fixed windows while
 *   being much cheaper than storing per-request timestamps.
 *
 * Example (limit=100 req/min):
 *   - Previous window: 80 requests
 *   - Current window started 30s ago (50% through)
 *   - Weighted count = 80 × 0.5 + current = 40 + current
 *   - Remaining budget = 100 - (40 + current)
 *
 * Error bound: ≤ max_limit × (1 - overlap) — typically <1% with short windows
 *
 * Time complexity: O(1)
 * Space complexity: O(k) where k = unique keys
 */

"use strict";

class SlidingWindowCounter {
  /**
   * @param {object} opts
   * @param {number} opts.limit      - Max requests per window
   * @param {number} opts.windowMs   - Window size in milliseconds
   * @param {object} store
   */
  constructor({ limit, windowMs }, store) {
    if (limit <= 0) throw new Error("limit must be > 0");
    if (windowMs <= 0) throw new Error("windowMs must be > 0");

    this.limit = limit;
    this.windowMs = windowMs;
    this.store = store;
    this.name = "sliding_window_counter";
  }

  async check(key) {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.windowMs);
    const prevWindow = currentWindow - 1;
    const elapsed = now - currentWindow * this.windowMs; // ms into current window
    const overlap = 1 - elapsed / this.windowMs;         // fraction of prev window still "active"

    const currKey = `swc:${key}:${currentWindow}`;
    const prevKey = `swc:${key}:${prevWindow}`;

    const [currData, prevData] = await Promise.all([
      this.store.get(currKey),
      this.store.get(prevKey),
    ]);

    const currCount = currData ? currData.count : 0;
    const prevCount = prevData ? prevData.count : 0;

    // Weighted approximation of requests in the sliding window
    const weightedCount = prevCount * overlap + currCount;

    if (weightedCount < this.limit) {
      // Increment current window counter
      const newCount = currCount + 1;
      const ttl = this.windowMs * 2; // keep two windows
      await this.store.set(currKey, { count: newCount }, ttl);

      return {
        allowed: true,
        remaining: Math.floor(this.limit - weightedCount - 1),
        retryAfter: 0,
        windowResetAt: (currentWindow + 1) * this.windowMs,
        algorithm: this.name,
      };
    } else {
      const resetAt = (currentWindow + 1) * this.windowMs;
      return {
        allowed: false,
        remaining: 0,
        retryAfter: resetAt - now,
        windowResetAt: resetAt,
        algorithm: this.name,
      };
    }
  }

  async reset(key) {
    const now = Date.now();
    const currentWindow = Math.floor(now / this.windowMs);
    await Promise.all([
      this.store.del(`swc:${key}:${currentWindow}`),
      this.store.del(`swc:${key}:${currentWindow - 1}`),
    ]);
  }
}

module.exports = SlidingWindowCounter;
