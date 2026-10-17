import {test,before,after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,Client,sleep,connectGateway,type Harness} from './helpers.js';
import {pool} from '../src/db/pool.js';
import {Perm,has} from '../src/models/permissions.js';
import {getAccess} from '../src/services/permissionService.js';
import * as admins from '../src/services/adminService.js';
import * as friends from '../src/services/friendService.js';
import * as messages from '../src/services/messageService.js';
import * as servers from '../src/services/serverService.js';

let h:Harness,sequence=0;
before(async()=>{h=await startServer();});after(async()=>{await h.close();});
async function fixture(){
 const n=++sequence,owner=await new Client(h.base).register(`state_owner_${n}`),member=await new Client(h.base).register(`state_member_${n}`);
 const full=(await owner.post('/api/servers',{name:`State audit ${n}`})).body;
 const invite=(await owner.post(`/api/servers/${full.server.id}/invites`,{})).body;
 assert.equal((await member.post(`/api/invites/${invite.code}`)).status,200);
 return {owner,member,full,serverId:full.server.id,channel:full.channels.find((c:any)=>c.type==='text')};
}
/** Hold a completed SQL read without changing the shared production implementation. */
async function queryBarrier(t:TestContext,predicate:(sql:string,params:any[])=>boolean,hits=1){
 const c=await pool.connect(),prototype=Object.getPrototypeOf(c),original=prototype.query;c.release();
 let count=0,release!:()=>void,arrived!:()=>void;const gate=new Promise<void>(r=>release=r),waiting=new Promise<void>(r=>arrived=r);
 const pause=async()=>{if(++count===hits)arrived();await gate;};
 t.mock.method(prototype,'query',function(this:any,...args:any[]){
  if(count<hits&&typeof args[0]==='string'&&predicate(args[0],args[1]??[])){
   if(typeof args[2]==='function'){const callback=args[2];args[2]=(...results:any[])=>{void pause().then(()=>callback(...results));};return original.apply(this,args);}
   return original.apply(this,args).then(async(result:any)=>{await pause();return result;});
  }
  return original.apply(this,args);
 });
 return {release,waiting};
}

test('role assignment cannot grant an existing lower role with permissions the actor lacks',async()=>{
 const {owner,member,serverId}=await fixture();
 const low=(await owner.post(`/api/servers/${serverId}/roles`,{name:'Admin below manager',permissions:Perm.ADMINISTRATOR.toString()})).body;
 const manager=(await owner.post(`/api/servers/${serverId}/roles`,{name:'Role manager',permissions:Perm.MANAGE_ROLES.toString()})).body;
 assert.equal((await owner.put(`/api/servers/${serverId}/members/${member.user.id}/roles`,{roleIds:[manager.id]})).status,200);
 assert.equal(has((await getAccess(serverId,member.user.id))!.perms,Perm.ADMINISTRATOR),false);
 const escalation=await member.put(`/api/servers/${serverId}/members/${member.user.id}/roles`,{roleIds:[manager.id,low.id]});
 assert.equal(escalation.status,403);assert.equal(has((await getAccess(serverId,member.user.id))!.perms,Perm.ADMINISTRATOR),false);
});

test('unknown and overflowing role permission bits return validation errors instead of database failures',async()=>{
 const {owner,serverId}=await fixture();
 for(const permissions of ['99999999999999999999',(1n<<42n).toString()]){
  const result=await owner.post(`/api/servers/${serverId}/roles`,{name:'Invalid bits',permissions});assert.equal(result.status,400);
 }
});

test('concurrent platform admin removals preserve a final administrator',async(t)=>{
 const {owner,member}=await fixture();await pool.query(`UPDATE users SET is_platform_admin=false`);
 await pool.query(`UPDATE users SET is_platform_admin=true WHERE id=ANY($1::uuid[])`,[[owner.user.id,member.user.id]]);
 const gate=await queryBarrier(t,sql=>/SELECT count\(\*\)::int AS n FROM users WHERE is_platform_admin/.test(sql),2);
 const results=Promise.allSettled([admins.setPlatformAdmin(owner.user.id,member.user.id,false),admins.setPlatformAdmin(member.user.id,owner.user.id,false)]);
 try{await Promise.race([gate.waiting,sleep(150)]);}finally{gate.release();}
 await results;const count=await pool.query(`SELECT count(*)::int AS n FROM users WHERE is_platform_admin`);assert.equal(count.rows[0].n,1);
});

