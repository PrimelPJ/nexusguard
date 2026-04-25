/**
 * RedisStore
 * ==========
 * Distributed key-value store backed by Redis via ioredis.
 * Drop-in replacement for MemoryStore — same interface.
 *
 * Enables true distributed rate limiting across multiple server instances.
 * All operations use atomic Lua scripts where necessary to prevent race conditions.
 *
 * Why Lua scripts?
 *   A read-then-write (GET + SET) is not atomic in Redis. Without a Lua script,
 *   two concurrent requests can both read "count=99" and both succeed, allowing
 *   101 requests instead of 100. The Lua script executes atomically in the Redis
 *   server process, eliminating the race.
 */

"use strict";

let Redis;
try {
  Redis = require("ioredis");
} catch {
  Redis = null;
}

class RedisStore {
  /**
   * @param {object} opts
   * @param {string} [opts.host='localhost']
   * @param {number} [opts.port=6379]
   * @param {string} [opts.password]
   * @param {number} [opts.db=0]
   * @param {string} [opts.keyPrefix='ng:']
   */
  constructor(opts = {}) {
    if (!Redis) {
      throw new Error(
        "ioredis not installed. Run: npm install ioredis\n" +
        "Or use MemoryStore for single-instance deployments."
      );
    }

    this._prefix = opts.keyPrefix || "ng:";
    this._name = "redis";

    this._client = new Redis({
      host: opts.host || process.env.REDIS_HOST || "localhost",
      port: opts.port || parseInt(process.env.REDIS_PORT || "6379"),
      password: opts.password || process.env.REDIS_PASSWORD,
      db: opts.db || 0,
      lazyConnect: true,
      retryStrategy: (times) => Math.min(times * 100, 3000),
      enableReadyCheck: true,
    });

    this._client.on("error", (err) => {
      console.error("[RedisStore] Connection error:", err.message);
    });
  }

  async connect() {
    await this._client.connect();
  }

  async get(key) {
    const raw = await this._client.get(this._prefix + key);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  async set(key, value, ttlMs = null) {
    const serialized = JSON.stringify(value);
    const prefixedKey = this._prefix + key;
    if (ttlMs) {
      await this._client.psetex(prefixedKey, ttlMs, serialized);
    } else {
      await this._client.set(prefixedKey, serialized);
    }
  }

  async del(key) {
    await this._client.del(this._prefix + key);
  }

  async keys(pattern = null) {
    const pat = this._prefix + (pattern || "*");
    return this._client.keys(pat);
  }

  /**
   * Atomic increment with TTL (for Fixed Window algorithm).
   * Uses a single round-trip Redis script.
   */
  async atomicIncrWithTTL(key, ttlMs) {
    const script = `
      local current = redis.call('incr', KEYS[1])
      if current == 1 then
        redis.call('pexpire', KEYS[1], ARGV[1])
      end
      return current
    `;
    return this._client.eval(script, 1, this._prefix + key, ttlMs);
  }

  async ping() {
    return this._client.ping();
  }

  async disconnect() {
    await this._client.quit();
  }
}

module.exports = RedisStore;
