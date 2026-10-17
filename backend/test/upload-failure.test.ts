import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import sharp from 'sharp';
import { pool } from '../src/db/pool.js';
import { storage } from '../src/storage/index.js';
import { upload } from '../src/services/attachmentService.js';

const channelId='44444444-4444-4444-8444-444444444444';
const userId='55555555-5555-4555-8555-555555555555';

for(const stage of ['preview','original','database'] as const){
  test(`failed attachment ${stage} write leaves no untracked storage objects`,async(t)=>{
    const objects=new Set<string>();
    // Real image metadata/preview processing, but isolated storage and SQL fault injection.
    const image=await sharp({create:{width:2000,height:1000,channels:3,background:'#334455'}}).png().toBuffer();
    const request=Readable.from([image]) as unknown as IncomingMessage;
    request.headers={'x-file-name':'large.png','content-length':String(image.length)};
    t.mock.method(pool,'query',(async(text:string)=>{
      if(text.includes('FROM channels c WHERE'))return {rows:[{id:channelId,server_id:null,type:'dm',name:'',slowmode_seconds:0,is_member:true,peers:[userId]}],rowCount:1};
      if(text.includes('INSERT INTO attachments'))throw new Error('database write interrupted');
      throw new Error(`Unexpected SQL in isolated upload fixture: ${text.slice(0,60)}`);
    }) as typeof pool.query);
    t.mock.method(storage,'put',async(key:string)=>{
      objects.add(key); // A write can fail after creating the object.
      if((stage==='preview'&&key.endsWith('.preview.webp'))||(stage==='original'&&!key.endsWith('.preview.webp')))
        throw new Error('storage write interrupted');
    });
    t.mock.method(storage,'delete',async(key:string)=>{objects.delete(key);});
    await assert.rejects(upload(request,channelId,userId));
    assert.equal(objects.size,0,'failed uploads have no database row for the orphan cleaner to discover');
  });
}
