import {before,after,test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,Client,sleep,type Harness} from './helpers.js';
import {pool} from '../src/db/pool.js';
import {storage} from '../src/storage/index.js';
import {redis} from '../src/redis.js';
import {BUS_CHANNEL} from '../src/websocket/bus.js';

let h:Harness,sequence=0;
before(async()=>{h=await startServer();});after(async()=>{await h.close();});

async function fixture(count:number,content='',attach=true){
  const u=await new Client(h.base).register(`attachment_audit_${++sequence}`);
  const full=(await u.post('/api/servers',{name:'Attachment audit'})).body;
  const channel=full.channels.find((c:any)=>c.type==='text');
  const files:{id:string;storage_key:string}[]=[];
  for(let i=0;i<count;i++){
    const uploaded=await u.req('POST',`/api/channels/${channel.id}/attachments`,Buffer.from(`Attachment probe ${i}`),{'X-File-Name':`probe-${i}.txt`});
    assert.equal(uploaded.status,201);
    files.push((await pool.query(`SELECT id,storage_key FROM attachments WHERE id=$1`,[uploaded.body.id])).rows[0]);
  }
  const message=attach?(await u.post(`/api/channels/${channel.id}/messages`,{content,attachmentIds:files.map(f=>f.id)})).body:null;
  return {u,channel,files,message};
}

function captureEvents(t:TestContext){
  const events:any[]=[],original=redis.publish.bind(redis);
  t.mock.method(redis,'publish',async(channel:string,value:string)=>{
    if(channel===BUS_CHANNEL){const event=JSON.parse(value);if(event.kind==='event')events.push(event);}
    return original(channel,value);
  });
  return events;
}

function pauseStorageDeletes(t:TestContext,keys:string[],hits:number){
  let release!:()=>void,arrive!:()=>void,count=0;
  const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>arrive=r);
  const original=storage.delete.bind(storage);
  t.mock.method(storage,'delete',async(key:string)=>{
    await original(key);
    if(keys.includes(key)){if(++count===hits)arrive();await gate;}
  });
  return {release,waiting};
}

async function awaitBarrier(waiting:Promise<void>){
  await Promise.race([waiting,sleep(5_000).then(()=>{throw new Error('Attachment operation did not reach the test barrier');})]);
}

async function pauseQuery(t:TestContext,predicate:(sql:string,params:any[])=>boolean){
  const c=await pool.connect(),prototype=Object.getPrototypeOf(c),original=prototype.query;c.release();
  let release!:()=>void,arrive!:()=>void,paused=false;
  const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>arrive=r);
  const pause=async()=>{paused=true;arrive();await gate;};
  t.mock.method(prototype,'query',function(this:any,...args:any[]){
    if(!paused&&typeof args[0]==='string'&&predicate(args[0],args[1]??[])){
      if(typeof args[2]==='function'){const callback=args[2];args[2]=(...results:any[])=>{void pause().then(()=>callback(...results));};return original.apply(this,args);}
      return original.apply(this,args).then(async(result:any)=>{await pause();return result;});
    }
    return original.apply(this,args);
  });
  return {release,waiting};
}

test('removing an attachment while its message is deleted completes without a null hydration error',async(t)=>{
  const {u,files,message}=await fixture(1,'Keep message content');
  const events=captureEvents(t),gate=pauseStorageDeletes(t,files.map(f=>f.storage_key),1);
  const removing=u.del(`/api/attachments/${files[0]!.id}`);
  try{
    await awaitBarrier(gate.waiting);
    assert.equal((await u.del(`/api/messages/${message.id}`)).status,204);
  }finally{gate.release();}
  assert.equal((await removing).status,204);
  assert.equal(events.filter(e=>e.t==='message:delete'&&e.d.id===message.id).length,1);
  assert.equal(events.filter(e=>e.t==='message:update'&&e.d.id===message.id).length,0);
});

test('concurrent removal of the last two attachments deletes an empty message exactly once',async(t)=>{
  const {u,files,message}=await fixture(2);
  const events=captureEvents(t),gate=pauseStorageDeletes(t,files.map(f=>f.storage_key),2);
  const removing=Promise.all(files.map(file=>u.del(`/api/attachments/${file.id}`)));
  try{await awaitBarrier(gate.waiting);}finally{gate.release();}
  assert.deepEqual((await removing).map(r=>r.status),[204,204]);
  assert.equal((await pool.query(`SELECT id FROM messages WHERE id=$1`,[message.id])).rowCount,0);
  assert.equal(events.filter(e=>e.t==='message:delete'&&e.d.id===message.id).length,1);
});

test('an upload linked to a message during removal cannot leave an empty message behind',async(t)=>{
  const {u,channel,files}=await fixture(1,'',false),file=files[0]!;
  const gate=await pauseQuery(t,(sql,params)=>/^SELECT \* FROM attachments WHERE id = \$1/.test(sql)&&params[0]===file.id);
  const events=captureEvents(t),removing=u.del(`/api/attachments/${file.id}`);
  let message:any;
  try{
    await awaitBarrier(gate.waiting);
    const sent=await u.post(`/api/channels/${channel.id}/messages`,{content:'',attachmentIds:[file.id]});
    assert.equal(sent.status,201);message=sent.body;
  }finally{gate.release();}
  assert.equal((await removing).status,204);
  assert.equal((await pool.query(`SELECT id FROM messages WHERE id=$1`,[message.id])).rowCount,0);
  assert.equal(events.filter(e=>e.t==='message:delete'&&e.d.id===message.id).length,1);
});

test('full message removal racing its last attachment publishes deletion only for the winner',async(t)=>{
  const {u,files,message}=await fixture(1);
  const events=captureEvents(t);
  const gate=await pauseQuery(t,(sql,params)=>sql.includes('FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = $1')&&params[0]===message.id);
  const removingMessage=u.del(`/api/messages/${message.id}`);
  try{
    await awaitBarrier(gate.waiting);
    assert.equal((await u.del(`/api/attachments/${files[0]!.id}`)).status,204);
  }finally{gate.release();}
  assert.equal((await removingMessage).status,204);
  assert.equal(events.filter(e=>e.t==='message:delete'&&e.d.id===message.id).length,1);
});
