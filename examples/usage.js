/**
 * NexusGuard — Express Usage Examples
 * =====================================
 * Copy-paste snippets for integrating NexusGuard into your API.
 */

"use strict";

const express = require("express");
const { NexusGuard, createMultiGuard } = require("../src/limiter");
const MemoryStore = require("../src/store/memoryStore");

const app = express();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Example 1: Simple sliding window (20 req / 10s per IP)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const basicLimiter = new NexusGuard({
  algorithm: "sliding_window",
  limit: { limit: 20, windowMs: 10_000 },
});
app.use("/api", basicLimiter.middleware());

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Example 2: Token bucket per API key
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const apiKeyLimiter = new NexusGuard({
  algorithm: "token_bucket",
  limit: { capacity: 100, refillRate: 10 }, // 10 req/s, burst up to 100
  keyGenerator: (req) => req.headers["x-api-key"] || req.ip,
  onBlocked: (req, res, result) => {
    res.status(429).json({
      error: "Rate limit exceeded",
      retryAfter: `${Math.ceil(result.retryAfter / 1000)}s`,
      documentation: "https://api.yourapp.com/docs/rate-limits",
    });
  },
});
app.use("/v1", apiKeyLimiter.middleware());

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Example 3: Multi-rule guard (layered protection)
//   - 5 req/s per IP (token bucket — burst protection)
//   - 1000 req/min per API key (sliding window — sustained limit)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const sharedStore = new MemoryStore();
const strictLimiter = createMultiGuard([
  {
    algorithm: "token_bucket",
    limit: { capacity: 5, refillRate: 5 },
    store: sharedStore,
    keyGenerator: (req) => `ip:${req.ip}`,
  },
  {
    algorithm: "sliding_window",
    limit: { limit: 1000, windowMs: 60_000 },
    store: sharedStore,
    keyGenerator: (req) => `key:${req.headers["x-api-key"] || req.ip}`,
  },
]);
app.post("/payment", strictLimiter.middleware(), (req, res) => {
  res.json({ ok: true });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Example 4: Leaky bucket for smooth downstream protection
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const smoothLimiter = new NexusGuard({
  algorithm: "leaky_bucket",
  limit: { capacity: 20, drainRate: 5 }, // max 5 req/s, queue up to 20
});
app.get("/stream", smoothLimiter.middleware(), (req, res) => {
  res.json({ data: "stream response" });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Example 5: Programmatic check (no Express)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function checkProgrammatic() {
  const guard = new NexusGuard({
    algorithm: "token_bucket",
    limit: { capacity: 10, refillRate: 2 },
  });

  const result = await guard.check("user-42");
  if (!result.allowed) {
    console.log(`Blocked. Retry in ${result.retryAfter}ms`);
    return;
  }
  console.log(`Allowed. ${result.remaining} tokens remaining.`);
}

module.exports = { app };
