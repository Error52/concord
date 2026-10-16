import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { startServer, Client, connectGateway, sleep, type Harness } from './helpers.js';
import { hotp, base32Decode } from '../src/auth/totp.js';
import { verifyJwt, signJwt } from '../src/auth/jwt.js';
import { config,platformAdminEmails,validateMailConfiguration } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { createHash } from 'node:crypto';
import { deliverPendingMail,protectQueuedMail,clearInvalidMail } from '../src/services/mailOutbox.js';
import {syncPlatformAdmins} from '../src/services/adminService.js';
import {reconcileVoice} from '../src/jobs.js';
import {captureSmtp} from './smtpCapture.js';
import {createServer} from 'node:http';
import {markJoined,markLeft,forceDisconnectUser,handleWebhook,updateSelfState} from '../src/services/voiceService.js';
import {Perm} from '../src/models/permissions.js';
import {pendingRings,ring as ringCall,decline as declineCall,accept as acceptCall} from '../src/services/callService.js';
import {redis} from '../src/redis.js';
import {react,create as createMessage} from '../src/services/messageService.js';
import {notify,list as listNotifications,markRead as readNotifications,clear as clearNotifications} from '../src/services/notificationService.js';
import {resendEmailVerification,confirmEmail} from '../src/services/authService.js';
import {openMail} from '../src/services/mailCrypto.js';
import {joinPublic,ban as banMember} from '../src/services/serverService.js';

let h: Harness;
const c = (): Client => new Client(h.base);

async function withLiveKitCapture(fn:(calls:{method:string;room:string;identity:string}[])=>Promise<void>,responses:Record<string,unknown>={}){
 const calls:{method:string;room:string;identity:string}[]=[];
 const fake=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const method=req.url!.split('/').at(-1)!;calls.push({method,...JSON.parse(body)});const response=responses[method];res.setHeader('Content-Type','application/json');res.end(JSON.stringify(typeof response==='function'?await response():response??{}));});
 await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));const previous=config.LIVEKIT_URL;
 config.LIVEKIT_URL=`http://127.0.0.1:${(fake.address() as import('node:net').AddressInfo).port}`;
 try{await fn(calls);}finally{config.LIVEKIT_URL=previous;await new Promise<void>(resolve=>fake.close(()=>resolve()));}
}

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

test('email allowlist never grants admin through demo verification or startup sync',async()=>{
 const previous=config.DEMO_MAILBOX,emails=[...platformAdminEmails];
 const signup=async(name:string)=>{const result=await c().post('/api/auth/register',{username:name,email:`${name}@example.com`,password:'password123'});assert.equal(result.status,201);return result.body.user;};
 try{
  platformAdminEmails.push('demo_admin_spoof@example.com','real_admin_verify@example.com');config.DEMO_MAILBOX=true;
  const demo=await signup('demo_admin_spoof');assert.equal(demo.isPlatformAdmin,false);
  const letter=await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE user_id=$1`,[demo.id]);
  await confirmEmail(openMail(letter.rows[0]).text.match(/token=([^\s]+)/)![1]);await syncPlatformAdmins();
  config.DEMO_MAILBOX=false;await syncPlatformAdmins();
  assert.equal((await pool.query(`SELECT is_platform_admin FROM users WHERE id=$1`,[demo.id])).rows[0].is_platform_admin,false);
  const real=await signup('real_admin_verify');assert.equal(real.isPlatformAdmin,false);
  const realLetter=await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE user_id=$1`,[real.id]);
  await confirmEmail(openMail(realLetter.rows[0]).text.match(/token=([^\s]+)/)![1]);
  assert.equal((await pool.query(`SELECT is_platform_admin FROM users WHERE id=$1`,[real.id])).rows[0].is_platform_admin,true);
 }finally{config.DEMO_MAILBOX=previous;platformAdminEmails.splice(0,platformAdminEmails.length,...emails);}
});

test('public verification fails early without usable SMTP and keeps LAN demo mode available',()=>{
 const previous={NODE_ENV:config.NODE_ENV,SMTP_HOST:config.SMTP_HOST,DEMO_MAILBOX:config.DEMO_MAILBOX,APP_URL:config.APP_URL,REQUIRE_EMAIL_VERIFICATION:config.REQUIRE_EMAIL_VERIFICATION};
 try{Object.assign(config,{NODE_ENV:'production',SMTP_HOST:'',DEMO_MAILBOX:false,APP_URL:'https://chat.example.com',REQUIRE_EMAIL_VERIFICATION:true});assert.throws(validateMailConfiguration,/real SMTP/);config.SMTP_HOST='mailpit';assert.throws(validateMailConfiguration,/real SMTP/);config.DEMO_MAILBOX=true;assert.doesNotThrow(validateMailConfiguration);}
 finally{Object.assign(config,previous);}
});

