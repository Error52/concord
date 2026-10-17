import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Client, sleep, startServer, type Harness } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { Close } from '../src/websocket/gateway.js';

let h: Harness;
before(async () => { h = await startServer(); });
after(async () => { await h.close(); });

test('logout between gateway authentication and session indexing cannot establish a revoked socket', async (t) => {
  const user = await new Client(h.base).register('gateway_logout_barrier');
  const client = await pool.connect(), prototype = Object.getPrototypeOf(client), query = prototype.query;
  client.release();
  let release!: () => void, arrived!: () => void, receivedRevoke!: () => void, held = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const revoked = new Promise<void>(resolve => { receivedRevoke = resolve; });
  t.mock.method(prototype, 'query', function (this: any, ...args: any[]) {
    if (!held && typeof args[0] === 'string' && /WHERE u.id = \$1/.test(args[0]) && args[1]?.[0] === user.user.id) {
      held = true;
      const pause = async () => { arrived(); await gate; };
      if (typeof args[2] === 'function') {
        const callback = args[2];
        args[2] = (...result: any[]) => { void pause().then(() => callback(...result)); };
        return query.apply(this, args);
      }
      return query.apply(this, args).then(async (result: any) => { await pause(); return result; });
    }
    return query.apply(this, args);
  });
  const gateway = h.app.gateway as any, onBus = gateway.onBus;
  t.mock.method(gateway, 'onBus', function (this: any, message: any) {
    const result = onBus.call(this, message);
    if (message.kind === 'revoke') receivedRevoke();
    return result;
  });
  const ws = new WebSocket(h.base.replace('http', 'ws') + '/gateway');
  const outcome = new Promise<{ kind: string; code?: number }>(resolve => {
    ws.on('message', raw => { if (JSON.parse(raw.toString()).t === 'ready') resolve({ kind: 'ready' }); });
    ws.on('close', code => resolve({ kind: 'close', code }));
  });
  try {
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ op: 'auth', d: { token: user.token } }));
    await Promise.race([waiting, sleep(2000).then(() => { throw new Error('Gateway did not reach its user lookup'); })]);
    assert.equal((await user.post('/api/auth/logout')).status, 204);
    await Promise.race([revoked, sleep(2000).then(() => { throw new Error('Revocation event was not processed'); })]);
    assert.equal(gateway.bySession.size, 0, 'revocation arrives before the connection is indexed');
    release();
    const result = await Promise.race([outcome, sleep(2000).then(() => { throw new Error('Revoked gateway remained open'); })]);
    assert.deepEqual(result, { kind: 'close', code: Close.SessionRevoked });
    assert.equal((await user.get('/api/users/me')).status, 401);
  } finally {
    release();
    ws.terminate();
  }
});
