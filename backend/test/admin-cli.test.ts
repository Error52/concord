import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {startServer,Client,type Harness} from './helpers.js';
import {pool} from '../src/db/pool.js';
import {config} from '../src/config.js';

const run=promisify(execFile);
let h:Harness,sequence=0;
before(async()=>{h=await startServer();config.BOOTSTRAP_FIRST_ADMIN=false;});
after(async()=>{await h.close();});
async function account(){return new Client(h.base).register(`local_admin_${++sequence}`);}
async function cli(email:string,...args:string[]){
 try {const result=await run(process.execPath,['--import','tsx','src/db/admin-cli.ts',email,...args],{env:process.env,timeout:15_000});return {code:0,...result};}
 catch(err:any){return {code:err.code,stdout:err.stdout as string,stderr:err.stderr as string};}
}

test('local admin bootstrap grants the selected account and records the deliberate operation',async()=>{
 const user=await account();const result=await cli(user.user.email.toUpperCase());assert.equal(result.code,0,result.stderr);
 const {rows}=await pool.query(`SELECT is_platform_admin FROM users WHERE id=$1`,[user.user.id]);assert.equal(rows[0].is_platform_admin,true);
 const audit=await pool.query(`SELECT action,actor_id,meta FROM platform_audit_log WHERE target_id=$1`,[user.user.id]);
 assert.equal(audit.rows.length,1);assert.equal(audit.rows[0].action,'admin.grant');assert.equal(audit.rows[0].actor_id,null);assert.equal(audit.rows[0].meta.source,'local-cli');
});

test('local CLI cannot revoke the last administrator',async()=>{
 const user=await account();await pool.query(`UPDATE users SET is_platform_admin=(id=$1)`,[user.user.id]);
 const result=await cli(user.user.email,'--revoke');assert.equal(result.code,1);assert.match(result.stderr,/последнего администратора/);
 assert.equal((await pool.query(`SELECT is_platform_admin FROM users WHERE id=$1`,[user.user.id])).rows[0].is_platform_admin,true);
});

test('concurrent CLI revocations preserve one administrator',async()=>{
 const a=await account(),b=await account();await pool.query(`UPDATE users SET is_platform_admin=(id=ANY($1::uuid[]))`,[[a.user.id,b.user.id]]);
 const results=await Promise.all([cli(a.user.email,'--revoke'),cli(b.user.email,'--revoke')]);
 assert.deepEqual(results.map(r=>r.code).sort(),[0,1]);
 assert.equal((await pool.query(`SELECT count(*)::int n FROM users WHERE is_platform_admin`)).rows[0].n,1);
});
