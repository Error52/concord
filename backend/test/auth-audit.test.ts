import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { startServer, Client, sleep, type Harness } from './helpers.js';
import { pool } from '../src/db/pool.js';
import { redis } from '../src/redis.js';
import * as auth from '../src/services/authService.js';
import { base32Decode, generateTotpSecret, hotp } from '../src/auth/totp.js';
import { signJwt } from '../src/auth/jwt.js';
import { config } from '../src/config.js';
import { createHash } from 'node:crypto';

let h: Harness;
const clientInfo = { ip:'127.0.0.1', userAgent:'auth regression' };
const code = (secret:string) => hotp(base32Decode(secret),Math.floor(Date.now()/30_000));
const capture = <T>(p:Promise<T>) => p.then(value=>({value,error:null}),error=>({value:null,error}));

before(async()=>{h=await startServer();});
after(async()=>{await h.close();});

async function waitForBlocked(count:number):Promise<void> {
  for(let i=0;i<400;i++){
    const r=await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`);
    if(r.rows[0].n>=count)return;
    await sleep(10);
  }
  throw new Error('Expected authentication request to reach the transaction barrier');
}

/** Change credentials after a request verified its initial snapshot, before it can issue a session. */
async function changeWhileAuthenticating<T>(userId:string,action:()=>Promise<T>,change:(db:PoolClient)=>Promise<unknown>) {
  const barrier=await pool.connect();
  let pending:ReturnType<typeof capture<T>>|undefined;
  try{
    await barrier.query('BEGIN');
    await barrier.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,72601))`,[userId]);
    pending=capture(action());
    await waitForBlocked(1);
    await change(barrier);
    await barrier.query('COMMIT');
    return await pending;
  }finally{
    await barrier.query('ROLLBACK');
    barrier.release();
    await pending;
  }
}

test('password-only login cannot pass an MFA setting enabled while its session was queued',async()=>{
  const u=await new Client(h.base).register('auth_factor_login');
  const secret=generateTotpSecret();
  const before=(await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id=$1`,[u.user.id])).rows[0].n;
  const result=await changeWhileAuthenticating(u.user.id,()=>auth.login(u.user.email,'password123',clientInfo),
    db=>db.query(`UPDATE users SET totp_enabled=true,totp_secret=$2 WHERE id=$1`,[u.user.id,secret]));
  assert.equal(result.error?.code,'MFA_EXPIRED');
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id=$1`,[u.user.id])).rows[0].n,before);
});

test('malformed JWT JSON is rejected as authentication failure instead of a server error',async()=>{
  const stranger=new Client(h.base);
  stranger.token='bnVsbA.e30.AA'; // JSON null is syntactically valid, but is not a JWT header.
  assert.equal((await stranger.get('/api/users/me')).status,401);
  assert.equal((await stranger.post('/api/auth/mfa',{ticket:stranger.token,code:'123456'})).status,401);
});

test('MFA completion cannot issue a session after that authenticator was removed',async()=>{
  const u=await new Client(h.base).register('auth_factor_mfa');
  const setup=await auth.beginTotpSetup(u.user.id);await auth.enableTotp(u.user.id,code(setup.secret));
  const login=await auth.login(u.user.email,'password123',clientInfo);assert.equal(login.kind,'mfa');
  if(login.kind!=='mfa')throw new Error('Missing challenge');
  const result=await changeWhileAuthenticating(u.user.id,()=>auth.completeMfa(login.ticket,code(setup.secret),clientInfo),
    db=>db.query(`UPDATE users SET totp_enabled=false,totp_secret=NULL WHERE id=$1`,[u.user.id]));
  assert.equal(result.error?.code,'MFA_EXPIRED');
});

test('MFA tickets are bound to their authenticator and expire after it is replaced',async()=>{
  const u=await new Client(h.base).register('auth_factor_ticket');
  const first=await auth.beginTotpSetup(u.user.id);await auth.enableTotp(u.user.id,code(first.secret));
  const login=await auth.login(u.user.email,'password123',clientInfo);assert.equal(login.kind,'mfa');
  if(login.kind!=='mfa')throw new Error('Missing challenge');
  await auth.disableTotp(u.user.id,'password123',code(first.secret));
  const second=await auth.beginTotpSetup(u.user.id);await auth.enableTotp(u.user.id,code(second.secret));
  await assert.rejects(auth.completeMfa(login.ticket,code(second.secret),clientInfo),{code:'MFA_EXPIRED'});
});