test('legacy mail queue is encrypted before startup and expired link bodies are erased',async()=>{
 const user=await c().register('mail_legacy_protect');
 const row=await pool.query(`INSERT INTO outbound_emails(user_id,recipient,subject,text_body,html_body,expires_at) VALUES($1,$2,'legacy','private legacy link','<p>private legacy link</p>',now()+interval '1 hour') RETURNING id`,[user.user.id,user.user.email]);
 await protectQueuedMail();let current=(await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE id=$1`,[row.rows[0].id])).rows[0];assert.match(current.text_body,/^sealed:v1:/);assert.equal(openMail(current).text,'private legacy link');assert.equal(current.html_body,'');
 await pool.query(`UPDATE outbound_emails SET expires_at=now()-interval '1 second' WHERE id=$1`,[row.rows[0].id]);await clearInvalidMail();current=(await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE id=$1`,[row.rows[0].id])).rows[0];assert.deepEqual(current,{text_body:'',html_body:''});
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
  const queued=await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[u.user.id]);
  const token=openMail(queued.rows[0]).text.match(/token=([^\s]+)/)![1];
  assert.ok(!queued.rows[0].text_body.includes(token));assert.equal(queued.rows[0].html_body,'');
  const stored=await pool.query(`SELECT token_hash FROM email_verifications WHERE user_id=$1`,[u.user.id]);
  assert.equal(stored.rows[0].token_hash,createHash('sha256').update(token).digest('hex'));
  await pool.query(`UPDATE email_verifications SET expires_at=now()-interval '1 minute' WHERE user_id=$1`,[u.user.id]);
  assert.equal((await c().post('/api/auth/email/confirm',{token})).status,400,'expired links cannot verify the account');
  assert.equal((await u.post('/api/auth/email/resend')).status,429);
  await pool.query(`UPDATE email_verifications SET created_at=now()-interval '2 minutes' WHERE user_id=$1`,[u.user.id]);
  assert.equal((await u.post('/api/auth/email/resend')).status,200);
  assert.equal((await c().post('/api/auth/email/confirm',{token})).status,400,'resend invalidates superseded link');
  const latest=await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[u.user.id]);
  const fresh=openMail(latest.rows[0]).text.match(/token=([^\s]+)/)![1];
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

