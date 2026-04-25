/**
 * NexusGuard — Demo API Server
 * =============================
 * Demonstrates all four rate limiting algorithms with:
 *   - REST API with rate-limited routes
 *   - Real-time WebSocket dashboard (ws://localhost:3000/metrics/ws)
 *   - Prometheus metrics endpoint (/metrics)
 *   - Admin reset endpoint (/admin/reset/:key)
 */

"use strict";

const http = require("http");
const express = require("express");
const path = require("path");
const WebSocket = require("ws");
const client = require("prom-client");

const { NexusGuard, createMultiGuard } = require("./limiter");
const MemoryStore = require("./store/memoryStore");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard/public")));

// ---- Prometheus metrics ----
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const requestsTotal = new client.Counter({
  name: "nexusguard_requests_total",
  help: "Total requests",
  labelNames: ["route", "result", "algorithm"],
  registers: [register],
});

const blockRate = new client.Gauge({
  name: "nexusguard_block_rate",
  help: "Current block rate (0-1)",
  labelNames: ["guard"],
  registers: [register],
});

// ---- Shared store ----
const sharedStore = new MemoryStore();

// ---- Guards ----
const slidingGuard = new NexusGuard({
  algorithm: "sliding_window",
  limit: { limit: 20, windowMs: 10_000 },
  store: sharedStore,
  onBlocked: (req, res, result) => {
    requestsTotal.inc({ route: req.path, result: "blocked", algorithm: "sliding_window" });
    res.status(429).json({ error: "Too Many Requests", retryAfterMs: result.retryAfter });
  },
});

const tokenGuard = new NexusGuard({
  algorithm: "token_bucket",
  limit: { capacity: 10, refillRate: 2 },
  store: new MemoryStore(),
});

const leakyGuard = new NexusGuard({
  algorithm: "leaky_bucket",
  limit: { capacity: 15, drainRate: 3 },
  store: new MemoryStore(),
});

const fixedGuard = new NexusGuard({
  algorithm: "fixed_window",
  limit: { limit: 30, windowMs: 60_000 },
  store: new MemoryStore(),
});

// Multi-rule: strict protection layer
const strictGuard = createMultiGuard([
  {
    algorithm: "token_bucket",
    limit: { capacity: 5, refillRate: 1 },
    store: new MemoryStore(),
    keyGenerator: (req) => req.ip,
  },
  {
    algorithm: "sliding_window",
    limit: { limit: 50, windowMs: 60_000 },
    store: sharedStore,
    keyGenerator: (req) => req.headers["x-api-key"] || req.ip,
  },
]);

// ---- Routes ----

// Health
app.get("/health", (req, res) => {
  res.json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() });
});

// Sliding window demo
app.get("/api/sliding", slidingGuard.middleware(), (req, res) => {
  requestsTotal.inc({ route: "/api/sliding", result: "allowed", algorithm: "sliding_window" });
  res.json({ message: "✓ Request allowed", algorithm: "sliding_window", time: Date.now() });
});

// Token bucket demo
app.get("/api/token", tokenGuard.middleware(), (req, res) => {
  requestsTotal.inc({ route: "/api/token", result: "allowed", algorithm: "token_bucket" });
  res.json({ message: "✓ Request allowed", algorithm: "token_bucket", time: Date.now() });
});

// Leaky bucket demo
app.get("/api/leaky", leakyGuard.middleware(), (req, res) => {
  requestsTotal.inc({ route: "/api/leaky", result: "allowed", algorithm: "leaky_bucket" });
  res.json({ message: "✓ Request allowed", algorithm: "leaky_bucket", time: Date.now() });
});

// Fixed window demo
app.get("/api/fixed", fixedGuard.middleware(), (req, res) => {
  requestsTotal.inc({ route: "/api/fixed", result: "allowed", algorithm: "fixed_window" });
  res.json({ message: "✓ Request allowed", algorithm: "fixed_window", time: Date.now() });
});

// Multi-guard strict endpoint
app.post("/api/strict", strictGuard.middleware(), (req, res) => {
  res.json({ message: "✓ Passed all rate limit rules", time: Date.now() });
});

// Admin reset
app.post("/admin/reset/:key", (req, res) => {
  const key = decodeURIComponent(req.params.key);
  Promise.all([
    slidingGuard.reset(key),
    tokenGuard.reset(key),
    leakyGuard.reset(key),
    fixedGuard.reset(key),
  ]).then(() => {
    res.json({ reset: key });
  });
});

// Prometheus metrics
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});

// Aggregated guard metrics (for dashboard)
app.get("/api/guard-metrics", (req, res) => {
  const guards = {
    sliding_window: slidingGuard.getMetrics(),
    token_bucket: tokenGuard.getMetrics(),
    leaky_bucket: leakyGuard.getMetrics(),
    fixed_window: fixedGuard.getMetrics(),
  };

  // Update Prometheus gauges
  for (const [name, m] of Object.entries(guards)) {
    blockRate.set({ guard: name }, m.blockRate);
  }

  res.json({ guards, timestamp: Date.now() });
});

// ---- WebSocket Dashboard ----
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/metrics/ws" });

// Broadcast metrics every second to all connected dashboards
setInterval(() => {
  if (wss.clients.size === 0) return;

  const payload = JSON.stringify({
    type: "metrics",
    data: {
      sliding_window: slidingGuard.getMetrics(),
      token_bucket: tokenGuard.getMetrics(),
      leaky_bucket: leakyGuard.getMetrics(),
      fixed_window: fixedGuard.getMetrics(),
    },
    timestamp: Date.now(),
  });

  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  });
}, 1000);

wss.on("connection", (ws) => {
  console.log("[WS] Dashboard client connected");
  ws.on("close", () => console.log("[WS] Dashboard client disconnected"));
});

// ---- Start ----
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n╔═══════════════════════════════════════╗`);
  console.log(`║          NexusGuard v1.0.0            ║`);
  console.log(`╠═══════════════════════════════════════╣`);
  console.log(`║  API:        http://localhost:${PORT}    ║`);
  console.log(`║  Dashboard:  http://localhost:${PORT}    ║`);
  console.log(`║  Metrics:    http://localhost:${PORT}/metrics ║`);
  console.log(`║  WS:         ws://localhost:${PORT}/metrics/ws ║`);
  console.log(`╚═══════════════════════════════════════╝\n`);
});

module.exports = { app, server };
