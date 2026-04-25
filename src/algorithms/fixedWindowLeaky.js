/**
 * Fixed Window Counter
 * ====================
 * Simplest algorithm — used as a baseline / fallback.
 * Counts requests in fixed time buckets. Cheapest to implement.
 * Known issue: allows 2x burst at window boundaries.
 */

"use strict";

class FixedWindow {
  constructor({ limit, windowMs }, store) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.store = store;
    this.name = "fixed_window";
  }

  async check(key) {
    const now = Date.now();
    const window = Math.floor(now / this.windowMs);
    const storeKey = `fw:${key}:${window}`;

    const data = await this.store.get(storeKey);
    const count = data ? data.count : 0;

    if (count < this.limit) {
      await this.store.set(storeKey, { count: count + 1 }, this.windowMs + 1000);
      return {
        allowed: true,
        remaining: this.limit - count - 1,
        retryAfter: 0,
        windowResetAt: (window + 1) * this.windowMs,
        algorithm: this.name,
      };
    }

    const resetAt = (window + 1) * this.windowMs;
    return {
      allowed: false,
      remaining: 0,
      retryAfter: resetAt - now,
      windowResetAt: resetAt,
      algorithm: this.name,
    };
  }

  async reset(key) {
    const window = Math.floor(Date.now() / this.windowMs);
    await this.store.del(`fw:${key}:${window}`);
  }
}

/**
 * Leaky Bucket
 * ============
 * Models a bucket with a hole: requests fill the bucket, and they drain
 * (are processed) at a fixed rate. Excess overflows (is rejected).
 *
 * Guarantees a perfectly smooth output rate — ideal for protecting
 * downstream services from spikes.
 *
 * Key difference from Token Bucket:
 *   - Token Bucket: controls AVERAGE rate, allows bursts up to capacity
 *   - Leaky Bucket: controls INSTANTANEOUS rate, no bursts allowed
 */
class LeakyBucket {
  /**
   * @param {object} opts
   * @param {number} opts.capacity  - Max queue depth (bucket size)
   * @param {number} opts.drainRate - Requests drained per second
   * @param {object} store
   */
  constructor({ capacity, drainRate }, store) {
    this.capacity = capacity;
    this.drainRate = drainRate;        // requests/second drained
    this.drainIntervalMs = 1000 / drainRate;
    this.store = store;
    this.name = "leaky_bucket";
  }

  async check(key) {
    const storeKey = `lb:${key}`;
    const now = Date.now();

    const existing = await this.store.get(storeKey);

    let queue, lastDrain;
    if (!existing) {
      queue = 0;
      lastDrain = now;
    } else {
      queue = existing.queue;
      lastDrain = existing.lastDrain;
    }

    // Drain the bucket based on elapsed time
    const elapsed = now - lastDrain; // ms
    const drained = Math.floor((elapsed / 1000) * this.drainRate);
    queue = Math.max(0, queue - drained);
    lastDrain = now;

    if (queue < this.capacity) {
      queue += 1;
      await this.store.set(storeKey, { queue, lastDrain });
      return {
        allowed: true,
        remaining: this.capacity - queue,
        retryAfter: 0,
        queueDepth: queue,
        algorithm: this.name,
      };
    } else {
      await this.store.set(storeKey, { queue, lastDrain });
      const retryAfter = Math.ceil(this.drainIntervalMs);
      return {
        allowed: false,
        remaining: 0,
        retryAfter,
        queueDepth: queue,
        algorithm: this.name,
      };
    }
  }

  async reset(key) {
    await this.store.del(`lb:${key}`);
  }
}

module.exports = { FixedWindow, LeakyBucket };