test('opposite simultaneous friend requests resolve to one friendship',async(t)=>{
 const {owner,member}=await fixture();
 const gate=await queryBarrier(t,sql=>/SELECT id FROM friend_requests WHERE from_id =/.test(sql),2);
 const requests=Promise.allSettled([friends.request(owner.user.id,{userId:member.user.id}),friends.request(member.user.id,{userId:owner.user.id})]);
 try{await Promise.race([gate.waiting,sleep(150)]);}finally{gate.release();}
 await requests;
 const both=await Promise.all([friends.list(owner.user.id),friends.list(member.user.id)]);
 assert.ok(both.every(items=>items.length===1&&items[0]!.type==='friend'));
});

test('blocking during a friend request cannot leave a pending request behind',async(t)=>{
 const {owner,member}=await fixture();const gate=await queryBarrier(t,(sql,params)=>/SELECT 1 FROM blocks/.test(sql)&&params.includes(member.user.id));
 const requesting=friends.request(owner.user.id,{userId:member.user.id}).then(()=>null,err=>err);await gate.waiting;
 const blocking=friends.block(member.user.id,owner.user.id);
 try{await Promise.race([blocking,sleep(150)]);}finally{gate.release();}
 await Promise.all([requesting,blocking]);assert.equal((await pool.query(`SELECT 1 FROM friend_requests WHERE (from_id=$1 AND to_id=$2) OR (from_id=$2 AND to_id=$1)`,[owner.user.id,member.user.id])).rowCount,0);
});

test('private attachment responses cannot be reused from the browser cache after logout',async()=>{
 const {member,channel}=await fixture();const file=await member.req('POST',`/api/channels/${channel.id}/attachments`,Buffer.from('private cache probe'),{'X-File-Name':'private.txt'});assert.equal(file.status,201);
 const response=await member.get(file.body.url);assert.equal(response.status,200);assert.match(response.headers.get('cache-control')??'',/no-store/);
});

test('read state revisions cover mentions, reads and intentional backwards markers',async()=>{
 const {owner,member,channel}=await fixture(),a=await connectGateway(h.base,owner.token!),b=await connectGateway(h.base,member.token!);
 try{
  const sent=await messages.create(channel.id,member.user.id,{content:`one <@${owner.user.id}>`,nonce:'read-version-one'});
  const mention=await a.waitFor('read:update',d=>d.channelId===channel.id&&d.mentionCount===1);assert.ok(BigInt(mention.revision)>0n);
  const author=await b.waitFor('read:update',d=>d.channelId===channel.id&&d.lastReadId===sent.id);assert.ok(author.revision);
  await messages.markRead(channel.id,owner.user.id,sent.id);const read=await a.waitFor('read:update',d=>d.lastReadId===sent.id&&d.mentionCount===0);assert.ok(BigInt(read.revision)>BigInt(mention.revision));
  await messages.markUnread(channel.id,owner.user.id,sent.id);const unread=await a.waitFor('read:update',d=>BigInt(d.lastReadId)<BigInt(sent.id)&&d.mentionCount===1);assert.ok(BigInt(unread.revision)>BigInt(read.revision));
  const snapshot=(await messages.readStates(owner.user.id)).find(r=>r.channelId===channel.id)!;assert.equal(snapshot.revision,unread.revision);
 }finally{a.close();b.close();}
});

test('an older mention committed after a newer read marker stays read',async(t)=>{
 const {owner,member,channel}=await fixture();const gate=await queryBarrier(t,(sql,params)=>/INSERT INTO messages/.test(sql)&&params.includes('late-mention'));
 const older=messages.create(channel.id,member.user.id,{content:`late <@${owner.user.id}>`,nonce:'late-mention'});await gate.waiting;
 try{const newer=await messages.create(channel.id,member.user.id,{content:'newer',nonce:'newer-than-mention'});await messages.markRead(channel.id,owner.user.id,newer.id);}finally{gate.release();}
 await older;const state=(await messages.readStates(owner.user.id)).find(r=>r.channelId===channel.id)!;assert.equal(state.mentionCount,0);
});