test('email confirmation and resend use a consistent lock order',async()=>{
 const u=c(),signup=await u.post('/api/auth/register',{username:'verify_lock_order',email:'verify_lock_order@example.com',password:'password123'});
 const userId=signup.body.user.id;
 const queued=await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[userId]);
 const token=openMail(queued.rows[0]).text.match(/token=([^\s]+)/)![1];
 await pool.query(`UPDATE email_verifications SET created_at=now()-interval '2 minutes' WHERE user_id=$1`,[userId]);
 const barrier=await pool.connect();await barrier.query('BEGIN');await barrier.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`,[userId]);
 const observe=(p:Promise<unknown>)=>p.then(()=>null,e=>e);
 const waitBlocked=async(n:number)=>{for(let i=0;i<150;i++){const r=await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`);if(r.rows[0].n>=n)return;await sleep(10);}throw new Error('Expected verification queries to reach row lock');};
 let resend:Promise<any>|undefined,confirm:Promise<any>|undefined;
 try{
  resend=observe(resendEmailVerification(userId));await waitBlocked(1);
  confirm=observe(confirmEmail(token));await waitBlocked(2);
 }finally{await barrier.query('COMMIT');barrier.release();}
 const errors=await Promise.all([resend!,confirm!]);
 assert.equal(errors[0],null,'resend finishes without a database deadlock');
 assert.equal(errors[1]?.code,'VERIFY_INVALID','superseded link is rejected after the resend commits');
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
  const resetLetter=await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE user_id=$1 AND purpose='password-reset' ORDER BY created_at DESC LIMIT 1`,[u.user.id]);
  const oldReset=openMail(resetLetter.rows[0]).text.match(/token=([^\s]+)/)![1];
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

test('deleting a voice channel removes its active participants and occupancy',async()=>{
 const {owner,member,serverId,voice}=await serverWithMember();
 await withLiveKitCapture(async calls=>{
  await markJoined(owner.user.id,voice.id);await markJoined(member.user.id,voice.id);
  await forceDisconnectUser(member.user.id,serverId,'00000000-0000-4000-8000-000000000001');assert.equal(calls.length,0);
  const gw=await connectGateway(h.base,member.token!);
  try{
   assert.equal((await owner.del(`/api/channels/${voice.id}`)).status,204);
   assert.equal(await redis.get(`voice:user:${member.user.id}`),null);assert.equal(await redis.get(`voice:user:${owner.user.id}`),null);
   assert.deepEqual(await redis.smembers(`voice:room:${voice.id}`),[]);
   assert.equal(calls.filter(c=>c.method==='RemoveParticipant'&&c.room===`ch_${voice.id}`).length,2);
   await gw.waitFor('voice:disconnect',d=>d.channelId===voice.id);
  }finally{gw.close();}
 });
});
test('deleting a server removes its active voice participants before cascading channels',async()=>{
 const {owner,member,serverId,voice}=await serverWithMember();
 await withLiveKitCapture(async calls=>{
  await markJoined(member.user.id,voice.id);assert.equal((await owner.del(`/api/servers/${serverId}`)).status,204);
  assert.equal(await redis.get(`voice:user:${member.user.id}`),null);assert.deepEqual(await redis.smembers(`voice:room:${voice.id}`),[]);
  assert.equal(calls.filter(c=>c.method==='RemoveParticipant'&&c.identity===member.user.id).length,1);
 });
});
test('notification mutations return exactly the affected ids and unread count',async()=>{
 const a=await c().register('notif_snapshot_a'),b=await c().register('notif_snapshot_b');
 await notify([a.user.id,b.user.id],'server',{content:'before read'});
 const first=(await a.get('/api/notifications')).body.items[0].id;
 const read=await a.post('/api/notifications/read',{ids:'all'});assert.equal(read.status,200);assert.deepEqual(read.body.ids,[first]);assert.equal(read.body.unreadChanged,1);assert.ok(read.body.mutationId);
 const repeated=(await a.post('/api/notifications/read',{ids:'all'})).body;assert.deepEqual(repeated.ids,[]);assert.equal(repeated.unreadChanged,0);
 assert.equal((await b.get('/api/notifications')).body.unread,1);
 await notify([a.user.id],'server',{content:'after read'});const beforeClear=(await a.get('/api/notifications')).body;
 const cleared=await a.del('/api/notifications');assert.equal(cleared.status,200);assert.equal(cleared.body.unreadChanged,1);assert.deepEqual(cleared.body.ids.sort(),beforeClear.items.map((n:any)=>n.id).sort());
 await notify([a.user.id],'server',{content:'after clear'});assert.equal((await a.get('/api/notifications')).body.unread,1);
});

test('notification read and clear are broadcast to every active device',async()=>{
 const user=await c().register('notification_devices'),a=await connectGateway(h.base,user.token!),b=await connectGateway(h.base,user.token!);
 try{
  await notify([user.user.id],'server',{content:'multi-device fixture'});const item=await a.waitFor('notification:new');
  const read=(await user.post('/api/notifications/read',{ids:'all'})).body;
  for(const gateway of [a,b]){const event=await gateway.waitFor('notification:read',d=>d.mutationId===read.mutationId);assert.deepEqual(event.ids,[item.id]);assert.equal(event.unreadChanged,1);}
  const clear=(await user.del('/api/notifications')).body;
  for(const gateway of [a,b]){const event=await gateway.waitFor('notification:clear',d=>d.mutationId===clear.mutationId);assert.deepEqual(event.ids,[item.id]);assert.equal(event.unreadChanged,0);}
 }finally{a.close();b.close();}
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

test('invite redemption counts successful memberships only and is idempotent',async()=>{
 const {owner,member,serverId}=await serverWithMember();
 await owner.put(`/api/servers/${serverId}/bans/${member.user.id}`,{});
 const inv=(await owner.post(`/api/servers/${serverId}/invites`,{maxUses:1})).body;
 assert.equal((await member.post(`/api/invites/${inv.code}`)).status,403);
 assert.equal((await pool.query(`SELECT uses FROM invites WHERE code=$1`,[inv.code])).rows[0].uses,0,'denied membership must not consume an invite');
 const newcomer=await c().register('invite_atomic');
 const attempts=await Promise.all(Array.from({length:5},()=>newcomer.post(`/api/invites/${inv.code}`)));
 assert.ok(attempts.every(r=>r.status===200),'repeated acceptance by the same member succeeds');
 assert.equal((await pool.query(`SELECT uses FROM invites WHERE code=$1`,[inv.code])).rows[0].uses,1);
 assert.equal((await newcomer.post(`/api/invites/${inv.code}`)).status,200);
 const other=await c().register('invite_atomic_other');
 assert.equal((await other.post(`/api/invites/${inv.code}`)).status,410);
});

test('concurrent single-use invite redemptions admit one distinct member',async()=>{
 const {owner,serverId}=await serverWithMember();
 const inv=(await owner.post(`/api/servers/${serverId}/invites`,{maxUses:1})).body;
 const a=await c().register('invite_cap_a'),b=await c().register('invite_cap_b');
 const results=await Promise.all([a,b].map(u=>u.post(`/api/invites/${inv.code}`)));
 assert.deepEqual(results.map(r=>r.status).sort(),[200,410]);
 assert.equal((await pool.query(`SELECT uses FROM invites WHERE code=$1`,[inv.code])).rows[0].uses,1);
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM server_members WHERE server_id=$1 AND user_id=ANY($2::uuid[])`,[serverId,[a.user.id,b.user.id]])).rows[0].n,1);
});

