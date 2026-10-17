import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {startServer,Client,connectGateway,sleep,type Harness} from './helpers.js';
import {config,platformAdminEmails,validateMailConfiguration} from '../src/config.js';
import {pool} from '../src/db/pool.js';
import {redis} from '../src/redis.js';
import * as auth from '../src/services/authService.js';
import {normalizeRecoveryWord} from '../src/auth/accountReadiness.js';
import {verifyPassword} from '../src/auth/password.js';
import {base32Decode,generateTotpSecret,hotp} from '../src/auth/totp.js';
import {deliverPendingMail} from '../src/services/mailOutbox.js';

let h:Harness;
const original={ACCOUNT_VERIFICATION_MODE:config.ACCOUNT_VERIFICATION_MODE,BOOTSTRAP_FIRST_ADMIN:config.BOOTSTRAP_FIRST_ADMIN,DEMO_MAILBOX:config.DEMO_MAILBOX};
before(async()=>{config.ACCOUNT_VERIFICATION_MODE='secret-word';config.BOOTSTRAP_FIRST_ADMIN=false;config.DEMO_MAILBOX=false;h=await startServer();});
after(async()=>{Object.assign(config,original);await h.close();});
const word=(name:string)=>`фиолетовая космическая сова ${name}`;
const nextWord=(name:string)=>`янтарный космический кит ${name}`;
async function signup(name:string){
  const c=new Client(h.base),r=await c.post('/api/auth/register',{username:name,email:`${name}@example.com`,password:'password123',recoveryWord:word(name)});
  assert.equal(r.status,201);c.user=r.body.user;c.token=r.body.accessToken;return c;
}
const reset=(name:string,extra:Partial<auth.RecoveryWordReset>={})=>({identifier:name,recoveryWord:word(name),newPassword:'new-password-456',newRecoveryWord:nextWord(name),...extra});
const observe=<T>(p:Promise<T>)=>p.then(value=>({value,error:null}),error=>({value:null,error}));
const code=(secret:string)=>hotp(base32Decode(secret),Math.floor(Date.now()/30_000));

