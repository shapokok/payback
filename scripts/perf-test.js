#!/usr/bin/env node
const http = require('http');

const URL = process.env.TARGET_URL || 'http://localhost:3000';
const RUNS = 3;

function fetchTimed(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const req = http.get(url, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - start }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function run() {
  console.log(`\nPayBack — Load Time Test`);
  console.log(`Target: ${URL}`);
  console.log(`Runs:   ${RUNS}\n`);

  const times = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const result = await fetchTimed(URL);
      times.push(result.ms);
      const status = result.ms < 3000 ? '✓' : '✗';
      console.log(`  Run ${i}: ${result.ms}ms  HTTP ${result.status}  ${status}`);
    } catch (err) {
      console.log(`  Run ${i}: ERROR — ${err.message}`);
    }
  }

  if (times.length === 0) {
    console.log('\n  Could not reach server. Is the frontend running?');
    process.exit(1);
  }

  const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
  const min = Math.min(...times);
  const max = Math.max(...times);
  const pass = avg < 3000;

  console.log(`\n  Min: ${min}ms  Max: ${max}ms  Avg: ${avg}ms`);
  console.log(`  NFR-01 target (<3000ms): ${pass ? 'PASS ✓' : 'FAIL ✗'}\n`);
  process.exit(pass ? 0 : 1);
}

run();