test('active voice permissions follow role edits, assignments and deletion',async()=>{
 const {owner,member,serverId,voice,full}=await serverWithMember();
 const base=full.roles.find((r:any)=>r.isDefault);
 await withLiveKitCapture(async calls=>{
  await markJoined(member.user.id,voice.id);
  const patch=await owner.patch(`/api/servers/${serverId}/roles/${base.id}`,{permissions:Perm.CONNECT.toString()});assert.equal(patch.status,204);
  const permissions=()=>calls.filter(c=>c.method==='UpdateParticipant'&&c.identity===member.user.id).map(c=>(c as any).permission);
  assert.deepEqual(permissions().at(-1)?.canPublishSources,[],'existing tracks lose revoked sources immediately');
  const role=(await owner.post(`/api/servers/${serverId}/roles`,{name:'Speaker',permissions:Perm.SPEAK.toString()})).body;
  assert.equal((await owner.put(`/api/servers/${serverId}/members/${member.user.id}/roles`,{roleIds:[role.id]})).status,200);
  assert.deepEqual(permissions().at(-1)?.canPublishSources,['MICROPHONE']);
  await owner.del(`/api/servers/${serverId}/roles/${role.id}`);
  assert.deepEqual(permissions().at(-1)?.canPublishSources,[]);
  assert.equal((await owner.patch(`/api/servers/${serverId}/roles/${base.id}`,{permissions:'0'})).status,204);
  assert.ok(calls.some(c=>c.method==='RemoveParticipant'&&c.identity===member.user.id));
  assert.equal(await redis.get(`voice:user:${member.user.id}`),null);
 });
});

test('concurrent server moderation preserves a newer self-mute state',async()=>{
 const {owner,member,serverId,voice}=await serverWithMember();let release!:()=>void,received!:()=>void;
 const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>received=r);
 await withLiveKitCapture(async()=>{
  await markJoined(member.user.id,voice.id);const moderation=owner.patch(`/api/servers/${serverId}/voice/${member.user.id}`,{serverMute:true});
  try{await waiting;await updateSelfState(member.user.id,{selfMute:true});}finally{release();}
  assert.equal((await moderation).status,200);const state=JSON.parse((await redis.get(`voice:user:${member.user.id}`))!);assert.equal(state.serverMute,true);assert.equal(state.selfMute,true);
 },{UpdateParticipant:async()=>{received();await gate;return {};}});
});

