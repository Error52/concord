import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {Client,connectGateway,startServer,type Harness} from './helpers.js';
import {notify} from '../src/services/notificationService.js';

let h:Harness;
before(async()=>{h=await startServer();});
after(async()=>{await h.close();});
function serverConnection(userId:string){return [...(h.app.gateway as any).conns.values()].find((connection:any)=>connection.userId===userId) as any;}
function congest(connection:any){Object.defineProperty(connection.ws,'bufferedAmount',{configurable:true,get:()=>16*1024*1024});}

test('a slow recipient reconnects for a fresh snapshot while healthy recipients continue receiving',async()=>{
  const user=await new Client(h.base).register('slow_gateway_broadcast');
  const slow=await connectGateway(h.base,user.token!),connection=serverConnection(user.user.id),healthy=await connectGateway(h.base,user.token!);
  let restored:Awaited<ReturnType<typeof connectGateway>>|undefined;
  try{
    congest(connection);
    const closed=Promise.race([once(slow.ws,'close'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('slow recipient stayed connected')),1500))]);
    await notify([user.user.id],'server',{content:'recover this committed notification'});
    const notification=await healthy.waitFor('notification:new',value=>value.data.content==='recover this committed notification');
    assert.equal((await closed as unknown[])[0],1013);
    restored=await connectGateway(h.base,user.token!);
    assert.ok(restored.ready.notifications.items.some((item:any)=>item.id===notification.id),'reconnect recovers committed state instead of silently skipping an event');
    healthy.send('heartbeat',{});await healthy.waitFor('heartbeat:ack');
  }finally{delete connection.ws.bufferedAmount;slow.close();healthy.close();restored?.close();}
});

test('direct gateway replies use the same slow-client protection as broadcasts',async()=>{
  const user=await new Client(h.base).register('slow_gateway_reply'),client=await connectGateway(h.base,user.token!),connection=serverConnection(user.user.id);
  try{
    congest(connection);
    const closed=Promise.race([once(client.ws,'close'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('slow direct reply stayed connected')),1500))]);
    client.send('heartbeat',{});
    assert.equal((await closed as unknown[])[0],1013);
  }finally{delete connection.ws.bufferedAmount;client.close();}
});

for(const large of [false,true])test(`incoming gateway ${large?'bytes':'message count'} stay bounded while an operation waits`,async(t)=>{
  const user=await new Client(h.base).register(large?'large_gateway_input':'burst_gateway_input');
  const slow=await connectGateway(h.base,user.token!),healthy=await connectGateway(h.base,user.token!);
  const connection=serverConnection(user.user.id),gateway=h.app.gateway as any,original=gateway.onMessage;
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),waiting=new Promise<void>(resolve=>entered=resolve);
  let blocked=false;
  t.mock.method(gateway,'onMessage',async function(this:unknown,conn:any,raw:any){
    if(conn===connection&&!blocked){blocked=true;entered();await gate;}
    return original.call(this,conn,raw);
  });
  try{
    slow.send('heartbeat',{});await waiting;
    const closed=Promise.race([once(slow.ws,'close'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('input backlog stayed unbounded')),1500))]);
    for(let n=0;n<(large?6:80);n++)slow.send('heartbeat',large?{padding:'x'.repeat(60*1024)}:{});
    healthy.send('heartbeat',{});await healthy.waitFor('heartbeat:ack');
    assert.equal((await closed as unknown[])[0],1013);
  }finally{release();slow.close();healthy.close();}
});