test('word mode publishes only options and admits new users without claiming email ownership or sending mail',async()=>{
  const options=await new Client(h.base).get('/api/auth/options');assert.equal(options.status,200);
  assert.deepEqual(options.body,{verificationMode:'secret-word',recoveryWordMinLength:8,recoveryWordMaxLength:256});
  const c=await signup('word_signup');
  assert.equal(c.user.accountReady,true);assert.equal(c.user.emailVerified,false);assert.equal(c.user.hasRecoveryWord,true);
  assert.equal(c.user.recoveryWordAllowed,true);assert.equal(c.user.emailVerificationRequired,false);assert.equal(c.user.demoMailbox,false);
  const row=(await pool.query(`SELECT email_verified_at,local_verified_at,recovery_word_hash,email_verified_via_smtp,is_platform_admin FROM users WHERE id=$1`,[c.user.id])).rows[0];
  assert.equal(row.email_verified_at,null);assert.ok(row.local_verified_at);assert.match(row.recovery_word_hash,/^scrypt\$/);
  assert.equal(await verifyPassword(normalizeRecoveryWord(word('word_signup')),row.recovery_word_hash),true);
  assert.equal(row.email_verified_via_smtp,false);assert.equal(row.is_platform_admin,false);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM outbound_emails WHERE user_id=$1`,[c.user.id])).rows[0].n,0);
  assert.equal(c.user.recovery_word_hash,undefined);
  assert.equal((await c.post('/api/servers',{name:'Word ready server'})).status,201);
});

test('signup rejects missing, short, oversized and password-equivalent words after normalization',async()=>{
  for(const [i,recoveryWord] of [undefined,'коротко','x'.repeat(257),'ＰＡＳＳＷＯＲＤ１２３４５６'].entries()){
    const r=await new Client(h.base).post('/api/auth/register',{username:`word_bad_${i}`,email:`word_bad_${i}@example.com`,password:i===3?'Password123456':'password123',recoveryWord});
    assert.equal(r.status,400);assert.ok(['RECOVERY_WORD_INVALID','RECOVERY_WORD_EQUALS_PASSWORD','VALIDATION'].includes(r.body.error.code));
  }
});

test('signup accepts eight normalized Cyrillic characters and rejects seven, including composed Unicode boundaries',async()=>{
  for(const [name,recoveryWord,expected] of [
    ['word_min_seven','крайний',400],['word_min_eight','радужный',201],
    ['word_nfkc_seven','  КРАИ\u0306НИЙ  ',400],['word_nfkc_eight','  РАДУЖНЫИ\u0306  ',201],
  ] as const){
    const c=new Client(h.base),r=await c.post('/api/auth/register',{username:name,email:`${name}@example.com`,password:'password123',recoveryWord});
    assert.equal(r.status,expected,name);
    if(expected===400)assert.equal(r.body.error.code,'RECOVERY_WORD_INVALID');
    else{
      const stored=(await pool.query(`SELECT recovery_word_hash FROM users WHERE id=$1`,[r.body.user.id])).rows[0].recovery_word_hash;
      assert.equal(await verifyPassword('радужный',stored),true);
    }
  }
});

test('authenticated changes accept eight normalized characters and refuse seven',async()=>{
  const name='word_setup_boundary',c=await signup(name);
  const short=await c.post('/api/auth/recovery-word',{currentPassword:'password123',oldRecoveryWord:word(name),recoveryWord:'краи\u0306ний'});
  assert.equal(short.status,400);assert.equal(short.body.error.code,'RECOVERY_WORD_INVALID');
  assert.equal((await c.post('/api/auth/recovery-word',{currentPassword:'password123',oldRecoveryWord:word(name),recoveryWord:' РАДУЖНЫИ\u0306 '})).status,200);
  const stored=(await pool.query(`SELECT recovery_word_hash FROM users WHERE id=$1`,[c.user.id])).rows[0].recovery_word_hash;
  assert.equal(await verifyPassword('радужный',stored),true);
});

test('recovery accepts an eight-character old word and rotates to a new eight-character word',async()=>{
  const name='word_reset_boundary',c=new Client(h.base);
  const signup=await c.post('/api/auth/register',{username:name,email:`${name}@example.com`,password:'password123',recoveryWord:'радужный'});
  assert.equal(signup.status,201);
  const short=await c.post('/api/auth/recovery-word/reset',reset(name,{recoveryWord:'  РАДУЖНЫИ\u0306 ',newRecoveryWord:'баскетб'}));
  assert.equal(short.status,400);assert.equal(short.body.error.code,'RECOVERY_WORD_INVALID');
  const valid=await c.post('/api/auth/recovery-word/reset',reset(name,{recoveryWord:' РАДУЖНЫИ\u0306 ',newRecoveryWord:'баскетбо'}));
  assert.equal(valid.status,200);
  const stored=(await pool.query(`SELECT recovery_word_hash FROM users WHERE id=$1`,[signup.body.user.id])).rows[0].recovery_word_hash;
  assert.equal(await verifyPassword('баскетбо',stored),true);
});

test('username or email login stays compatible and normalization is stable',async()=>{
  await signup('word_login');
  for(const payload of [{identifier:'WORD_LOGIN',password:'password123'},{identifier:' WORD_LOGIN@example.com ',password:'password123'},{email:'word_login@example.com',password:'password123'}])
    assert.equal((await new Client(h.base).post('/api/auth/login',payload)).status,200);
  assert.equal(normalizeRecoveryWord('  ФИОЛЕТОВАЯ　　КОСМИЧЕСКАЯ  СОВА  '),'фиолетовая космическая сова');
  assert.equal(normalizeRecoveryWord('ＳＴＲＡＳＳＥ  Σςß'),normalizeRecoveryWord('strasse σσss'));
});

test('local word readiness grants gateway, attachments and voice token access',async()=>{
  const c=await signup('word_features'),server=await c.post('/api/servers',{name:'Word features'});
  const text=server.body.channels.find((ch:any)=>ch.type==='text'),voice=server.body.channels.find((ch:any)=>ch.type==='voice');
  const gateway=await connectGateway(h.base,c.token!);assert.equal(gateway.ready.user.accountReady,true);gateway.close();
  const file=await c.req('POST',`/api/channels/${text.id}/attachments`,Buffer.from('%PDF-1.4\nfixture\n%%EOF'),{'X-File-Name':'fixture.pdf'});
  assert.equal(file.status,201);
  const message=await c.post(`/api/channels/${text.id}/messages`,{content:'word upload',attachmentIds:[file.body.id]});assert.equal(message.status,201);
  assert.equal((await c.get(file.body.url)).status,200);
  assert.equal((await c.post(`/api/voice/${voice.id}/token`)).status,200);
  assert.equal((await c.post('/api/auth/2fa/setup')).status,200);
});

test('word recovery atomically rotates both secrets, revokes sessions and invalidates old email links',async()=>{
  const name='word_reset',c=await signup(name),other=new Client(h.base);
  const login=await other.post('/api/auth/login',{identifier:name,password:'password123'});other.token=login.body.accessToken;
  const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
  await pool.query(`INSERT INTO password_resets(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[c.user.id,hash('old-password-reset-link')]);
  await pool.query(`INSERT INTO email_verifications(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '1 hour')`,[c.user.id,hash('old-verification-link')]);
  const r=await new Client(h.base).post('/api/auth/recovery-word/reset',reset(name,{recoveryWord:`  ${word(name).toUpperCase()}  `}));
  assert.equal(r.status,200);assert.deepEqual(r.body,{ok:true});
  assert.equal((await c.get('/api/users/me')).status,401);assert.equal((await other.post('/api/auth/refresh')).status,401);
  assert.equal((await new Client(h.base).post('/api/auth/login',{identifier:name,password:'password123'})).status,401);
  assert.equal((await new Client(h.base).post('/api/auth/login',{identifier:name,password:'new-password-456'})).status,200);
  await assert.rejects(auth.resetByRecoveryWord(reset(name)),{code:'RECOVERY_INVALID'});
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id=$1 AND revoked_at IS NULL`,[c.user.id])).rows[0].n,1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM password_resets WHERE user_id=$1 AND used_at IS NULL`,[c.user.id])).rows[0].n,0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM email_verifications WHERE user_id=$1 AND used_at IS NULL`,[c.user.id])).rows[0].n,0);
});

test('recovery requires a different new word and refuses password-word equality',async()=>{
  const name='word_rotation_rules';await signup(name);
  await assert.rejects(auth.resetByRecoveryWord(reset(name,{newRecoveryWord:word(name)})),{code:'RECOVERY_WORD_REUSED'});
  await assert.rejects(auth.resetByRecoveryWord(reset(name,{newRecoveryWord:'new-password-456'})),{code:'RECOVERY_WORD_EQUALS_PASSWORD'});
  await assert.rejects(auth.resetByRecoveryWord(reset(name,{newPassword:'password123'})),{code:'PASSWORD_REUSED'});
});

async function blockedQueries(n:number):Promise<void>{
  for(let i=0;i<400;i++){
    const row=await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`);
    if(row.rows[0].n>=n)return;await sleep(10);
  }
  throw new Error('Expected recovery transaction to reach the session lock barrier');
}

