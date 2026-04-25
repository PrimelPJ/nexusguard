# NexusGuard ⚡

> A distributed rate limiter and traffic controller with **4 algorithms implemented from scratch**, Redis-backed distributed state, real-time WebSocket monitoring, and Prometheus metrics.

---

## What is this?

NexusGuard is a production-grade rate limiting engine for Node.js APIs. It implements the four core rate limiting algorithms used at companies like **Cloudflare, Stripe, AWS API Gateway, and Google Apigee** — not as wrappers, but from first principles.

It ships as:
- **Express middleware** — drop into any route in one line
- **Programmatic API** — for non-HTTP contexts (queues, workers)
- **Multi-rule guard** — layer multiple algorithms for defense in depth
- **Real-time dashboard** — WebSocket-powered live metrics
- **Prometheus endpoint** — `/metrics` for Grafana integration

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Incoming HTTP Request                        │
└──────────────────────────┬──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                      NexusGuard Middleware                      │
│  1. keyGenerator(req)  → "user-42" / "ip:1.2.3.4"               │
│  2. algorithm.check(key) → {allowed, remaining, retryAfter}     │
│  3. Inject rate limit headers (X-RateLimit-Remaining, etc.)     │
│  4. Allow → next() / Deny → 429 + Retry-After                   │
└──────────────────────────┬──────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   Token Bucket    Sliding Window      Leaky Bucket
   Fixed Window    (pick one or        (or chain all)
                   chain multiple)
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
              ┌────────────▼────────────┐
              │       State Store        │
              │  MemoryStore (default)   │
              │  RedisStore  (distributed)│
              └──────────────────────────┘
```

---

## The Four Algorithms

### 1. Token Bucket

The most widely deployed algorithm. Used by AWS API Gateway, Stripe, and most REST APIs at FAANG.

**How it works:**
- Each client has a bucket that holds up to `capacity` tokens
- Tokens are added at `refillRate` per second (continuously, not in batches)
- Each request consumes 1 (or more) tokens
- If insufficient tokens → 429 Too Many Requests

```
Time →
Tokens: ████████░░  (refilling)
        ↑ burst allowed up to capacity
Request hits → consume 1 token
```

**Properties:**
- ✅ Allows short bursts (up to `capacity`)
- ✅ Enforces sustained rate of `refillRate` req/s
- ✅ Smooth output — no sharp boundaries
- ❌ Burst means short-term spikes can still hit downstream

**Best for:** Public APIs, per-user quotas, payment endpoints

---

### 2. Sliding Window Counter

Used by Cloudflare, Nginx, and Google's Apigee. Fixes the "boundary burst" problem of fixed windows at O(1) cost.

**How it works:**

Fixed window has a known flaw: if your limit is 100 req/min, a user can make 100 requests at 11:59:59 and 100 more at 12:00:01 — effectively 200 req in 2 seconds.

Sliding window fixes this by weighting the previous window:

```
count = prevWindowCount × (1 - elapsedInCurrentWindow/windowSize) + currentWindowCount

Example (limit=100 req/min):
  - Previous window: 80 requests
  - We're 30s into the current window
  - Weight of prev window = 1 - 30/60 = 0.5
  - Effective count = 80×0.5 + current = 40 + current
```

**Error bound:** At most `limit × (1 - overlap)` error — typically < 1% with 1-minute windows.

**Properties:**
- ✅ No boundary burst problem
- ✅ O(1) time and space per check
- ✅ Near-exact sliding window behavior
- ✅ Best recall/accuracy tradeoff

**Best for:** General-purpose API rate limiting, default algorithm

---

### 3. Leaky Bucket

Guarantees a perfectly smooth output rate. Used to protect downstream services from any spikes.

**How it works:**

```
Requests → [QUEUE: capacity=N] → leak out at drainRate req/s → downstream
                                      ↑
                              Queue overflows? → 429