test('simultaneous voice joins are recorded once and switching removes the old SFU participant',async()=>{
 const {owner,member,serverId,voice}=await serverWithMember();
 const second=(await owner.post(`/api/servers/${serverId}/channels`,{name:'Second voice',type:'voice'})).body;
 await withLiveKitCapture(async calls=>{
  await Promise.all(Array.from({length:5},()=>markJoined(member.user.id,voice.id)));
  const rows=await pool.query(`SELECT count(*)::int AS n FROM voice_participants WHERE user_id=$1 AND left_at IS NULL`,[member.user.id]);assert.equal(rows.rows[0].n,1);
  await markJoined(member.user.id,second.id);
  assert.ok(calls.some(c=>c.method==='RemoveParticipant'&&c.room===`ch_${voice.id}`&&c.identity===member.user.id));
  assert.equal(await redis.sismember(`voice:room:${voice.id}`,member.user.id),0);assert.equal(await redis.sismember(`voice:room:${second.id}`,member.user.id),1);
  await markLeft(member.user.id,voice.id);assert.equal(JSON.parse((await redis.get(`voice:user:${member.user.id}`))!).channelId,second.id);
  await markLeft(member.user.id,second.id);
 });
});

test('two users swapping voice rooms cannot deadlock their session history',async(t)=>{
 const {owner,member,serverId,voice}=await serverWithMember();const second=(await owner.post(`/api/servers/${serverId}/channels`,{name:'Swap voice',type:'voice'})).body;
 await withLiveKitCapture(async()=>{
  await markJoined(owner.user.id,voice.id);await markJoined(member.user.id,second.id);
  const client=await pool.connect(),prototype=Object.getPrototypeOf(client),original=prototype.query;client.release();
  let release!:()=>void,arrived!:()=>void,count=0;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>arrived=r);
  t.mock.method(prototype,'query',function(this:any,...args:any[]){const result=original.apply(this,args);if(typeof args[0]==='string'&&/UPDATE voice_sessions SET ended_at = now\(\)/.test(args[0])&&count<2)return result.then(async(row:any)=>{if(++count===2)arrived();await gate;return row;});return result;});
  const swapping=Promise.all([markJoined(owner.user.id,second.id),markJoined(member.user.id,voice.id)]);
  try{await Promise.race([waiting,sleep(150)]);}finally{release();}
  await swapping;
  assert.equal(JSON.parse((await redis.get(`voice:user:${owner.user.id}`))!).channelId,second.id);
  assert.equal(JSON.parse((await redis.get(`voice:user:${member.user.id}`))!).channelId,voice.id);
  await markLeft(owner.user.id,second.id);await markLeft(member.user.id,voice.id);
 });
});

test('gateway delivers events created during its ready snapshot after ready',async(t)=>{
 const user=await c().register('ready_event_order');const instance=h.app.gateway as any,original=instance.buildReady.bind(instance);
 t.mock.method(instance,'buildReady',async(...args:any[])=>{const ready=await original(...args);await notify([user.user.id],'server',{content:'during ready'});await sleep(30);return ready;});
 const {WebSocket}=await import('ws');const ws=new WebSocket(h.base.replace('http','ws')+'/gateway');const frames:{t:string;d:any}[]=[];
 try{
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('ready event timeout')),3000);ws.on('message',raw=>{const frame=JSON.parse(raw.toString());frames.push(frame);if(frames.some(f=>f.t==='ready')&&frames.some(f=>f.t==='notification:new')){clearTimeout(timer);resolve();}});ws.once('open',()=>ws.send(JSON.stringify({op:'auth',d:{token:user.token}})));});
  assert.ok(frames.findIndex(f=>f.t==='ready')<frames.findIndex(f=>f.t==='notification:new'));
 }finally{ws.close();}
});

test('a failed ready snapshot closes for reconnect instead of leaving a half-authenticated socket',async(t)=>{
 const user=await c().register('ready_snapshot_failure');t.mock.method(h.app.gateway as any,'buildReady',async()=>{throw new Error('simulated snapshot failure');});
 const {WebSocket}=await import('ws');const ws=new WebSocket(h.base.replace('http','ws')+'/gateway');
 try{
  const code=await new Promise<number>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('snapshot failure left the socket open')),1500);ws.once('close',code=>{clearTimeout(timer);resolve(code);});ws.once('open',()=>ws.send(JSON.stringify({op:'auth',d:{token:user.token}})));});
  assert.equal(code,4009);
 }finally{ws.close();}
});