test('concurrent recovery attempts rotate credentials exactly once',async()=>{
  const name='word_parallel',c=await signup(name),barrier=await pool.connect();
  await barrier.query('BEGIN');await barrier.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,72601))`,[c.user.id]);
  let attempts:Array<ReturnType<typeof observe<void>>>=[];
  try{attempts=[observe(auth.resetByRecoveryWord(reset(name))),observe(auth.resetByRecoveryWord(reset(name,{newPassword:'different-new-password',newRecoveryWord:'другой новый длинный секрет'})))];await blockedQueries(2);}
  finally{await barrier.query('COMMIT');barrier.release();}
  const results=await Promise.all(attempts);
  assert.equal(results.filter(r=>r.error===null).length,1);assert.equal(results.filter(r=>r.error?.code==='RECOVERY_INVALID').length,1);
});

test('queued recovery cannot overwrite a user promoted to platform admin after verifying the word',async()=>{
  const name='word_promoted',c=await signup(name),barrier=await pool.connect();
  await barrier.query('BEGIN');await barrier.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,72601))`,[c.user.id]);
  let pending:ReturnType<typeof observe<void>>|undefined;
  try{pending=observe(auth.resetByRecoveryWord(reset(name)));await blockedQueries(1);await barrier.query(`UPDATE users SET is_platform_admin=true WHERE id=$1`,[c.user.id]);}
  finally{await barrier.query('COMMIT');barrier.release();}
  assert.equal((await pending!).error?.code,'RECOVERY_INVALID');
  assert.equal((await auth.login(name,'password123',{ip:'127.0.0.1',userAgent:'fixture'})).kind,'ok');
  assert.equal((await pool.query(`SELECT is_platform_admin FROM users WHERE id=$1`,[c.user.id])).rows[0].is_platform_admin,true);
});

