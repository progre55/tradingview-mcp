#!/usr/bin/env node
// Capture the REST payload of an alert created via the TradingView UI with
// sound enabled. Prints the sound_file / sound_duration values TV inserts by
// default — used to seed the `sound: true` shorthand in
// `src/core/alerts.js::buildNotificationFields`.
//
// Usage:
//   1. Start TradingView Desktop with CDP enabled (scripts/launch_tv_debug_mac.sh).
//   2. Run this script: `node scripts/capture_alert_sound.js`.
//   3. In TV, create a new price alert with the "Play sound" channel toggled on
//      (leave the sound dropdown at TV's default) and click Create.
//   4. This script prints the captured payload and exits.
//
// Implementation: monkey-patches window.fetch in TV's page context to store any
// POST to /create_alert under window.__capturedAlert, then polls until set.

import CDP from 'chrome-remote-interface';

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find((x) => x.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target on port 9222'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

// Install the hook. Survives until the page reloads.
await c.Runtime.evaluate({
  expression: `
    (function() {
      if (window.__alertCaptureInstalled) return 'already-installed';
      window.__alertCaptureInstalled = true;
      window.__capturedAlert = null;
      var origFetch = window.fetch;
      window.fetch = function(input, init) {
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.indexOf('/create_alert') !== -1 && init && init.body) {
            window.__capturedAlert = String(init.body);
          }
        } catch(e) {}
        return origFetch.apply(this, arguments);
      };
      return 'installed';
    })()
  `,
  returnByValue: true,
});

console.log('Hook installed. In TradingView, create an alert with "Play sound" ON and click Create.');
console.log('Waiting for capture (Ctrl-C to abort)...');

let captured = null;
const start = Date.now();
while (Date.now() - start < 5 * 60 * 1000) {
  const r = await c.Runtime.evaluate({ expression: 'window.__capturedAlert', returnByValue: true });
  if (r.result?.value) { captured = r.result.value; break; }
  await new Promise((r) => setTimeout(r, 500));
}

if (!captured) {
  console.error('No /create_alert request captured in 5 minutes. Aborting.');
  await c.close();
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(captured); }
catch (e) { console.error('Captured body is not JSON:', captured); await c.close(); process.exit(1); }

const payload = parsed.payload || parsed;
console.log('\n--- Captured /create_alert payload ---');
console.log(JSON.stringify(payload, null, 2));
console.log('\n--- Sound fields ---');
console.log('sound_file:    ', JSON.stringify(payload.sound_file));
console.log('sound_duration:', JSON.stringify(payload.sound_duration));

await c.close();
