'use strict';

const Homey = require('homey');

class InternetSpeedApp extends Homey.App {
  async onInit() {
    this.log('Internet Speed initialized');

    try {
      this.homey.flow.getActionCard('run_speedtest')
        .registerRunListener(async ({ device }) => {
          await device.runSpeedTest('flow');
          return true;
        });
    } catch (err) {
      this.error('Failed to register run_speedtest Flow action:', err);
    }
  }
}

module.exports = InternetSpeedApp;
