import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signJwt, verifyJwt } from '../src/auth/jwt.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { base32Decode, base32Encode, hotp, verifyTotp, generateTotpSecret } from '../src/auth/totp.js';
import { contrastRatio, isReadableGradient } from '../src/utils/color.js';
import { sniff, assertExtensionMatches, sanitizeFilename } from '../src/services/mediaService.js';
import { toPrefixTsQuery } from '../src/services/searchService.js';
import { Perm, has, fromNames, permNames, DEFAULT_MEMBER_PERMS } from '../src/models/permissions.js';
import { signV4 } from '../src/storage/s3.js';
import { verifyWebhook } from '../src/webrtc/livekit.js';
import { config } from '../src/config.js';
import { withLock } from '../src/jobs.js';
import { redis } from '../src/redis.js';
import { log } from '../src/logger.js';
import { assertTestDatabases } from './environment.js';

test('API test isolation checks the database name, not a password or hostname containing test', () => {
  const env={NODE_ENV:'test',DATABASE_URL:'postgres://user:password@localhost/concord_test',REDIS_URL:'redis://localhost/1'};
  assert.doesNotThrow(()=>assertTestDatabases(env));
  assert.throws(()=>assertTestDatabases({...env,DATABASE_URL:'postgres://test:test_password@test-host/concord'}));
  assert.throws(()=>assertTestDatabases({...env,REDIS_URL:'redis://localhost/0'}));
  assert.throws(()=>assertTestDatabases({...env,NODE_ENV:'production'}));
});

test('maintenance skips unavailable Redis without an unhandled rejection', async (t) => {
  t.mock.method(redis, 'set', async () => { throw new Error('Redis temporarily unavailable'); });
  const warning = t.mock.method(log, 'warn', () => undefined);
  let ran = false;
  await withLock('recovery-test', 25, async () => { ran = true; });
  assert.equal(ran, false);
  assert.equal(warning.mock.callCount(), 1);
  assert.equal(warning.mock.calls[0]?.arguments[0], 'job failed');
});

test('jwt: roundtrip, tamper and expiry', () => {
  const t = signJwt({ sub: 'u1' }, 'secret-secret-secret-secret-secret!', 60);
  assert.equal(verifyJwt(t, 'secret-secret-secret-secret-secret!')?.sub, 'u1');
  assert.equal(verifyJwt(t, 'another-secret-another-secret-12345'), null);
  const [h, , s] = t.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url')}.${s}`;
  assert.equal(verifyJwt(forged, 'secret-secret-secret-secret-secret!'), null);
  const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.`;
  assert.equal(verifyJwt(none, 'secret-secret-secret-secret-secret!'), null);
  const expired = signJwt({ sub: 'u1' }, 'k'.repeat(32), -10);
  assert.equal(verifyJwt(expired, 'k'.repeat(32)), null);
});

test('password: scrypt hash verifies only the right password', async () => {
  const h = await hashPassword('correct horse');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('correct horse', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
});

test('totp: RFC 6238 test vector and drift window', () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", T=59s → 94287082 (last 6 digits: 287082)
  const secret = Buffer.from('12345678901234567890');
  assert.equal(hotp(secret, 1), '287082');
  const b32 = base32Encode(secret);
  assert.deepEqual(base32Decode(b32), secret);
  assert.equal(verifyTotp(b32, '287082', 59_000), true);
  assert.equal(verifyTotp(b32, '287082', 59_000 + 30_000), true); // one step later still accepted
  assert.equal(verifyTotp(b32, '287082', 59_000 + 90_000), false);
  assert.equal(generateTotpSecret().length, 32);
});

test('color: contrast validation rejects unreadable gradients', () => {
  assert.ok(contrastRatio('#000000', '#ffffff') > 20);
  assert.equal(isReadableGradient('#1e1f2e', '#2b2d42'), true);
  assert.equal(isReadableGradient('#777777', '#888888'), false); // mid-grey: neither white nor black text reaches 4.5:1
  assert.equal(isReadableGradient('#000000', '#ffffff'), false); // no single text color works on both
});

test('upload sniffing: magic bytes beat the file name', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(sniff(png)?.mime, 'image/png');
  assert.doesNotThrow(() => assertExtensionMatches('a.png', sniff(png)!));
  assert.throws(() => assertExtensionMatches('a.jpg', sniff(png)!));
  const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff]);
  assert.equal(sniff(exe), null);
  assert.equal(sniff(Buffer.from('hello world\n'))?.mime, 'text/plain');
  assert.throws(() => assertExtensionMatches('notes.html', sniff(Buffer.from('<script>alert(1)</script>'))!));
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('отчёт <1>.pdf'), 'отчёт _1_.pdf');
});

test('search: tsquery builder strips operators', () => {
  assert.equal(toPrefixTsQuery('Hello  World'), 'hello:* & world:*');
  assert.equal(toPrefixTsQuery("a & b | !c ':*"), 'a:* & b:* & c:*');
  assert.equal(toPrefixTsQuery('!!!'), null);
  assert.equal(toPrefixTsQuery('привет мир'), 'привет:* & мир:*');
});

test('permissions: administrator implies all, names roundtrip', () => {
  assert.equal(has(Perm.ADMINISTRATOR, Perm.BAN_MEMBERS), true);
  assert.equal(has(DEFAULT_MEMBER_PERMS, Perm.BAN_MEMBERS), false);
  assert.equal(has(DEFAULT_MEMBER_PERMS, Perm.SEND_MESSAGES), true);
  assert.equal(fromNames(permNames(DEFAULT_MEMBER_PERMS)), DEFAULT_MEMBER_PERMS);
});

test('s3: SigV4 matches the AWS documented example', () => {
  // Example from AWS docs "GET Object" (examplebucket/test.txt with Range header).
  const headers = signV4({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    headers: { range: 'bytes=0-9' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    region: 'us-east-1',
    accessKey: 'AKIAIOSFODNN7EXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    date: new Date('2013-05-24T00:00:00Z'),
  });
  assert.match(headers.authorization!, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test('livekit: webhook signature is verified against the body hash', () => {
  const body = Buffer.from(JSON.stringify({ event: 'participant_joined', room: { name: 'ch_x' } }));
  const sha = createHash('sha256').update(body).digest('base64');
  const token = signJwt({ iss: config.LIVEKIT_API_KEY, sha256: sha }, config.LIVEKIT_API_SECRET, 60);
  assert.equal(verifyWebhook(body, `Bearer ${token}`)?.event, 'participant_joined');
  assert.equal(verifyWebhook(Buffer.from('{"event":"room_finished"}'), `Bearer ${token}`), null);
  assert.equal(verifyWebhook(body, undefined), null);
});
