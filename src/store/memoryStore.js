/**
 * MemoryStore
 * ===========
 * In-process key-value store with TTL support.
 * Used in single-process deployments and testing.
 *
 * Not suitable for multi-instance deployments — use RedisStore instead.
 * All operations are synchronous O(1), making benchmarks very clean.
 */

"use strict";

class MemoryStore {
  constructor() {
    this._data = new Map(); // key → { value, expiresAt }
    this._name = "memory";

    // Periodic cleanup of expired keys (every 60s)
    this._cleanupInterval = setInterval(() => this._cleanup(), 60_000);
    this._cleanupInterval.unref(); // don't block process exit
  }

  async get(key) {
    const entry = this._data.get(key);
    if (!entry) return null;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      this._data.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key, value, ttlMs = null) {
    this._data.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
  }

  async del(key) {
    this._data.delete(key);
  }

  async keys(pattern = null) {
    const now = Date.now();
    const result = [];
    for (const [key, entry] of this._data.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) continue;
      if (!pattern || key.includes(pattern)) result.push(key);
    }
    return result;
  }

  size() {
    return this._data.size;
  }

  clear() {
    this._data.clear();
  }

  destroy() {
    clearInterval(this._cleanupInterval);
    this._data.clear();
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this._data.entries()) {
      if (entry.expiresAt && now > entry.expiresAt) {
        this._data.delete(key);
      }
    }
  }
}

module.exports = MemoryStore;
