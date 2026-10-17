// Production-bundle DM call regressions against a real LiveKit SFU.
// Uses the isolated demo Alice/Bob accounts and records only per-case history deltas.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = process.env.BASE_URL ?? 'http://localhost:5181';
const OUT = process.env.CALL_DIR ?? 'test/results/call-lifecycle';
await mkdir(OUT, { recursive: true });
const result = { checks: [], errors: [] };
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const sessions = [];
let a, b, channelId, oldSid;

async function session(name) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'] });
  sessions.push(context);
  await context.addInitScript(() => {
    window.__callProbe = { sent: [], received: [] };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        if (!String(args[0]).includes('/gateway')) return;
        this.addEventListener('message', event => {
          try {
            const msg = JSON.parse(event.data);
            if (/^(call:|voice:|error$)/.test(msg.t)) {
              window.__callProbe.received.push(msg);
              if (window.__callProbe.received.length > 256) window.__callProbe.received.shift();
            }
          } catch { /* SFU binary frames and unrelated traffic are ignored. */ }
        });
      }
      send(data) {
        if (this.url.includes('/gateway')) {
          try {
            const msg = JSON.parse(data);
            if (/^(call:|voice:)/.test(msg.op)) {
              window.__callProbe.sent.push(msg);
              if (window.__callProbe.sent.length > 256) window.__callProbe.sent.shift();
            }
          } catch { /* Ignore non-JSON frames. */ }
        }
        return super.send(data);
      }
    };
  });
  const page = await context.newPage();
  page.on('pageerror', error => result.errors.push(`${name}: ${error.message}`));
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(`${name}@concord.local`);
  await page.getByLabel('Пароль', { exact: true }).fill('demo12345');
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/auth/login');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const login = await response;
  assert.equal(login.status(), 200);
  const auth = await login.json();
  await page.getByText('Друзья', { exact: true }).first().waitFor();
  return { context, page, token: auth.accessToken, userId: auth.user.id };
}

async function api(session, path, data) {
  const response = await session.context.request[data === undefined ? 'get' : 'post'](`${BASE}/api${path}`, {
    headers: { Authorization: `Bearer ${session.token}`, 'X-Requested-With': 'concord' },
    ...(data === undefined ? {} : { data }),
  });
  assert.ok(response.ok(), `${path}: ${response.status()}`);
  return response.json();
}

async function calls() {
  const messages = await api(a, `/channels/${channelId}/messages?limit=100`);
  return messages.filter(message => message.kind === 'system' && /^call:/.test(message.content));
}

async function waitFor(fn, description, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let last;
  do {
    last = await fn();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < until);
  assert.fail(`Timed out: ${description}`);
}

async function voiceCount(count) {
  return waitFor(async () => (await api(a, `/voice/states/${channelId}`)).length === count, `${count} authoritative DM voice participants`);
}

const incoming = () => b.page.getByRole('alertdialog', { name: /^Входящий звонок от / });
const hangup = page => page.locator('.stage-controls').getByRole('button', { name: 'Отключиться', exact: true });

async function start() {
  await a.page.getByRole('button', { name: 'Голосовой звонок', exact: true }).click();
  await incoming().waitFor();
  await hangup(a.page).waitFor();
  await voiceCount(1);
  const sid = await a.page.evaluate(channel => window.__callProbe.sent.filter(m => m.op === 'voice:state' && m.d.channelId === channel && m.d.participantSid).at(-1)?.d.participantSid, channelId);
  assert.ok(sid, 'the production voice engine announces its actual participant SID');
  return sid;
}

async function check(name, expected, fn) {
  const before = new Set((await calls()).map(message => message.id));
  const started = Date.now();
  await fn(async () => (await calls()).filter(message => !before.has(message.id)));
  const delta = await waitFor(async () => {
    const rows = (await calls()).filter(message => !before.has(message.id));
    return rows.length ? rows : null;
  }, 'one committed call history entry');
  await voiceCount(0);
  // Let delayed client end operations and SFU departure webhooks both settle.
  await new Promise(resolve => setTimeout(resolve, 500));
  const stable = (await calls()).filter(message => !before.has(message.id));
  assert.equal(delta.length, 1);
  assert.equal(stable.length, 1, 'late departure/end must not duplicate call history');
  assert.match(stable[0].content, expected);
  result.checks.push({ name, ms: Date.now() - started, history: stable.map(message => ({ id: message.id, content: message.content })) });
}

