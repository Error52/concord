import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sealMail,openMail} from '../src/services/mailCrypto.js';
test('mail bodies are encrypted with unique nonces and authenticated against tampering',()=>{
 const text='Reset https://example.com/reset?token=live-secret',html='<a>live-secret</a>';
 const a=sealMail(text,html),b=sealMail(text,html);assert.notEqual(a,b);assert.ok(!a.includes('live-secret'));
 assert.deepEqual(openMail({text_body:a,html_body:''}),{text,html});
 const bytes=Buffer.from(a.slice('sealed:v1:'.length),'base64');bytes[bytes.length-1]^=1;
 assert.throws(()=>openMail({text_body:'sealed:v1:'+bytes.toString('base64'),html_body:''}));
 assert.deepEqual(openMail({text_body:text,html_body:html}),{text,html},'legacy queue rows remain readable while being migrated');
});
