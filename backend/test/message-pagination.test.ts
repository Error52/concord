import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {startServer,Client,type Harness} from './helpers.js';

let h:Harness,user:Client,channelId:string,dmId:string;
const ids:string[]=[];
before(async()=>{
 h=await startServer();user=await new Client(h.base).register('pagination_user');
 const peer=await new Client(h.base).register('pagination_peer');
 const server=await user.post('/api/servers',{name:'Pagination contract'});assert.equal(server.status,201);
 channelId=server.body.channels.find((c:any)=>c.type==='text').id;
 const dm=await user.post('/api/dm',{recipientId:peer.user.id});assert.equal(dm.status,200);dmId=dm.body.id;
 for(let n=0;n<7;n++){
  const sent=await user.post(`/api/channels/${channelId}/messages`,{content:`pagination message ${n}`});assert.equal(sent.status,201);ids.push(sent.body.id);
 }
});
after(async()=>{await h?.close();});

test('message history rejects noninteger or out-of-contract limits for channel and DM endpoints',async()=>{
 for(const endpoint of [`/api/channels/${channelId}/messages`,`/api/dm/${dmId}/messages`]){
  for(const limit of ['abc','NaN','Infinity','1.5','0','-1','101','']){
   const result=await user.get(`${endpoint}?limit=${encodeURIComponent(limit)}`);
   assert.equal(result.status,400,`${endpoint} limit=${limit}`);assert.equal(result.body.error.code,'VALIDATION');
  }
  assert.equal((await user.get(`${endpoint}?limit=100`)).status,200);
 }
});

test('message IDs above PostgreSQL bigint fail validation rather than issuing a failing SQL query',async()=>{
 const overflow='9999999999999999999',maximum='9223372036854775807';
 for(const path of [
  `/api/channels/${channelId}/messages?before=${overflow}`,
  `/api/channels/${channelId}/messages?around=${overflow}`,
  `/api/dm/${dmId}/messages?before=${overflow}`,
  `/api/messages/${overflow}/thread`,
 ])assert.equal((await user.get(path)).status,400,path);
 assert.equal((await user.post(`/api/channels/${channelId}/read`,{messageId:overflow})).status,400);
 assert.equal((await user.get(`/api/channels/${channelId}/messages?before=${maximum}`)).status,200);
 assert.equal((await user.get(`/api/messages/${maximum}/thread`)).status,404);
});

test('around message windows include the anchor without exceeding odd or even limits',async()=>{
 const anchor=ids[3]!;
 for(const limit of [1,2,3,4]){
  const response=await user.get(`/api/channels/${channelId}/messages?around=${anchor}&limit=${limit}`);
  assert.equal(response.status,200);assert.equal(response.body.length,limit,`around limit ${limit}`);
  assert.ok(response.body.some((message:any)=>message.id===anchor));
  assert.deepEqual(response.body.map((message:any)=>message.id),[...response.body.map((message:any)=>message.id)].sort());
 }
});
