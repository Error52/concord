import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { Client, startServer, type Harness } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { redis } from '../src/redis.js';
import { accept, decline, end, ring } from '../src/services/callService.js';
import { markJoined, markLeft } from '../src/services/voiceService.js';

let h: Harness;
let serial = 0;
before(async () => { h = await startServer(); });
after(async () => { await h?.close(); });

async function pair() {
  const id = ++serial;
  const a = await new Client(h.base).register(`call_reg_a${id}`);
  const b = await new Client(h.base).register(`call_reg_b${id}`);
  const dm = (await a.post('/api/dm', { recipientId: b.user.id })).body.id as string;
  return { a, b, dm };
}

async function pending(channelId: string) {
  const raw = await redis.get(`call:ring:${channelId}`);
  return raw ? JSON.parse(raw) as { id: string; callerId: string } : null;
}

async function history(channelId: string): Promise<string[]> {
  return (await pool.query(`SELECT content FROM messages WHERE channel_id=$1 AND kind='system' ORDER BY id`, [channelId])).rows.map(row => row.content);
}

test('each unanswered attempt is retained when ringing expires before the caller leaves its SFU room', async () => {
  const { a, dm } = await pair();
  await markJoined(a.user.id, dm);
  await ring(dm, a.user.id, false);
  const first = await pending(dm);
  // Deterministically simulate Redis TTL expiry without waiting 45 seconds.
  await redis.del(`call:ring:${dm}`);
  await Promise.all(Array.from({ length: 3 }, () => ring(dm, a.user.id, false)));
  assert.notEqual((await pending(dm))?.id, first?.id);
  await markLeft(a.user.id, dm);
  assert.deepEqual(await history(dm), ['call:missed', 'call:missed']);
});

test('retrying a ring in an already answered SFU session never creates a false missed call', async () => {
  const { a, b, dm } = await pair();
  await markJoined(a.user.id, dm);
  await ring(dm, a.user.id, false);
  await markJoined(b.user.id, dm);
  await redis.del(`call:ring:${dm}`);
  await ring(dm, a.user.id, true);
  assert.deepEqual(await history(dm), []);
  await markLeft(a.user.id, dm);
  await markLeft(b.user.id, dm);
  const messages = await history(dm);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^call:ended:[1-9]\d*$/);
});

test('accepting before the callee SFU join does not erase the call if its caller disconnects first', async () => {
  const { a, b, dm } = await pair();
  await markJoined(a.user.id, dm);
  await ring(dm, a.user.id, false);
  await accept(dm, b.user.id, (await pending(dm))!.id);
  await markLeft(a.user.id, dm);
  assert.deepEqual(await history(dm), ['call:missed']);
  // A late failed answer leaves a solo visit, not a second call history entry.
  await markJoined(b.user.id, dm);
  await markLeft(b.user.id, dm);
  assert.deepEqual(await history(dm), ['call:missed']);
});

test('accept followed by a successful SFU join creates one completed call', async () => {
  const { a, b, dm } = await pair();
  await markJoined(a.user.id, dm);
  await ring(dm, a.user.id, true);
  await accept(dm, b.user.id, (await pending(dm))!.id);
  await markJoined(b.user.id, dm);
  await markLeft(a.user.id, dm);
  await markLeft(b.user.id, dm);
  const messages = await history(dm);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /^call:ended:[1-9]\d*$/);
});

test('stale decline and accept identifiers cannot consume a replacement ring', async () => {
  const { a, b, dm } = await pair();
  await markJoined(a.user.id, dm);
  await ring(dm, a.user.id, false);
  const first = (await pending(dm))!;
  await end(dm, a.user.id, null);
  await ring(dm, a.user.id, false);
  const second = (await pending(dm))!;
  await decline(dm, b.user.id, first.id);
  await accept(dm, b.user.id, first.id);
  assert.equal((await pending(dm))?.id, second.id);
  await end(dm, a.user.id, null);
  await markLeft(a.user.id, dm);
  assert.deepEqual(await history(dm), ['call:missed', 'call:missed']);
});

test('the caller cannot accept or decline itself and a callee cannot cancel its caller ring', async () => {
  const { a, b, dm } = await pair();
  await markJoined(a.user.id, dm);
  await ring(dm, a.user.id, false);
  const original = (await pending(dm))!;
  await accept(dm, a.user.id, original.id);
  await decline(dm, a.user.id, original.id);
  await end(dm, b.user.id, 999999);
  assert.equal((await pending(dm))?.id, original.id);
  assert.deepEqual(await history(dm), []);
  await end(dm, a.user.id, 999999);
  await markLeft(a.user.id, dm);
  assert.deepEqual(await history(dm), ['call:missed']);
});

test('nonmembers cannot consume or replace a DM call', async () => {
  const { a, dm } = await pair();
  const outsider = await new Client(h.base).register(`call_reg_out${++serial}`);
  await markJoined(a.user.id, dm);
  await ring(dm, a.user.id, false);
  const original = (await pending(dm))!;
  for (const operation of [
    () => ring(dm, outsider.user.id, true),
    () => accept(dm, outsider.user.id, original.id),
    () => decline(dm, outsider.user.id, original.id),
    () => end(dm, outsider.user.id, null),
  ]) await assert.rejects(operation);
  assert.equal((await pending(dm))?.id, original.id);
  await end(dm, a.user.id, null);
  await markLeft(a.user.id, dm);
  assert.deepEqual(await history(dm), ['call:missed']);
});

test('an old tab from the same caller cannot cancel a ring belonging to a newer SFU participant', async () => {
  const { a, dm } = await pair();
  await markJoined(a.user.id, dm);
  const instanceKey = `voice:instance:${a.user.id}`;
  await redis.set(instanceKey, JSON.stringify({ channelId: dm, participantSid: 'PA_old_tab' }));
  await ring(dm, a.user.id, false);
  await end(dm, a.user.id, null, 'PA_old_tab');
  assert.deepEqual(await history(dm), ['call:missed']);
  await redis.set(instanceKey, JSON.stringify({ channelId: dm, participantSid: 'PA_new_tab' }));
  await ring(dm, a.user.id, false);
  const original = (await pending(dm))!;
  await end(dm, a.user.id, null, 'PA_old_tab');
  await end(dm, a.user.id, null);
  assert.equal((await pending(dm))?.id, original.id);
  assert.deepEqual(await history(dm), ['call:missed']);
  await Promise.all([
    end(dm, a.user.id, null, 'PA_new_tab'),
    end(dm, a.user.id, null, 'PA_new_tab'),
  ]);
  assert.equal(await pending(dm), null);
  await markLeft(a.user.id, dm);
  assert.deepEqual(await history(dm), ['call:missed', 'call:missed']);
});
