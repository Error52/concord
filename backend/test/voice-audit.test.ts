import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, connectGateway, sleep, startServer, type Harness } from './helpers.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { redis } from '../src/redis.js';
import { disconnectRevokedSessions, handleWebhook, leaveClient, markJoined, markLeft, myState, roomName } from '../src/services/voiceService.js';
import { decline, end, ring } from '../src/services/callService.js';
import { reconcileVoice } from '../src/jobs.js';
import { verifyJwt } from '../src/auth/jwt.js';

let h:Harness;
let serial=0;
before(async()=>{h=await startServer();});
after(async()=>{await h.close();});

async function pair(){
  const id=++serial;
  const a=await new Client(h.base).register(`voice_audit_a${id}`),b=await new Client(h.base).register(`voice_audit_b${id}`);
  const dm=(await a.post('/api/dm',{recipientId:b.user.id})).body.id as string;
  return {a,b,dm};
}

async function fakeSfu(fn:(rooms:Map<string,{sid:string;participants:{identity:string;sid:string;metadata?:string}[]}>,failure:{status:number})=>Promise<void>){
  const rooms=new Map<string,{sid:string;participants:{identity:string;sid:string;metadata?:string}[]}>();
  const failure={status:0};
  const fake=createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw),method=req.url!.split('/').at(-1)!;
    res.setHeader('Content-Type','application/json');
    if(failure.status){res.statusCode=failure.status;res.end('{}');return;}
    if(method==='ListRooms'){res.end(JSON.stringify({rooms:[...rooms].map(([name,r])=>({name,sid:r.sid}))}));return;}
    if(method==='ListParticipants'){
      const room=rooms.get(body.room);
      if(!room){res.statusCode=404;res.end(JSON.stringify({code:'not_found'}));return;}
      res.end(JSON.stringify({participants:room.participants}));return;
    }
    if(method==='RemoveParticipant'){
      const room=rooms.get(body.room);if(room)room.participants=room.participants.filter(p=>p.identity!==body.identity);
    }
    res.end('{}');
  });
  await new Promise<void>(resolve=>fake.listen(0,'127.0.0.1',resolve));
  const previous=config.LIVEKIT_URL;
  config.LIVEKIT_URL=`http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  try{await fn(rooms,failure);}finally{config.LIVEKIT_URL=previous;await new Promise<void>(resolve=>fake.close(()=>resolve()));}
}

test('old participant_left and room_finished cannot erase a full reconnect to the same room',async()=>{
  const {a,dm}=await pair(),name=roomName(dm);
  await fakeSfu(async rooms=>{
    rooms.set(name,{sid:'RM_old',participants:[{identity:a.user.id,sid:'PA_old'}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_old'},participant:{identity:a.user.id,sid:'PA_old'}});
    rooms.set(name,{sid:'RM_new',participants:[{identity:a.user.id,sid:'PA_new'}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_new'},participant:{identity:a.user.id,sid:'PA_new'}});
    const joinedAt=(await myState(a.user.id))!.joinedAt;
    await handleWebhook({event:'participant_left',room:{name,sid:'RM_old'},participant:{identity:a.user.id,sid:'PA_old'}});
    await handleWebhook({event:'room_finished',room:{name,sid:'RM_old'}});
    assert.equal((await myState(a.user.id))!.joinedAt,joinedAt);
    assert.equal(await redis.sismember(`voice:room:${dm}`,a.user.id),1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM voice_participants WHERE user_id=$1 AND left_at IS NULL`,[a.user.id])).rows[0].n,1);
    rooms.delete(name);
    await handleWebhook({event:'participant_left',room:{name,sid:'RM_new'},participant:{identity:a.user.id,sid:'PA_new'}});
    assert.equal(await myState(a.user.id),null,'a genuinely departed participant in a deleted room is removed');
  });
});

test('a client reconnect announced before its webhook survives delayed departure and SFU outages',async()=>{
  const {a,dm}=await pair(),name=roomName(dm);
  await fakeSfu(async(rooms,failure)=>{
    await markJoined(a.user.id,dm);
    rooms.set(name,{sid:'RM_live',participants:[{identity:a.user.id,sid:'PA_live'}]});
    await handleWebhook({event:'participant_left',room:{name,sid:'RM_old'},participant:{identity:a.user.id,sid:'PA_old'}});
    assert.equal((await myState(a.user.id))?.channelId,dm);
    failure.status=503;
    await handleWebhook({event:'participant_left',room:{name,sid:'RM_live'},participant:{identity:a.user.id,sid:'PA_live'}});
    await handleWebhook({event:'room_finished',room:{name,sid:'RM_old'}});
    assert.equal((await myState(a.user.id))?.channelId,dm,'SFU errors must not erase occupancy');
    failure.status=0;rooms.delete(name);
    await handleWebhook({event:'room_finished',room:{name,sid:'RM_live'}});
    assert.equal(await myState(a.user.id),null);
  });
});

