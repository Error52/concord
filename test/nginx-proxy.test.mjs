import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const docker=(...args)=>execFileSync('docker',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const available=(()=>{try{docker('info');return true;}catch{return false;}})();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('nginx preserves security headers, LiveKit paths and discovers recreated backend IPs',{skip:available?false:'Docker is required',timeout:90000},async()=>{
 const id='concord-proxy-'+randomUUID().slice(0,8),network=id+'-net',backend=id+'-backend',livekit=id+'-livekit',frontend=id+'-frontend',replacement=id+'-replacement';
 const stub=`require('http').createServer((q,s)=>{s.setHeader('Content-Type','application/json');s.end(JSON.stringify({service:process.env.SERVICE,url:q.url}));}).listen(Number(process.env.PORT),'0.0.0.0')`;
 const runStub=(name,alias,port,label,ip)=>docker('run','-d','--name',name,'--network',network,'--network-alias',alias,...(ip?['--ip',ip]:[]),'-e',`PORT=${port}`,'-e',`SERVICE=${label}`,'node:24-bookworm-slim','node','-e',stub);
 try{
  docker('network','create',network);runStub(backend,'backend',4000,'before');runStub(livekit,'livekit',7880,'livekit');
  docker('run','-d','--name',frontend,'--network',network,'-p','127.0.0.1::80',process.env.FRONTEND_IMAGE??'concord-frontend-ci');
  const port=JSON.parse(docker('inspect',frontend))[0].NetworkSettings.Ports['80/tcp'][0].HostPort,base=`http://127.0.0.1:${port}`;
  async function wait(path,predicate){let last;for(let i=0;i<50;i++){try{last=await fetch(base+path,{signal:AbortSignal.timeout(2000)});if(await predicate(last.clone()))return last;}catch{}await delay(300);}throw new Error('Proxy did not recover: '+path+' '+last?.status);}
  const home=await wait('/',r=>r.ok),html=await home.text();
  const asset=html.match(/(?:src|href)="(\/assets\/[^" ]+\.js)"/)?.[1];assert.ok(asset,'built JS asset exists');
  for(const url of ['/','/login',asset,'/assets/missing-check.js','/api/health']){
   const response=await fetch(base+url);assert.equal(response.headers.get('x-content-type-options'),'nosniff',url);
   assert.equal(response.headers.get('referrer-policy'),'strict-origin-when-cross-origin',url);
   assert.ok(response.headers.get('permissions-policy')?.includes('microphone=(self)'),url);
   assert.ok(response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"),url);
   if(url===asset)assert.ok(response.headers.get('cache-control')?.includes('immutable'));
   if(url==='/login')assert.ok(response.headers.get('cache-control')?.includes('no-cache'));
  }
  assert.deepEqual(await(await wait('/livekit/rtc?test=1',r=>r.ok)).json(),{service:'livekit',url:'/rtc?test=1'});
  assert.equal((await(await wait('/api/health',async r=>r.ok&&(await r.json()).service==='before')).json()).service,'before');
  const original=JSON.parse(docker('inspect',backend))[0].NetworkSettings.Networks[network].IPAddress;
  const started=JSON.parse(docker('inspect',frontend))[0].State.StartedAt;
  const next=original.split('.');next[3]=String(Number(next[3])+10);docker('rm','-f',backend);runStub(replacement,'backend',4000,'after',next.join('.'));
  await wait('/api/health',async r=>r.ok&&(await r.json()).service==='after');
  assert.equal(JSON.parse(docker('inspect',frontend))[0].State.StartedAt,started,'frontend recovered without restart');
 }finally{
  for(const name of [frontend,backend,livekit,replacement])try{docker('rm','-f',name);}catch{}
  try{docker('network','rm',network);}catch{}
 }
});
