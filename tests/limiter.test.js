"use strict";

const MemoryStore = require("../src/store/memoryStore");
const { NexusGuard, createMultiGuard } = require("../src/limiter");

function mockRes() {
  const res = { headers: {}, statusCode: 200, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function mockReq(overrides = {}) {
  return { ip: "10.0.0.1", headers: {}, ...overrides };
}

async function run(middleware, req = mockReq()) {
  const res = mockRes();
  const next = jest.fn();
  await middleware(req, res, next);
  return { res, next };
}

describe("NexusGuard middleware", () => {
  let store;
  beforeEach(() => { store = new MemoryStore(); });
  afterEach(() => { store.destroy(); });

  test("allows requests under the limit and sets rate limit headers", async () => {
    const guard = new NexusGuard({ algorithm: "fixed_window", limit: { limit: 2, windowMs: 60_000 }, store });
    const { res, next } = await run(guard.middleware());
    expect(next).toHaveBeenCalled();
    expect(res.headers["X-RateLimit-Algorithm"]).toBe("fixed_window");
    expect(res.headers["X-RateLimit-Limit"]).toBe(2);
    expect(res.headers["X-RateLimit-Remaining"]).toBe(1);
    expect(res.headers["X-RateLimit-Reset"]).toBeGreaterThan(0);
  });

  test("blocks with 429 and Retry-After once the limit is hit", async () => {
    const guard = new NexusGuard({ algorithm: "fixed_window", limit: { limit: 1, windowMs: 60_000 }, store });
    const mw = guard.middleware();
    await run(mw);
    const { res, next } = await run(mw);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.body.error).toBe("Too Many Requests");
    expect(res.headers["Retry-After"]).toBeGreaterThan(0);
  });

  test("uses capacity as the limit header for bucket algorithms", async () => {
    const guard = new NexusGuard({ algorithm: "token_bucket", limit: { capacity: 3, refillRate: 1 }, store });
    const { res } = await run(guard.middleware());
    expect(res.headers["X-RateLimit-Limit"]).toBe(3);
  });

  test("calls a custom onBlocked handler instead of the default response", async () => {
    const onBlocked = jest.fn((req, res) => res.status(503).json({ custom: true }));
    const guard = new NexusGuard({
      algorithm: "fixed_window", limit: { limit: 1, windowMs: 60_000 }, store, onBlocked,
    });
    const mw = guard.middleware();
    await run(mw);
    const { res } = await run(mw);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ custom: true });
  });

  test("fails open and counts an error when the store throws", async () => {
    const broken = { get: async () => { throw new Error("store down"); }, set: async () => {} };
    const guard = new NexusGuard({ algorithm: "fixed_window", limit: { limit: 1, windowMs: 60_000 }, store: broken });
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { next } = await run(guard.middleware());
    spy.mockRestore();
    expect(next).toHaveBeenCalled();
    expect(guard.getMetrics().errors).toBe(1);
  });

  test("tracks allowed and blocked counts and block rate", async () => {
    const guard = new NexusGuard({ algorithm: "fixed_window", limit: { limit: 1, windowMs: 60_000 }, store });
    expect(guard.getMetrics().blockRate).toBe(0);
    const mw = guard.middleware();
    await run(mw);
    await run(mw);
    const metrics = guard.getMetrics();
    expect(metrics).toMatchObject({ allowed: 1, blocked: 1, total: 2, blockRate: 0.5, algorithm: "fixed_window" });
  });

  test("keys requests by IP, then X-Forwarded-For, then socket address", async () => {
    const guard = new NexusGuard({ algorithm: "fixed_window", limit: { limit: 1, windowMs: 60_000 }, store });
    const mw = guard.middleware();
    await run(mw, mockReq({ ip: undefined, headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.2" } }));
    expect(await store.keys("203.0.113.9")).toHaveLength(1);
    await run(mw, mockReq({ ip: undefined, connection: { remoteAddress: "192.0.2.4" } }));
    expect(await store.keys("192.0.2.4")).toHaveLength(1);
    await run(mw, mockReq({ ip: undefined }));
    expect(await store.keys("unknown")).toHaveLength(1);
  });

  test("supports a custom key generator", async () => {
    const guard = new NexusGuard({
      algorithm: "fixed_window",
      limit: { limit: 1, windowMs: 60_000 },
      store,
      keyGenerator: (req) => req.headers["x-api-key"],
    });
    const mw = guard.middleware();
    await run(mw, mockReq({ headers: { "x-api-key": "a" } }));
    const { next } = await run(mw, mockReq({ headers: { "x-api-key": "b" } }));
    expect(next).toHaveBeenCalled(); // different key, separate budget
  });

  test("check and reset work without Express", async () => {
    const guard = new NexusGuard({ algorithm: "fixed_window", limit: { limit: 1, windowMs: 60_000 }, store });
    expect((await guard.check("k")).allowed).toBe(true);
    expect((await guard.check("k")).allowed).toBe(false);
    await guard.reset("k");
    expect((await guard.check("k")).allowed).toBe(true);
  });

  test("rejects unknown algorithms", () => {
    expect(() => new NexusGuard({ algorithm: "nope", limit: {}, store })).toThrow(/Unknown algorithm/);
  });

  test("defaults to sliding window with an in-memory store", () => {
    const guard = new NexusGuard({ limit: { limit: 5, windowMs: 1000 } });
    expect(guard.algorithm).toBe("sliding_window");
    expect(guard.store).toBeInstanceOf(MemoryStore);
    guard.store.destroy();
  });
});

describe("createMultiGuard", () => {
  test("passes when every rule allows the request", async () => {
    const multi = createMultiGuard([
      { algorithm: "fixed_window", limit: { limit: 5, windowMs: 60_000 } },
      { algorithm: "token_bucket", limit: { capacity: 5, refillRate: 1 } },
    ]);
    const { next } = await run(multi.middleware());
    expect(next).toHaveBeenCalled();
  });

  test("the first rule that denies wins and is reported", async () => {
    const multi = createMultiGuard([
      { algorithm: "token_bucket", limit: { capacity: 100, refillRate: 1 } },
      { algorithm: "fixed_window", limit: { limit: 1, windowMs: 60_000 } },
    ]);
    const mw = multi.middleware();
    await run(mw);
    const { res, next } = await run(mw);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(429);
    expect(res.headers["X-RateLimit-Violated-Rule"]).toBe("fixed_window");
    expect(res.body.violatedRule).toBe("fixed_window");
  });
});