```

Unlike Token Bucket, which allows burst delivery, Leaky Bucket queues requests and releases them at a fixed rate. The "bucket" fills with incoming requests and drains at a constant rate.

**Properties:**
- ✅ Perfectly smooth output rate (great for downstream protection)
- ✅ Absorbs short bursts (up to `capacity`) without dropping
- ❌ Increased latency for burst requests (they wait in queue)
- ❌ No concept of "credit" — you can't bank unused capacity

**Best for:** Protecting databases, third-party APIs, anything that shouldn't see sudden load spikes

---

### 4. Fixed Window Counter

The simplest algorithm. Cheap to implement, easy to reason about. Used as a fallback or for high-volume, low-precision limiting.

**How it works:**
- Time is divided into fixed windows (e.g., one per minute)
- Count requests per key per window
- Reset counter at window boundary

**Known issue:** The "thundering herd" boundary problem (see Sliding Window above). Acceptable when the window is short or precision isn't critical.

**Properties:**
- ✅ Cheapest to implement and understand
- ✅ Predictable behavior (resets on the clock)
- ❌ Allows 2× burst at window boundaries
- ❌ Uneven distribution within a window

**Best for:** Coarse-grained limits (e.g., 10,000 req/day), admin dashboards

---

## Algorithm Comparison

| Algorithm        | Burst Handling | Smoothness | Accuracy | Complexity | Memory |
|-----------------|---------------|-----------|----------|------------|--------|
| Token Bucket    | ✅ Allows burst | Medium    | High     | O(1)       | Low    |
| Sliding Window  | ⚠️ Approximated | High      | ~High    | O(1)       | Low    |
| Leaky Bucket    | ✅ Queues burst  | ⭐ Perfect | High     | O(1)       | Low    |
| Fixed Window    | ❌ Boundary burst| Low       | Medium   | O(1)       | Low    |

---

## Quick Start

### Install

```bash
git clone https://github.com/primeljayawardana/nexusguard
cd nexusguard
npm install
npm start
# → http://localhost:3000
```

### Middleware in 3 lines

```javascript
const { NexusGuard } = require("./src/limiter");

const guard = new NexusGuard({
  algorithm: "sliding_window",
  limit: { limit: 100, windowMs: 60_000 }, // 100 req/min
});

app.use("/api", guard.middleware());
```

### Switch to Redis (distributed)

```javascript
const RedisStore = require("./src/store/redisStore");

const guard = new NexusGuard({
  algorithm: "token_bucket",
  limit: { capacity: 50, refillRate: 10 },
  store: new RedisStore({ host: "redis", port: 6379 }),
});
```

### Layer multiple rules

```javascript
const { createMultiGuard } = require("./src/limiter");

const guard = createMultiGuard([
  // Rule 1: 10 req/s per IP (burst protection)
  {
    algorithm: "token_bucket",
    limit: { capacity: 10, refillRate: 10 },
    keyGenerator: (req) => req.ip,
  },
  // Rule 2: 1000 req/min per API key (sustained limit)
  {
    algorithm: "sliding_window",
    limit: { limit: 1000, windowMs: 60_000 },
    keyGenerator: (req) => req.headers["x-api-key"],
  },
]);

app.post("/checkout", guard.middleware(), handler);
```

---

## Response Headers

Every rate-limited response includes:

```
X-RateLimit-Remaining: 42
X-RateLimit-Reset: 1716825600
X-RateLimit-Algorithm: sliding_window
Retry-After: 3          (on 429)
```

---

## API Reference

### `new NexusGuard(config)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `algorithm` | string | `sliding_window` | One of: `token_bucket`, `sliding_window`, `leaky_bucket`, `fixed_window` |
| `limit` | object | required | Algorithm-specific config (see below) |
| `store` | object | `MemoryStore` | State store — `MemoryStore` or `RedisStore` |
| `keyGenerator` | function | `req.ip` | `(req) => string` — how to identify a client |
| `onBlocked` | function | `null` | Custom 429 handler: `(req, res, result) => void` |

### Algorithm `limit` configs

```javascript
// Token Bucket
{ capacity: 100, refillRate: 10, tokensPerReq: 1 }

// Sliding Window / Fixed Window
{ limit: 100, windowMs: 60_000 }

// Leaky Bucket
{ capacity: 50, drainRate: 10 }
```

