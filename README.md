# Internet Speed for Homey Pro

Internet Speed measures the connection from Homey Pro to Cloudflare over HTTPS.

## Measurements

- Download (Mbps)
- Upload (Mbps)
- Latency (ms)
- Jitter (ms)
- Request loss (%)

All measurements support Homey Insights.

## Flow

**When**
- A speed test completed
- Internet quality degraded
- Internet quality restored
- A speed test failed

**Then**
- Run a speed test

Quality thresholds and the automatic test interval can be configured in the device settings.

## Privacy

The app performs test requests against `speed.cloudflare.com`. No Homey account credentials are sent by this app.
