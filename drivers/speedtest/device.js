'use strict';

const Homey = require('homey');
const https = require('https');
const { Readable } = require('stream');
const { performance } = require('perf_hooks');

const HOST = 'speed.cloudflare.com';

class SpeedtestDevice extends Homey.Device {
  async onInit() {
    this.log('Internet Speed device initialized (Cloudflare backend)');
    this._timer = null;
    this._startupTimer = null;
    this._running = false;
    this._wasDegraded = false;

    this._scheduleNext();

    // Populate the device shortly after it is added/restarted.
    this._startupTimer = this.homey.setTimeout(() => {
      this.runSpeedTest('startup').catch(err => this.error('Startup speed test failed:', err));
    }, 15000);
  }

  async onDeleted() {
    if (this._timer) this.homey.clearInterval(this._timer);
    if (this._startupTimer) this.homey.clearTimeout(this._startupTimer);
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('interval_hours')) {
      this._scheduleNext(newSettings.interval_hours);
    }
  }

  _scheduleNext(forcedHours) {
    if (this._timer) {
      this.homey.clearInterval(this._timer);
      this._timer = null;
    }

    const hours = Number(forcedHours ?? this.getSetting('interval_hours') ?? 0);
    if (!Number.isFinite(hours) || hours <= 0) {
      this.log('Automatic speed tests disabled');
      return;
    }

    const ms = Math.max(1, hours) * 60 * 60 * 1000;
    this._timer = this.homey.setInterval(() => {
      this.runSpeedTest('schedule').catch(err => this.error('Scheduled test failed:', err));
    }, ms);
    this.log(`Automatic speed test scheduled every ${hours} hour(s)`);
  }

  async runSpeedTest(source = 'manual') {
    if (this._running) throw new Error('A speed test is already running');
    this._running = true;
    this.log(`Starting Cloudflare speed test (${source})`);

    try {
      const latency = await this._measureLatency(8);

      // Warm-up / estimation pass.
      const warmDownload = await this._downloadBytes(2 * 1024 * 1024, 15000);
      const estimatedDownBps = warmDownload.bitsPerSecond;
      const downloadTarget = this._clamp(Math.round(estimatedDownBps * 4 / 8), 10 * 1024 * 1024, 100 * 1024 * 1024);
      const download = await this._parallelDownload(downloadTarget, 4);

      const warmUpload = await this._uploadBytes(512 * 1024, 15000);
      const estimatedUpBps = warmUpload.bitsPerSecond;
      const uploadTarget = this._clamp(Math.round(estimatedUpBps * 3 / 8), 2 * 1024 * 1024, 30 * 1024 * 1024);
      const upload = await this._parallelUpload(uploadTarget, 2);

      const values = {
        download: this._round1(download / 1e6),
        upload: this._round1(upload / 1e6),
        ping: this._round1(latency.ping),
        jitter: this._round1(latency.jitter),
        packet_loss: this._round1(latency.loss)
      };

      await Promise.all([
        this.setCapabilityValue('measure_download_speed', values.download),
        this.setCapabilityValue('measure_upload_speed', values.upload),
        this.setCapabilityValue('measure_ping', values.ping),
        this.setCapabilityValue('measure_jitter', values.jitter),
        this.setCapabilityValue('measure_packet_loss', values.packet_loss)
      ]);

      await this.driver.triggerCard('speedtest_completed', this, values, {});

      await this._evaluateQuality(values);

      this.log(`Speed test completed: ${values.download} Mbps down, ${values.upload} Mbps up, ${values.ping} ms latency, ${values.jitter} ms jitter`);
      return values;
    } catch (err) {
      this.error(`Speed test failed (${source}):`, err);
      try {
        await this.driver.triggerCard('speedtest_failed', this, { error: err.message || String(err) }, {});
      } catch (triggerErr) {
        this.error('Failed to trigger speedtest_failed Flow:', triggerErr);
      }
      throw err;
    } finally {
      this._running = false;
    }
  }


  async _evaluateQuality(values) {
    const minDownload = Number(this.getSetting('min_download') || 0);
    const minUpload = Number(this.getSetting('min_upload') || 0);
    const maxLatency = Number(this.getSetting('max_latency') || 0);
    const maxLoss = Number(this.getSetting('max_request_loss') || 0);

    const reasons = [];
    if (minDownload > 0 && values.download < minDownload) reasons.push(`Download ${values.download} Mbps < ${minDownload} Mbps`);
    if (minUpload > 0 && values.upload < minUpload) reasons.push(`Upload ${values.upload} Mbps < ${minUpload} Mbps`);
    if (maxLatency > 0 && values.ping > maxLatency) reasons.push(`Latency ${values.ping} ms > ${maxLatency} ms`);
    if (maxLoss > 0 && values.packet_loss > maxLoss) reasons.push(`Request loss ${values.packet_loss}% > ${maxLoss}%`);

    const degraded = reasons.length > 0;
    if (degraded && !this._wasDegraded) {
      await this.driver.triggerCard('connection_degraded', this, { reason: reasons.join('; '), ...values }, {});
    } else if (!degraded && this._wasDegraded) {
      await this.driver.triggerCard('connection_restored', this, values, {});
    }
    this._wasDegraded = degraded;
  }

  async _measureLatency(attempts) {
    const samples = [];
    let failures = 0;

    for (let i = 0; i < attempts; i++) {
      try {
        const t0 = performance.now();
        await this._request({ method: 'GET', path: `/__down?bytes=1000&r=${Date.now()}-${i}` }, null, 8000, true);
        samples.push(performance.now() - t0);
      } catch (err) {
        failures++;
        this.log(`Latency probe ${i + 1} failed: ${err.message}`);
      }
      await new Promise(resolve => this.homey.setTimeout(resolve, 120));
    }

    if (!samples.length) throw new Error('Cloudflare latency test failed: no successful requests');

    const sorted = [...samples].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const ping = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

    let jitter = 0;
    if (samples.length > 1) {
      let total = 0;
      for (let i = 1; i < samples.length; i++) total += Math.abs(samples[i] - samples[i - 1]);
      jitter = total / (samples.length - 1);
    }

    return { ping, jitter, loss: (failures / attempts) * 100 };
  }

  async _parallelDownload(totalBytes, concurrency) {
    const perRequest = Math.max(1024 * 1024, Math.ceil(totalBytes / concurrency));
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: concurrency }, (_, i) =>
      this._downloadBytes(perRequest, 30000, i)
    ));
    const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001);
    const bytes = results.reduce((sum, r) => sum + r.bytes, 0);
    return bytes * 8 / elapsedSeconds;
  }

  async _downloadBytes(bytes, timeoutMs, lane = 0) {
    const start = performance.now();
    const result = await this._request({
      method: 'GET',
      path: `/__down?bytes=${bytes}&r=${Date.now()}-${lane}`
    }, null, timeoutMs, false);
    const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001);
    return { bytes: result.bytes, bitsPerSecond: result.bytes * 8 / elapsedSeconds };
  }

  async _parallelUpload(totalBytes, concurrency) {
    const perRequest = Math.max(512 * 1024, Math.ceil(totalBytes / concurrency));
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: concurrency }, () =>
      this._uploadBytes(perRequest, 30000)
    ));
    const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001);
    const bytes = results.reduce((sum, r) => sum + r.bytes, 0);
    return bytes * 8 / elapsedSeconds;
  }

  async _uploadBytes(bytes, timeoutMs) {
    const start = performance.now();
    await this._request({
      method: 'POST',
      path: '/__up',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes)
      }
    }, bytes, timeoutMs, true);
    const elapsedSeconds = Math.max((performance.now() - start) / 1000, 0.001);
    return { bytes, bitsPerSecond: bytes * 8 / elapsedSeconds };
  }

  _request(options, uploadBytes, timeoutMs, discardBody) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let received = 0;

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve(value);
      };

      const req = https.request({
        host: HOST,
        port: 443,
        ...options,
        headers: {
          'user-agent': 'Homey-Internet-Speed/1.2.1',
          'cache-control': 'no-cache',
          ...(options.headers || {})
        }
      }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return finish(new Error(`Cloudflare returned HTTP ${res.statusCode}`));
        }

        res.on('data', chunk => {
          received += chunk.length;
          if (discardBody) return;
        });
        res.on('end', () => finish(null, { bytes: received }));
        res.on('error', err => finish(err));
      });

      req.setTimeout(timeoutMs, () => req.destroy(new Error(`Request timed out after ${timeoutMs} ms`)));
      req.on('error', err => finish(err));

      if (typeof uploadBytes === 'number' && uploadBytes > 0) {
        const chunkSize = 64 * 1024;
        let remaining = uploadBytes;
        const stream = new Readable({
          read() {
            while (remaining > 0) {
              const size = Math.min(chunkSize, remaining);
              remaining -= size;
              if (!this.push(Buffer.alloc(size))) return;
            }
            this.push(null);
          }
        });
        stream.on('error', err => req.destroy(err));
        stream.pipe(req);
      } else {
        req.end();
      }
    });
  }

  _round1(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0;
  }

  _clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }
}

module.exports = SpeedtestDevice;
