#!/usr/bin/env node

import { performance } from 'node:perf_hooks';

const [url, requestsRaw = '128', concurrencyRaw = '8'] = process.argv.slice(2);
if (!url) {
  throw new Error('usage: node scripts/http-load-gate.mjs URL [requests] [concurrency]');
}
const requests = boundedInteger(requestsRaw, 'requests', 1, 100_000);
const concurrency = boundedInteger(concurrencyRaw, 'concurrency', 1, 256);
const timeoutMs = boundedInteger(
  process.env.HTTP_LOAD_REQUEST_TIMEOUT_MS ?? '5000',
  'HTTP_LOAD_REQUEST_TIMEOUT_MS',
  100,
  60_000,
);
const expectedStatus = boundedInteger(
  process.env.HTTP_LOAD_EXPECTED_STATUS ?? '200',
  'HTTP_LOAD_EXPECTED_STATUS',
  100,
  599,
);

const latencies = new Array(requests);
const failures = [];
let next = 0;
const startedAt = performance.now();

await Promise.all(Array.from(
  { length: Math.min(requests, concurrency) },
  async () => {
    while (true) {
      const index = next++;
      if (index >= requests) return;
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        await response.arrayBuffer();
        latencies[index] = performance.now() - requestStartedAt;
        if (response.status !== expectedStatus) {
          failures.push({ index, status: response.status });
        }
      } catch (error) {
        latencies[index] = performance.now() - requestStartedAt;
        failures.push({
          index,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
  },
));

latencies.sort((a, b) => a - b);
const report = {
  url: new URL(url).origin + new URL(url).pathname,
  requests,
  concurrency,
  expectedStatus,
  requestTimeoutMs: timeoutMs,
  failures: failures.length,
  durationMs: Math.round(performance.now() - startedAt),
  latencyMs: {
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: Math.round(latencies.at(-1) ?? 0),
  },
};
console.log(JSON.stringify(report));
if (failures.length) {
  console.error(JSON.stringify({ sampleFailures: failures.slice(0, 10) }));
  process.exitCode = 1;
}

function boundedInteger(raw, label, min, max) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function percentile(values, quantile) {
  const index = Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1);
  return Math.round(values[Math.max(0, index)] ?? 0);
}
