import {before,after,test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {Client,sleep,startServer,type Harness} from './helpers.js';
import {pool} from '../src/db/pool.js';
import {config} from '../src/config.js';
import {verifyJwt} from '../src/auth/jwt.js';
import {handleWebhook,myState,roomName} from '../src/services/voiceService.js';

let h:Harness,sequence=0;
before(async()=>{h=await startServer();});
after(async()=>{await h?.close();});

async function fixture(){
 const n=++sequence,a=await new Client(h.base).register(`media_order_a${n}`),b=await new Client(h.base).register(`media_order_b${n}`);
 const channelId=(await a.post('/api/dm',{recipientId:b.user.id})).body.id as string;
 const grant=await a.post(`/api/voice/${channelId}/token`);assert.equal(grant.status,200);
 const metadata=verifyJwt<any>(grant.body.token,config.LIVEKIT_API_SECRET)!.metadata as string;
 return {a,channelId,metadata,sessionId:JSON.parse(metadata).sessionId as string};
}

async function sqlBarrier(t:TestContext,matches:(sql:string,params:any[])=>boolean){
 const c=await pool.connect(),prototype=Object.getPrototypeOf(c),original=prototype.query;c.release();
 let paused=false,release!:()=>void,arrive!:()=>void;
 const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>arrive=r);
 const pause=async()=>{arrive();await gate;};
 t.mock.method(prototype,'query',function(this:any,...args:any[]){
  if(!paused&&typeof args[0]==='string'&&matches(args[0],args[1]??[])){
   paused=true;
   if(typeof args[2]==='function'){const callback=args[2];args[2]=(...result:any[])=>{void pause().then(()=>callback(...result));};return original.apply(this,args);}
   return original.apply(this,args).then(async(result:any)=>{await pause();return result;});
  }
  return original.apply(this,args);
 });
 return {release,waiting};
}

async function sfu(metadata:string,userId:string,channelId:string,fn:(present:()=>boolean)=>Promise<void>){
 let present=true;
 const server=createServer(async(req,res)=>{
  for await(const _chunk of req){};
  const method=req.url!.split('/').at(-1);res.setHeader('Content-Type','application/json');
  if(method==='RemoveParticipant')present=false;
  res.end(JSON.stringify(method==='ListParticipants'?{participants:present?[{identity:userId,sid:'PA_session_order',metadata}]:[]}:{}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const previous=config.LIVEKIT_URL;config.LIVEKIT_URL=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 try{await fn(()=>present);}finally{config.LIVEKIT_URL=previous;await new Promise<void>(r=>server.close(()=>r()));}
}

const bounded=(waiting:Promise<void>)=>Promise.race([waiting,sleep(2000).then(()=>{throw new Error('SQL barrier was not reached');})]);

test('logout waits for checked media admission and then removes its committed presence',async(t)=>{
 const {a,channelId,metadata,sessionId}=await fixture();
 await sfu(metadata,a.user.id,channelId,async present=>{
  const gate=await sqlBarrier(t,(sql,params)=>sql.includes('AND EXISTS(SELECT 1 FROM sessions active')&&params[0]===sessionId);
  const joining=handleWebhook({event:'participant_joined',room:{name:roomName(channelId)},participant:{identity:a.user.id,sid:'PA_session_order',metadata}});
  await bounded(gate.waiting);let loggedOut=false;
  const logout=a.post('/api/auth/logout').then(result=>{assert.equal(result.status,204);loggedOut=true;});
  try{await sleep(100);assert.equal(loggedOut,false,'logout cannot finish while an admitted join has not published its presence');}
  finally{gate.release();await Promise.all([joining,logout]);}
  assert.equal(await myState(a.user.id),null);assert.equal(present(),false);
 });
});

test('media admission waits for an in-flight logout and rejects the revoked family',async(t)=>{
 const {a,channelId,metadata}=await fixture();
 await sfu(metadata,a.user.id,channelId,async present=>{
  const gate=await sqlBarrier(t,sql=>sql.includes('UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE family_id='));
  const logout=a.post('/api/auth/logout');await bounded(gate.waiting);let joined=false;
  const joining=handleWebhook({event:'participant_joined',room:{name:roomName(channelId)},participant:{identity:a.user.id,sid:'PA_session_order',metadata}}).then(()=>{joined=true;});
  try{await sleep(100);assert.equal(joined,false,'media cannot publish state based on a family being revoked in another transaction');}
  finally{gate.release();const [result]=await Promise.all([logout,joining]);assert.equal(result.status,204);}
  assert.equal(await myState(a.user.id),null);assert.equal(present(),false);
 });
});
