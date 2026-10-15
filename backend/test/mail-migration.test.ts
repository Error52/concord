import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {pool} from '../src/db/pool.js';
import {assertTestDatabases} from './environment.js';
assertTestDatabases(process.env);
after(()=>pool.end());

test('mail validity migration preserves old token lifetimes and does not revive expired resets',async()=>{
 const client=await pool.connect(),user=randomUUID(),resetToken='old_reset_token_0123456789',verifyToken='old_verify_token_0123456789';
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
 try{
  await client.query('BEGIN');
  // Temp tables shadow public tables only for this connection; the entire fixture is rolled back.
  await client.query(`CREATE TEMP TABLE outbound_emails (user_id uuid,subject text,text_body text,created_at timestamptz);
    CREATE TEMP TABLE password_resets (user_id uuid,token_hash text,expires_at timestamptz);
    CREATE TEMP TABLE email_verifications (user_id uuid,token_hash text,expires_at timestamptz);`);
  await client.query(`INSERT INTO password_resets VALUES ($1,$2,now()-interval '1 hour')`,[user,hash(resetToken)]);
  await client.query(`INSERT INTO email_verifications VALUES ($1,$2,now()+interval '23 hours')`,[user,hash(verifyToken)]);
  await client.query(`INSERT INTO outbound_emails VALUES
    ($1,'Concord — восстановление пароля',$2,now()-interval '2 hours'),
    ($1,'Concord — подтвердите почту',$3,now()-interval '1 hour')`,[user,`http://localhost/reset-password?token=${resetToken}`,`http://localhost/verify-email?token=${verifyToken}`]);
  await client.query(await readFile(new URL('../migrations/004_mail_validity.sql',import.meta.url),'utf8'));
  const rows=(await client.query(`SELECT purpose,token_hash,expires_at>now() AS valid FROM outbound_emails ORDER BY purpose`)).rows;
  assert.deepEqual(rows.map(r=>({purpose:r.purpose,token_hash:r.token_hash,valid:r.valid})),[
    {purpose:'password-reset',token_hash:hash(resetToken),valid:false},
    {purpose:'verification',token_hash:hash(verifyToken),valid:true},
  ]);
 }finally{await client.query('ROLLBACK');client.release();}
});
