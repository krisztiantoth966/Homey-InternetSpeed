'use strict';

// Speed test against speed.cloudflare.com over HTTPS.
// One keep-alive agent per test, so latency samples measure the round trip on
// an open connection (no DNS/TCP/TLS set-up), the same way browser speed tests do.

const https = require('https');
const { Readable } = require('stream');
const { performance } = require('perf_hooks');

const HOST = 'speed.cloudflare.com';

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Server processing time Cloudflare reports in Server-Timing (ms). */
function serverTimeMs(header) {
  const text = Array.isArray(header) ? header.join(',') : String(header || '');
  let max = 0;
  const re = /\bdur=([0-9.]+)/g;
  let m;
  while ((m = re.exec(text))) max = Math.max(max, Number(m[1]) || 0);
  return max;
}

/** Mean absolute difference between consecutive samples (RFC 3550 style). */
function jitterOf(samples) {
  if (samples.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < samples.length; i++) total += Math.abs(samples[i] - samples[i - 1]);
  return total / (samples.length - 1);
}

class CloudflareSpeedTest {
  constructor({ userAgent = 'Homey-Internet-Speed', host = HOST, port = 443, transport = https } = {}) {
    this.userAgent = userAgent;
    this.host = host;
    this.port = port;
    this.transport = transport;
    this.agent = new transport.Agent({ keepAlive: true, maxSockets: 8 });
  }

  close() {
    this.agent.destroy();
  }

  /**
   * Latency: time to the first response byte of a zero-byte download on a
   * warm connection. The first (cold) request is discarded.
   */
  async latency(attempts = 20, pauseMs = 100) {
    await this._request({ method: 'GET', path: `/__down?bytes=0&warm=${Date.now()}` }, null, 8000)
      .catch(() => {});

    const samples = [];
    let failures = 0;
    for (let i = 0; i < attempts; i++) {
      try {
        const { ttfb, serverMs } = await this._request({ method: 'GET', path: `/__down?bytes=0&r=${Date.now()}-${i}` }, null, 5000);
        // network round trip only: remove Cloudflare's own processing time
        samples.push(Math.max(0, ttfb - serverMs));
      } catch (err) {
        failures++;
      }
      if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
    if (!samples.length) throw new Error('Cloudflare latency test failed: no successful requests');
    return {
      ping: median(samples),
      jitter: jitterOf(samples),
      loss: (failures / attempts) * 100,
      samples,
    };
  }

  async download(bytes, timeoutMs = 30000, lane = 0) {
    const start = performance.now();
    const result = await this._request({ method: 'GET', path: `/__down?bytes=${bytes}&r=${Date.now()}-${lane}` }, null, timeoutMs);
    // count from the first byte: excludes the request round trip
    const seconds = Math.max((performance.now() - start - result.ttfb) / 1000, 0.001);
    return { bytes: result.bytes, bitsPerSecond: result.bytes * 8 / seconds };
  }

  async parallelDownload(totalBytes, lanes = 4, timeoutMs = 30000) {
    const per = Math.max(1024 * 1024, Math.ceil(totalBytes / lanes));
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: lanes }, (_, i) => this.download(per, timeoutMs, i)));
    const seconds = Math.max((performance.now() - start) / 1000, 0.001);
    return results.reduce((sum, r) => sum + r.bytes, 0) * 8 / seconds;
  }

  async upload(bytes, timeoutMs = 30000) {
    const start = performance.now();
    await this._request({
      method: 'POST',
      path: '/__up',
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes) },
    }, bytes, timeoutMs);
    const seconds = Math.max((performance.now() - start) / 1000, 0.001);
    return { bytes, bitsPerSecond: bytes * 8 / seconds };
  }

  async parallelUpload(totalBytes, lanes = 2, timeoutMs = 30000) {
    const per = Math.max(512 * 1024, Math.ceil(totalBytes / lanes));
    const start = performance.now();
    await Promise.all(Array.from({ length: lanes }, () => this.upload(per, timeoutMs)));
    const seconds = Math.max((performance.now() - start) / 1000, 0.001);
    return per * lanes * 8 / seconds;
  }

  /** Full test: latency, then download and upload sized from a short warm-up. */
  async run() {
    const latency = await this.latency();
    const warmDown = await this.download(2 * 1024 * 1024, 15000);
    const downTarget = clamp(Math.round(warmDown.bitsPerSecond * 4 / 8), 10 * 1024 * 1024, 100 * 1024 * 1024);
    const download = await this.parallelDownload(downTarget, 4);
    const warmUp = await this.upload(512 * 1024, 15000);
    const upTarget = clamp(Math.round(warmUp.bitsPerSecond * 3 / 8), 2 * 1024 * 1024, 30 * 1024 * 1024);
    const upload = await this.parallelUpload(upTarget, 2);
    return {
      download: round1(download / 1e6),
      upload: round1(upload / 1e6),
      ping: round1(latency.ping),
      jitter: round1(latency.jitter),
      packet_loss: round1(latency.loss),
      bytes_used: Math.round(2 * 1024 * 1024 + downTarget + 512 * 1024 + upTarget),
    };
  }

  _request(options, uploadBytes, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let received = 0;
      const start = performance.now();
      let ttfb = null;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(value);
      };

      const req = this.transport.request({
        host: this.host,
        port: this.port,
        agent: this.agent,
        ...options,
        headers: {
          'user-agent': this.userAgent,
          'cache-control': 'no-cache',
          ...(options.headers || {}),
        },
      }, (res) => {
        ttfb = performance.now() - start;
        const serverMs = serverTimeMs(res.headers['server-timing']);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          finish(new Error(`Cloudflare returned HTTP ${res.statusCode}`));
          return;
        }
        res.on('data', (chunk) => { received += chunk.length; });
        res.on('end', () => finish(null, { bytes: received, ttfb, serverMs }));
        res.on('error', (err) => finish(err));
      });

      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
      req.on('error', (err) => finish(err));

      if (typeof uploadBytes === 'number' && uploadBytes > 0) {
        const chunkSize = 64 * 1024;
        const chunk = Buffer.alloc(chunkSize);
        let remaining = uploadBytes;
        const stream = new Readable({
          read() {
            while (remaining > 0) {
              const size = Math.min(chunkSize, remaining);
              remaining -= size;
              if (!this.push(size === chunkSize ? chunk : chunk.subarray(0, size))) return;
            }
            this.push(null);
          },
        });
        stream.on('error', (err) => req.destroy(err));
        stream.pipe(req);
      } else {
        req.end();
      }
    });
  }
}

function round1(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

module.exports = { CloudflareSpeedTest, median, jitterOf, serverTimeMs };
