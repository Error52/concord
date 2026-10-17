#!/usr/bin/env node
// Bounded GET + gateway checks. Existing verified accounts only; never sends chat/mail/media.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function integer(value,fallback,min,max,name){
  const text=String(value??fallback);if(!/^\d+$/.test(text))throw new Error(`${name} must be an integer`);
  const number=Number(text);if(number<min||number>max)throw new Error(`${name} must be between ${min} and ${max}`);return number;
}
export function loadConfig(env=process.env){
  const base=new URL(env.BASE_URL??'http://127.0.0.1:5181');
  if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw new Error('BASE_URL must be an HTTP(S) origin without credentials or a path');
  if(!['localhost','127.0.0.1','[::1]'].includes(base.hostname)&&env.LOAD_ALLOW_PUBLIC!=='1')throw new Error('Set LOAD_ALLOW_PUBLIC=1 to run against the explicitly selected non-loopback host');
  return {base:base.origin,stageSeconds:integer(env.LOAD_STAGE_SECONDS,15,1,30,'LOAD_STAGE_SECONDS'),
    maxRequests:integer(env.LOAD_MAX_REQUESTS,1000,1,1000,'LOAD_MAX_REQUESTS'),
    requestTimeoutMs:integer(env.LOAD_TIMEOUT_MS,5000,250,10000,'LOAD_TIMEOUT_MS'),
    maxSockets:integer(env.LOAD_MAX_SOCKETS,8,0,20,'LOAD_MAX_SOCKETS'),
    usersFile:env.LOAD_USERS_FILE??null,output:env.LOAD_OUT??'load-results.json'};
}
export function loadUsers(value){
  const users=Array.isArray(value)?value:value?.users;
  if(!Array.isArray(users)||users.length<1||users.length>20)throw new Error('LOAD_USERS_FILE needs 1–20 existing account entries');
  const seen=new Set();
  return users.map(user=>{
    if(!user||typeof user.accessToken!=='string'||user.accessToken.length<10||user.accessToken.length>4096)throw new Error('Every account needs an accessToken');
    for(const key of ['channelId','serverId'])if(user[key]!==undefined&&!UUID.test(user[key]))throw new Error(`${key} must be a UUID`);
    // This is only workload bucketing; the server still verifies every token.
    let account=user.accessToken;
    try{const claims=JSON.parse(Buffer.from(user.accessToken.split('.')[1],'base64url').toString());if(UUID.test(claims.sub))account=claims.sub;}catch{}
    if(seen.has(account))throw new Error('Use one fixture entry per distinct account');seen.add(account);
    return {accessToken:user.accessToken,channelId:user.channelId,serverId:user.serverId};
  });
}
export function distribution(values){
  const sorted=values.toSorted((a,b)=>a-b),pick=p=>sorted.length?Math.round(sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]*100)/100:null;
  return {samples:sorted.length,p50Ms:pick(.5),p95Ms:pick(.95),maxMs:pick(1)};
}
async function drain(response,maxBytes=2*1024*1024){
  let bytes=0;if(!response.body)return bytes;
  const reader=response.body.getReader();
  try{for(;;){const {done,value}=await reader.read();if(done)return bytes;bytes+=value.byteLength;if(bytes>maxBytes)throw new Error('response-size');}}
  catch(error){await reader.cancel().catch(()=>undefined);throw error;}
  finally{reader.releaseLock();}
}
function targets(user){
  if(!user)return [{label:'ready',pathname:'/api/ready'}];
  return [{label:'ready',pathname:'/api/ready',public:true},{label:'self',pathname:'/api/users/me'},
    {label:'servers',pathname:'/api/servers'},{label:'notifications',pathname:'/api/notifications'},
    ...(user.channelId?[{label:'messages50',pathname:`/api/channels/${user.channelId}/messages?limit=50`}]:[]),
    ...(user.serverId?[{label:'serverSnapshot',pathname:`/api/servers/${user.serverId}`}]:[])];
}
export async function runLoad(config,users=[],options={}){
  const fetchImpl=options.fetchImpl??globalThis.fetch,Socket=options.WebSocketImpl??globalThis.WebSocket;
  const stop=new AbortController(),probes=new Set();
  const report={kind:'bounded-http-gateway',target:config.base,startedAt:new Date().toISOString(),
    accounts:users.length,limits:{maxHttpRequests:config.maxRequests,maxSockets:config.maxSockets,maxSocketsPerAccount:4,maxHttpRate:20,maxHttpConcurrency:8,responseBytes:2*1024*1024,totalHttpBytes:32*1024*1024,stageSeconds:config.stageSeconds},
    scope:'GET reads, gateway auth and heartbeat only. No chat writes, email, login brute force or SFU capacity measurement.',stages:[],stopReason:null};
  let issued=0,failures=0,totalBytes=0;
  function halt(reason){if(!report.stopReason){report.stopReason=reason;stop.abort();}}
  const interrupted=()=>halt('interrupted');options.signal?.addEventListener('abort',interrupted,{once:true});
  if(options.signal?.aborted)interrupted();
  const deadline=setTimeout(()=>halt('wall-time-budget'),180000);
  function openProbe(user,stage){
    return new Promise(resolve=>{
      const url=new URL('/api/gateway',config.base);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      const started=performance.now();let resolved=false,heartbeatTimer,pendingPing;
      const ws=new Socket(url),probe={ws,closing:false,close(){
        this.closing=true;clearTimeout(authTimer);clearInterval(heartbeatTimer);if(pendingPing)clearTimeout(pendingPing.timer);
        try{ws.close(1000,'load check finished');}catch{}probes.delete(this);
      }};
      probes.add(probe);
      function failed(code){if(probe.closing)return;stage.ws.errors[code]=(stage.ws.errors[code]??0)+1;halt(code);probe.close();if(!resolved){resolved=true;resolve(null);}}
      const authTimer=setTimeout(()=>failed('ws-ready-timeout'),config.requestTimeoutMs);
      ws.addEventListener('open',()=>ws.send(JSON.stringify({op:'auth',d:{token:user.accessToken}})));
      ws.addEventListener('message',event=>{
        let frame;try{frame=JSON.parse(String(event.data));}catch{failed('ws-invalid-frame');return;}
        if(frame.t==='ready'&&!resolved){
          resolved=true;clearTimeout(authTimer);stage.ws.readySamples.push(performance.now()-started);stage.ws.ready++;
          heartbeatTimer=setInterval(()=>{
            if(probe.closing||pendingPing)return;
            pendingPing={started:performance.now(),timer:setTimeout(()=>failed('ws-heartbeat-timeout'),config.requestTimeoutMs)};
            try{ws.send(JSON.stringify({op:'heartbeat',d:{}}));}catch{failed('ws-send-failed');}
          },2000);
          resolve(probe);
        }else if(frame.t==='heartbeat:ack'&&pendingPing){clearTimeout(pendingPing.timer);stage.ws.ackSamples.push(performance.now()-pendingPing.started);pendingPing=null;}
        else if(frame.t==='error')failed('ws-operation-error');
      });
      ws.addEventListener('error',()=>failed('ws-transport-error'));
      ws.addEventListener('close',event=>{if(!probe.closing)failed(`ws-unexpected-close-${event.code}`);});
    });
  }
  try{
    for(const [index,plan] of [{rate:2,concurrency:1,sockets:1},{rate:8,concurrency:4,sockets:4},{rate:20,concurrency:8,sockets:8}].entries()){
      if(stop.signal.aborted||issued>=config.maxRequests)break;
      const stage={stage:index+1,offeredRate:plan.rate,concurrency:plan.concurrency,http:{issued:0,completed:0,successful:0,aborted:0,bytes:0,skippedBusySlots:0,statuses:{},errors:{},samples:[],successSamples:[],endpoints:{}},
        ws:{requested:Math.min(plan.sockets,config.maxSockets,users.length*4),ready:0,readySamples:[],ackSamples:[],errors:{}}};
      report.stages.push(stage);
      if(stage.ws.requested&&typeof Socket!=='function')throw new Error('Node 22+ with WebSocket support is required');
      for(let n=0;n<stage.ws.requested&&!stop.signal.aborted;n+=2){
        await Promise.all(Array.from({length:Math.min(2,stage.ws.requested-n)},(_,offset)=>openProbe(users[(n+offset)%users.length],stage)));
      }
      const start=performance.now(),ends=start+config.stageSeconds*1000,pending=new Set();let slot=0;
      async function request(number){
        const user=users.length?users[number%users.length]:null,choices=targets(user),target=choices[Math.floor(number/Math.max(1,users.length))%choices.length];
        const auth=user&&!target.public?{Authorization:`Bearer ${user.accessToken}`}:{},started=performance.now();let okay=false;
        try{
          const response=await fetchImpl(config.base+target.pathname,{headers:auth,redirect:'error',signal:AbortSignal.any([stop.signal,AbortSignal.timeout(config.requestTimeoutMs)])});
          const bytes=await drain(response);stage.http.bytes+=bytes;totalBytes+=bytes;
          if(totalBytes>32*1024*1024)halt('byte-budget');
          if(!response.headers.get('content-type')?.includes('application/json'))throw new Error('unexpected-content-type');
          stage.http.statuses[response.status]=(stage.http.statuses[response.status]??0)+1;
          okay=response.ok;
          if(!okay){stage.http.errors[`http-${response.status}`]=(stage.http.errors[`http-${response.status}`]??0)+1;failures++;if(response.status===429)halt('rate-limited');else if(response.status===401||response.status===403)halt('fixture-auth-failed');}
        }catch(error){
          if(!stop.signal.aborted){const code=['response-size','unexpected-content-type'].includes(error?.message)?error.message:error?.name==='TimeoutError'?'timeout':'network';stage.http.errors[code]=(stage.http.errors[code]??0)+1;failures++;}
          else stage.http.aborted++;
        }finally{
          const elapsed=performance.now()-started;stage.http.completed++;stage.http.samples.push(elapsed);
          if(okay){stage.http.successful++;stage.http.successSamples.push(elapsed);}
          const endpoint=stage.http.endpoints[target.label]??={count:0,errors:0,samples:[]};endpoint.count++;if(!okay)endpoint.errors++;endpoint.samples.push(elapsed);
          if(failures>=3)halt('error-budget');
        }
      }
      while(performance.now()<ends&&!stop.signal.aborted&&issued<config.maxRequests){
        const due=start+slot*1000/plan.rate;slot++;
        if(due>performance.now())await sleep(Math.min(due-performance.now(),1000));
        if(performance.now()>=ends||stop.signal.aborted)break;
        if(pending.size>=plan.concurrency){stage.http.skippedBusySlots++;continue;}
        const number=issued++;stage.http.issued++;
        const work=request(number);pending.add(work);void work.finally(()=>pending.delete(work));
      }
      await Promise.all(pending);
      stage.elapsedSeconds=Math.round((performance.now()-start)/10)/100;
      stage.http.completedPerSecond=stage.elapsedSeconds?Math.round(stage.http.completed/stage.elapsedSeconds*100)/100:0;
      stage.http.serviceErrorPercent=stage.http.completed?Math.round((stage.http.completed-stage.http.successful-stage.http.aborted)/stage.http.completed*10000)/100:0;
      stage.http.latency=distribution(stage.http.samples);stage.http.successLatency=distribution(stage.http.successSamples);
      delete stage.http.samples;delete stage.http.successSamples;
      for(const endpoint of Object.values(stage.http.endpoints)){endpoint.latency=distribution(endpoint.samples);delete endpoint.samples;}
      stage.ws.connectToReady=distribution(stage.ws.readySamples);stage.ws.heartbeatRtt=distribution(stage.ws.ackSamples);delete stage.ws.readySamples;delete stage.ws.ackSamples;
      for(const probe of [...probes])probe.close();
      options.onStage?.(stage);
    }
    if(issued>=config.maxRequests&&!report.stopReason)report.stopReason='request-budget';
  }finally{
    clearTimeout(deadline);stop.abort();for(const probe of [...probes])probe.close();options.signal?.removeEventListener('abort',interrupted);
    report.finishedAt=new Date().toISOString();report.totalHttpRequests=issued;report.totalHttpBytes=totalBytes;report.passed=!report.stopReason&&failures===0;
  }
  return report;
}
async function main(){
  const config=loadConfig(),users=config.usersFile?loadUsers(JSON.parse(await readFile(config.usersFile,'utf8'))):[];
  const interrupted=new AbortController(),onInterrupt=()=>interrupted.abort();process.once('SIGINT',onInterrupt);process.once('SIGTERM',onInterrupt);
  try{
    const report=await runLoad(config,users,{signal:interrupted.signal,onStage:stage=>console.log(`Stage ${stage.stage}: HTTP ${stage.http.completed} requests, p95 ${stage.http.successLatency.p95Ms??'n/a'} ms, WS ${stage.ws.ready} ready`)});
    await mkdir(path.dirname(path.resolve(config.output)),{recursive:true});await writeFile(config.output,JSON.stringify(report,null,2));
    console.log(`Report: ${path.resolve(config.output)}; ${report.stopReason??'completed'}`);if(!report.passed)process.exitCode=1;
  }finally{process.removeListener('SIGINT',onInterrupt);process.removeListener('SIGTERM',onInterrupt);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(()=>{console.error('Load check failed. Verify BASE_URL, bounded options and the private account fixture. Credentials are never printed.');process.exitCode=1;});