test('old setup cannot replace an already enabled authenticator',async()=>{
  const u=await new Client(h.base).register('auth_factor_replace');
  const setup=await auth.beginTotpSetup(u.user.id);
  const pending=await redis.get(`totp-setup:${u.user.id}`);
  await auth.enableTotp(u.user.id,code(setup.secret));
  // A setup response from a concurrent tab may finish after enable consumed it.
  await redis.set(`totp-setup:${u.user.id}`,pending!,'EX',600);
  await assert.rejects(auth.enableTotp(u.user.id,code(setup.secret)),{code:'TOTP_ENABLED'});
});

test('unverified signup cannot lock the email owner out with a preconfigured authenticator',async()=>{
  const u=new Client(h.base);
  const signup=await u.post('/api/auth/register',{username:'auth_unverified_factor',email:'auth_unverified_factor@example.com',password:'password123'});
  assert.equal(signup.status,201);u.token=signup.body.accessToken;u.user=signup.body.user;
  assert.equal((await u.post('/api/auth/2fa/setup')).status,403);
  assert.equal((await u.post('/api/auth/2fa/enable',{code:'123456'})).body.error.code,'EMAIL_UNVERIFIED');
  assert.equal((await pool.query(`SELECT totp_enabled FROM users WHERE id=$1`,[u.user.id])).rows[0].totp_enabled,false);
  // The mailbox owner can recover the unverified registration without an attacker's 2FA.
  const token='auth-owner-recovery-token-0123456789';
  await pool.query(`INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
    [u.user.id,createHash('sha256').update(token).digest('hex')]);
  await auth.confirmPasswordReset(token,'ownerpassword123');
  assert.equal((await auth.login(u.user.email,'ownerpassword123',clientInfo)).kind,'ok');
  const setup=await auth.beginTotpSetup(u.user.id);await auth.enableTotp(u.user.id,code(setup.secret));
});

test('password changes invalidate pending authenticator setup',async()=>{
  const u=await new Client(h.base).register('auth_factor_setup');
  const setup=await auth.beginTotpSetup(u.user.id);
  await auth.changePassword(u.user.id,u.cookies.get('cc_refresh')!.split('.')[0]!,'password123','newpassword123');
  await assert.rejects(auth.enableTotp(u.user.id,code(setup.secret)),{code:'TOTP_SETUP_EXPIRED'});
  assert.equal((await pool.query(`SELECT totp_enabled FROM users WHERE id=$1`,[u.user.id])).rows[0].totp_enabled,false);
});

test('stale disable cannot remove a replacement authenticator',async()=>{
  const u=await new Client(h.base).register('auth_factor_disable');
  const setup=await auth.beginTotpSetup(u.user.id);await auth.enableTotp(u.user.id,code(setup.secret));
  const replacement=generateTotpSecret();
  const result=await changeWhileAuthenticating(u.user.id,()=>auth.disableTotp(u.user.id,'password123',code(setup.secret)),
    db=>db.query(`UPDATE users SET totp_secret=$2 WHERE id=$1`,[u.user.id,replacement]));
  assert.equal(result.error?.code,'AUTH_CHANGED');
  const row=(await pool.query(`SELECT totp_enabled,totp_secret FROM users WHERE id=$1`,[u.user.id])).rows[0];
  assert.deepEqual(row,{totp_enabled:true,totp_secret:replacement});
});

test('password change in an already revoked family cannot modify credentials',async()=>{
  const u=await new Client(h.base).register('auth_family_revoked');
  const sid=u.cookies.get('cc_refresh')!.split('.')[0]!;
  await auth.logout(sid);
  await assert.rejects(auth.changePassword(u.user.id,sid,'password123','newpassword123'),{code:'SESSION_EXPIRED'});
  assert.equal((await auth.login(u.user.email,'password123',clientInfo)).kind,'ok');
});

test('password reset request and confirmation cannot deadlock on their user and token rows',async()=>{
  const u=await new Client(h.base).register('auth_reset_lock_order');
  const token='auth-audit-known-reset-token-0123456789';
  await pool.query(`INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,
    [u.user.id,createHash('sha256').update(token).digest('hex')]);
  const barrier=await pool.connect();
  let requested:ReturnType<typeof capture<void>>|undefined;
  let confirmed:ReturnType<typeof capture<void>>|undefined;
  try{
    await barrier.query('BEGIN');await barrier.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`,[u.user.id]);
    requested=capture(auth.requestPasswordReset(u.user.email));await waitForBlocked(1);
    confirmed=capture(auth.confirmPasswordReset(token,'replacementpassword123'));await waitForBlocked(2);
    await barrier.query('COMMIT');
    assert.equal((await requested).error,null,'sending the newer reset link completes');
    assert.equal((await confirmed).error?.code,'RESET_INVALID','the older link is invalidated without a database deadlock');
  }finally{
    await barrier.query('ROLLBACK');barrier.release();await Promise.all([requested,confirmed]);
  }
});

test('revocation remains effective when Redis loses its session rejection keys',async()=>{
  const u=await new Client(h.base).register('auth_revoke_durable');
  const access=u.token!;
  // A rotated access token is accepted while a sibling refresh session is active.
  await auth.refresh(u.cookies.get('cc_refresh')!,clientInfo);
  assert.equal((await u.get('/api/users/me')).status,200);
  await auth.logout(u.cookies.get('cc_refresh')!.split('.')[0]!);
  const sessions=await pool.query(`SELECT id FROM sessions WHERE user_id=$1`,[u.user.id]);
  await redis.del(...sessions.rows.map(s=>`revoked-sid:${s.id}`));
  u.token=access;
  assert.equal((await u.get('/api/users/me')).status,401,'durable database revocation survives cache loss');
});

test('access claims require an existing owned session and reject malformed UUIDs without server errors',async()=>{
  const owner=await new Client(h.base).register('auth_session_owner');
  const other=await new Client(h.base).register('auth_session_other');
  const sid=owner.cookies.get('cc_refresh')!.split('.')[0]!;
  const stranger=new Client(h.base);
  for(const claims of [
    {sub:owner.user.id,sid:'not-a-uuid'},
    {sub:'not-a-uuid',sid},
    {sub:owner.user.id,sid:'00000000-0000-0000-0000-000000000000'},
    {sub:other.user.id,sid},
  ]){
    stranger.token=signJwt({...claims,typ:'access'},config.JWT_SECRET,60);
    assert.equal((await stranger.get('/api/users/me')).status,401);
  }
});

test('refresh reuse revokes descendants created by a concurrent rotation',async()=>{
  const u=await new Client(h.base).register('auth_family_reuse');
  const old=u.cookies.get('cc_refresh')!;
  const current=await auth.refresh(old,clientInfo);
  await pool.query(`UPDATE sessions SET rotated_at=now()-interval '1 minute' WHERE id=$1`,[old.split('.')[0]]);
  // Pause session updates before they acquire row locks. A refresh that escapes
  // the family lock can insert its descendant here, after reuse captured old IDs.
  const barrier=await pool.connect();
  let reused:ReturnType<typeof capture<auth.SessionTokens>>|undefined;
  let rotated:ReturnType<typeof capture<auth.SessionTokens>>|undefined;
  try{
    await pool.query(`CREATE FUNCTION auth_audit_pause_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock_shared(7260272602); RETURN NULL; END $$`);
    await pool.query(`CREATE TRIGGER auth_audit_pause_update BEFORE UPDATE ON sessions
      FOR EACH STATEMENT EXECUTE FUNCTION auth_audit_pause_update()`);
    await barrier.query('BEGIN');await barrier.query(`SELECT pg_advisory_xact_lock(7260272602)`);
    reused=capture(auth.refresh(old,clientInfo));await waitForBlocked(1);
    rotated=capture(auth.refresh(current.refreshToken,clientInfo));await waitForBlocked(2);
    await barrier.query('COMMIT');
    assert.equal((await reused).error?.code,'SESSION_EXPIRED');
    await rotated;
    const active=await pool.query(`SELECT id FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`,[u.user.id]);
    assert.equal(active.rowCount,0,'no concurrent refresh descendant survives reuse detection');
  }finally{
    await barrier.query('ROLLBACK');barrier.release();await Promise.all([reused,rotated]);
    await pool.query(`DROP TRIGGER IF EXISTS auth_audit_pause_update ON sessions`);
    await pool.query(`DROP FUNCTION IF EXISTS auth_audit_pause_update()`);
  }
});
