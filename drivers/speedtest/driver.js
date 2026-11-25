'use strict';

const Homey = require('homey');

class SpeedtestDriver extends Homey.Driver {
  async onInit() {
    this.log('Internet Speed driver initialized');

    this._triggers = {};
    for (const id of ['speedtest_completed', 'connection_degraded', 'connection_restored', 'speedtest_failed']) {
      try {
        this._triggers[id] = this.homey.flow.getDeviceTriggerCard(id);
      } catch (err) {
        this.error(`Failed to register Flow trigger ${id}:`, err);
      }
    }
  }

  async triggerCard(id, device, tokens = {}, state = {}) {
    const card = this._triggers[id];
    if (!card) {
      this.error(`Flow trigger ${id} is unavailable`);
      return;
    }
    await card.trigger(device, tokens, state);
  }

  async onPairListDevices() {
    const existing = this.getDevices();
    if (existing.length > 0) return [];

    return [{
      name: 'Internet Speed',
      data: { id: 'internet-speed' },
      settings: {
        interval_hours: 6,
        min_download: 50,
        min_upload: 10,
        max_latency: 100,
        max_request_loss: 5
      }
    }];
  }
}

module.exports = SpeedtestDriver;