test('a delayed old participant_joined cannot resurrect a previously left room',async()=>{
  const {a,b,dm}=await pair(),name=roomName(dm);
  const c=await new Client(h.base).register(`voice_audit_c${++serial}`);
  const other=(await a.post('/api/dm',{recipientId:c.user.id})).body.id;
  await fakeSfu(async rooms=>{
    rooms.set(name,{sid:'RM_old',participants:[]});
    await markJoined(a.user.id,other);
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_old'},participant:{identity:a.user.id,sid:'PA_old'}});
    assert.equal((await myState(a.user.id))?.channelId,other);
    assert.equal(await redis.sismember(`voice:room:${dm}`,a.user.id),0);
    await markLeft(a.user.id,other);
  });
});

test('two gateway devices cannot overwrite or leave the newer SFU incarnation',async()=>{
  const {a,dm}=await pair(),name=roomName(dm);
  const old=await connectGateway(h.base,a.token!),current=await connectGateway(h.base,a.token!);
  const sync=async(gw:typeof old)=>{gw.send('heartbeat',{});await gw.waitFor('heartbeat:ack');};
  try{await fakeSfu(async rooms=>{
    rooms.set(name,{sid:'RM_devices',participants:[{identity:a.user.id,sid:'PA_old_device'}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_devices'},participant:{identity:a.user.id,sid:'PA_old_device'}});
    rooms.set(name,{sid:'RM_devices',participants:[{identity:a.user.id,sid:'PA_current_device'}]});
    current.send('voice:state',{channelId:dm,participantSid:'PA_current_device',selfMute:false});await sync(current);
    old.send('voice:state',{channelId:null,expectedChannelId:dm,participantSid:'PA_old_device'});await sync(old);
    old.send('voice:state',{channelId:dm,participantSid:'PA_old_device',selfMute:true});await sync(old);
    assert.equal((await myState(a.user.id))?.selfMute,false);
    old.send('voice:state',{channelId:null});await sync(old);
    assert.equal((await myState(a.user.id))?.channelId,dm,'legacy stale leave cannot erase a live SFU participant');
    current.send('voice:state',{channelId:dm,participantSid:'PA_current_device',selfMute:true});await sync(current);
    assert.equal((await myState(a.user.id))?.selfMute,true);
    const c=await new Client(h.base).register(`voice_audit_device_c${++serial}`);
    const other=(await a.post('/api/dm',{recipientId:c.user.id})).body.id as string;
    rooms.delete(name);rooms.set(roomName(other),{sid:'RM_other',participants:[{identity:a.user.id,sid:'PA_other'}]});
    current.send('voice:state',{channelId:other,participantSid:'PA_other',selfMute:false});await sync(current);
    old.send('voice:state',{channelId:null,expectedChannelId:dm,participantSid:'PA_current_device'});await sync(old);
    old.send('voice:state',{channelId:dm,participantSid:'PA_current_device',selfMute:true});await sync(old);
    assert.equal((await myState(a.user.id))?.channelId,other);assert.equal((await myState(a.user.id))?.selfMute,false);
    rooms.delete(roomName(other));await leaveClient(a.user.id,other,'PA_other');assert.equal(await myState(a.user.id),null);
  });}finally{old.close();current.close();}
});

test('reconciliation retains current participant SIDs when the join webhook was missed',async()=>{
  const {a,dm}=await pair(),name=roomName(dm);
  await fakeSfu(async rooms=>{
    rooms.set(name,{sid:'RM_reconcile',participants:[{identity:a.user.id,sid:'PA_before'}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_reconcile'},participant:{identity:a.user.id,sid:'PA_before'}});
    rooms.set(name,{sid:'RM_reconcile',participants:[{identity:a.user.id,sid:'PA_after'}]});
    await reconcileVoice();
    assert.equal(JSON.parse((await redis.get(`voice:instance:${a.user.id}`))!).participantSid,'PA_after');
    rooms.delete(name);
    await handleWebhook({event:'participant_left',room:{name,sid:'RM_reconcile'},participant:{identity:a.user.id,sid:'PA_after'}});
    assert.equal(await myState(a.user.id),null,'the real departure is accepted after reconciling its new SID');
  });
});

test('voice grants bind to the login family, survive rotation and disconnect on real HTTP logout',async()=>{
  const {a,dm}=await pair(),name=roomName(dm);
  const grant=await a.post(`/api/voice/${dm}/token`);assert.equal(grant.status,200);
  const claims=verifyJwt<any>(grant.body.token,config.LIVEKIT_API_SECRET)!,metadata=claims.metadata as string;
  const sessionId=JSON.parse(metadata).sessionId;
  assert.equal(sessionId,verifyJwt<any>(a.token!,config.JWT_SECRET)!.sid);
  await fakeSfu(async rooms=>{
    rooms.set(name,{sid:'RM_bound',participants:[{identity:a.user.id,sid:'PA_bound',metadata}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_bound'},participant:{identity:a.user.id,sid:'PA_bound',metadata}});
    const rotated=await a.post('/api/auth/refresh');assert.equal(rotated.status,200);a.token=rotated.body.accessToken;
    await reconcileVoice();assert.equal((await myState(a.user.id))?.channelId,dm,'rotation retains the active media family');
    assert.equal((await a.post('/api/auth/logout')).status,204);
    assert.equal(rooms.get(name)!.participants.length,0,'logout removes its live SFU participant');
    assert.equal(await myState(a.user.id),null);
  });
});

test('revoking an older device preserves the current participant from a different login family',async()=>{
  const {a,dm}=await pair(),name=roomName(dm);
  const first=(await a.post(`/api/voice/${dm}/token`)).body;
  const oldMetadata=verifyJwt<any>(first.token,config.LIVEKIT_API_SECRET)!.metadata as string;
  const oldSessionId=JSON.parse(oldMetadata).sessionId as string;
  const device=new Client(h.base),login=await device.post('/api/auth/login',{email:a.user.email,password:'password123'});
  assert.equal(login.status,200);device.token=login.body.accessToken;device.user=login.body.user;
  const second=(await device.post(`/api/voice/${dm}/token`)).body;
  const metadata=verifyJwt<any>(second.token,config.LIVEKIT_API_SECRET)!.metadata as string;
  assert.notEqual(JSON.parse(metadata).sessionId,oldSessionId);
  await fakeSfu(async rooms=>{
    rooms.set(name,{sid:'RM_other_family',participants:[{identity:a.user.id,sid:'PA_other_family',metadata}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_other_family'},participant:{identity:a.user.id,sid:'PA_other_family',metadata}});
    assert.equal((await a.post('/api/auth/logout')).status,204);
    await disconnectRevokedSessions([oldSessionId]);
    assert.equal(rooms.get(name)!.participants[0]?.sid,'PA_other_family');
    assert.equal((await myState(a.user.id))?.channelId,dm);
    assert.equal((await device.get('/api/users/me')).status,200);
    rooms.delete(name);await leaveClient(a.user.id,dm,'PA_other_family');
  });
});

test('revoked and foreign media sessions are rejected by webhooks/reconciliation while legacy grants remain compatible',async()=>{
  const {a,b,dm}=await pair(),name=roomName(dm);
  const grant=(await a.post(`/api/voice/${dm}/token`)).body;
  const metadata=verifyJwt<any>(grant.token,config.LIVEKIT_API_SECRET)!.metadata as string;
  const foreignSid=verifyJwt<any>(b.token!,config.JWT_SECRET)!.sid as string;
  assert.equal((await a.post('/api/auth/logout')).status,204);
  await fakeSfu(async rooms=>{
    // This token reaches the SFU after logout, before any presence was recorded in Redis.
    rooms.set(name,{sid:'RM_late_bound',participants:[{identity:a.user.id,sid:'PA_late_bound',metadata}]});
    await reconcileVoice();assert.equal(rooms.get(name)!.participants.length,0);assert.equal(await myState(a.user.id),null);
    for(const badMetadata of [JSON.stringify({sessionId:foreignSid}),JSON.stringify({sessionId:'------------------------------------'}),'null']){
      rooms.set(name,{sid:'RM_bad_bound',participants:[{identity:a.user.id,sid:'PA_bad_bound',metadata:badMetadata}]});
      await handleWebhook({event:'participant_joined',room:{name,sid:'RM_bad_bound'},participant:{identity:a.user.id,sid:'PA_bad_bound',metadata:badMetadata}});
      assert.equal(rooms.get(name)!.participants.length,0);assert.equal(await myState(a.user.id),null);
    }
    const legacy=JSON.stringify({username:a.user.username,avatarUrl:null});
    rooms.set(name,{sid:'RM_legacy',participants:[{identity:a.user.id,sid:'PA_legacy',metadata:legacy}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_legacy'},participant:{identity:a.user.id,sid:'PA_legacy',metadata:legacy}});
    assert.equal((await myState(a.user.id))?.channelId,dm);
    rooms.delete(name);await leaveClient(a.user.id,dm,'PA_legacy');
  });
});

test('legacy media is disconnected after the five-minute backend upgrade grace even if its SFU token was renewed',async(t)=>{
  const {a,dm}=await pair(),name=roomName(dm),metadata=JSON.stringify({username:a.user.username,avatarUrl:null});
  await fakeSfu(async rooms=>{
    rooms.set(name,{sid:'RM_grace',participants:[{identity:a.user.id,sid:'PA_grace',metadata}]});
    await handleWebhook({event:'participant_joined',room:{name,sid:'RM_grace'},participant:{identity:a.user.id,sid:'PA_grace',metadata}});
    assert.equal((await myState(a.user.id))?.channelId,dm);
    const later=Date.now()+10*60_000;t.mock.method(Date,'now',()=>later);
    try{
      await reconcileVoice();
      assert.equal(rooms.get(name)!.participants.length,0,'renewed legacy metadata does not restart the backend grace');
      assert.equal(await myState(a.user.id),null);
    }finally{t.mock.restoreAll();}
  });
});

test('last concurrent departure records one server-timed call and duplicate end operations are silent',async()=>{
  const {a,b,dm}=await pair();
  const ga=await connectGateway(h.base,a.token!);
  try{
    await end(dm,a.user.id,999999);
    await markJoined(a.user.id,dm);await markJoined(b.user.id,dm);
    await pool.query(`UPDATE voice_sessions SET started_at=now()-interval '12 seconds' WHERE channel_id=$1 AND ended_at IS NULL`,[dm]);
    await Promise.all([end(dm,a.user.id,999999),end(dm,b.user.id,999999)]);
    await Promise.all([markLeft(a.user.id,dm),markLeft(b.user.id,dm),markLeft(a.user.id,dm),markLeft(b.user.id,dm)]);
    await Promise.all(Array.from({length:5},()=>end(dm,a.user.id,999999)));
    await sleep(30);
    const rows=await pool.query(`SELECT content FROM messages WHERE channel_id=$1 AND kind='system' AND content LIKE 'call:%'`,[dm]);
    assert.equal(rows.rowCount,1);
    assert.match(rows.rows[0].content,/^call:ended:1[2-5]$/,'server session duration is used instead of an arbitrary client value');
    assert.equal(ga.events.filter(e=>e.t==='call:ended'&&e.d.channelId===dm).length,1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM voice_sessions WHERE channel_id=$1 AND call_logged_at IS NOT NULL`,[dm])).rows[0].n,1);
    // A subsequent real session has an independent durable claim.
    await markJoined(a.user.id,dm);await markJoined(b.user.id,dm);
    await markLeft(a.user.id,dm);await markLeft(b.user.id,dm);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM messages WHERE channel_id=$1 AND content LIKE 'call:ended:%'`,[dm])).rows[0].n,2);
  }finally{ga.close();}
});

test('declining or cancelling a ring records one missed call even when the caller then leaves',async()=>{
  for(const cancel of [false,true]){
    const {a,b,dm}=await pair();await markJoined(a.user.id,dm);await ring(dm,a.user.id,false);
    const pending=JSON.parse((await redis.get(`call:ring:${dm}`))!);
    if(cancel)await Promise.all([end(dm,a.user.id,4),end(dm,a.user.id,4)]);
    else await Promise.all([decline(dm,b.user.id,pending.id),decline(dm,b.user.id,pending.id)]);
    await markLeft(a.user.id,dm);await end(dm,a.user.id,4);
    const messages=await pool.query(`SELECT content FROM messages WHERE channel_id=$1 AND kind='system'`,[dm]);
    assert.deepEqual(messages.rows.map(r=>r.content),['call:missed']);
    const read=(await pool.query(`SELECT last_read_id,revision FROM read_states WHERE user_id=$1 AND channel_id=$2`,[a.user.id,dm])).rows[0];
    assert.equal(read.last_read_id,(await pool.query(`SELECT max(id)::text AS id FROM messages WHERE channel_id=$1`,[dm])).rows[0].id);
    assert.ok(BigInt(read.revision)>0n,'own call history advances the authoritative read state');
  }
});

test('an unanswered caller disappearing without call:end still clears the ring and records one missed call',async()=>{
  const {a,dm}=await pair();await markJoined(a.user.id,dm);await ring(dm,a.user.id,false);
  await Promise.all([markLeft(a.user.id,dm),markLeft(a.user.id,dm)]);
  assert.equal(await redis.get(`call:ring:${dm}`),null);
  assert.deepEqual((await pool.query(`SELECT content FROM messages WHERE channel_id=$1 AND kind='system'`,[dm])).rows.map(r=>r.content),['call:missed']);
});

test('an unanswered call still records one missed call after its ringing key expires',async()=>{
  const {a,dm}=await pair();
  // Visiting a DM voice room alone does not imply that another user was called.
  await markJoined(a.user.id,dm);await markLeft(a.user.id,dm);
  assert.equal((await pool.query(`SELECT 1 FROM messages WHERE channel_id=$1 AND kind='system'`,[dm])).rowCount,0);
  await markJoined(a.user.id,dm);await ring(dm,a.user.id,false);
  // Expiry and a Redis restart both remove this ephemeral signalling state.
  await redis.del(`call:ring:${dm}`);
  await Promise.all([markLeft(a.user.id,dm),markLeft(a.user.id,dm)]);
  await end(dm,a.user.id,90);
  assert.deepEqual((await pool.query(`SELECT content FROM messages WHERE channel_id=$1 AND kind='system'`,[dm])).rows.map(r=>r.content),['call:missed']);
});

test('a call answered through the DM sidebar is never falsely recorded as missed',async()=>{
  for(const cancel of [false,true]){
    const {a,b,dm}=await pair();await markJoined(a.user.id,dm);await ring(dm,a.user.id,false);
    const pending=JSON.parse((await redis.get(`call:ring:${dm}`))!);
    await markJoined(b.user.id,dm);
    if(cancel)await end(dm,a.user.id,3);else await decline(dm,b.user.id,pending.id);
    await markLeft(a.user.id,dm);await markLeft(b.user.id,dm);
    const messages=await pool.query(`SELECT content FROM messages WHERE channel_id=$1 AND kind='system'`,[dm]);
    assert.equal(messages.rowCount,1);assert.match(messages.rows[0].content,/^call:ended:/);
  }
});

test('voice moderation respects owner and role hierarchy while allowing moderator self-management',async()=>{
  const {a:owner,b:mod}=await pair();
  const created=(await owner.post('/api/servers',{name:'Voice hierarchy'})).body;
  const serverId=created.server.id,voice=created.channels.find((c:any)=>c.type==='voice');
  const invite=(await owner.post(`/api/servers/${serverId}/invites`)).body;
  assert.equal((await mod.post(`/api/invites/${invite.code}`)).status,200);
  const admin=await new Client(h.base).register(`voice_audit_admin${++serial}`);
  assert.equal((await admin.post(`/api/invites/${invite.code}`)).status,200);
  for(const [member,name] of [[mod,'Moderator'],[admin,'Admin']] as const){
    const role=created.roles.find((r:any)=>r.name===name);
    assert.equal((await owner.put(`/api/servers/${serverId}/members/${member.user.id}/roles`,{roleIds:[role.id]})).status,200);
  }
  await fakeSfu(async()=>{
    for(const target of [owner,admin]){
      assert.equal((await mod.patch(`/api/servers/${serverId}/voice/${target.user.id}`,{serverMute:true})).status,403);
      assert.equal((await mod.patch(`/api/servers/${serverId}/voice/${target.user.id}`,{channelId:voice.id})).status,403);
      assert.equal((await mod.del(`/api/servers/${serverId}/voice/${target.user.id}`)).status,403);
    }
    await markJoined(mod.user.id,voice.id);
    assert.equal((await mod.patch(`/api/servers/${serverId}/voice/${mod.user.id}`,{serverMute:true})).status,200);
    assert.equal((await mod.patch(`/api/servers/${serverId}/voice/${mod.user.id}`,{channelId:voice.id})).status,204);
    assert.equal((await mod.del(`/api/servers/${serverId}/voice/${mod.user.id}`)).status,204);
  });
});
