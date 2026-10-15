import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api,ApiError,getAccessToken,refreshSession,setAccessToken,setSessionLostHandler} from '../src/api/client';
const settle=()=>new Promise(r=>setTimeout(r,5));

test('concurrent expired requests share one refresh and retry with the new token',async(t)=>{
  await settle();setAccessToken('old');let refreshes=0;
  t.mock.method(globalThis,'fetch',async(url:string,init:RequestInit)=>{
    if(url.endsWith('/auth/refresh')){refreshes++;await settle();return Response.json({accessToken:'new'});}
    return (init.headers as Record<string,string>).Authorization==='Bearer new'?Response.json({ok:true}):Response.json({error:{code:'SESSION_EXPIRED',message:'expired'}},{status:401});
  });
  const results=await Promise.all(Array.from({length:8},()=>api.get<{ok:boolean}>('/users/me')));
  assert.ok(results.every(r=>r.ok));assert.equal(refreshes,1);assert.equal(getAccessToken(),'new');
});
test('temporary refresh failures preserve the token and do not trigger logout',async(t)=>{
  await settle();setAccessToken('keep');let lost=0;setSessionLostHandler(()=>lost++);
  t.mock.method(globalThis,'fetch',async(url:string)=>url.endsWith('/auth/refresh')?Response.json({error:{code:'INTERNAL',message:'temporarily unavailable'}},{status:503}):new Response(null,{status:401}));
  await assert.rejects(api.get('/users/me'),(e:unknown)=>e instanceof ApiError&&e.status===503);
  assert.equal(lost,0);assert.equal(getAccessToken(),'keep');
});
test('refresh retries a tab race; an actually expired session clears the token',async(t)=>{
  await settle();setAccessToken('keep');let requests=0;
  t.mock.method(globalThis,'fetch',async()=>++requests===1?new Response(null,{status:409}):Response.json({accessToken:'rotated'}));
  assert.equal(await refreshSession(),true);assert.equal(requests,2);assert.equal(getAccessToken(),'rotated');
  await settle();t.mock.restoreAll();t.mock.method(globalThis,'fetch',async()=>new Response(null,{status:401}));
  assert.equal(await refreshSession(),false);assert.equal(getAccessToken(),null);
});