test('failed SFU moderation removes the participant instead of pretending mute succeeded',async()=>{
 const {owner,member,serverId,voice}=await serverWithMember();const calls:string[]=[];
 const fake=createServer(async(req,res)=>{for await(const chunk of req){void chunk;}const method=req.url!.split('/').at(-1)!;calls.push(method);res.setHeader('Content-Type','application/json');res.statusCode=method==='UpdateParticipant'?500:200;res.end('{}');});
 await new Promise<void>(r=>fake.listen(0,'127.0.0.1',r));const previous=config.LIVEKIT_URL;config.LIVEKIT_URL=`http://127.0.0.1:${(fake.address() as import('node:net').AddressInfo).port}`;
 try{
  await markJoined(member.user.id,voice.id);
  const muted=await owner.patch(`/api/servers/${serverId}/voice/${member.user.id}`,{serverMute:true});assert.equal(muted.status,200);
  assert.ok(calls.includes('RemoveParticipant'));assert.equal(await redis.get(`voice:user:${member.user.id}`),null);
  assert.equal(JSON.parse((await redis.get(`voice:mod:${serverId}:${member.user.id}`))!).serverMute,true);
 }finally{config.LIVEKIT_URL=previous;await markLeft(member.user.id,voice.id);await new Promise<void>(r=>fake.close(()=>r()));}
});

test('notification revisions order concurrent mutations and consistent snapshots',async()=>{
 const user=await c().register('notification_revisions');const revisions:string[]=[];
 await Promise.all(Array.from({length:6},(_,i)=>notify([user.user.id],'server',{content:String(i)})));
 const first=await listNotifications(user.user.id);assert.equal(first.unread,6);assert.equal(first.items.filter(n=>!n.read).length,6);revisions.push(first.revision);
 const read=await readNotifications(user.user.id,[first.items[0]!.id]);assert.equal(read.unread,5);revisions.push(read.revision);
 const cleared=await clearNotifications(user.user.id);assert.equal(cleared.unread,0);revisions.push(cleared.revision);
 const final=await listNotifications(user.user.id);assert.equal(final.unread,0);assert.equal(final.items.length,0);assert.equal(final.revision,cleared.revision);
 assert.ok(BigInt(revisions[0]!)<BigInt(revisions[1]!)&&BigInt(revisions[1]!)<BigInt(revisions[2]!));
});

test('late voice webhooks recheck access and old token publishing permissions',async()=>{
 const {owner,member,serverId,voice,full}=await serverWithMember();
 const base=full.roles.find((r:any)=>r.isDefault);
 await withLiveKitCapture(async calls=>{
  const token=await member.post(`/api/voice/${voice.id}/token`);assert.equal(token.status,200);
  await owner.patch(`/api/servers/${serverId}/roles/${base.id}`,{permissions:Perm.CONNECT.toString()});
  await handleWebhook({event:'participant_joined',room:{name:`ch_${voice.id}`},participant:{identity:member.user.id}});
  assert.deepEqual((calls.find(c=>c.method==='UpdateParticipant') as any)?.permission.canPublishSources,[]);
  await markLeft(member.user.id,voice.id);
  await owner.patch(`/api/servers/${serverId}/roles/${base.id}`,{permissions:'0'});
  await handleWebhook({event:'participant_joined',room:{name:`ch_${voice.id}`},participant:{identity:member.user.id}});
  assert.equal(await redis.get(`voice:user:${member.user.id}`),null);
  assert.ok(calls.some(c=>c.method==='RemoveParticipant'&&c.identity===member.user.id));
 });
});