test('queued authenticated word change cannot outlive its revoked session family',async()=>{
  const name='word_setup_revoke',c=await signup(name),barrier=await pool.connect();
  const sessionId=c.cookies.get('cc_refresh')!.split('.')[0]!;
  await barrier.query('BEGIN');await barrier.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,72601))`,[c.user.id]);
  let pending:ReturnType<typeof observe<void>>|undefined;
  try{pending=observe(auth.setRecoveryWord(c.user.id,sessionId,{currentPassword:'password123',oldRecoveryWord:word(name),recoveryWord:nextWord(name)}));await blockedQueries(1);await barrier.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1`,[c.user.id]);}
  finally{await barrier.query('COMMIT');barrier.release();}
  assert.equal((await pending!).error?.code,'SESSION_EXPIRED');
  const hash=(await pool.query(`SELECT recovery_word_hash FROM users WHERE id=$1`,[c.user.id])).rows[0].recovery_word_hash;
  assert.equal(await verifyPassword(normalizeRecoveryWord(word(name)),hash),true);
});

test('unknown users, absent words, wrong words and admins return the same generic recovery failure',async()=>{
  const a=await signup('word_wrong'),b=await signup('word_admin');
  await pool.query(`UPDATE users SET is_platform_admin=true,recovery_word_hash=NULL WHERE id=$1`,[b.user.id]);
  await pool.query(`UPDATE users SET recovery_word_hash=NULL WHERE id=$1`,[a.user.id]);
  const errors=await Promise.all(['word_unknown','word_wrong','word_admin'].map(name=>observe(auth.resetByRecoveryWord(reset(name)))));
  assert.ok(errors.every(r=>r.error?.code==='RECOVERY_INVALID'));
  assert.ok(errors.every(r=>r.error.message===errors[0]!.error.message));
});

test('account aliases share a hashed limiter and Redis failure cannot bypass throttling',async(t)=>{
  const name='word_rate',c=await signup(name);
  for(let i=0;i<5;i++)await assert.rejects(auth.resetByRecoveryWord(reset(name,{identifier:i%2?`${name}@example.com`:name,recoveryWord:'неверное ключевое слово'})),{code:'RECOVERY_INVALID'});
  await assert.rejects(auth.resetByRecoveryWord(reset(name)),{status:429});
  const keys=await redis.keys('rl:recovery-word-account:*');assert.ok(keys.every(key=>!key.includes(name)&&!key.includes('@')));
  t.mock.method(redis,'multi',()=>{throw new Error('Redis unavailable');});
  await assert.rejects(auth.resetByRecoveryWord(reset('word_new_unknown')),{status:503,code:'RATE_LIMIT_UNAVAILABLE'});
  assert.equal((await c.get('/api/users/me')).status,200);
});

test('word recovery preserves MFA and rejects missing, invalid or replayed TOTP codes',async()=>{
  const name='word_mfa',c=await signup(name),secret=generateTotpSecret();
  await pool.query(`UPDATE users SET totp_enabled=true,totp_secret=$2 WHERE id=$1`,[c.user.id,secret]);
  await assert.rejects(auth.resetByRecoveryWord(reset(name,{newPassword:'password123',newRecoveryWord:word(name)})),{code:'RECOVERY_INVALID'});
  const valid=code(secret),invalid=String((Number(valid)+1)%1_000_000).padStart(6,'0');
  await assert.rejects(auth.resetByRecoveryWord(reset(name,{totpCode:invalid,newRecoveryWord:word(name)})),{code:'RECOVERY_INVALID'});
  await auth.resetByRecoveryWord(reset(name,{totpCode:valid}));
  const login=await auth.login(name,'new-password-456',{ip:'127.0.0.1',userAgent:'fixture'});assert.equal(login.kind,'mfa');
  await assert.rejects(auth.resetByRecoveryWord(reset(name,{recoveryWord:nextWord(name),newPassword:'later-password-789',newRecoveryWord:'изумрудный ключ следующего поколения',totpCode:valid})),{code:'RECOVERY_INVALID'});
  const row=(await pool.query(`SELECT totp_enabled,totp_secret FROM users WHERE id=$1`,[c.user.id])).rows[0];assert.equal(row.totp_enabled,true);assert.equal(row.totp_secret,secret);
});

