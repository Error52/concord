import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Client, type Harness } from './helpers.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import * as auth from '../src/services/authService.js';

let h:Harness;
before(async()=>{h=await startServer();});
after(async()=>{await h.close();});

test('public first registrations receive no platform admin and preserve deliberately assigned admins',async(t)=>{
  const previous=config.BOOTSTRAP_FIRST_ADMIN;config.BOOTSTRAP_FIRST_ADMIN=false;
  t.after(()=>{config.BOOTSTRAP_FIRST_ADMIN=previous;});
  const first=await Promise.all(['public_first','public_second'].map(name=>new Client(h.base).register(name)));
  assert.equal(first.filter(c=>c.user.isPlatformAdmin).length,0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`)).rows[0].n,0);
  await pool.query(`UPDATE users SET is_platform_admin=true WHERE id=$1`,[first[0]!.user.id]);
  const next=await new Client(h.base).register('public_later');
  assert.equal(next.user.isPlatformAdmin,false);
  const admins=(await pool.query(`SELECT id FROM users WHERE is_platform_admin`)).rows;
  assert.deepEqual(admins.map(r=>r.id),[first[0]!.user.id]);
});

test('seed verification does not bypass disabled first-admin policy',async(t)=>{
  const previous=config.BOOTSTRAP_FIRST_ADMIN;config.BOOTSTRAP_FIRST_ADMIN=false;
  t.after(()=>{config.BOOTSTRAP_FIRST_ADMIN=previous;});
  await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  const result=await auth.register({username:'public_seed',email:'public_seed@example.com',password:'password123'},
    {ip:'127.0.0.1',userAgent:'bootstrap test'},true);
  assert.equal(result.user.emailVerified,true);
  assert.equal(result.user.isPlatformAdmin,false);
});

test('explicit local bootstrap still grants exactly one admin under concurrent first registrations',async(t)=>{
  const previous=config.BOOTSTRAP_FIRST_ADMIN;config.BOOTSTRAP_FIRST_ADMIN=true;
  t.after(()=>{config.BOOTSTRAP_FIRST_ADMIN=previous;});
  await pool.query(`TRUNCATE users RESTART IDENTITY CASCADE`);
  const first=await Promise.all(['local_first','local_second'].map(name=>new Client(h.base).register(name)));
  assert.equal(first.filter(c=>c.user.isPlatformAdmin).length,1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`)).rows[0].n,1);
});
