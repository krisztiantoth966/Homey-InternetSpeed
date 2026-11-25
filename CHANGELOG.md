# Changelog

## 1.3.0
- Realistic latency and jitter: samples are taken on one warm keep-alive connection, the cold first request is discarded and Cloudflare's own processing time (Server-Timing) is subtracted. Previously DNS/TCP/TLS set-up was counted, inflating latency (e.g. 70 ms) and jitter (e.g. 212 ms).
- 20 latency samples instead of 8; download speed counted from the first byte.
- Degraded/restored state is remembered across restarts, so the Flows do not fire twice.
- Timers are cleaned up when the app stops.

## 1.2.1
- Fixed startup crash caused by device Flow cards being defined at app level.
- Moved device triggers and the manual speed-test action to `driver.flow.compose.json`.
- Made Flow registration fault-tolerant.
- Simplified capability SVG icon paths for Homey UI compatibility.

## 1.2.0
- Added publish-ready app and driver artwork.
- Reworked custom capability icons for Homey UI compatibility.
- Renamed Ping to Latency in the user interface.
- Added configurable quality thresholds.
- Added Flow triggers for degraded/restored internet quality and failed tests.
- Added App Store metadata and driver connectivity metadata.

## 1.1.0
- Replaced native Ookla CLI backend with a pure HTTPS Cloudflare speed test backend.
