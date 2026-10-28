/**
 * NexusGuard — Core Rate Limiter Engine
 * =======================================
 * Orchestrates algorithm selection, key extraction, telemetry,
 * and multi-rule matching.
 */

"use strict";

const TokenBucket = require("./algorithms/tokenBucket");
const SlidingWindowCounter = require("./algorithms/slidingWindow");
const { FixedWindow, LeakyBucket } = require("./algorithms/fixedWindowLeaky");
const MemoryStore = require("./store/memoryStore");

const ALGORITHMS = {
  token_bucket: TokenBucket,
  sliding_window: SlidingWindowCounter,
  fixed_window: FixedWindow,
  leaky_bucket: LeakyBucket,
};

const DEFAULT_LIMITS = {
  token_bucket:   { capacity: 100, refillRate: 10, refillInterval: 1000 },
  sliding_window: { max: 100, windowMs: 60000 },
  fixed_window:   { max: 100, windowMs: 60000 },
  leaky_bucket:   { capacity: 100, drainRate: 10, drainInterval: 1000 },
};

const TRUSTED_PROXY_HEADERS = [
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
  "x-client-ip",
  "fastly-client-ip",
  "true-client-ip",
  "x-cluster-client-ip",
  "fly-client-ip",
  "x-envoy-external-address",
  "x-forwarded",
  "x-original-forwarded-for",
  "x-proxyuser-ip",
  "x-nf-client-connection-ip",
  "x-azure-socketip",
];

class NexusGuard {
  /**
   * @param {object} config
   * @param {string} [config.algorithm='sliding_window'] - Algorithm to use
   * @param {object} config.limit                        - Algorithm-specific limit config
   * @param {object} [config.store]                      - Store instance (default: MemoryStore)
   * @param {Function} [config.keyGenerator]             - (req) => string
   * @param {Function} [config.onBlocked]                - (req, res, result) => void
   * @param {boolean}  [config.skipSuccessfulRequests]   - Only count failed reqs
   * @param {number[]} [config.skipStatusCodes]          - Status codes to not count
   */
  constructor(config = {}) {
    this.algorithm = config.algorithm || "sliding_window";
    this.store = config.store || new MemoryStore();
    this.keyGenerator = config.keyGenerator || defaultKeyGenerator;
    this.onBlocked = config.onBlocked || null;
    this.skipSuccessfulRequests = config.skipSuccessfulRequests || false;

    const AlgoClass = ALGORITHMS[this.algorithm];
    if (!AlgoClass) {
      throw new Error(
        `Unknown algorithm: "${this.algorithm}". Available: ${Object.keys(ALGORITHMS).join(", ")}`
      );
    }

    this._algo = new AlgoClass(config.limit, this.store);
    this._metrics = createMetrics();
  }

  /**
   * Express middleware factory.
   * Usage: app.use(guard.middleware())
   */
  middleware() {
    return async (req, res, next) => {
      const key = await this.keyGenerator(req);

      let result;
      try {
        result = await this._algo.check(key);
      } catch (err) {
        // Store failure → fail open (let the request through)
        console.error("[NexusGuard] Store error — failing open:", err.message);
        this._metrics.errors++;
        return next();
      }

      // Attach rate limit headers (RFC 6585 style)
      res.setHeader("X-RateLimit-Algorithm", result.algorithm);
      res.setHeader("X-RateLimit-Limit", this._algo.limit ?? this._algo.capacity);
      res.setHeader("X-RateLimit-Remaining", result.remaining);
      if (result.windowResetAt) {
        res.setHeader("X-RateLimit-Reset", Math.ceil(result.windowResetAt / 1000));
      }

      if (!result.allowed) {
        this._metrics.blocked++;
        res.setHeader("Retry-After", Math.ceil(result.retryAfter / 1000));

        if (this.onBlocked) {
          return this.onBlocked(req, res, result);
        }

        return res.status(429).json({
          error: "Too Many Requests",
          retryAfterMs: result.retryAfter,
          algorithm: result.algorithm,
        });
      }

      this._metrics.allowed++;
      next();
    };
  }

  /**
   * Programmatic check (without Express req/res).
   */
  async check(key) {
    return this._algo.check(key);
  }

  /**
   * Reset a specific key's counter.
   */
  async reset(key) {
    return this._algo.reset(key);
  }

  getMetrics() {
    const total = this._metrics.allowed + this._metrics.blocked;
    return {
      ...this._metrics,
      total,
      blockRate: total > 0 ? (this._metrics.blocked / total) : 0,
      algorithm: this.algorithm,
    };
  }
}

/**
 * Create a multi-rule guard that checks multiple limiters in sequence.
 * First rule to deny wins. Useful for layered protection:
 *   e.g. 10 req/s per IP + 1000 req/min per API key
 */
function createMultiGuard(rules) {
  const guards = rules.map((rule) => new NexusGuard(rule));

  return {
    middleware() {
      return async (req, res, next) => {
        for (const guard of guards) {
          const key = await guard.keyGenerator(req);
          const result = await guard._algo.check(key);

          if (!result.allowed) {
            res.setHeader("X-RateLimit-Violated-Rule", guard.algorithm);
            res.setHeader("Retry-After", Math.ceil(result.retryAfter / 1000));
            return res.status(429).json({
              error: "Too Many Requests",
              violatedRule: guard.algorithm,
              retryAfterMs: result.retryAfter,
            });
          }
        }
        next();
      };
    },
  };
}

// ---- Helpers ----

function defaultKeyGenerator(req) {
  return (
    req.ip ||
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.connection?.remoteAddress ||
    "unknown"
  );
}

function createMetrics() {
  return { allowed: 0, blocked: 0, errors: 0 };
}

module.exports = { NexusGuard, createMultiGuard, ALGORITHMS, DEFAULT_LIMITS };