test('nickname moderation protects the owner while preserving self-service',async()=>{
 const {owner,member,serverId}=await fixture();
 const role=(await owner.post(`/api/servers/${serverId}/roles`,{name:'Server manager',permissions:Perm.MANAGE_SERVER.toString()})).body;
 await servers.setMemberRoles(serverId,owner.user.id,member.user.id,[role.id]);
 await assert.rejects(servers.setNickname(serverId,member.user.id,owner.user.id,'Changed owner'),(err:any)=>err.status===403);
 assert.equal((await servers.setNickname(serverId,member.user.id,member.user.id,'My nick')).nickname,'My nick');
});

test('role edits and role revocation serialize before reading actor permissions',async(t)=>{
 const {owner,member,serverId}=await fixture();
 const role=(await owner.post(`/api/servers/${serverId}/roles`,{name:'Role manager race',permissions:Perm.MANAGE_ROLES.toString()})).body;
 await servers.setMemberRoles(serverId,owner.user.id,member.user.id,[role.id]);
 const gate=await queryBarrier(t,(sql,params)=>/SELECT s.owner_id, sm.timeout_until/.test(sql)&&params[1]===member.user.id);
 const creating=servers.createRole(serverId,member.user.id,{name:'Concurrent role',permissions:'0'}).then(()=>201,(err:any)=>err.status);
 await gate.waiting;let revoked=false;
 const revoking=servers.setMemberRoles(serverId,owner.user.id,member.user.id,[]).then(()=>{revoked=true;});
 let revokedBeforeRelease=false;
 try{await Promise.race([revoking,sleep(150)]);revokedBeforeRelease=revoked;}finally{gate.release();}
 const status=await creating;await revoking;
 assert.equal(status,revokedBeforeRelease?403:201);
 assert.equal(has((await getAccess(serverId,member.user.id))!.perms,Perm.MANAGE_ROLES),false);
});

test('role assignment and a simultaneous join do not deadlock on the server foreign key',async(t)=>{
 const {owner,serverId}=await fixture();
 const joining=await new Client(h.base).register(`state_joining_${++sequence}`);
 const invite=await servers.createInvite(serverId,owner.user.id,{});
 const role=await servers.createRole(serverId,owner.user.id,{name:'Concurrent join role',permissions:'0'});
 const gate=await queryBarrier(t,(sql,params)=>/pg_advisory_xact_lock/.test(sql)&&params[0]===`membership:${serverId}:${joining.user.id}`);
 const join=servers.acceptInvite(invite.code,joining.user.id);await gate.waiting;
 const assignment=servers.setMemberRoles(serverId,owner.user.id,joining.user.id,[role.id]);
 try{await sleep(150);}finally{gate.release();}
 await Promise.all([join,assignment]);
 assert.equal((await getAccess(serverId,joining.user.id))!.topPosition,role.position);
});

test('own system messages publish a new authoritative read revision',async()=>{
 const {owner,channel}=await fixture();const gateway=await connectGateway(h.base,owner.token!);
 try{
  const previous=(await messages.readStates(owner.user.id)).find(r=>r.channelId===channel.id);
  await messages.postSystem(channel.id,owner.user.id,'system read regression');
  const event=await gateway.waitFor('read:update',d=>d.channelId===channel.id&&BigInt(d.revision)>BigInt(previous?.revision??'0'));
  const latest=await pool.query(`SELECT last_message_id FROM channels WHERE id=$1`,[channel.id]);
  assert.equal(event.lastReadId,latest.rows[0].last_message_id);assert.equal(event.mentionCount,0);
 }finally{gateway.close();}
});

test('gateway shutdown waits for asynchronous presence cleanup',async(t)=>{
 const {owner}=await fixture();const gateway=await connectGateway(h.base,owner.token!);
 const gate=await queryBarrier(t,(sql,params)=>/WHERE u.id = \$1/.test(sql)&&params[0]===owner.user.id);
 gateway.close();await gate.waiting;let stopped=false;
 const stopping=h.app.gateway.stop().then(()=>{stopped=true;});
 try{await sleep(75);assert.equal(stopped,false);}finally{gate.release();}
 await stopping;assert.equal(h.app.gateway.connectionCount,0);
});
