import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createReadinessProbe} from '../src/services/readiness.js';
import {startServer,type Harness,sleep} from './helpers.js';

let h:Harness;
before(async()=>{h=await startServer();});after(async()=>{await h.close();});
test('ready checks actual dependencies and health remains a separate liveness endpoint',async()=>{
 const ready=await fetch(h.base+'/api/ready');assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{ok:true});
 assert.equal((await fetch(h.base+'/api/health')).status,200);
});
test('readiness failure recovers after the cached response expires',async()=>{
 let failed=true,calls=0;const probe=createReadinessProbe(async()=>{calls++;if(failed)throw new Error('private dependency failure');},100,5);
 assert.equal(await probe(),false);failed=false;assert.equal(await probe(),false);assert.equal(calls,1);
 await sleep(10);assert.equal(await probe(),true);assert.equal(calls,2);
});
test('timed-out readiness polling does not accumulate unresolved dependency checks',async()=>{
 let calls=0,release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
 const probe=createReadinessProbe(async()=>{calls++;await blocked;},10,5);
 assert.deepEqual(await Promise.all([probe(),probe(),probe()]),[false,false,false]);assert.equal(calls,1);
 assert.equal(await probe(),false);assert.equal(calls,1);release();await sleep(0);assert.equal(await probe(),true);
});
