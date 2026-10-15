import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer, Client, connectGateway, sleep, type Harness } from './helpers.js';
import { hotp, base32Decode } from '../src/auth/totp.js';
import { verifyJwt, signJwt } from '../src/auth/jwt.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { createHash } from 'node:crypto';
import { deliverPendingMail } from '../src/services/mailOutbox.js';
import {captureSmtp} from './smtpCapture.js';
import {createServer} from 'node:http';
import {markJoined,markLeft} from '../src/services/voiceService.js';
import {Perm} from '../src/models/permissions.js';
import {pendingRings} from '../src/services/callService.js';
import {redis} from '../src/redis.js';
import {react} from '../src/services/messageService.js';

let h: Harness;
const c = (): Client => new Client(h.base);

before(async () => {
  h = await startServer();
});
after(async () => {
  await h.close();
});

// ───────────────────────────── auth ─────────────────────────────

test('registration validates input and rejects duplicates', async () => {
  const bad = await c().post('/api/auth/register', { username: 'x', email: 'nope', password: '1' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION');
  const boot=await Promise.all(['bootstrap_one','bootstrap_two'].map(username=>c().post('/api/auth/register',{username,email:`${username}@example.com`,password:'password123'})));
  assert.ok(boot.every(r=>r.status===201));
  assert.equal(boot.filter(r=>r.body.user.isPlatformAdmin).length,1,'concurrent first registrations grant one automatic admin');

  const a = await c().register('alice');
  assert.equal(a.user.username, 'alice');
  assert.ok(a.cookies.has('cc_refresh'));
  const row = await pool.query(`SELECT password_hash FROM users WHERE username = 'alice'`);
  assert.match(row.rows[0].password_hash, /^scrypt\$/); // never stored in plain text

  const dupEmail = await c().post('/api/auth/register', { username: 'alice2', email: 'ALICE@example.com', password: 'password123' });
  assert.equal(dupEmail.status, 409);
  assert.equal(dupEmail.body.error.code, 'EMAIL_TAKEN');
  const dupName = await c().post('/api/auth/register', { username: 'Alice', email: 'other@example.com', password: 'password123' });
  assert.equal(dupName.body.error.code, 'USERNAME_TAKEN');
});

test('registration races keep field-specific duplicate errors',async()=>{
  const attempts=await Promise.all(['race_one','race_two'].map(username=>c().post('/api/auth/register',{username,email:'same-race@example.com',password:'password123'})));
  assert.deepEqual(attempts.map(r=>r.status).sort(),[201,409]);
  assert.equal(attempts.find(r=>r.status===409)!.body.error.code,'EMAIL_TAKEN');
});

test('failed SMTP remains queued with bounded backoff rather than pretending delivery',async()=>{
  const pending=await pool.query(`SELECT id,attempts FROM outbound_emails WHERE delivered_at IS NULL AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 1`);
  assert.ok(pending.rowCount);
  await deliverPendingMail(1);
  const row=await pool.query(`SELECT attempts,delivered_at,next_attempt_at FROM outbound_emails WHERE id=$1`,[pending.rows[0].id]);
  assert.equal(row.rows[0].attempts,pending.rows[0].attempts+1);assert.equal(row.rows[0].delivered_at,null);assert.ok(row.rows[0].next_attempt_at.getTime()>Date.now());
});

test('email verification gates new users, resends with cooldown and safely consumes links',async()=>{
  const u=c(),signup=await u.post('/api/auth/register',{username:'verify_signup',email:'VERIFY@example.com',password:'password123'});
  assert.equal(signup.status,201);u.token=signup.body.accessToken;u.user=signup.body.user;
  assert.equal(u.user.email,'verify@example.com');assert.equal(u.user.emailVerified,false);
  assert.equal((await u.get('/api/users/me')).status,200);
  assert.equal((await u.post('/api/servers',{name:'Unverified server'})).body.error.code,'EMAIL_UNVERIFIED');
  const queued=await pool.query(`SELECT text_body FROM outbound_emails WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[u.user.id]);
  const token=queued.rows[0].text_body.match(/token=([^\s]+)/)[1];
  const stored=await pool.query(`SELECT token_hash FROM email_verifications WHERE user_id=$1`,[u.user.id]);
  assert.equal(stored.rows[0].token_hash,createHash('sha256').update(token).digest('hex'));
  await pool.query(`UPDATE email_verifications SET expires_at=now()-interval '1 minute' WHERE user_id=$1`,[u.user.id]);
  assert.equal((await c().post('/api/auth/email/confirm',{token})).status,400,'expired links cannot verify the account');
  assert.equal((await u.post('/api/auth/email/resend')).status,429);
  await pool.query(`UPDATE email_verifications SET created_at=now()-interval '2 minutes' WHERE user_id=$1`,[u.user.id]);
  assert.equal((await u.post('/api/auth/email/resend')).status,200);
  assert.equal((await c().post('/api/auth/email/confirm',{token})).status,400,'resend invalidates superseded link');
  const latest=await pool.query(`SELECT text_body FROM outbound_emails WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[u.user.id]);
  const fresh=latest.rows[0].text_body.match(/token=([^\s]+)/)[1];
  const confirm=await c().post('/api/auth/email/confirm',{token:fresh});assert.equal(confirm.status,200);assert.equal(confirm.body.accessToken,undefined,'confirmation is not login');
  assert.equal((await c().post('/api/auth/email/confirm',{token:fresh})).status,200,'opening a consumed confirmed link is harmless');
  assert.equal((await u.get('/api/users/me')).body.emailVerified,true);
  const refresh=await u.post('/api/auth/refresh');u.token=refresh.body.accessToken;
  assert.equal((await u.post('/api/servers',{name:'Verified server'})).status,201);
  assert.equal((await c().post('/api/auth/email/confirm',{token:'expired-invalid-token-0123456789'})).status,400);
});

test('login: wrong password, success, CSRF header required for cookie endpoints', async () => {
  await c().register('bob');
  const wrong = await c().post('/api/auth/login', { email: 'bob@example.com', password: 'wrongpass' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  const unknown = await c().post('/api/auth/login', { email: 'ghost@example.com', password: 'whatever1' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.message, wrong.body.error.message); // no account enumeration

  const noCsrf = await fetch(h.base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bob@example.com', password: 'password123' }),
  });
  assert.equal(noCsrf.status, 403);

  const ok = await c().post('/api/auth/login', { email: 'bob@example.com', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.accessToken);
});

test('mail worker delivers current links and skips expired or superseded authentication mail',async()=>{
 const reset=await c().register('mail_current_reset');
 await reset.post('/api/auth/password/forgot',{email:reset.user.email});
 await pool.query(`UPDATE password_resets SET expires_at=now()-interval '1 minute' WHERE user_id=$1`,[reset.user.id]);
 await reset.post('/api/auth/password/forgot',{email:reset.user.email});
 await reset.post('/api/auth/password/forgot',{email:reset.user.email});
 const verification=c(),signup=await verification.post('/api/auth/register',{username:'mail_current_verify',email:'mail_current_verify@example.com',password:'password123'});
 verification.token=signup.body.accessToken;
 await pool.query(`UPDATE email_verifications SET created_at=now()-interval '2 minutes' WHERE user_id=$1`,[signup.body.user.id]);
 assert.equal((await verification.post('/api/auth/email/resend')).status,200);
 const capture=await captureSmtp(),previous={SMTP_HOST:config.SMTP_HOST,SMTP_PORT:config.SMTP_PORT,SMTP_USER:config.SMTP_USER,SMTP_PASSWORD:config.SMTP_PASSWORD,SMTP_TLS:config.SMTP_TLS,SMTP_STARTTLS:config.SMTP_STARTTLS};
 Object.assign(config,capture.options);
 try{await deliverPendingMail(100);}finally{Object.assign(config,previous);await capture.close();}
 assert.equal(capture.messages.filter(m=>m.recipient===reset.user.email).length,1);
 assert.equal(capture.messages.filter(m=>m.recipient===signup.body.user.email).length,1);
 const rows=await pool.query(`SELECT purpose,delivered_at,attempts FROM outbound_emails WHERE user_id=ANY($1::uuid[]) ORDER BY created_at`,[[reset.user.id,signup.body.user.id]]);
 assert.equal(rows.rows.filter(r=>r.purpose==='password-reset'&&r.delivered_at).length,1);
 assert.equal(rows.rows.filter(r=>r.purpose==='verification'&&r.delivered_at).length,1);
 assert.ok(rows.rows.filter(r=>!r.delivered_at).every(r=>r.attempts===0));
});

test('demo verification mailbox is disabled by default and isolates authenticated users',async()=>{
  const a=c(),b=c();
  for(const [client,name] of [[a,'demomail_a'],[b,'demomail_b']] as const){
    const r=await client.post('/api/auth/register',{username:name,email:`${name}@example.com`,password:'password123'});
    assert.equal(r.status,201);client.token=r.body.accessToken;client.user=r.body.user;
  }
  const original=config.DEMO_MAILBOX;config.DEMO_MAILBOX=false;
  try{
    assert.equal((await a.get('/api/auth/email/demo')).status,404);
    config.DEMO_MAILBOX=true;
    assert.equal((await c().get('/api/auth/email/demo')).status,401);
    const own=await a.get(`/api/auth/email/demo?userId=${b.user.id}`);
    assert.equal(own.status,200);assert.ok(own.body.verificationPath.startsWith('/verify-email?token='));
    const token=new URL(own.body.verificationPath,'http://localhost').searchParams.get('token');
    assert.equal((await c().post('/api/auth/email/confirm',{token})).body.userId,a.user.id);
    assert.equal((await b.get('/api/users/me')).body.emailVerified,false);
    assert.equal((await a.get('/api/auth/email/demo')).body.verificationPath,null);
    assert.ok((await b.get('/api/auth/email/demo')).body.verificationPath);
  }finally{config.DEMO_MAILBOX=original;}
});

test('refresh tokens rotate and reuse revokes the whole session family', async () => {
  const u = await c().register('carol');
  const firstCookie = u.cookies.get('cc_refresh')!;
  const r1 = await u.post('/api/auth/refresh');
  assert.equal(r1.status, 200);
  const secondCookie = u.cookies.get('cc_refresh')!;
  assert.notEqual(firstCookie, secondCookie);
  u.token = r1.body.accessToken;
  assert.equal((await u.get('/api/users/me')).status, 200);

  // Attacker replays the first (already rotated) token after the grace window.
  await pool.query(`UPDATE sessions SET rotated_at = now() - interval '1 minute' WHERE rotated_at IS NOT NULL`);
  const thief = c();
  thief.cookies.set('cc_refresh', firstCookie);
  assert.equal((await thief.post('/api/auth/refresh')).status, 401);
  await sleep(150);
  // The legitimate session is now revoked as well.
  assert.equal((await u.post('/api/auth/refresh')).status, 401);
  assert.equal((await u.get('/api/users/me')).status, 401);
});

test('concurrent tabs receive the same rotated cookie; logout revokes retired access tokens too',async()=>{
  const u=await c().register('multitab'),first=u.cookies.get('cc_refresh')!,oldAccess=u.token!;
  const a=c(),b=c();a.cookies.set('cc_refresh',first);b.cookies.set('cc_refresh',first);
  const res=await Promise.all([a.post('/api/auth/refresh'),b.post('/api/auth/refresh')]);
  assert.ok(res.every(r=>r.status===200));assert.equal(a.cookies.get('cc_refresh'),b.cookies.get('cc_refresh'));
  assert.notEqual(first,a.cookies.get('cc_refresh'));a.token=res[0].body.accessToken;
  assert.equal((await a.get('/api/users/me')).status,200);
  assert.equal((await a.post('/api/auth/logout')).status,204);
  u.token=oldAccess;assert.equal((await u.get('/api/users/me')).status,401);
  assert.equal((await b.post('/api/auth/refresh')).status,401);
});

test('logout revokes the access token immediately', async () => {
  const u = await c().register('dave');
  const fake=c();fake.cookies.set('cc_refresh',u.cookies.get('cc_refresh')!.split('.')[0]+'.wrong-secret');
  assert.equal((await fake.post('/api/auth/logout')).status,204);
  assert.equal((await u.get('/api/users/me')).status,200,'knowing only a session ID cannot revoke someone else');
  const malformed=c();malformed.cookies.set('cc_refresh','------------------------------------.test');
  assert.equal((await malformed.post('/api/auth/refresh')).status,401,'malformed UUID is an expired cookie, not SQL failure');
  assert.equal((await u.post('/api/auth/logout')).status, 204);
  assert.equal((await u.get('/api/users/me')).status, 401);
  assert.equal(u.cookies.has('cc_refresh'), false);
});

test('two-factor authentication: setup, login challenge, replay protection', async () => {
  const u = await c().register('erin');
  const setup = await u.post('/api/auth/2fa/setup');
  const secret = setup.body.secret as string;
  const code = () => hotp(base32Decode(secret), Math.floor(Date.now() / 30_000));
  assert.equal((await u.post('/api/auth/2fa/enable', { code: '000000' })).status, 400);
  assert.equal((await u.post('/api/auth/2fa/enable', { code: code() })).status, 200);

  const login = await c().post('/api/auth/login', { email: 'erin@example.com', password: 'password123' });
  assert.equal(login.body.mfaRequired, true);
  assert.equal(login.body.accessToken, undefined);
  const mfa = await c().post('/api/auth/mfa', { ticket: login.body.ticket, code: code() });
  assert.equal(mfa.status, 200);
  const replay = await c().post('/api/auth/mfa', { ticket: login.body.ticket, code: code() });
  assert.equal(replay.status, 401);
  const oldTicket=await c().post('/api/auth/login',{email:'erin@example.com',password:'password123'});
  await u.post('/api/auth/password/change',{currentPassword:'password123',newPassword:'differentpassword123'});
  assert.equal((await c().post('/api/auth/mfa',{ticket:oldTicket.body.ticket,code:code()})).body.error.code,'MFA_EXPIRED','password change invalidates a pending MFA login');
});

test('password reset: token is single-use and logs out other sessions', async () => {
  const u = await c().register('frank');
  assert.equal((await c().post('/api/auth/password/forgot', { email: 'frank@example.com' })).status, 200);
  assert.equal((await c().post('/api/auth/password/forgot', { email: 'nobody@example.com' })).status, 200);
  // The emailed token is only stored hashed; inject a known one to exercise the confirm endpoint.
  const token = 'known-reset-token-for-test-0123456789';
  await pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`, [
    u.user.id,
    createHash('sha256').update(token).digest('hex'),
  ]);
  assert.equal((await c().post('/api/auth/password/reset', { token, password: 'newpassword1' })).status, 200);
  assert.equal((await c().post('/api/auth/password/reset', { token, password: 'newpassword2' })).status, 400);
  assert.equal((await u.get('/api/users/me')).status, 401);
  assert.equal((await c().post('/api/auth/login', { email: 'frank@example.com', password: 'newpassword1' })).status, 200);
});

test('concurrent password resets consume a link once and revoke pre-rotation tokens',async()=>{
  const u=await c().register('reset_race'),old=u.token!;await u.post('/api/auth/refresh');
  const token='concurrent-reset-token-0123456789';
  await pool.query(`INSERT INTO password_resets (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 hour')`,[u.user.id,createHash('sha256').update(token).digest('hex')]);
  const results=await Promise.all(['resetwinner1','resetwinner2'].map(password=>c().post('/api/auth/password/reset',{token,password})));
  assert.deepEqual(results.map(r=>r.status).sort(),[200,400]);
  u.token=old;assert.equal((await u.get('/api/users/me')).status,401);
});

test('changing password revokes every token on other devices and keeps the current family',async()=>{
  const u=await c().register('change_session'),device=c();
  const login=await device.post('/api/auth/login',{email:'change_session@example.com',password:'password123'});device.token=login.body.accessToken;
  const retired=device.token;await device.post('/api/auth/refresh');
  await u.post('/api/auth/password/forgot',{email:u.user.email});
  const resetLetter=await pool.query(`SELECT text_body FROM outbound_emails WHERE user_id=$1 AND purpose='password-reset' ORDER BY created_at DESC LIMIT 1`,[u.user.id]);
  const oldReset=resetLetter.rows[0].text_body.match(/token=([^\s]+)/)[1];
  assert.equal((await u.post('/api/auth/password/change',{currentPassword:'password123',newPassword:'changedpassword123'})).status,200);
  assert.equal((await c().post('/api/auth/password/reset',{token:oldReset,password:'obsoletepassword123'})).status,400,'changing password invalidates outstanding reset links');
  device.token=retired;assert.equal((await device.get('/api/users/me')).status,401);
  assert.equal((await device.post('/api/auth/refresh')).status,401);
  assert.equal((await u.get('/api/users/me')).status,200);
});

// ───────────────────────────── servers, roles, invites ─────────────────────────────

async function serverWithMember() {
  const owner = await c().register(`own${Date.now() % 100000}`);
  const member = await c().register(`mem${Date.now() % 100000}`);
  const created = await owner.post('/api/servers', { name: 'Test Server' });
  assert.equal(created.status, 201);
  const serverId = created.body.server.id as string;
  const invite = await owner.post(`/api/servers/${serverId}/invites`, { maxUses: 5 });
  const joined = await member.post(`/api/invites/${invite.body.code}`);
  assert.equal(joined.status, 200);
  const general = created.body.channels.find((ch: any) => ch.type === 'text');
  const voice = created.body.channels.find((ch: any) => ch.type === 'voice');
  return { owner, member, serverId, general, voice, full: created.body };
}

test('server creation gives default roles and channels; non-members get 404', async () => {
  const { owner, serverId, full } = await serverWithMember();
  assert.deepEqual(full.roles.map((r: any) => r.name).sort(), ['Admin', 'Member', 'Moderator']);
  assert.equal(full.channels.length, 2);
  const outsider = await c().register('outsider');
  assert.equal((await outsider.get(`/api/servers/${serverId}`)).status, 404);
  assert.equal((await owner.get(`/api/servers/${serverId}`)).status, 200);
});

test('permissions: members cannot manage channels; owners can; changes broadcast', async () => {
  const { owner, member, serverId } = await serverWithMember();
  const gw = await connectGateway(h.base, member.token!);
  const denied = await member.post(`/api/servers/${serverId}/channels`, { name: 'hack', type: 'text' });
  assert.equal(denied.status, 403);
  const ok = await owner.post(`/api/servers/${serverId}/channels`, { name: 'My Memes', type: 'text' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.name, 'my-memes');
  const ev = await gw.waitFor('channel:create', (d) => d.id === ok.body.id);
  assert.equal(ev.name, 'my-memes');
  gw.close();
});

test('invites: max uses and expiry are enforced; banned users cannot rejoin', async () => {
  const { owner, member, serverId } = await serverWithMember();
  const inv = await owner.post(`/api/servers/${serverId}/invites`, { maxUses: 1 });
  const u1 = await c().register('inv1');
  const u2 = await c().register('inv2');
  assert.equal((await u1.post(`/api/invites/${inv.body.code}`)).status, 200);
  assert.equal((await u2.post(`/api/invites/${inv.body.code}`)).status, 410);

  const inv2 = await owner.post(`/api/servers/${serverId}/invites`, {});
  assert.equal((await owner.put(`/api/servers/${serverId}/bans/${member.user.id}`, { reason: 'spam' })).status, 204);
  assert.equal((await member.get(`/api/servers/${serverId}`)).status, 404);
  assert.equal((await member.post(`/api/invites/${inv2.body.code}`)).status, 403);

  const logs = await owner.get(`/api/servers/${serverId}/audit-log`);
  assert.ok(logs.body.some((l: any) => l.action === 'member.ban' && l.targetId === member.user.id));
  assert.ok(logs.body.some((l: any) => l.action === 'invite.create'));
});

test('role hierarchy: a moderator cannot kick an admin or grant permissions they lack', async () => {
  const { owner, member: mod, serverId, full } = await serverWithMember();
  const admin = await c().register('adminuser');
  const inv = await owner.post(`/api/servers/${serverId}/invites`, {});
  await admin.post(`/api/invites/${inv.body.code}`);
  const roleId = (n: string) => full.roles.find((r: any) => r.name === n).id;
  assert.equal((await owner.put(`/api/servers/${serverId}/members/${mod.user.id}/roles`, { roleIds: [roleId('Moderator')] })).status, 200);
  assert.equal((await owner.put(`/api/servers/${serverId}/members/${admin.user.id}/roles`, { roleIds: [roleId('Admin')] })).status, 200);

  assert.equal((await mod.post(`/api/servers/${serverId}/members/${admin.user.id}/kick`, {})).status, 403);
  assert.equal((await mod.post(`/api/servers/${serverId}/members/${owner.user.id}/kick`, {})).status, 403);
  // Moderator has no MANAGE_ROLES at all.
  assert.equal((await mod.post(`/api/servers/${serverId}/roles`, { name: 'x' })).status, 403);
  // Admin can kick the moderator.
  assert.equal((await admin.post(`/api/servers/${serverId}/members/${mod.user.id}/kick`, {})).status, 204);
});

test('badges: only MANAGE_BADGES can create/grant; badges appear on profiles', async () => {
  const { owner, member, serverId } = await serverWithMember();
  const denied = await member.post(`/api/servers/${serverId}/badges`, { name: 'Self-made', emoji: '🏆' });
  assert.equal(denied.status, 403);
  const badge = await owner.post(`/api/servers/${serverId}/badges`, { name: 'Early User', description: 'Joined early', emoji: '🏆', color: '#f5a623' });
  assert.equal(badge.status, 201);
  // Member cannot grant a badge to themselves.
  assert.equal((await member.put(`/api/servers/${serverId}/badges/${badge.body.id}/users/${member.user.id}`)).status, 403);
  assert.equal((await owner.put(`/api/servers/${serverId}/badges/${badge.body.id}/users/${member.user.id}`)).status, 204);
  const profile = await owner.get(`/api/users/${member.user.id}`);
  assert.equal(profile.body.user.badges[0].name, 'Early User');
  assert.equal(profile.body.mutualServers.length, 1);
  assert.equal((await owner.del(`/api/servers/${serverId}/badges/${badge.body.id}/users/${member.user.id}`)).status, 204);
  assert.equal((await owner.get(`/api/users/${member.user.id}`)).body.user.badges.length, 0);
});

test('admin panel: only platform admins manage special badges; they show on profiles everywhere', async () => {
  const { owner, member, serverId } = await serverWithMember();
  await pool.query(`UPDATE users SET is_platform_admin = false`);
  // Regular users (even server owners) get 403 on every admin endpoint.
  assert.equal((await owner.get('/api/admin/badges')).status, 403);
  assert.equal((await owner.post('/api/admin/badges', { name: 'Hacker', emoji: '💀' })).status, 403);
  assert.equal((await owner.put(`/api/admin/users/${owner.user.id}/admin`, { value: true })).status, 403);

  await pool.query(`UPDATE users SET is_platform_admin = true WHERE id = $1`, [owner.user.id]);
  const badge = await owner.post('/api/admin/badges', { name: 'Concord Staff', description: 'Team', emoji: '🛡️', color: '#5865f2' });
  assert.equal(badge.status, 201);
  assert.equal(badge.body.global, true);
  assert.equal(badge.body.serverId, null);
  // A special badge is invisible to the per-server badge endpoints.
  assert.equal((await owner.put(`/api/servers/${serverId}/badges/${badge.body.id}/users/${member.user.id}`)).status, 404);
  assert.ok(!(await owner.get(`/api/servers/${serverId}/badges`)).body.some((b: any) => b.id === badge.body.id));

  const png = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const icon = await owner.req('PUT', `/api/admin/badges/${badge.body.id}/icon`, png, { 'Content-Type': 'image/png' });
  assert.equal(icon.status, 200);
  assert.ok(icon.body.iconUrl);

  assert.equal((await owner.put(`/api/admin/badges/${badge.body.id}/users/${member.user.id}`)).status, 204);
  const profile = await member.get(`/api/users/${member.user.id}`);
  assert.equal(profile.body.user.badges[0].name, 'Concord Staff');
  assert.equal(profile.body.user.badges[0].global, true);
  const found = await owner.get(`/api/admin/users?q=${encodeURIComponent(member.user.username)}`);
  assert.deepEqual(found.body[0].globalBadgeIds, [badge.body.id]);
  assert.equal((await owner.get(`/api/admin/badges/${badge.body.id}/users`)).body.length, 1);
  // The badge holder still can't touch admin endpoints.
  assert.equal((await member.del(`/api/admin/badges/${badge.body.id}/users/${member.user.id}`)).status, 403);

  // Last admin can't remove themselves; a second admin can be added and removed.
  assert.equal((await owner.put(`/api/admin/users/${owner.user.id}/admin`, { value: false })).status, 400);
  assert.equal((await owner.put(`/api/admin/users/${member.user.id}/admin`, { value: true })).status, 204);
  assert.equal((await member.get('/api/admin/stats')).status, 200);
  assert.equal((await owner.put(`/api/admin/users/${member.user.id}/admin`, { value: false })).status, 204);
  assert.equal((await member.get('/api/admin/stats')).status, 403);

  const log = await owner.get('/api/admin/audit-log');
  assert.ok(log.body.some((e: any) => e.action === 'badge.grant'));
  assert.equal((await owner.del(`/api/admin/badges/${badge.body.id}`)).status, 204);
  assert.equal((await member.get(`/api/users/${member.user.id}`)).body.user.badges.length, 0);
});

// ───────────────────────────── messages ─────────────────────────────

test('messages: realtime delivery, edit/delete permissions, reactions, replies, mentions', async () => {
  const { owner, member, serverId, general } = await serverWithMember();
  const gwOwner = await connectGateway(h.base, owner.token!);

  const sent = await member.post(`/api/channels/${general.id}/messages`, { content: `hi <@${owner.user.id}> **bold**`, nonce: 'n1' });
  assert.equal(sent.status, 201);
  const live = await gwOwner.waitFor('message:new', (d) => d.id === sent.body.id);
  assert.equal(live.author.username, member.user.username);
  assert.deepEqual(live.mentionIds, [owner.user.id]);
  const notif = await gwOwner.waitFor('notification:new', (d) => d.type === 'mention');
  assert.equal(notif.data.messageId, sent.body.id);

  // Owner cannot edit someone else's message but can delete it (MANAGE_MESSAGES).
  assert.equal((await owner.patch(`/api/messages/${sent.body.id}`, { content: 'hacked' })).status, 403);
  const edited = await member.patch(`/api/messages/${sent.body.id}`, { content: 'edited' });
  assert.ok(edited.body.editedAt);

  const reply = await owner.post(`/api/channels/${general.id}/messages`, { content: 'reply', replyToId: sent.body.id });
  assert.equal(reply.body.replyTo.id, sent.body.id);
  const thread = await member.get(`/api/messages/${sent.body.id}/thread`);
  assert.equal(thread.body.parent.id, sent.body.id);
  assert.deepEqual(thread.body.replies.map((r: any) => r.id), [reply.body.id]);

  assert.equal((await owner.put(`/api/messages/${sent.body.id}/reactions/${encodeURIComponent('🔥')}`)).status, 204);
  const reaction = await gwOwner.waitFor('reaction:update');
  assert.equal(reaction.count, 1);
  assert.equal(reaction.actorId,owner.user.id);assert.equal(reaction.actorHasReaction,true);

  // Member cannot delete the owner's message.
  assert.equal((await member.del(`/api/messages/${reply.body.id}`)).status, 403);
  assert.equal((await owner.del(`/api/messages/${sent.body.id}`)).status, 204);
  await gwOwner.waitFor('message:delete', (d) => d.id === sent.body.id);

  const history = await member.get(`/api/channels/${general.id}/messages`);
  assert.ok(history.body.every((m: any) => m.id !== sent.body.id));
  gwOwner.close();
});

test('messages: XSS payloads are stored as text, non-members cannot read or post', async () => {
  const { member, general } = await serverWithMember();
  const payload = '<img src=x onerror=alert(1)>';
  const sent = await member.post(`/api/channels/${general.id}/messages`, { content: payload });
  assert.equal(sent.body.content, payload); // rendered as text by the client, never as HTML
  const outsider = await c().register('outsider2');
  assert.equal((await outsider.get(`/api/channels/${general.id}/messages`)).status, 404);
  assert.equal((await outsider.post(`/api/channels/${general.id}/messages`, { content: 'x' })).status, 404);
});

test('the twenty-emoji limit still allows joining an existing reaction',async()=>{
 const {owner,member,general}=await serverWithMember();
 const sent=await owner.post(`/api/channels/${general.id}/messages`,{content:'reaction limit'});
 const added=await Promise.allSettled(Array.from({length:21},(_,i)=>react(sent.body.id,owner.user.id,`r${i}`,true)));
 assert.equal(added.filter(r=>r.status==='fulfilled').length,20);assert.equal(added.filter(r=>r.status==='rejected').length,1);
 const existing=(await pool.query(`SELECT emoji FROM message_reactions WHERE message_id=$1 LIMIT 1`,[sent.body.id])).rows[0].emoji;
 assert.equal((await member.put(`/api/messages/${sent.body.id}/reactions/${existing}`)).status,204);
 assert.equal((await member.put(`/api/messages/${sent.body.id}/reactions/extra`)).status,400);
});

test('read acknowledgements preserve later mentions, emit the stored marker and clamp future ids',async()=>{
 const {owner,member,general}=await serverWithMember();
 const first=await member.post(`/api/channels/${general.id}/messages`,{content:`first <@${owner.user.id}>`});
 const second=await member.post(`/api/channels/${general.id}/messages`,{content:`second <@${owner.user.id}>`});
 const gw=await connectGateway(h.base,owner.token!);
 const stored=async()=> (await pool.query(`SELECT last_read_id,mention_count FROM read_states WHERE user_id=$1 AND channel_id=$2`,[owner.user.id,general.id])).rows[0];
 try{
  await owner.post(`/api/channels/${general.id}/read`,{messageId:first.body.id});
  assert.equal((await stored()).mention_count,1);
  await owner.post(`/api/channels/${general.id}/read`,{messageId:second.body.id});
  const third=await member.post(`/api/channels/${general.id}/messages`,{content:`third <@${owner.user.id}>`});
  gw.events.splice(0);await owner.post(`/api/channels/${general.id}/read`,{messageId:first.body.id});
  const live=await gw.waitFor('read:update');assert.equal(live.lastReadId,second.body.id);assert.equal(live.mentionCount,1);
  assert.deepEqual(await stored(),{last_read_id:second.body.id,mention_count:1});
  await owner.post(`/api/channels/${general.id}/unread`,{messageId:second.body.id});assert.equal((await stored()).mention_count,2);
  const unread=await gw.waitFor('read:update',d=>d.lastReadId===(BigInt(second.body.id)-1n).toString());assert.equal(unread.mentionCount,2);
  await owner.post(`/api/channels/${general.id}/read`,{messageId:'9000000000000000000'});assert.equal((await stored()).last_read_id,third.body.id);
  const everyone=await owner.post(`/api/channels/${general.id}/messages`,{content:`@everyone and <@${member.user.id}>`});assert.equal(everyone.status,201);
  const recipient=async()=>(await pool.query(`SELECT mention_count FROM read_states WHERE user_id=$1 AND channel_id=$2`,[member.user.id,general.id])).rows[0].mention_count;
  assert.equal(await recipient(),1,'explicit mention plus everyone counts once in the same transaction');
  await member.post(`/api/channels/${general.id}/read`,{messageId:everyone.body.id});assert.equal(await recipient(),0);
 }finally{gw.close();}
});

test('slowmode is enforced for regular members', async () => {
  const { owner, member, general } = await serverWithMember();
  await owner.patch(`/api/channels/${general.id}`, { slowmodeSeconds: 30 });
  assert.equal((await member.post(`/api/channels/${general.id}/messages`, { content: 'one' })).status, 201);
  const second = await member.post(`/api/channels/${general.id}/messages`, { content: 'two' });
  assert.equal(second.status, 429);
  assert.equal(second.body.error.code, 'SLOWMODE');
  assert.equal((await owner.post(`/api/channels/${general.id}/messages`, { content: 'mod bypass' })).status, 201);
});

test('pins, bookmarks, unread markers and full-text search with filters', async () => {
  const { owner, member, serverId, general } = await serverWithMember();
  const m1 = await member.post(`/api/channels/${general.id}/messages`, { content: 'Привет всем, hello everyone' });
  await member.post(`/api/channels/${general.id}/messages`, { content: 'see https://example.com' });
  await owner.post(`/api/channels/${general.id}/messages`, { content: 'hello from owner' });

  assert.equal((await member.put(`/api/messages/${m1.body.id}/pin`)).status, 403);
  assert.equal((await owner.put(`/api/messages/${m1.body.id}/pin`)).status, 200);
  assert.equal((await member.get(`/api/channels/${general.id}/pins`)).body.length, 1);

  assert.equal((await member.put(`/api/messages/${m1.body.id}/bookmark`)).status, 204);
  assert.equal((await member.get('/api/bookmarks')).body[0].id, m1.body.id);

  const s1 = await member.get(`/api/search/messages?q=hel&serverId=${serverId}`);
  assert.equal(s1.body.total, 2);
  const s2 = await member.get(`/api/search/messages?q=hello&authorId=${owner.user.id}`);
  assert.equal(s2.body.results.length, 1);
  assert.equal(s2.body.results[0].channelName, 'general');
  const s3 = await member.get(`/api/search/messages?has=link&serverId=${serverId}`);
  assert.equal(s3.body.total, 1);
  const s4 = await member.get(`/api/search/messages?q=привет`);
  assert.equal(s4.body.total, 1);
  const s5 = await member.get(`/api/search/messages?q=hello&before=2000-01-01`);
  assert.equal(s5.body.total, 0);
  // Outsiders see nothing even with a matching query.
  const outsider = await c().register('outsider3');
  assert.equal((await outsider.get('/api/search/messages?q=hello')).body.total, 0);
  // around= loads the window containing an old message (jump to search result).
  const around = await member.get(`/api/channels/${general.id}/messages?around=${m1.body.id}&limit=10`);
  assert.ok(around.body.some((m: any) => m.id === m1.body.id));
});

// ───────────────────────────── DMs & friends ─────────────────────────────

test('friends: request, accept, presence; blocking stops DMs', async () => {
  const a = await c().register('fa');
  const b = await c().register('fb');
  const gwB = await connectGateway(h.base, b.token!);
  assert.equal((await a.post('/api/friends/request', { username: 'fb' })).status, 200);
  await gwB.waitFor('friend:request');
  const list = await b.get('/api/friends');
  assert.equal(list.body[0].type, 'incoming');
  await b.post(`/api/friends/${a.user.id}/accept`);
  assert.equal((await a.get('/api/friends')).body[0].type, 'friend');

  const gwA = await connectGateway(h.base, a.token!);
  const online = await gwB.waitFor('presence:update', (d) => d.userId === a.user.id);
  assert.equal(online.status, 'online');
  gwA.close();
  const offline = await gwB.waitFor('presence:update', (d) => d.userId === a.user.id && d.status === 'offline');
  assert.equal(offline.status, 'offline');

  const dm = await a.post('/api/dm', { recipientId: b.user.id });
  assert.equal(dm.status, 200);
  const msg = await a.post(`/api/dm/${dm.body.id}/messages`, { content: 'secret' });
  assert.equal(msg.status, 201);
  await gwB.waitFor('message:new', (d) => d.id === msg.body.id);
  await gwB.waitFor('notification:new', (d) => d.type === 'dm');

  // A third user cannot read the DM even knowing its id.
  const eve = await c().register('eve');
  assert.equal((await eve.get(`/api/dm/${dm.body.id}/messages`)).status, 404);
  assert.equal((await eve.get(`/api/channels/${dm.body.id}/messages`)).status, 404);

  await b.put(`/api/blocks/${a.user.id}`);
  assert.equal((await a.post(`/api/dm/${dm.body.id}/messages`, { content: 'still there?' })).status, 403);
  assert.equal((await a.post('/api/friends/request', { userId: b.user.id })).status, 403);
  gwB.close();
});

// ───────────────────────────── files ─────────────────────────────

test('uploads: content sniffing, size limit, access control by channel membership', async () => {
  const { member, general } = await serverWithMember();
  const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
  const up = await member.req('POST', `/api/channels/${general.id}/attachments`, png, { 'X-File-Name': encodeURIComponent('кот.png') });
  assert.equal(up.status, 201);
  assert.equal(up.body.kind, 'image');
  assert.equal(up.body.width, 64);

  const fake = await member.req('POST', `/api/channels/${general.id}/attachments`, png, { 'X-File-Name': 'virus.exe' });
  assert.equal(fake.status, 415);
  const html = await member.req('POST', `/api/channels/${general.id}/attachments`, Buffer.from('<html><script>x</script></html>'), { 'X-File-Name': 'a.html' });
  assert.equal(html.status, 415);

  const msg = await member.post(`/api/channels/${general.id}/messages`, { content: '', attachmentIds: [up.body.id] });
  assert.equal(msg.status, 201);
  assert.equal(msg.body.attachments.length, 1);
  // Re-using an attachment in another message is rejected.
  assert.equal((await member.post(`/api/channels/${general.id}/messages`, { content: 'x', attachmentIds: [up.body.id] })).status, 400);

  const file = await member.req('GET', msg.body.attachments[0].url);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/);

  // An outsider with the exact URL is refused (no IDOR).
  const outsider = await c().register('outsider4');
  assert.equal((await outsider.req('GET', msg.body.attachments[0].url)).status, 404);
  const anon = await fetch(h.base + msg.body.attachments[0].url);
  assert.equal(anon.status, 401);

  // Range requests work for media seeking.
  const ranged = await member.req('GET', msg.body.attachments[0].url, undefined, { Range: 'bytes=0-9' });
  assert.equal(ranged.status, 206);

  const copy=c();copy.cookies.set('cc_media',member.cookies.get('cc_media')!);
  const rotated=await member.post('/api/auth/refresh');member.token=rotated.body.accessToken;
  assert.equal((await copy.get(msg.body.attachments[0].url)).status,200,'media survives normal session rotation');
  await member.post('/api/auth/logout');
  assert.equal((await copy.get(msg.body.attachments[0].url)).status,401,'copied long-lived media cookie is invalid after logout');
  const login=await member.post('/api/auth/login',{email:member.user.email,password:'password123'});member.token=login.body.accessToken;
  const other=c();other.cookies.set('cc_media',member.cookies.get('cc_media')!);
  await member.post('/api/auth/password/forgot',{email:member.user.email});
  const letter=await pool.query(`SELECT text_body FROM outbound_emails WHERE user_id=$1 AND subject='Concord — восстановление пароля' ORDER BY created_at DESC LIMIT 1`,[member.user.id]);
  const resetToken=letter.rows[0].text_body.match(/token=([^\s]+)/)[1];
  await c().post('/api/auth/password/reset',{token:resetToken,password:'replacement123'});
  assert.equal((await other.get(msg.body.attachments[0].url)).status,401,'password reset invalidates copied media cookies');
  const again=await member.post('/api/auth/login',{email:member.user.email,password:'replacement123'});member.token=again.body.accessToken;

  assert.equal((await member.del(`/api/attachments/${up.body.id}`)).status, 204);
});

test('avatar upload is re-encoded and served as webp; bad profile colors are rejected', async () => {
  const u = await c().register('artist');
  const jpg = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#3355ff' } }).jpeg().toBuffer();
  const res = await u.req('PUT', '/api/users/me/avatar', jpg);
  assert.equal(res.status, 200);
  const img = await fetch(h.base + res.body.avatarUrl);
  assert.equal(img.headers.get('content-type'), 'image/webp');
  const meta = await sharp(Buffer.from(await img.arrayBuffer())).metadata();
  assert.equal(meta.width, 256);

  const unreadable = await u.patch('/api/users/me', { theme: { preset: 'custom', primary: '#777777', secondary: '#888888' } });
  assert.equal(unreadable.status, 400);
  const ok = await u.patch('/api/users/me', { theme: { preset: 'custom', primary: '#101020', secondary: '#402060', glow: true }, bio: 'hi' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.theme.glow, true);
});

// ───────────────────────────── voice ─────────────────────────────

test('voice: tokens carry real grants; timeouts and server mute are enforced server-side', async () => {
  const { owner, member, serverId, voice, general } = await serverWithMember();
  assert.equal((await member.post(`/api/voice/${general.id}/token`)).status, 400); // text channel
  const tok = await member.post(`/api/voice/${voice.id}/token`);
  assert.equal(tok.status, 200);
  const grant = verifyJwt<any>(tok.body.token, config.LIVEKIT_API_SECRET)!;
  assert.equal(grant.sub, member.user.id);
  assert.equal(grant.video.room, `ch_${voice.id}`);
  assert.ok(grant.video.canPublishSources.includes('microphone'));
  assert.ok(grant.video.canPublishSources.includes('screen_share_audio'));

  const outsider = await c().register('outsider5');
  assert.equal((await outsider.post(`/api/voice/${voice.id}/token`)).status, 404);

  // Simulate LiveKit's signed webhook: the user joins → everyone in the server sees it.
  const gwOwner = await connectGateway(h.base, owner.token!);
  const body = Buffer.from(JSON.stringify({ event: 'participant_joined', room: { name: `ch_${voice.id}` }, participant: { identity: member.user.id } }));
  const sig = signJwt({ iss: config.LIVEKIT_API_KEY, sha256: createHash('sha256').update(body).digest('base64') }, config.LIVEKIT_API_SECRET, 60);
  const forged = await fetch(h.base + '/api/webhooks/livekit', { method: 'POST', body: new Uint8Array(body), headers: { Authorization: 'Bearer nope', 'Content-Type': 'application/webhook+json' } });
  assert.equal(forged.status, 401);
  const hook = await fetch(h.base + '/api/webhooks/livekit', { method: 'POST', body: new Uint8Array(body), headers: { Authorization: sig, 'Content-Type': 'application/webhook+json' } });
  assert.equal(hook.status, 200);
  const joined = await gwOwner.waitFor('voice:join', (d) => d.userId === member.user.id);
  assert.equal(joined.channelId, voice.id);

  // Server mute (moderator action) — member's next token has no microphone grant. LiveKit is not
  // running in the test environment, so the live permission update is logged and skipped.
  assert.equal((await member.patch(`/api/servers/${serverId}/voice/${owner.user.id}`, { serverMute: true })).status, 403);
  const muted = await owner.patch(`/api/servers/${serverId}/voice/${member.user.id}`, { serverMute: true });
  assert.equal(muted.status, 200);
  const st = await gwOwner.waitFor('voice:state', (d) => d.userId === member.user.id);
  assert.equal(st.serverMute, true);
  const tok2 = verifyJwt<any>((await member.post(`/api/voice/${voice.id}/token`)).body.token, config.LIVEKIT_API_SECRET)!;
  assert.equal(tok2.video.canPublishSources.includes('microphone'), false);

  // Timeout removes CONNECT.
  await owner.post(`/api/servers/${serverId}/members/${member.user.id}/timeout`, { minutes: 5 });
  assert.equal((await member.post(`/api/voice/${voice.id}/token`)).status, 403);
  assert.equal((await member.post(`/api/channels/${general.id}/messages`, { content: 'x' })).status, 403);
  gwOwner.close();
});

test('gateway: accepts a heartbeat sent immediately after authentication', async () => {
  const user = await c().register('authheartbeat');
  const gateway = await connectGateway(h.base, user.token!, true);
  try {
    assert.equal(gateway.ready.user.id, user.user.id);
    await gateway.waitFor('heartbeat:ack');
    assert.equal(gateway.ws.readyState, 1);
  } finally {
    gateway.close();
  }
});

test('voice role restrictions survive moderation and prohibit screen audio without VIDEO',async()=>{
 const {owner,member,serverId,voice}=await serverWithMember();
 const updates:{canPublish:boolean;canPublishSources:string[]}[]=[];
 const fake=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;updates.push(JSON.parse(body).permission);res.setHeader('Content-Type','application/json');res.end('{}');});
 await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));
 const previous=config.LIVEKIT_URL;config.LIVEKIT_URL=`http://127.0.0.1:${(fake.address() as import('node:net').AddressInfo).port}`;
 try{
  await pool.query(`UPDATE roles SET permissions=$2 WHERE server_id=$1 AND is_default`,[serverId,Perm.CONNECT.toString()]);
  const token=await member.post(`/api/voice/${voice.id}/token`);assert.equal(token.status,200);
  const grant=verifyJwt<any>(token.body.token,config.LIVEKIT_API_SECRET)!;
  assert.equal(grant.video.canPublish,false);assert.deepEqual(grant.video.canPublishSources,[]);
  await markJoined(member.user.id,voice.id);
  assert.equal((await owner.patch(`/api/servers/${serverId}/voice/${member.user.id}`,{serverMute:true})).status,200);
  assert.equal((await owner.patch(`/api/servers/${serverId}/voice/${member.user.id}`,{serverMute:false})).status,200);
  assert.equal(updates.length,2);assert.ok(updates.every(p=>!p.canPublish&&p.canPublishSources.length===0));
  await pool.query(`UPDATE roles SET permissions=$2 WHERE server_id=$1 AND is_default`,[serverId,(Perm.CONNECT|Perm.SPEAK).toString()]);
  const onlyMic=verifyJwt<any>((await member.post(`/api/voice/${voice.id}/token`)).body.token,config.LIVEKIT_API_SECRET)!;
  assert.deepEqual(onlyMic.video.canPublishSources,['microphone']);
 }finally{config.LIVEKIT_URL=previous;await markLeft(member.user.id,voice.id);await new Promise<void>(resolve=>fake.close(()=>resolve()));}
});

test('gateway: rejects bad tokens, relays typing and DM call signalling', async () => {
  const ws = await import('ws');
  const sock = new ws.WebSocket(h.base.replace('http', 'ws') + '/gateway');
  await new Promise((r) => sock.once('open', r));
  sock.send(JSON.stringify({ op: 'auth', d: { token: 'not-a-real-token' } }));
  const code = await new Promise<number>((r) => sock.once('close', (c: number) => r(c)));
  assert.equal(code, 4001);

  const a = await c().register('callera');
  const b = await c().register('callerb');
  const dm = await a.post('/api/dm', { recipientId: b.user.id });
  const gwA = await connectGateway(h.base, a.token!);
  const gwB = await connectGateway(h.base, b.token!);
  gwA.send('typing', { channelId: dm.body.id });
  const typing = await gwB.waitFor('typing:start');
  assert.equal(typing.userId, a.user.id);

  gwA.send('call:ring', { channelId: dm.body.id, video: true });
  const incoming = await gwB.waitFor('call:incoming');
  assert.equal(incoming.caller.id, a.user.id);
  assert.equal(incoming.video, true);
  gwB.send('call:decline', { channelId: dm.body.id });
  await gwA.waitFor('call:declined');
  const missed = await gwA.waitFor('message:new', (d) => d.kind === 'system');
  assert.equal(missed.content, 'call:missed');
  gwA.close();
  gwB.close();
});

test('blocked DM participants cannot ring in either direction or restore a stale ring',async()=>{
 const a=await c().register('blocked_caller'),b=await c().register('blocked_callee');
 const dm=await a.post('/api/dm',{recipientId:b.user.id});assert.equal(dm.status,200);
 const ga=await connectGateway(h.base,a.token!),gb=await connectGateway(h.base,b.token!);
 try{
  assert.equal((await b.put(`/api/blocks/${a.user.id}`)).status,200);
  for(const caller of [ga,gb]){
   caller.send('call:ring',{channelId:dm.body.id,video:false});
   const error=await caller.waitFor('error',d=>d.op==='call:ring');assert.equal(error.code,'FORBIDDEN');
  }
  assert.equal(await redis.get(`call:ring:${dm.body.id}`),null);
  assert.equal((await b.get('/api/notifications')).body.items.filter((n:any)=>n.type==='call').length,0);
  await redis.set(`call:ring:${dm.body.id}`,JSON.stringify({callerId:a.user.id,video:false,startedAt:new Date().toISOString()}),'EX',45);
  assert.deepEqual(await pendingRings(b.user.id,[dm.body.id]),[]);
  await redis.del(`call:ring:${dm.body.id}`);
  assert.equal((await b.del(`/api/blocks/${a.user.id}`)).status,200);
  ga.send('call:ring',{channelId:dm.body.id,video:true});await gb.waitFor('call:incoming');
 }finally{ga.close();gb.close();}
});

test('rate limiting returns 429 with Retry-After', async () => {
  let last = 0;
  let retry: string | null = null;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(h.base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'concord', 'X-Forwarded-For': '10.9.9.9' },
      body: JSON.stringify({ email: 'rl@example.com', password: 'whatever1' }),
    });
    last = res.status;
    retry = res.headers.get('retry-after');
  }
  assert.equal(last, 429);
  assert.ok(Number(retry) > 0);
});
