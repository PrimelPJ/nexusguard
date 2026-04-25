"use strict";

const MemoryStore = require("../src/store/memoryStore");
const TokenBucket = require("../src/algorithms/tokenBucket");
const SlidingWindowCounter = require("../src/algorithms/slidingWindow");
const { FixedWindow, LeakyBucket } = require("../src/algorithms/fixedWindowLeaky");
const { NexusGuard } = require("../src/limiter");

// ---- MemoryStore ----

describe("MemoryStore", () => {
  let store;
  beforeEach(() => { store = new MemoryStore(); });
  afterEach(() => { store.destroy(); });

  test("set and get", async () => {
    await store.set("k", { val: 42 });
    expect(await store.get("k")).toEqual({ val: 42 });
  });

  test("returns null for missing key", async () => {
    expect(await store.get("missing")).toBeNull();
  });

  test("TTL expiry", async () => {
    await store.set("k", "v", 50);
    await sleep(100);
    expect(await store.get("k")).toBeNull();
  });

  test("del removes key", async () => {
    await store.set("k", "v");
    await store.del("k");
    expect(await store.get("k")).toBeNull();
  });
});

// ---- Token Bucket ----

describe("TokenBucket", () => {
  test("allows requests within capacity", async () => {
    const store = new MemoryStore();
    const tb = new TokenBucket({ capacity: 5, refillRate: 1 }, store);
    for (let i = 0; i < 5; i++) {
      const r = await tb.check("user1");
      expect(r.allowed).toBe(true);
    }
    store.destroy();
  });

  test("blocks when bucket is empty", async () => {
    const store = new MemoryStore();
    const tb = new TokenBucket({ capacity: 3, refillRate: 1 }, store);
    for (let i = 0; i < 3; i++) await tb.check("u");
    const r = await tb.check("u");
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBeGreaterThan(0);
    store.destroy();
  });

  test("refills tokens over time", async () => {
    const store = new MemoryStore();
    const tb = new TokenBucket({ capacity: 2, refillRate: 10 }, store); // 10 tokens/s
    await tb.check("u");
    await tb.check("u"); // empty
    await sleep(200);    // wait 0.2s → 2 new tokens
    const r = await tb.check("u");
    expect(r.allowed).toBe(true);
    store.destroy();
  });

  test("independent keys don't interfere", async () => {
    const store = new MemoryStore();
    const tb = new TokenBucket({ capacity: 1, refillRate: 0.1 }, store);
    await tb.check("a"); // drains a
    const r = await tb.check("b");
    expect(r.allowed).toBe(true); // b should still have tokens
    store.destroy();
  });

  test("reset clears bucket", async () => {
    const store = new MemoryStore();
    const tb = new TokenBucket({ capacity: 1, refillRate: 1 }, store);
    await tb.check("u"); // drain
    await tb.reset("u");
    const r = await tb.check("u");
    expect(r.allowed).toBe(true);
    store.destroy();
  });
});

// ---- Sliding Window ----

describe("SlidingWindowCounter", () => {
  test("allows requests within limit", async () => {
    const store = new MemoryStore();
    const sw = new SlidingWindowCounter({ limit: 5, windowMs: 10000 }, store);
    for (let i = 0; i < 5; i++) {
      expect((await sw.check("u")).allowed).toBe(true);
    }
    store.destroy();
  });

  test("blocks when limit exceeded", async () => {
    const store = new MemoryStore();
    const sw = new SlidingWindowCounter({ limit: 3, windowMs: 10000 }, store);
    for (let i = 0; i < 3; i++) await sw.check("u");
    const r = await sw.check("u");
    expect(r.allowed).toBe(false);
    store.destroy();
  });
});

// ---- Fixed Window ----

describe("FixedWindow", () => {
  test("resets after window passes", async () => {
    const store = new MemoryStore();
    const fw = new FixedWindow({ limit: 2, windowMs: 100 }, store);
    await fw.check("u");
    await fw.check("u");
    expect((await fw.check("u")).allowed).toBe(false);
    await sleep(110);
    expect((await fw.check("u")).allowed).toBe(true);
    store.destroy();
  });
});

// ---- Leaky Bucket ----

describe("LeakyBucket", () => {
  test("allows requests within capacity", async () => {
    const store = new MemoryStore();
    const lb = new LeakyBucket({ capacity: 5, drainRate: 1 }, store);
    for (let i = 0; i < 5; i++) {
      expect((await lb.check("u")).allowed).toBe(true);
    }
    store.destroy();
  });

  test("blocks when at capacity", async () => {
    const store = new MemoryStore();
    const lb = new LeakyBucket({ capacity: 2, drainRate: 0.1 }, store);
    await lb.check("u");
    await lb.check("u");
    expect((await lb.check("u")).allowed).toBe(false);
    store.destroy();
  });
});

// ---- NexusGuard middleware ----

describe("NexusGuard middleware", () => {
  test("throws on unknown algorithm", () => {
    expect(() => new NexusGuard({ algorithm: "unicorn", limit: {} }))
      .toThrow("Unknown algorithm");
  });

  test("returns metrics after requests", async () => {
    const guard = new NexusGuard({
      algorithm: "token_bucket",
      limit: { capacity: 5, refillRate: 10 },
    });

    // Simulate middleware calls
    const mockReq = { ip: "127.0.0.1" };
    const mockRes = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const next = jest.fn();

    await guard.middleware()(mockReq, mockRes, next);
    expect(next).toHaveBeenCalled();

    const m = guard.getMetrics();
    expect(m.allowed).toBe(1);
    expect(m.blocked).toBe(0);
  });
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