try {
  a = await session('alice');
  b = await session('bob');
  channelId = (await api(a, '/dm', { recipientId: b.userId })).id;
  await Promise.all([a.page.goto(`${BASE}/channels/@me/${channelId}`), b.page.goto(`${BASE}/channels/@me/${channelId}`)]);
  await a.page.getByRole('button', { name: 'Голосовой звонок', exact: true }).waitFor();
  await b.page.getByRole('button', { name: 'Голосовой звонок', exact: true }).waitFor();
  await voiceCount(0);

  await check('caller cancellation clears the incoming ring and records exactly one missed call', /^call:missed$/, async () => {
    oldSid = await start();
    await hangup(a.page).click();
    assert.equal(await a.page.evaluate(() => window.__callProbe.sent.filter(m => m.op === 'call:end').at(-1)?.d.participantSid), oldSid, 'UI hangup carries the current SFU participant SID');
    await incoming().waitFor({ state: 'detached' });
  });

  await check('callee decline followed by caller departure records exactly one missed call', /^call:missed$/, async () => {
    await start();
    await incoming().getByRole('button', { name: 'Отклонить', exact: true }).click();
    await incoming().waitFor({ state: 'detached' });
    await hangup(a.page).click();
  });

  await check('an answered real SFU call is recorded only after its last participant leaves', /^call:ended:[1-9]\d*$/, async delta => {
    await start();
    await incoming().getByRole('button', { name: 'Ответить', exact: true }).click();
    await hangup(b.page).waitFor();
    await voiceCount(2);
    await waitFor(async () => (await a.page.locator('.stage-grid .tile').count()) === 2 && (await b.page.locator('.stage-grid .tile').count()) === 2, 'both SFU clients see their remote participant');
    assert.deepEqual(await delta(), []);
    await hangup(a.page).click();
    await voiceCount(1);
    assert.deepEqual(await delta(), [], 'the first departure must not close a call still in progress');
    await hangup(b.page).click();
  });

  await check('stale and missing participant SIDs cannot cancel a new ring from the same caller', /^call:missed$/, async delta => {
    const currentSid = await start();
    assert.notEqual(currentSid, oldSid, 'the subsequent call has a new SFU participant incarnation');
    await a.page.evaluate(async ({ token, channelId, oldSid }) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/gateway`);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error('stale-tab gateway timeout')); }, 10000);
        ws.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('stale-tab gateway connection failed')); });
        ws.addEventListener('open', () => ws.send(JSON.stringify({ op: 'auth', d: { token } })));
        ws.addEventListener('message', event => {
          const msg = JSON.parse(event.data);
          if (msg.t === 'error') { clearTimeout(timeout); ws.close(); reject(new Error(`stale-tab gateway: ${msg.d.code}`)); }
          if (msg.t === 'ready') {
            ws.send(JSON.stringify({ op: 'call:end', d: { channelId, durationSec: 1, participantSid: oldSid } }));
            ws.send(JSON.stringify({ op: 'call:end', d: { channelId, durationSec: 1 } }));
            // Gateway operations execute in wire order; ack proves both end operations completed.
            ws.send(JSON.stringify({ op: 'heartbeat', d: { afk: false } }));
          }
          if (msg.t === 'heartbeat:ack') { clearTimeout(timeout); ws.close(); resolve(); }
        });
      });
    }, { token: a.token, channelId, oldSid });
    assert.ok(await incoming().isVisible(), 'the newer ring survives old/missing end SIDs');
    assert.deepEqual(await delta(), []);
    await hangup(a.page).click();
    assert.equal(await a.page.evaluate(() => window.__callProbe.sent.filter(m => m.op === 'call:end').at(-1)?.d.participantSid), currentSid, 'the current caller sends its new SID on hangup');
    await incoming().waitFor({ state: 'detached' });
  });
  assert.deepEqual(result.errors, []);
} catch (error) {
  result.failure = error.message;
  result.diagnostics = await Promise.all([a, b].filter(Boolean).map(async session => ({
    url: session.page.url(),
    text: (await session.page.locator('body').innerText().catch(() => '')).slice(-1800),
    probe: await session.page.evaluate(() => ({ sent: window.__callProbe.sent.slice(-20), received: window.__callProbe.received.slice(-20) })).catch(() => null),
  })));
  throw error;
} finally {
  await Promise.allSettled(sessions.map(context => context.close()));
  await browser.close();
  await writeFile(`${OUT}/results.json`, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}