test('voice reconciliation finds untracked SFU rooms and removes banned token holders',async()=>{
 const {owner,member,serverId,voice}=await serverWithMember();await owner.put(`/api/servers/${serverId}/bans/${member.user.id}`,{});
 await withLiveKitCapture(async calls=>{
  await reconcileVoice();assert.ok(calls.some(c=>c.method==='RemoveParticipant'&&c.identity===member.user.id&&c.room===`ch_${voice.id}`));assert.equal(await redis.get(`voice:user:${member.user.id}`),null);
 },{ListRooms:{rooms:[{name:`ch_${voice.id}`}]},ListParticipants:{participants:[{identity:member.user.id}]}});
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

test('message nonce retries create one row, one mention and one notification',async()=>{
 const {owner,member,general}=await serverWithMember();
 const input={content:`retry <@${owner.user.id}>`,nonce:'same-request'};
 const sent=await Promise.all(Array.from({length:4},()=>member.post(`/api/channels/${general.id}/messages`,input)));
 assert.ok(sent.every(r=>r.status===201),JSON.stringify(sent.map(r=>r.body)));
 assert.equal(new Set(sent.map(r=>r.body.id)).size,1);
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE channel_id=$1 AND kind='default'`,[general.id])).rows[0].n,1);
 assert.equal((await pool.query(`SELECT mention_count FROM read_states WHERE channel_id=$1 AND user_id=$2`,[general.id,owner.user.id])).rows[0].mention_count,1);
 assert.equal((await owner.get('/api/notifications')).body.items.filter((n:any)=>n.data.channelId===general.id).length,1);
 const changed=await member.post(`/api/channels/${general.id}/messages`,{...input,content:'different payload'});
 assert.equal(changed.status,409);assert.equal(changed.body.error.code,'NONCE_CONFLICT');
});

test('a ban racing with public join cannot leave a banned member inside the server',async(t)=>{
 const {owner,serverId}=await serverWithMember(),outsider=await c().register('join_ban_race');await pool.query(`UPDATE servers SET is_public=true WHERE id=$1`,[serverId]);
 const client=await pool.connect(),prototype=Object.getPrototypeOf(client),original=prototype.query;client.release();
 let release!:()=>void,checked!:()=>void,gated=false;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>checked=r);
 t.mock.method(prototype,'query',function(this:any,...args:any[]){
  if(!gated&&typeof args[0]==='string'&&/SELECT 1 FROM bans/.test(args[0])&&args[1]?.includes(outsider.user.id)){
    gated=true;
    if(typeof args[2]==='function'){const callback=args[2];args[2]=(...results:any[])=>{checked();void gate.then(()=>callback(...results));};return original.apply(this,args);}
    return original.apply(this,args).then(async(result:any)=>{checked();await gate;return result;});
  }
  return original.apply(this,args);
 });
 const joining=joinPublic(serverId,outsider.user.id).then(()=>null,err=>err);await waiting;
 const banning=banMember(serverId,owner.user.id,outsider.user.id);
 try{await Promise.race([banning,sleep(250)]);}finally{release();}
 await banning;await joining;
 assert.equal((await pool.query(`SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`,[serverId,outsider.user.id])).rowCount,0);
 assert.equal((await pool.query(`SELECT 1 FROM bans WHERE server_id=$1 AND user_id=$2`,[serverId,outsider.user.id])).rowCount,1);
});

test('an older concurrent message commit cannot move channel and read markers backwards',async(t)=>{
 const {member,general}=await serverWithMember();const client=await pool.connect(),prototype=Object.getPrototypeOf(client),original=prototype.query;client.release();
 let release!:()=>void,inserted!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>inserted=r);
 t.mock.method(prototype,'query',function(this:any,...args:any[]){
  const result=original.apply(this,args);
  if(typeof args[0]==='string'&&/INSERT INTO messages/.test(args[0])&&args[1]?.includes('older-commit'))return result.then(async(row:any)=>{inserted();await gate;return row;});
  return result;
 });
 const older=createMessage(general.id,member.user.id,{content:'older',nonce:'older-commit'});await waiting;
 let newer:any;
 try{newer=await createMessage(general.id,member.user.id,{content:'newer',nonce:'newer-commit'});await pool.query(`UPDATE read_states SET mention_count=1 WHERE channel_id=$1 AND user_id=$2`,[general.id,member.user.id]);}finally{release();}
 const old=await older;assert.ok(BigInt(old.id)<BigInt(newer.id));
 assert.equal((await pool.query(`SELECT last_message_id FROM channels WHERE id=$1`,[general.id])).rows[0].last_message_id,newer.id);
 assert.deepEqual((await pool.query(`SELECT last_read_id,mention_count FROM read_states WHERE channel_id=$1 AND user_id=$2`,[general.id,member.user.id])).rows[0],{last_read_id:newer.id,mention_count:1});
});

test('message nonce retry survives used attachments and an active slowmode timer',async()=>{
 const {owner,member,general}=await serverWithMember();
 await owner.patch(`/api/channels/${general.id}`,{slowmodeSeconds:30});
 const file=await member.req('POST',`/api/channels/${general.id}/attachments`,Buffer.from('retry file'),{'Content-Type':'text/plain','X-File-Name':'retry.txt'});
 assert.equal(file.status,201);
 const input={content:'with attachment',attachmentIds:[file.body.id],nonce:'attachment-retry'};
 const first=await member.post(`/api/channels/${general.id}/messages`,input);assert.equal(first.status,201);
 const retry=await member.post(`/api/channels/${general.id}/messages`,input);assert.equal(retry.status,201);assert.equal(retry.body.id,first.body.id);assert.equal(retry.body.attachments.length,1);
 const fresh=await member.post(`/api/channels/${general.id}/messages`,{content:'new',nonce:'new-request'});assert.equal(fresh.status,429);
});

test('slowmode rejection of an invalid reply does not consume the send window',async()=>{
 const {owner,member,general}=await serverWithMember();await owner.patch(`/api/channels/${general.id}`,{slowmodeSeconds:30});
 const bad=await member.post(`/api/channels/${general.id}/messages`,{content:'bad reply',replyToId:'999999999999'});assert.equal(bad.status,400);
 const good=await member.post(`/api/channels/${general.id}/messages`,{content:'valid'});assert.equal(good.status,201);
});

test('message committed before a broadcast failure still reports success',async(t)=>{
 const {member,general}=await serverWithMember();
 t.mock.method(redis,'publish',async()=>{throw new Error('simulated Redis publish outage');});
 const sent=await member.post(`/api/channels/${general.id}/messages`,{content:'durable',nonce:'publish-failure'});
 assert.equal(sent.status,201);assert.ok(sent.body.id);
 assert.equal((await member.get(`/api/channels/${general.id}/messages`)).body.filter((m:any)=>m.content==='durable').length,1);
});

test('ring lifecycle rejects stale actions and records one concurrent decline',async()=>{
 const a=await c().register('ring_race_a'),b=await c().register('ring_race_b');const dm=(await a.post('/api/dm',{recipientId:b.user.id})).body.id;
 await Promise.all(Array.from({length:4},()=>ringCall(dm,a.user.id,false)));
 const first=JSON.parse((await redis.get(`call:ring:${dm}`))!);
 assert.ok(first.id);
 assert.equal((await b.get('/api/notifications')).body.items.filter((n:any)=>n.type==='call').length,1);
 await Promise.all(Array.from({length:4},()=>declineCall(dm,b.user.id,first.id)));
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE channel_id=$1 AND content='call:missed'`,[dm])).rows[0].n,1);
 await ringCall(dm,a.user.id,true);const second=JSON.parse((await redis.get(`call:ring:${dm}`))!);assert.notEqual(second.id,first.id);
 await declineCall(dm,b.user.id,first.id);await acceptCall(dm,b.user.id,first.id);
 assert.equal(JSON.parse((await redis.get(`call:ring:${dm}`))!).id,second.id);
 await acceptCall(dm,a.user.id,second.id);assert.ok(await redis.get(`call:ring:${dm}`),'caller cannot accept own ringing call');
 await acceptCall(dm,b.user.id,second.id);assert.equal(await redis.get(`call:ring:${dm}`),null);
});

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

