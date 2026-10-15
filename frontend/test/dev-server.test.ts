import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';

test('development server rejects malformed/traversing URLs and missing chunks without crashing',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'concord-static-test-'));
  await mkdir(path.join(dir,'dist'));await writeFile(path.join(dir,'dist/index.html'),'<h1>SPA</h1>');await writeFile(path.join(dir,'secret.txt'),'outside');
  const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
  const port=(reservation.address() as net.AddressInfo).port;await new Promise<void>(r=>reservation.close(()=>r()));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/serve.mjs',import.meta.url))],{cwd:dir,env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  try{
    await Promise.race([once(child.stdout!,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Static server did not start')),5000).unref())]);
    const base=`http://127.0.0.1:${port}`;
    assert.equal((await fetch(base+'/%E0%A4%A')).status,400);
    if(process.platform==='win32')assert.equal((await fetch(base+'/..%5Csecret.txt')).status,403);
    assert.equal((await fetch(base+'/assets/missing-chunk.js')).status,404);
    assert.equal(await(await fetch(base+'/channels/@me')).text(),'<h1>SPA</h1>');
    assert.equal(child.exitCode,null,'server remains running after malformed input');
  }finally{
    const exited=once(child,'exit');child.kill();await exited;
    const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(tmpdir())+path.sep));
    await rm(resolved,{recursive:true,force:true});
  }
});

test('proxy preserves distinct LAN addresses behind a trusted local proxy and strips direct spoofing',async()=>{
  const upstream=http.createServer((req,res)=>res.end(JSON.stringify(req.headers)));
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const upPort=(upstream.address() as net.AddressInfo).port;
  try{
    for(const trusted of ['0','1']){
      const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
      const port=(reservation.address() as net.AddressInfo).port;await new Promise<void>(r=>reservation.close(()=>r()));
      const child=spawn(process.execPath,[fileURLToPath(new URL('../scripts/serve.mjs',import.meta.url))],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',BACKEND:`http://127.0.0.1:${upPort}`,FRONTEND_TRUST_PROXY:trusted},windowsHide:true,stdio:['ignore','pipe','pipe']});
      try{
        await Promise.race([once(child.stdout!,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Proxy did not start')),5000).unref())]);
        const request=async(ip:string)=>(await(await fetch(`http://127.0.0.1:${port}/api/headers`,{headers:{'X-Forwarded-For':`6.6.6.6, ${ip}`,'Forwarded':'for=6.6.6.6','X-Forwarded-Proto':'https'}})).json()) as Record<string,string>;
        const a=await request('192.168.1.20'),b=await request('192.168.1.21');
        assert.equal(a['x-forwarded-for'],trusted==='1'?'192.168.1.20':'127.0.0.1');
        assert.equal(b['x-forwarded-for'],trusted==='1'?'192.168.1.21':'127.0.0.1');
        assert.equal(a.forwarded,undefined);
        assert.equal(a['x-forwarded-proto'],trusted==='1'?'https':undefined);
      }finally{const exited=once(child,'exit');child.kill();await exited;}
    }
  }finally{await new Promise<void>(r=>upstream.close(()=>r()));}
});
