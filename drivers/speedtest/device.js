'use strict';

const Homey = require('homey');
const { CloudflareSpeedTest } = require('../../lib/cloudflare');

class SpeedtestDevice extends Homey.Device {
  async onInit() {
    this.log('Internet Speed device initialized (Cloudflare backend)');
    this._timer = null;
    this._startupTimer = null;
    this._running = false;
    // remembered across restarts so degraded/restored Flows do not fire twice
    this._wasDegraded = Boolean(this.getStoreValue('wasDegraded'));

    this._scheduleNext();

    // Populate the device shortly after it is added/restarted.
    this._startupTimer = this.homey.setTimeout(() => {
      this.runSpeedTest('startup').catch(err => this.error('Startup speed test failed:', err));
    }, 15000);
  }

  async onDeleted() {
    this._clearTimers();
  }

  async onUninit() {
    this._clearTimers();
  }

  _clearTimers() {
    if (this._timer) this.homey.clearInterval(this._timer);
    if (this._startupTimer) this.homey.clearTimeout(this._startupTimer);
    this._timer = null;
    this._startupTimer = null;
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

    const test = new CloudflareSpeedTest({ userAgent: `Homey-Internet-Speed/${this.homey.manifest.version}` });
    try {
      const result = await test.run();
      const values = {
        download: result.download,
        upload: result.upload,
        ping: result.ping,
        jitter: result.jitter,
        packet_loss: result.packet_loss,
      };

      await Promise.all([
        this.setCapabilityValue('measure_download_speed', values.download),
        this.setCapabilityValue('measure_upload_speed', values.upload),
        this.setCapabilityValue('measure_ping', values.ping),
        this.setCapabilityValue('measure_jitter', values.jitter),
        this.setCapabilityValue('measure_packet_loss', values.packet_loss),
      ]);
      if (!this.getAvailable()) await this.setAvailable();

      await this.driver.triggerCard('speedtest_completed', this, values, {});
      await this._evaluateQuality(values);

      this.log(`Speed test completed: ${values.download} Mbps down, ${values.upload} Mbps up, `
        + `${values.ping} ms latency, ${values.jitter} ms jitter, ${Math.round(result.bytes_used / 1e6)} MB used`);
      return values;
    } catch (err) {
      this.error(`Speed test failed (${source}):`, err.message || err);
      try {
        await this.driver.triggerCard('speedtest_failed', this, { error: err.message || String(err) }, {});
      } catch (triggerErr) {
        this.error('Failed to trigger speedtest_failed Flow:', triggerErr);
      }
      throw err;
    } finally {
      test.close();
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
    if (degraded !== this._wasDegraded) await this.setStoreValue('wasDegraded', degraded);
    this._wasDegraded = degraded;
  }

}

module.exports = SpeedtestDevice;