test('pin capacity is atomic and pinning an existing pin is idempotent',async()=>{
 const {owner,general}=await serverWithMember();
 const pins=await pool.query(`INSERT INTO messages(channel_id,author_id,content,pinned) SELECT $1,$2,'capacity fixture',true FROM generate_series(1,49) RETURNING id`,[general.id,owner.user.id]);
 const a=(await owner.post(`/api/channels/${general.id}/messages`,{content:'candidate a'})).body;
 const b=(await owner.post(`/api/channels/${general.id}/messages`,{content:'candidate b'})).body;
 const attempts=await Promise.all([a,b].map(m=>owner.put(`/api/messages/${m.id}/pin`)));
 assert.deepEqual(attempts.map(r=>r.status).sort(),[200,400]);
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE channel_id=$1 AND pinned`,[general.id])).rows[0].n,50);
 assert.equal((await owner.put(`/api/messages/${pins.rows[0].id}/pin`)).status,200,'retry at capacity keeps an already pinned message pinned');
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
  const letter=await pool.query(`SELECT text_body,html_body FROM outbound_emails WHERE user_id=$1 AND subject='Concord — восстановление пароля' ORDER BY created_at DESC LIMIT 1`,[member.user.id]);
  const resetToken=openMail(letter.rows[0]).text.match(/token=([^\s]+)/)![1];
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
 await withLiveKitCapture(async()=>{
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

  // Server mute updates the captured SFU permission request and the next join token.
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
