import {before,after,test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {startServer,Client,type Harness} from './helpers.js';
import {S3Storage} from '../src/storage/s3.js';
import {pool} from '../src/db/pool.js';
import {storage} from '../src/storage/index.js';

let h:Harness;
before(async()=>{h=await startServer();});
after(async()=>{await h?.close();});

test('attachment HTTP preserves long names and returns empty authorized range errors',async()=>{
 const uploader=await new Client(h.base).register('file_edge_uploader'),outsider=await new Client(h.base).register('file_edge_outsider');
 const server=await uploader.post('/api/servers',{name:'File edge cases'}),channel=server.body.channels.find((c:any)=>c.type==='text');
 assert.equal(server.status,201);
 for(const name of ['a'.repeat(150)+'.txt','a'+'\u{1D400}'.repeat(70)+'.txt']){
  const up=await uploader.req('POST',`/api/channels/${channel.id}/attachments`,Buffer.from('abcdefghij'),{'X-File-Name':encodeURIComponent(name)});
  assert.equal(up.status,201);assert.ok(up.body.filename.endsWith('.txt'));assert.ok([...up.body.filename].length<=120);
  try{
   const full=await uploader.get(up.body.url);assert.equal(full.status,200);assert.equal(full.body,'abcdefghij');
   assert.equal(full.headers.get('content-disposition'),`attachment; filename*=UTF-8''${encodeURIComponent(up.body.filename)}`);
   for(const range of ['bytes=10-','bytes=-0','bytes=999999999999999999999-']){
    const rejected=await uploader.req('GET',up.body.url,undefined,{Range:range});
    assert.equal(rejected.status,416,range);assert.equal(rejected.headers.get('content-range'),'bytes */10');assert.equal(rejected.headers.get('content-length'),'0');assert.equal(rejected.body,null);
   }
   for(const range of ['bytes=7-2','bytes=-','bytes=one-two']){
    const ignored=await uploader.req('GET',up.body.url,undefined,{Range:range});assert.equal(ignored.status,200,range);assert.equal(ignored.body,'abcdefghij');assert.equal(ignored.headers.get('content-range'),null);
   }
   const partial=await uploader.req('GET',up.body.url,undefined,{Range:'bytes=-3'});assert.equal(partial.status,206);assert.equal(partial.body,'hij');assert.equal(partial.headers.get('content-range'),'bytes 7-9/10');
   assert.equal((await outsider.req('GET',up.body.url,undefined,{Range:'bytes=10-'})).status,404,'range cannot expose private attachment size');
   const anonymous=await fetch(h.base+up.body.url,{headers:{Range:'bytes=10-'}});assert.equal(anonymous.status,401);await anonymous.body?.cancel();
   const row=(await pool.query<{storage_key:string}>('SELECT storage_key FROM attachments WHERE id=$1',[up.body.id])).rows[0]!;
   await storage.put(row.storage_key,Buffer.alloc(0),'text/plain');
   const emptyRejected=await uploader.req('GET',up.body.url,undefined,{Range:'bytes=0-'});assert.equal(emptyRejected.status,416);assert.equal(emptyRejected.headers.get('content-range'),'bytes */0');assert.equal(emptyRejected.body,null);
   const emptySuffix=await uploader.req('GET',up.body.url,undefined,{Range:'bytes=-1'});assert.equal(emptySuffix.status,200);assert.equal(emptySuffix.headers.get('content-range'),null);assert.equal(emptySuffix.body,null);
  }finally{assert.equal((await uploader.del(`/api/attachments/${up.body.id}`)).status,204);}
 }
});

test('S3 range errors use real HTTP metadata and malformed ranges are ignored',async(t)=>{
 const requests:{method:string;path:string;range:string|undefined;signed:boolean}[]=[];
 const stub=createServer((req,res)=>{
  requests.push({method:req.method!,path:req.url!,range:req.headers.range,signed:req.headers.authorization?.startsWith('AWS4-HMAC-SHA256 ')??false});
  if(req.url==='/unit/full'){res.writeHead(200,{'Content-Length':'10'});res.end('abcdefghij');return;}
  if(req.method==='HEAD'){res.writeHead(200,{'Content-Length':req.url==='/unit/empty'?'0':'10','Content-Type':'audio/webm'});res.end();return;}
  res.writeHead(416,req.url==='/unit/header'?{'Content-Range':'bytes */10'}:{});res.end('<Error><Code>InvalidRange</Code></Error>');
 });
 await new Promise<void>(resolve=>stub.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await new Promise<void>(resolve=>stub.close(()=>resolve()));});
 const endpoint=`http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
 const s3=new S3Storage({endpoint,bucket:'unit',region:'unit',accessKey:'unit-fixture',secretKey:'unit-fixture'});
 for(const [key,expected] of [['header','bytes */10'],['metadata','bytes */10'],['empty','bytes */0']]){
  const object=(await s3.get(key!,'bytes=99-'))!,chunks:Buffer[]=[];
  for await(const chunk of object.stream)chunks.push(Buffer.from(chunk));
  assert.equal(object.status,416);assert.equal(object.contentRange,expected);assert.equal(object.size,0);assert.equal(Buffer.concat(chunks).length,0);
 }
 const object=(await s3.get('full','bytes=7-2'))!,chunks:Buffer[]=[];
 for await(const chunk of object.stream)chunks.push(Buffer.from(chunk));
 assert.equal(object.status,200);assert.equal(Buffer.concat(chunks).toString(),'abcdefghij');
 assert.deepEqual(requests.map(({method,path,range})=>[method,path,range]),[
  ['GET','/unit/header','bytes=99-'],['GET','/unit/metadata','bytes=99-'],['HEAD','/unit/metadata',undefined],
  ['GET','/unit/empty','bytes=99-'],['HEAD','/unit/empty',undefined],['GET','/unit/full',undefined],
 ]);
 assert.ok(requests.every(request=>request.signed),'HTTP requests pass through the real SigV4 signing path');
});
