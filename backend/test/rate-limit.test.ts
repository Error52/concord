import {test} from 'node:test';
import assert from 'node:assert/strict';
import {redis} from '../src/redis.js';
import {rateLimit} from '../src/middleware/rateLimit.js';

const rule={name:'isolated-limit',max:5,windowSec:900};
function transaction(result:unknown){
  const fixture={incr:()=>fixture,ttl:()=>fixture,exec:async()=>result};return fixture;
}

test('rate limiter fails closed on resolved Redis command errors and aborted or malformed transactions',async(t)=>{
  for(const result of [null,[],[[new Error('READONLY'),null],[null,10]],[[null,1],[new Error('OOM'),null]],[[null,0],[null,900]],[[null,NaN],[null,10]],[[null,1],[null,-2]]]){
    t.mock.method(redis,'multi',(()=>transaction(result)) as typeof redis.multi);
    await assert.rejects(rateLimit(rule,'fixture'),{status:503,code:'RATE_LIMIT_UNAVAILABLE'});
    t.mock.restoreAll();
  }
});

test('rate limiter fails closed when expiry cannot be installed or Redis rejects a command',async(t)=>{
  t.mock.method(redis,'multi',(()=>transaction([[null,1],[null,-1]])) as typeof redis.multi);
  t.mock.method(redis,'expire',async()=>0);
  await assert.rejects(rateLimit(rule,'fixture'),{status:503,code:'RATE_LIMIT_UNAVAILABLE'});
  t.mock.restoreAll();
  t.mock.method(redis,'multi',()=>{throw new Error('disconnected');});
  await assert.rejects(rateLimit(rule,'fixture'),{status:503,code:'RATE_LIMIT_UNAVAILABLE'});
});

test('rate limiter preserves valid buckets and reports retry time when over capacity',async(t)=>{
  t.mock.method(redis,'multi',(()=>transaction([[null,1],[null,-1]])) as typeof redis.multi);
  const expiry=t.mock.method(redis,'expire',async()=>1);
  await assert.doesNotReject(rateLimit(rule,'fixture'));assert.equal(expiry.mock.callCount(),1);
  t.mock.restoreAll();
  t.mock.method(redis,'multi',(()=>transaction([[null,6],[null,0]])) as typeof redis.multi);
  await assert.rejects(rateLimit(rule,'fixture'),{status:429,details:{retryAfter:1}});
});
