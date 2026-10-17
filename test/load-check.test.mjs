import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {loadConfig,loadUsers,distribution,runLoad} from '../scripts/load-check.mjs';

test('load settings enforce target, duration, socket and request bounds before sending traffic',()=>{
  assert.throws(()=>loadConfig({BASE_URL:'https://chat.example.com'}),/LOAD_ALLOW_PUBLIC/);
  for(const BASE_URL of ['file:///tmp/file','https://secret:password@example.com','http://localhost/private'])assert.throws(()=>loadConfig({BASE_URL,LOAD_ALLOW_PUBLIC:'1'}));
  for(const [key,value] of [['LOAD_MAX_REQUESTS','1001'],['LOAD_MAX_SOCKETS','21'],['LOAD_STAGE_SECONDS','31'],['LOAD_TIMEOUT_MS','NaN']])assert.throws(()=>loadConfig({[key]:value}));
  assert.equal(loadConfig({BASE_URL:'https://chat.example.com',LOAD_ALLOW_PUBLIC:'1'}).base,'https://chat.example.com');
  assert.throws(()=>loadUsers([{accessToken:'short'}]));
  assert.throws(()=>loadUsers([{accessToken:'test-only-token',channelId:'not-a-channel'}]));
  const sameAccount=Buffer.from(JSON.stringify({sub:'12345678-1234-1234-1234-123456789abc'})).toString('base64url');
  assert.throws(()=>loadUsers([{accessToken:`header.${sameAccount}.signature-one`},{accessToken:`header.${sameAccount}.signature-two`}]),/distinct account/);
  assert.deepEqual(distribution([5,1,4,2,3]),{samples:5,p50Ms:3,p95Ms:5,maxMs:5});
});

async function fixture(fn,handler){
  const server=createServer(handler??((_req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{await fn(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(resolve=>server.close(resolve));}
}
function event(type,properties={}){const value=new Event(type);for(const [key,item]of Object.entries(properties))Object.defineProperty(value,key,{value:item});return value;}
class TestSocket extends EventTarget{
  constructor(){super();queueMicrotask(()=>this.dispatchEvent(event('open')));}
  send(raw){const frame=JSON.parse(raw);queueMicrotask(()=>this.dispatchEvent(event('message',{data:JSON.stringify({t:frame.op==='auth'?'ready':'heartbeat:ack',d:{}})})));}
  close(){this.dispatchEvent(event('close',{code:1000}));}
}

test('mixed read stages measure HTTP and gateway latency without leaking credentials or writing routes',async()=>fixture(async base=>{
  const token='test-only-credential-not-for-output',config=loadConfig({BASE_URL:base,LOAD_STAGE_SECONDS:'3',LOAD_MAX_SOCKETS:'2'});
  const report=await runLoad(config,loadUsers([{accessToken:token}]),{WebSocketImpl:TestSocket});
  assert.equal(report.passed,true);assert.equal(report.stages.length,3);
  assert.ok(report.totalHttpRequests>30&&report.totalHttpRequests<=1000);
  for(const stage of report.stages){assert.ok(stage.http.successLatency.samples>0);assert.equal(stage.http.successful,stage.http.completed);assert.equal(stage.http.serviceErrorPercent,0);assert.equal(stage.ws.ready,Math.min(stage.ws.requested,2));assert.ok(stage.ws.heartbeatRtt.samples>0);}
  assert.ok(!JSON.stringify(report).includes(token));
},(req,res)=>{assert.equal(req.method,'GET');assert.match(req.url,/^\/api\/(ready|users\/me|servers|notifications)$/);res.setHeader('Content-Type','application/json');res.end('{"ok":true}');}));

test('a real 429 stops the workload immediately rather than retrying around rate limits',async()=>fixture(async base=>{
  const report=await runLoad(loadConfig({BASE_URL:base,LOAD_STAGE_SECONDS:'1',LOAD_MAX_SOCKETS:'0'}));
  assert.equal(report.stopReason,'rate-limited');assert.equal(report.totalHttpRequests,1);assert.equal(report.passed,false);assert.equal(report.stages[0].http.statuses[429],1);assert.equal(report.stages[0].http.serviceErrorPercent,100);
},(_req,res)=>{res.statusCode=429;res.setHeader('Content-Type','application/json');res.end('{"error":"limited"}');}));

test('a slow service never exceeds concurrency or silently queues missed request slots',async()=>{
  let active=0,peak=0;
  await fixture(async base=>{
    const report=await runLoad(loadConfig({BASE_URL:base,LOAD_STAGE_SECONDS:'1',LOAD_MAX_SOCKETS:'0'}));
    assert.equal(report.passed,true);assert.ok(peak<=8);assert.ok(report.stages.some(stage=>stage.http.skippedBusySlots>0));
  },(_req,res)=>{peak=Math.max(peak,++active);setTimeout(()=>{active--;res.setHeader('Content-Type','application/json');res.end('{"ok":true}');},700);});
});

test('an unready gateway stops before HTTP load and reports its timeout without a hung check',async()=>{
  class UnreadySocket extends TestSocket{send(){}}
  const report=await runLoad(loadConfig({LOAD_STAGE_SECONDS:'1',LOAD_TIMEOUT_MS:'250'}),loadUsers([{accessToken:'test-only-token'}]),{WebSocketImpl:UnreadySocket});
  assert.equal(report.stopReason,'ws-ready-timeout');assert.equal(report.totalHttpRequests,0);
  assert.equal(report.stages[0].ws.errors['ws-ready-timeout'],1);assert.equal(report.stages[0].http.completedPerSecond,0);
});
