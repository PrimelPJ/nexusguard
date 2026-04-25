#!/usr/bin/env node
/**
 * NexusGuard Load Tester
 * =======================
 * Fires concurrent requests against rate-limited endpoints
 * and reports: allowed, blocked, latency percentiles, RPS.
 *
 * Usage:
 *   node load-test/loadTest.js --url http://localhost:3000/api/sliding \
 *                               --rps 50 --duration 10
 */

"use strict";

const http = require("http");
const https = require("https");
const { URL } = require("url");

const args = parseArgs();
const targetUrl = new URL(args.url || "http://localhost:3000/api/sliding");
const targetRps = parseInt(args.rps || "30");
const durationSec = parseInt(args.duration || "10");
const concurrency = parseInt(args.concurrency || "10");

const results = { allowed: 0, blocked: 0, errors: 0, latencies: [] };

async function request(url) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.get(url, (res) => {
      res.on("data", () => {});
      res.on("end", () => {
        resolve({ status: res.statusCode, latency: Date.now() - t0 });
      });
    });
    req.on("error", () => {
      resolve({ status: 0, latency: Date.now() - t0 });
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ status: 0, latency: 5000 });
    });
  });
}

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function run() {
  console.log(`\n${"=".repeat(55)}`);
  console.log("  NexusGuard Load Test");
  console.log(`${"=".repeat(55)}`);
  console.log(`  Target   : ${targetUrl.href}`);
  console.log(`  RPS      : ${targetRps}`);
  console.log(`  Duration : ${durationSec}s`);
  console.log(`  Expected : ${targetRps * durationSec} requests`);
  console.log(`${"=".repeat(55)}\n`);

  const intervalMs = 1000 / targetRps;
  const endTime = Date.now() + durationSec * 1000;

  const pending = new Set();
  let reqCount = 0;

  const timer = setInterval(async () => {
    if (Date.now() >= endTime) {
      clearInterval(timer);
      await Promise.all(pending);
      printResults(reqCount);
      return;
    }

    if (pending.size >= concurrency) return; // backpressure

    const p = request(targetUrl).then(({ status, latency }) => {
      reqCount++;
      results.latencies.push(latency);
      if (status === 200) results.allowed++;
      else if (status === 429) results.blocked++;
      else results.errors++;
      pending.delete(p);
    });
    pending.add(p);
  }, intervalMs);
}

function printResults(total) {
  const lats = results.latencies;
  if (lats.length === 0) {
    console.log("No requests completed.");
    return;
  }

  const blockRate = ((results.blocked / total) * 100).toFixed(1);
  const p50 = percentile(lats, 50);
  const p95 = percentile(lats, 95);
  const p99 = percentile(lats, 99);
  const avg = (lats.reduce((s, v) => s + v, 0) / lats.length).toFixed(1);

  console.log(`\n${"=".repeat(55)}`);
  console.log("  RESULTS");
  console.log(`${"=".repeat(55)}`);
  console.log(`  Total requests  : ${total}`);
  console.log(`  Allowed         : ${results.allowed} (${(100 - parseFloat(blockRate)).toFixed(1)}%)`);
  console.log(`  Blocked (429)   : ${results.blocked} (${blockRate}%)`);
  console.log(`  Errors          : ${results.errors}`);
  console.log(``);
  console.log(`  Latency avg     : ${avg}ms`);
  console.log(`  Latency p50     : ${p50}ms`);
  console.log(`  Latency p95     : ${p95}ms`);
  console.log(`  Latency p99     : ${p99}ms`);
  console.log(`${"=".repeat(55)}\n`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, "");
    result[key] = args[i + 1];
  }
  return result;
}

run().catch(console.error);
