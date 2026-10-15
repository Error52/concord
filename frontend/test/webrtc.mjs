// Runs test/webrtc-harness.ts in headless Chromium with a fake microphone.
//   node test/webrtc.mjs
import * as esbuild from 'esbuild';
import http from 'node:http';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const bundle = await esbuild.build({ entryPoints: ['test/webrtc-harness.ts'], bundle: true, write: false, format: 'esm', target: 'chrome110' });
const js = bundle.outputFiles[0].text;
const server = http.createServer((req, res) => {
  if (req.url === '/h.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(js);
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><script type="module" src="/h.js"></script>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => typeof window.runHarness === 'function');
  const r = await page.evaluate(() => window.runHarness());
  console.log(JSON.stringify(r, null, 2));
  assert.ok(r.micMaxDb > -60, 'microphone level should be measured from real samples');
  assert.equal(r.vadOpened, true, 'VAD should open on the fake microphone tone');
  assert.ok(r.stats.rttMs !== null && r.stats.rttMs >= 0, 'RTT from candidate pair');
  assert.ok(r.stats.uploadKbps > 0, 'upload bitrate from outbound-rtp deltas');
  assert.ok(r.stats.downloadKbps > 0, 'download bitrate from inbound-rtp deltas');
  assert.equal(r.stats.codec, 'Opus');
  assert.ok(r.stats.transport?.startsWith('UDP'), 'transport from local candidate');
  assert.notEqual(r.stats.quality, 'unknown');
  console.log('webrtc harness: OK');
} finally {
  await browser.close();
  server.close();
}
