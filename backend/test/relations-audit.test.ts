import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db/pool.js';
import { block, list, request } from '../src/services/friendService.js';
import { Client, connectGateway, sleep, startServer, type Harness } from './helpers.js';

let h:Harness;
before(async()=>{h=await startServer();});
after(async()=>{await h.close();});

test('a delayed relationship snapshot is published before a newer block snapshot',async(t)=>{
  const a=await new Client(h.base).register('relations_snapshot_a'),b=await new Client(h.base).register('relations_snapshot_b');
  const ga=await connectGateway(h.base,a.token!);
  const snapshots:any[][]=[];
  ga.ws.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame.t==='friend:update')snapshots.push(frame.d);});
  const client=await pool.connect(),prototype=Object.getPrototypeOf(client),original=prototype.query;client.release();
  let paused=false,release!:()=>void,arrived!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),waiting=new Promise<void>(resolve=>arrived=resolve);
  t.mock.method(prototype,'query',function(this:any,...args:any[]){
    const result=original.apply(this,args);
    if(!paused&&typeof args[0]==='string'&&/SELECT (?:'friend'|CASE WHEN user_a)/.test(args[0])&&args[1]?.[0]===a.user.id){
      paused=true;return result.then(async(row:any)=>{arrived();await gate;return row;});
    }
    return result;
  });
  const requesting=request(a.user.id,{userId:b.user.id});
  try{
    await Promise.race([waiting,sleep(2000).then(()=>{throw new Error('relationship snapshot did not reach the barrier');})]);
    const blocking=block(a.user.id,b.user.id);
    // Wait for the durable mutation; its newer publisher must wait behind the old snapshot.
    const deadline=Date.now()+2000;let committed=false;
    while(Date.now()<deadline){
      if((await pool.query(`SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2`,[a.user.id,b.user.id])).rowCount){committed=true;break;}
      await sleep(5);
    }
    assert.equal(committed,true,'the block commits independently of the snapshot publication lock');
    release();await Promise.all([requesting,blocking]);
    await ga.waitFor('friend:update',items=>items.some((r:any)=>r.id===b.user.id&&r.type==='blocked'));
    await sleep(20);
    assert.deepEqual(snapshots.map(rows=>rows.map(r=>r.type)),[['outgoing'],['blocked']],
      'an old request snapshot cannot be delivered after the newer blocked snapshot');
    assert.deepEqual((await list(a.user.id)).map(r=>r.type),['blocked']);
  }finally{release();await requesting.catch(()=>undefined);ga.close();}
});

test('snapshot hydration can use its checked-out transaction without exhausting the PostgreSQL pool',async()=>{
  const a=await new Client(h.base).register('relations_pool_a'),b=await new Client(h.base).register('relations_pool_b');
  await request(a.user.id,{userId:b.user.id});
  const clients=await Promise.all(Array.from({length:20},()=>pool.connect()));
  try{
    const results=await Promise.race([
      Promise.all(clients.map(db=>list(a.user.id,db))),
      sleep(2000).then(()=>{throw new Error('relationship hydration requested another PostgreSQL pool connection');}),
    ]);
    assert.ok(results.every(rows=>rows.length===1&&rows[0]!.type==='outgoing'));
  }finally{clients.forEach(db=>db.release());}
});
