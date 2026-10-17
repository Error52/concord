import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audioOnlyMp4,audioOnlyWebm} from '../src/utils/mediaTracks.js';
import {LocalGifProvider,localGifBytes} from '../src/services/gif/local.js';

function ebml(id:number[],body:Buffer){assert.ok(body.length<127);return Buffer.concat([Buffer.from(id),Buffer.from([128+body.length]),body]);}
function webm(types:number[]){return Buffer.concat([ebml([0x1a,0x45,0xdf,0xa3],Buffer.alloc(0)),ebml([0x18,0x53,0x80,0x67],ebml([0x16,0x54,0xae,0x6b],Buffer.concat(types.map(type=>ebml([0xae],ebml([0x83],Buffer.from([type])))))))]);}
function atom(type:string,body:Buffer){const header=Buffer.alloc(8);header.writeUInt32BE(body.length+8);header.write(type,4);return Buffer.concat([header,body]);}
function mp4(handlers:string[]){return Buffer.concat([atom('ftyp',Buffer.from('isom0000')),atom('moov',Buffer.concat(handlers.map(handler=>atom('trak',atom('mdia',atom('hdlr',Buffer.concat([Buffer.alloc(8),Buffer.from(handler)])))))))]);}

test('container track metadata distinguishes audio messages from video and ignores payload strings',()=>{
 assert.equal(audioOnlyWebm(webm([2])),true);assert.equal(audioOnlyWebm(webm([1,2])),false);
 assert.equal(audioOnlyWebm(Buffer.concat([webm([]),Buffer.from('A_OPUS audio/webm')])),false);
 assert.equal(audioOnlyMp4(mp4(['soun'])),true);assert.equal(audioOnlyMp4(mp4(['vide','soun'])),false);
 assert.equal(audioOnlyMp4(atom('mdat',Buffer.from('soun'))),false);
 for(const binary of [Buffer.from([0]),Buffer.from([0x1a,0x45,0xdf]),Buffer.alloc(1024,255)]){assert.equal(audioOnlyWebm(binary),false);assert.equal(audioOnlyMp4(binary),false);}
});

test('local reactions are actual animated GIFs and use only the configured HTTPS origin',async()=>{
 const provider=new LocalGifProvider('https://chat.example.com:8443');
 const popular=await provider.trending(null,'ru_RU');assert.equal(popular.items.length,6);assert.equal(popular.next,null);
 for(const gif of popular.items){
  const url=new URL(gif.url);assert.equal(url.origin,'https://chat.example.com:8443');assert.equal(gif.previewUrl,gif.url);
  const bytes=localGifBytes(url.pathname.split('/').at(-1)!)!;assert.equal(bytes.subarray(0,6).toString(),'GIF89a');assert.ok(bytes.includes(Buffer.from('NETSCAPE2.0')));assert.ok(bytes.length>1000);
  assert.equal(provider.byUrl(gif.url)?.id,gif.id);assert.equal(provider.byUrl(gif.url+'?injected=1'),null);
 }
 assert.equal((await provider.search('trending',null,'en_US')).items[0]?.id,'fire-v1');
 assert.equal((await provider.search('cats with spaces',null,'en_US')).items.length,0);
 assert.equal((await provider.search((await provider.categories('en_US'))[0]!.query,null,'en_US')).items.length,6);
 assert.equal(localGifBytes('../private.gif'),null);assert.equal(localGifBytes('missing-v1.gif'),null);
});
