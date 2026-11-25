'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { CloudflareSpeedTest, median, jitterOf, serverTimeMs } = require('../lib/cloudflare');

test('median and jitter', () => {
  assert.strictEqual(median([5, 1, 3]), 3);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(jitterOf([10, 12, 10, 14]), (2 + 2 + 4) / 3);
  assert.strictEqual(jitterOf([10]), 0);
});

test('server time is taken from Server-Timing', () => {
  assert.strictEqual(serverTimeMs('cfSpeedEdge;dur=4, cfSpeedWorker;dur=16'), 16);
  assert.strictEqual(serverTimeMs(['cfL4;desc="?rtt=1"', 'cfRequestDuration;dur=12.5']), 12.5);
  assert.strictEqual(serverTimeMs(undefined), 0);
});

test('latency reuses one connection and removes server processing time', async () => {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    sockets.add(req.socket);
    // pretend the server spends 30 ms; the network itself is local (~0 ms)
    setTimeout(() => {
      res.setHeader('Server-Timing', 'cfSpeedWorker;dur=30');
      res.end();
    }, 30);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const t = new CloudflareSpeedTest({ host: '127.0.0.1', port: server.address().port, transport: http });
  try {
    const result = await t.latency(6, 0);
    assert.strictEqual(result.loss, 0);
    assert.ok(result.ping < 15, `ping ${result.ping} should exclude the 30 ms server time`);
    assert.strictEqual(sockets.size, 1, 'all samples on one keep-alive connection');
  } finally {
    t.close();
    server.close();
  }
});