### `guard.check(key)` → `Promise<Result>`

```typescript
{
  allowed: boolean,
  remaining: number,
  retryAfter: number,  // ms until retry (0 if allowed)
  algorithm: string,
  windowResetAt?: number,  // Unix ms (sliding/fixed window)
  queueDepth?: number,     // leaky bucket
}
```

---

## Real-time Dashboard

Navigate to `http://localhost:3000` to see the live WebSocket dashboard:

```
┌──────────────────────┐  ┌──────────────────────┐
│  Sliding Window      │  │  Token Bucket         │
│  Allowed:  4,821     │  │  Allowed:  3,201      │
│  Blocked:  179       │  │  Blocked:  799        │
│  Block Rate: 3.6%    │  │  Block Rate: 20.0%    │
│  ██░░░░░░░░░  3.6%   │  │  ████░░░░░░░  20.0%  │
└──────────────────────┘  └──────────────────────┘
```

Updates every second via WebSocket at `ws://localhost:3000/metrics/ws`.

---

## Prometheus / Grafana Integration

```yaml
# prometheus.yml scrape config
scrape_configs:
  - job_name: nexusguard
    static_configs:
      - targets: ['localhost:3000']
    metrics_path: /metrics
```

Exposed metrics:
- `nexusguard_requests_total{route, result, algorithm}` — Counter
- `nexusguard_block_rate{guard}` — Gauge
- Standard Node.js process metrics (CPU, memory, event loop lag)

---

## Load Testing

```bash
# Fire 50 req/s for 10 seconds at the sliding window endpoint
node load-test/loadTest.js \
  --url http://localhost:3000/api/sliding \
  --rps 50 \
  --duration 10

# Output:
# ═══════════════════════════════════════════════════════
#   RESULTS
# ═══════════════════════════════════════════════════════
#   Total requests  : 487
#   Allowed         : 19  (3.9%)
#   Blocked (429)   : 468 (96.1%)
#   Latency avg     : 2.1ms
#   Latency p50     : 1ms
#   Latency p95     : 4ms
#   Latency p99     : 11ms
```

---

## Project Structure

```
nexusguard/
├── src/
│   ├── algorithms/
│   │   ├── tokenBucket.js        # Token Bucket (O(1) amortized)
│   │   ├── slidingWindow.js      # Sliding Window Counter (weighted)
│   │   └── fixedWindowLeaky.js   # Fixed Window + Leaky Bucket
│   ├── store/
│   │   ├── memoryStore.js        # In-process store with TTL
│   │   └── redisStore.js         # Distributed Redis store
│   ├── limiter.js                # Core engine + multi-rule guard
│   ├── server.js                 # Express demo + WebSocket + Prometheus
│   └── dashboard/public/
│       └── index.html            # Real-time monitoring dashboard
├── tests/
│   └── algorithms.test.js        # 20+ unit tests
├── load-test/
│   └── loadTest.js               # CLI load testing tool
├── examples/
│   └── usage.js                  # Copy-paste integration examples
├── Dockerfile
├── .github/workflows/ci.yml
└── package.json
```

---

## Design Decisions

**Why implement algorithms from scratch?** Most Node.js rate limiter packages (express-rate-limit, rate-limiter-flexible) are excellent wrappers, but writing the algorithms from scratch requires deeply understanding the trade-offs — when does the sliding window approximation break down? What exactly happens at the token bucket boundary? This project answers those questions.

**Fail-open on store errors:** If Redis goes down, the middleware passes requests through rather than blocking your entire API. This is the same behavior as Google's API Gateway — availability > perfect rate limiting.

**Why two stores?** MemoryStore is for single-process deployments (zero dependencies, fastest possible check). RedisStore is for horizontally-scaled deployments where state must be shared across instances — e.g., 10 Node.js processes behind a load balancer.

**Atomic operations:** The RedisStore uses Lua scripts for the Fixed Window increment (`INCR` + `EXPIRE`) to prevent race conditions under concurrent load. Without atomicity, two simultaneous requests reading count=99 would both succeed, allowing 101 requests.

---

## License
Primel Jayawardana 
