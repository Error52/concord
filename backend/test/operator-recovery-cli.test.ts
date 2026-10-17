import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { startServer, Client, type Harness } from './helpers.js';
import { config } from '../src/config.js';
import { register } from '../src/services/authService.js';
import { pool } from '../src/db/pool.js';
import { verifyPassword } from '../src/auth/password.js';

let h: Harness;
before(async () => { h = await startServer(); });
after(async () => { await h.close(); });

function run(input: string, args = ['--stdin']): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/db/recover-account-cli.ts', ...args], { env: process.env, stdio: 'pipe' });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Operator CLI did not exit')); }, 15_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test('operator CLI reads a password through stdin, preserves administrator role and revokes the old session', async () => {
  const account = await register({ username: 'operator_cli', email: 'operator_cli@example.com', password: 'previous-password' }, { ip: 'operator-test', userAgent: 'test' }, true);
  await pool.query(`UPDATE users SET is_platform_admin=true WHERE id=$1`, [account.user.id]);
  const password = 'new-private-operator-password';
  const result = await run(JSON.stringify({ identifier: account.user.username, newPassword: password }));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.includes(password), false);
  assert.equal(result.stderr.includes(password), false);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, username: 'operator_cli', administrator: true, revokedSessions: 1 });
  const row = (await pool.query(`SELECT password_hash,is_platform_admin,email_verified_at,recovery_word_hash FROM users WHERE id=$1`, [account.user.id])).rows[0];
  assert.equal(await verifyPassword(password, row.password_hash), true);
  assert.equal(row.is_platform_admin, true); assert.ok(row.email_verified_at); assert.equal(row.recovery_word_hash, null);
  const client = new Client(h.base); client.token = account.tokens.accessToken;
  assert.equal((await client.get('/api/users/me')).status, 401);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM platform_audit_log WHERE target_id=$1 AND action='account.operator_recovery'`, [account.user.id])).rows[0].n, 1);
});

test('operator CLI rejects malformed or oversized stdin without printing supplied secrets', async () => {
  for (const input of ['private secret not JSON', JSON.stringify({ identifier: 'operator_cli', newPassword: 'another-private-password', unexpected: 'do not print me' }), 'secret'.repeat(1000)]) {
    const result = await run(input);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(input), false);
    assert.doesNotMatch(result.stderr, /another-private-password|do not print me|password_hash|postgres:\/\//);
  }
});

test('operator CLI refuses a password argument or a noninteractive prompt', async () => {
  const result = await run('', ['operator_cli', 'never-pass-a-secret-on-argv']);
  assert.equal(result.code, 1); assert.equal(result.stdout, '');
  assert.doesNotMatch(result.stderr, /never-pass-a-secret/);
  const prompt = await run('', ['operator_cli']);
  assert.equal(prompt.code, 1); assert.match(prompt.stderr, /Нужен терминал/);
});
