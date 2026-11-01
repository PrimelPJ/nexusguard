"use strict";

const MemoryStore = require("../src/store/memoryStore");

// In-memory stand-in for an ioredis client, so RedisStore can be tested without a server.
jest.mock("ioredis", () => {
  return jest.fn().mockImplementation(function FakeRedis(options) {
    const data = new Map();
    this.options = options;
    this.handlers = {};
    this.on = (event, fn) => { this.handlers[event] = fn; };
    this.connect = jest.fn(async () => {});
    this.get = jest.fn(async (k) => (data.has(k) ? data.get(k) : null));
    this.set = jest.fn(async (k, v) => { data.set(k, v); return "OK"; });
    this.psetex = jest.fn(async (k, ttl, v) => { data.set(k, v); return "OK"; });
    this.del = jest.fn(async (k) => (data.delete(k) ? 1 : 0));
    this.keys = jest.fn(async (pattern) => {
      const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return [...data.keys()].filter((k) => re.test(k));
    });
    this.eval = jest.fn(async () => 1);
    this.ping = jest.fn(async () => "PONG");
    this.quit = jest.fn(async () => "OK");
    this._data = data;
  });
});

const RedisStore = require("../src/store/redisStore");

describe("MemoryStore extras", () => {
  let store;
  beforeEach(() => { store = new MemoryStore(); });
  afterEach(() => { store.destroy(); });

  test("keys filters by substring and skips expired entries", async () => {
    await store.set("ip:1", 1);
    await store.set("ip:2", 2);
    await store.set("key:abc", 3);
    await store.set("ip:old", 4, 1);
    await new Promise((r) => setTimeout(r, 10));
    expect((await store.keys("ip:")).sort()).toEqual(["ip:1", "ip:2"]);
    expect(await store.keys()).toHaveLength(3);
  });

  test("del, size and clear", async () => {
    await store.set("a", 1);
    await store.set("b", 2);
    expect(store.size()).toBe(2);
    await store.del("a");
    expect(await store.get("a")).toBeNull();
    store.clear();
    expect(store.size()).toBe(0);
  });

  test("cleanup removes only expired entries", async () => {
    await store.set("keep", 1);
    await store.set("drop", 2, 1);
    await new Promise((r) => setTimeout(r, 10));
    store._cleanup();
    expect(store.size()).toBe(1);
    expect(await store.get("keep")).toBe(1);
  });
});

describe("RedisStore", () => {
  let store;
  beforeEach(() => { store = new RedisStore({ keyPrefix: "t:" }); });

  test("prefixes keys and round-trips JSON values", async () => {
    await store.set("user", { hits: 3 });
    expect(store._client._data.get("t:user")).toBe('{"hits":3}');
    expect(await store.get("user")).toEqual({ hits: 3 });
  });

  test("uses PSETEX when a TTL is given", async () => {
    await store.set("k", 1, 5000);
    expect(store._client.psetex).toHaveBeenCalledWith("t:k", 5000, "1");
    expect(store._client.set).not.toHaveBeenCalled();
  });

  test("returns null for missing keys and raw strings that are not JSON", async () => {
    expect(await store.get("missing")).toBeNull();
    store._client._data.set("t:raw", "not-json");
    expect(await store.get("raw")).toBe("not-json");
  });

  test("del and keys respect the prefix", async () => {
    await store.set("a", 1);
    await store.set("b", 2);
    await store.del("a");
    expect(await store.keys()).toEqual(["t:b"]);
    expect(store._client.keys).toHaveBeenLastCalledWith("t:*");
  });

  test("atomicIncrWithTTL runs a single Lua script on the prefixed key", async () => {
    expect(await store.atomicIncrWithTTL("counter", 1000)).toBe(1);
    const [script, numKeys, key, ttl] = store._client.eval.mock.calls[0];
    expect(script).toMatch(/incr/);
    expect(script).toMatch(/pexpire/);
    expect([numKeys, key, ttl]).toEqual([1, "t:counter", 1000]);
  });

  test("connect, ping and disconnect delegate to the client", async () => {
    await store.connect();
    expect(await store.ping()).toBe("PONG");
    await store.disconnect();
    expect(store._client.connect).toHaveBeenCalled();
    expect(store._client.quit).toHaveBeenCalled();
  });

  test("uses defaults and logs connection errors", () => {
    const plain = new RedisStore();
    expect(plain._prefix).toBe("ng:");
    expect(plain._client.options).toMatchObject({ host: "localhost", port: 6379, lazyConnect: true });
    expect(plain._client.options.retryStrategy(50)).toBe(3000);
    const spy = jest.spyOn(console, "error").mockImplementation(() => {});
    plain._client.handlers.error(new Error("ECONNREFUSED"));
    expect(spy).toHaveBeenCalledWith("[RedisStore] Connection error:", "ECONNREFUSED");
    spy.mockRestore();
  });

  test("throws a helpful error when ioredis is not installed", () => {
    jest.resetModules();
    jest.doMock("ioredis", () => { throw new Error("Cannot find module 'ioredis'"); });
    const Isolated = require("../src/store/redisStore");
    expect(() => new Isolated()).toThrow(/ioredis not installed/);
  });
});