test('legacy pending users can set their first word; changes need the old word and preserve the current session',async()=>{
  config.ACCOUNT_VERIFICATION_MODE='email';
  const c=new Client(h.base),r=await c.post('/api/auth/register',{username:'word_legacy',email:'word_legacy@example.com',password:'password123'});
  c.user=r.body.user;c.token=r.body.accessToken;
  config.ACCOUNT_VERIFICATION_MODE='secret-word';
  assert.equal((await c.post('/api/servers',{name:'Blocked pending'})).status,403);
  const setup=await c.post('/api/auth/recovery-word',{currentPassword:'password123',recoveryWord:word('legacy')});assert.equal(setup.status,200);
  const refresh=await c.post('/api/auth/refresh');c.token=refresh.body.accessToken;
  const me=await c.get('/api/users/me');assert.equal(me.body.accountReady,true);assert.equal(me.body.emailVerified,false);
  assert.equal((await c.post('/api/auth/recovery-word',{currentPassword:'password123',recoveryWord:nextWord('legacy')})).body.error.code,'RECOVERY_WORD_INVALID');
  assert.equal((await c.post('/api/auth/recovery-word',{currentPassword:'password123',oldRecoveryWord:word('legacy'),recoveryWord:nextWord('legacy')})).status,200);
  assert.equal((await c.get('/api/users/me')).status,200);
});

test('admins remain usable without words and cannot set or reset by word',async()=>{
  const name='word_admin_preserve',c=await signup(name);
  await pool.query(`UPDATE users SET is_platform_admin=true,recovery_word_hash=NULL,email_verified_at=NULL,local_verified_at=NULL WHERE id=$1`,[c.user.id]);
  const login=await c.post('/api/auth/login',{identifier:name,password:'password123'});c.token=login.body.accessToken;
  assert.equal(login.body.user.accountReady,true);assert.equal(login.body.user.recoveryWordAllowed,false);
  assert.equal((await c.post('/api/auth/recovery-word',{currentPassword:'password123',recoveryWord:word(name)})).status,403);
  await assert.rejects(auth.resetByRecoveryWord(reset(name)),{code:'RECOVERY_INVALID'});
  assert.equal((await c.get('/api/admin/stats')).status,200);
  assert.equal((await pool.query(`SELECT is_platform_admin FROM users WHERE id=$1`,[c.user.id])).rows[0].is_platform_admin,true);
});

test('word mode disables email mutation routes, mail delivery and SMTP startup requirement',async()=>{
  const c=await signup('word_no_email');
  for(const path of ['/api/auth/email/resend','/api/auth/email/confirm','/api/auth/password/forgot','/api/auth/password/reset'])
    assert.equal((await c.post(path,{email:c.user.email,token:'old-unusable-token-0123456789',password:'password123'})).status,404);
  assert.equal((await c.get('/api/auth/email/demo')).status,404);
  assert.doesNotThrow(validateMailConfiguration);await deliverPendingMail();
});

test('operator recovery preserves roles and MFA, clears lost word, revokes sessions and records only safe audit metadata',async()=>{
  const name='word_operator_fixture',c=await signup(name),secret=generateTotpSecret();
  await pool.query(`UPDATE users SET is_platform_admin=true,totp_enabled=true,totp_secret=$2 WHERE id=$1`,[c.user.id,secret]);
  const result=await auth.operatorResetPassword({identifier:name,newPassword:'operator-fixture-new-password'});
  assert.equal(result.isPlatformAdmin,true);assert.ok(result.revokedSessions>0);
  assert.equal((await c.get('/api/users/me')).status,401);
  const row=(await pool.query(`SELECT is_platform_admin,totp_enabled,totp_secret,recovery_word_hash FROM users WHERE id=$1`,[c.user.id])).rows[0];
  assert.deepEqual(row,{is_platform_admin:true,totp_enabled:true,totp_secret:secret,recovery_word_hash:null});
  const audit=(await pool.query(`SELECT actor_id,meta FROM platform_audit_log WHERE action='account.operator_recovery' AND target_id=$1`,[c.user.id])).rows[0];
  assert.equal(audit.actor_id,null);assert.equal(JSON.stringify(audit.meta).includes('operator-fixture-new-password'),false);
  assert.equal((await auth.login(name,'operator-fixture-new-password',{ip:'127.0.0.1',userAgent:'fixture'})).kind,'mfa');
});

test('local verification cannot satisfy email mode or promote an allowlisted admin',async(t)=>{
  const emails=[...platformAdminEmails];t.after(()=>{platformAdminEmails.splice(0,platformAdminEmails.length,...emails);config.ACCOUNT_VERIFICATION_MODE='secret-word';});
  platformAdminEmails.push('word_not_email@example.com');
  const c=await signup('word_not_email');assert.equal(c.user.isPlatformAdmin,false);
  config.ACCOUNT_VERIFICATION_MODE='email';
  assert.equal((await c.post('/api/servers',{name:'Needs real mail'})).status,403);
  const me=await c.get('/api/users/me');assert.equal(me.body.accountReady,false);assert.equal(me.body.emailVerified,false);
});
