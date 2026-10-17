import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {LocalStorage} from '../src/storage/local.js';
import {S3Storage} from '../src/storage/s3.js';

// This suite never connects to SQL/Redis; the media utility only needs a parsed config.
process.env.DATABASE_URL??='postgres://unit:unit@127.0.0.1/file_edge_test';
process.env.REDIS_URL??='redis://127.0.0.1/1';
process.env.JWT_SECRET??='file-edge-unit-secret-01234567890123456789';
process.env.STORAGE_DRIVER??='local';
const {sanitizeFilename,assertExtensionMatches,sniff}=await import('../src/services/mediaService.js');
const contents=async(stream:NodeJS.ReadableStream)=>{const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);};

test('long upload names retain their real extension after sanitation',()=>{
 const filename=sanitizeFilename('a'.repeat(150)+'.wav');
 assert.ok(filename.endsWith('.wav'));assert.ok([...filename].length<=120);
 assert.doesNotThrow(()=>assertExtensionMatches(filename,sniff(Buffer.from('RIFF0000WAVE'))!));
});
test('filename sanitation never cuts a Unicode code point before URL/header encoding',()=>{
 const filename=sanitizeFilename('a'+'\u{1D400}'.repeat(70)+'.txt');
 assert.doesNotThrow(()=>encodeURIComponent(filename));assert.ok(filename.endsWith('.txt'));assert.ok([...filename].length<=120);
});

test('local media ranges return 416 and length metadata when no requested bytes exist',async()=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'concord-file-edge-'));
 try{
  const storage=new LocalStorage(directory);await storage.put('attachment/file',Buffer.from('0123456789'),'audio/webm');
  for(const range of ['bytes=10-','bytes=99-100','bytes=-0','bytes=999999999999999999999999-']){
   const result=(await storage.get('attachment/file',range))!;const body=await contents(result.stream);
   assert.equal(result.status,416,range);assert.equal(result.contentRange,'bytes */10');assert.equal(result.size,0);assert.equal(body.length,0);
  }
  for(const [range,expected,header]of [['bytes=0-1','01','bytes 0-1/10'],['bytes=-3','789','bytes 7-9/10'],['bytes=8-999999999999999999999999','89','bytes 8-9/10']]){
   const result=(await storage.get('attachment/file',range))!;assert.equal((await contents(result.stream)).toString(),expected);assert.equal(result.status,206);assert.equal(result.contentRange,header);
  }
  for(const range of ['bytes=7-2','bytes=-','bytes=one-two','bytes=0-1,3-4','items=0-1']){
   const result=(await storage.get('attachment/file',range))!;assert.equal(result.status,200,range);assert.equal(result.contentRange,undefined);assert.equal((await contents(result.stream)).toString(),'0123456789');
  }
  await storage.put('attachment/empty',Buffer.alloc(0),'text/plain');
  for(const range of ['bytes=0-','bytes=0-0','bytes=-0']){
   const result=(await storage.get('attachment/empty',range))!;assert.equal(result.status,416,range);assert.equal(result.contentRange,'bytes */0');assert.equal((await contents(result.stream)).length,0);
  }
  for(const range of ['bytes=-1','bytes=7-2']){
   const result=(await storage.get('attachment/empty',range))!;assert.equal(result.status,200,range);assert.equal(result.contentRange,undefined);assert.equal((await contents(result.stream)).length,0);
  }
 }finally{
  assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('concord-file-edge-'));
  await rm(directory,{recursive:true,force:true});
 }
});

test('S3 416 responses pass through as media range failures instead of becoming HTTP 500',async(t)=>{
 t.mock.method(globalThis,'fetch',async()=>new Response('<InvalidRange/>',{status:416,headers:{'Content-Range':'bytes */10','Content-Type':'application/xml'}}));
 const storage=new S3Storage({endpoint:'https://storage.example.test',region:'unit',bucket:'unit',accessKey:'unit',secretKey:'unit'});
 const result=(await storage.get('attachment/file','bytes=99-'))!;
 assert.equal(result.status,416);assert.equal(result.contentRange,'bytes */10');assert.equal(result.size,0);assert.equal((await contents(result.stream)).length,0);
});

test('S3 providers without a 416 Content-Range use object metadata for its real length',async(t)=>{
 const methods:string[]=[];
 t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>{
  methods.push(init?.method??'GET');return init?.method==='HEAD'?new Response(null,{status:200,headers:{'Content-Length':'10','Content-Type':'audio/webm'}}):new Response('<InvalidRange/>',{status:416});
 });
 const storage=new S3Storage({endpoint:'https://storage.example.test',region:'unit',bucket:'unit',accessKey:'unit',secretKey:'unit'}),result=(await storage.get('attachment/file','bytes=99-'))!;
 assert.deepEqual(methods,['GET','HEAD']);assert.equal(result.status,416);assert.equal(result.contentRange,'bytes */10');assert.equal((await contents(result.stream)).length,0);
});
