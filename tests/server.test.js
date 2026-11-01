"use strict";

const request = require("supertest");
const { app, server } = require("../src/server");

afterAll(() => server.close());

describe("demo server", () => {
  test("health check", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  test("token bucket route blocks after its capacity of 10", async () => {
    const results = [];
    for (let i = 0; i < 11; i++) {
      results.push((await request(app).get("/api/token").set("X-Forwarded-For", "198.51.100.1")).status);
    }
    expect(results.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(results[10]).toBe(429);
  });

  test("sliding, leaky and fixed routes allow a first request", async () => {
    for (const route of ["/api/sliding", "/api/leaky", "/api/fixed"]) {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-algorithm"]).toBeDefined();
    }
  });

  test("strict multi-rule route blocks after 5 requests", async () => {
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await request(app).post("/api/strict")).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  test("admin reset echoes the decoded key", async () => {
    const res = await request(app).post("/admin/reset/" + encodeURIComponent("::ffff:127.0.0.1"));
    expect(res.body).toEqual({ reset: "::ffff:127.0.0.1" });
  });

  test("guard metrics and Prometheus endpoint", async () => {
    const metrics = await request(app).get("/api/guard-metrics");
    expect(Object.keys(metrics.body.guards)).toEqual(["sliding_window", "token_bucket", "leaky_bucket", "fixed_window"]);
    const prom = await request(app).get("/metrics");
    expect(prom.status).toBe(200);
    expect(prom.text).toMatch(/nexusguard_block_rate/);
  });
});
