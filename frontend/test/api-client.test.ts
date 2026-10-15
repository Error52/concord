import {test} from 'node:test';
import assert from 'node:assert/strict';
import {api,ApiError,getAccessToken,refreshSession,setAccessToken,setSessionLostHandler,uploadWithProgress} from '../src/api/client';
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

test('late refresh responses cannot resurrect logout or replace a newer account',async(t)=>{
 await settle();setAccessToken('old');let complete!:(response:Response)=>void;
 t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>{complete=resolve;}));
 const old=refreshSession();setAccessToken(null);complete(Response.json({accessToken:'obsolete'}));assert.equal(await old,false);assert.equal(getAccessToken(),null);
 await settle();setAccessToken('first');const expired=refreshSession();setAccessToken('second');complete(new Response(null,{status:401}));
 assert.equal(await expired,true);assert.equal(getAccessToken(),'second');
});

test('a request from a former account is not retried with another account credentials',async(t)=>{
 await settle();setAccessToken('first');let complete!:(response:Response)=>void,calls=0;
 t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise<Response>(resolve=>{complete=resolve;});});
 const pending=api.post('/servers',{name:'old account'});setAccessToken('second');complete(new Response(null,{status:401}));
 await assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.code==='SESSION_CHANGED');assert.equal(calls,1);assert.equal(getAccessToken(),'second');
});

test('aborting an upload while refresh is pending settles immediately and never resends',async(t)=>{
 await settle();setAccessToken('upload');let complete!:(response:Response)=>void,sends=0;
 class FakeXHR {
  upload={onprogress:null};status=401;responseText='';onload:(()=>Promise<void>)|null=null;onerror:null=null;onabort:(()=>void)|null=null;
  open(){}setRequestHeader(){}send(){sends++;void this.onload?.();}abort(){/* DONE XHR has no abort event */}
 }
 const previous=Object.getOwnPropertyDescriptor(globalThis,'XMLHttpRequest');Object.defineProperty(globalThis,'XMLHttpRequest',{configurable:true,value:FakeXHR});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'XMLHttpRequest',previous);else Reflect.deleteProperty(globalThis,'XMLHttpRequest');});
 t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>{complete=resolve;}));
 const upload=uploadWithProgress('/channels/test/attachments',new File(['hello'],'hello.txt'),()=>undefined);
 const rejected=assert.rejects(upload.promise,(e:unknown)=>e instanceof ApiError&&e.code==='ABORTED');upload.abort();await rejected;
 complete(Response.json({accessToken:'new'}));await settle();assert.equal(sends,1);
});

test('a newer refresh stays deduplicated when an older account refresh completes',async(t)=>{
 await settle();let calls=0;const pending:((r:Response)=>void)[]=[];
 t.mock.method(globalThis,'fetch',()=>{calls++;return new Promise<Response>(resolve=>pending.push(resolve));});
 setAccessToken('old');const old=refreshSession();setAccessToken('new');const current=refreshSession();
 pending[0]!(Response.json({accessToken:'obsolete'}));await old;await settle();
 assert.equal(refreshSession(),current);assert.equal(calls,2);
 pending[1]!(Response.json({accessToken:'new-rotated'}));await current;assert.equal(getAccessToken(),'new-rotated');
});

test('network failure on a post-refresh retry keeps the normal NETWORK error',async(t)=>{
 await settle();setAccessToken('old');let calls=0;
 t.mock.method(globalThis,'fetch',async(url:string)=>{if(url.endsWith('/auth/refresh'))return Response.json({accessToken:'new'});if(++calls===1)return new Response(null,{status:401});throw new TypeError('Failed to fetch');});
 await assert.rejects(api.get('/users/me'),(e:unknown)=>e instanceof ApiError&&e.code==='NETWORK');assert.equal(getAccessToken(),'new');
});

test('an upload response from a former account cannot refresh or return its attachment',async(t)=>{
 await settle();let refreshes=0,lost=0;setSessionLostHandler(()=>lost++);
 class FakeXHR {
  static current:FakeXHR;upload={onprogress:null};status=200;responseText='{"id":"old-private-file"}';onload:(()=>Promise<void>)|null=null;
  constructor(){FakeXHR.current=this;}open(){}setRequestHeader(){}send(){}abort(){}
 }
 const previous=Object.getOwnPropertyDescriptor(globalThis,'XMLHttpRequest');Object.defineProperty(globalThis,'XMLHttpRequest',{configurable:true,value:FakeXHR});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'XMLHttpRequest',previous);else Reflect.deleteProperty(globalThis,'XMLHttpRequest');});
 t.mock.method(globalThis,'fetch',async()=>{refreshes++;return new Response(null,{status:401});});
 for(const status of [200,401]){
  setAccessToken('first');const upload=uploadWithProgress('/channels/test/attachments',new File(['hello'],'hello.txt'),()=>undefined);
  setAccessToken('second');FakeXHR.current.status=status;await FakeXHR.current.onload?.();
  await assert.rejects(upload.promise,(e:unknown)=>e instanceof ApiError&&e.code==='SESSION_CHANGED');
 }
 assert.equal(refreshes,0);assert.equal(lost,0);assert.equal(getAccessToken(),'second');
});

test('an expired upload refresh cannot sign out an account selected while it was pending',async(t)=>{
 await settle();setAccessToken('first');let lost=0,complete!:(r:Response)=>void;setSessionLostHandler(()=>lost++);
 class FakeXHR {
  upload={onprogress:null};status=401;responseText='';onload:(()=>Promise<void>)|null=null;
  open(){}setRequestHeader(){}send(){void this.onload?.();}abort(){}
 }
 const previous=Object.getOwnPropertyDescriptor(globalThis,'XMLHttpRequest');Object.defineProperty(globalThis,'XMLHttpRequest',{configurable:true,value:FakeXHR});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'XMLHttpRequest',previous);else Reflect.deleteProperty(globalThis,'XMLHttpRequest');});
 t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>{complete=resolve;}));
 const upload=uploadWithProgress('/channels/test/attachments',new File(['hello'],'hello.txt'),()=>undefined);
 setAccessToken('second');complete(new Response(null,{status:401}));
 await assert.rejects(upload.promise,(e:unknown)=>e instanceof ApiError&&e.code==='SESSION_CHANGED');
 assert.equal(lost,0);assert.equal(getAccessToken(),'second');
});
