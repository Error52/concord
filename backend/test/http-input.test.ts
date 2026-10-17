import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

/** No SQL, Redis or SFU is needed: invalid targets fail before routing or authentication. */
async function isolatedListener(t: TestContext): Promise<number> {
  const source=`const {createApp}=await import('./src/app.ts');
    const app=createApp();app.server.listen(0,'127.0.0.1',()=>console.log('PORT:'+app.server.address().port));`;
  const child=spawn(process.execPath,['--import','tsx','--input-type=module','--eval',source],{
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    env:{...process.env,NODE_ENV:'test',DATABASE_URL:'postgres://test:test@127.0.0.1:9/no_connect_test',
      REDIS_URL:'redis://127.0.0.1:9/1',JWT_SECRET:'http-input-test-'.repeat(3),STORAGE_DRIVER:'local',LOG_LEVEL:'error'},
    stdio:['ignore','pipe','pipe'],
  });
  let output='',errors='';
  child.stderr.on('data',chunk=>{errors+=String(chunk);});
  t.after(async()=>{if(child.exitCode===null){child.kill();await once(child,'exit');}});
  return new Promise<number>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('HTTP input fixture did not start')),15_000);
    child.stdout.on('data',chunk=>{
      output+=String(chunk);const found=/PORT:(\d+)/.exec(output);
      if(found){clearTimeout(timer);resolve(Number(found[1]));}
    });
    child.on('exit',code=>{clearTimeout(timer);reject(new Error(`HTTP input fixture exited ${code}: ${errors.slice(-500)}`));});
  });
}

async function rawRequest(port:number,target:string,upgrade:boolean):Promise<string>{
  return new Promise<string>((resolve,reject)=>{
    const socket=connect({host:'127.0.0.1',port});let response='';
    socket.setTimeout(5000,()=>socket.destroy(new Error('HTTP input response timed out')));
    socket.on('connect',()=>socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\n${upgrade
      ?'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
      :'Connection: close\r\n'}\r\n`));
    socket.on('data',chunk=>{response+=String(chunk);});
    socket.on('end',()=>resolve(response));
    socket.on('error',reject);
    socket.on('close',()=>resolve(response));
  });
}

for(const upgrade of [false,true]){
  test(`malformed ${upgrade?'WebSocket upgrade':'HTTP'} targets do not crash the backend`,async(t)=>{
    const port=await isolatedListener(t);
    for(const target of ['http://[','//[']){
      assert.match(await rawRequest(port,target,upgrade),/^HTTP\/1\.1 400 /);
      const health=await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status,200);
      assert.deepEqual(await health.json(),{ok:true});
    }
  });
}
