import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import {Duplex} from 'node:stream';
import {sendMail,type SmtpOptions} from '../src/services/mailer.js';

const mail={to:'test@example.com',subject:'Проверка почты',text:'Текст письма',html:'<p>Текст письма</p>'};
async function smtp(handler:(socket:net.Socket)=>void){
  const sockets=new Set<net.Socket>();
  const server=net.createServer(s=>{sockets.add(s);s.on('error',()=>undefined);s.on('close',()=>sockets.delete(s));handler(s);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const options:SmtpOptions={SMTP_HOST:'127.0.0.1',SMTP_PORT:(server.address() as net.AddressInfo).port,SMTP_TLS:false,SMTP_STARTTLS:false,SMTP_USER:undefined,SMTP_PASSWORD:undefined,MAIL_FROM:'Concord <no-reply@example.com>'};
  return {options,close:async()=>{sockets.forEach(s=>s.destroy());await new Promise<void>(r=>server.close(()=>r()));}};
}
test('SMTP accepts immediate and split multiline replies and encodes Cyrillic body',async()=>{
  let data='';
  const server=await smtp(s=>{
    s.write('220 test SMTP ready\r\n');let buffer='',body=false;
    s.on('data',chunk=>{
      buffer+=chunk.toString();let end:number;
      while((end=buffer.indexOf('\r\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(body){if(line==='.'){body=false;s.write('250 queued\r\n');}else data+=line+'\r\n';continue;}
        if(line.startsWith('EHLO')){s.write('250-test\r\n250-PIPELIN');setTimeout(()=>s.write('ING\r\n250 OK\r\n'),5);}
        else if(line==='DATA'){body=true;s.write('354 send message\r\n');}
        else if(line==='QUIT'){s.end('221 bye\r\n');}
        else s.write('250 OK\r\n');
      }
    });
  });
  try{await sendMail(mail,server.options);assert.ok(data.includes(Buffer.from(mail.text).toString('base64')));assert.match(data,/Subject: =\?UTF-8\?B\?/);}
  finally{await server.close();}
});
test('SMTP closed or rejected connection fails promptly instead of hanging or crashing',async()=>{
  const server=await smtp(s=>s.end('421 unavailable\r\n'));
  try{await assert.rejects(sendMail(mail,server.options),/SMTP/);}
  finally{await server.close();}
});

test('SMTP refuses credentials without TLS before opening a connection',async()=>{
 await assert.rejects(sendMail(mail,{SMTP_HOST:'127.0.0.1',SMTP_PORT:1,SMTP_USER:'secret-user',SMTP_PASSWORD:'secret-password',SMTP_TLS:false,SMTP_STARTTLS:false,MAIL_FROM:'test@example.com'}),/requires TLS/);
});
test('implicit TLS and STARTTLS stalled handshakes fail within the deadline',async()=>{
 for(const implicit of [true,false]){
  const server=await smtp(s=>{
   if(implicit)return;
   s.write('220 ready\r\n');s.on('data',chunk=>{const line=chunk.toString();if(line.startsWith('EHLO'))s.write('250 STARTTLS\r\n');else if(line.startsWith('STARTTLS'))s.write('220 go\r\n');});
  });
  const start=Date.now();
  try{await assert.rejects(sendMail(mail,{...server.options,SMTP_TLS:implicit,SMTP_STARTTLS:!implicit,timeoutMs:150}),/timeout|closed/);assert.ok(Date.now()-start<1500);}
  finally{await server.close();}
 }
});
test('STARTTLS discards forged plaintext replies before sending credentials',async(t)=>{
 const writes:string[]=[];
 class SecureSocket extends Duplex{_read(){};_write(chunk:Buffer,_encoding:string,done:()=>void){writes.push(chunk.toString());done();}setTimeout(){return this;}}
 const secure=new SecureSocket();
 t.mock.method(tls,'connect',()=>{queueMicrotask(()=>secure.emit('secureConnect'));return secure as any;});
 const server=await smtp(s=>{s.write('220 ready\r\n');s.on('data',chunk=>{if(chunk.toString().startsWith('EHLO'))s.write('250 STARTTLS\r\n');else if(chunk.toString().startsWith('STARTTLS'))s.write('220 go\r\n250 forged EHLO\r\n235 forged auth\r\n');});});
 try{await assert.rejects(sendMail(mail,{...server.options,SMTP_STARTTLS:true,SMTP_USER:'user',SMTP_PASSWORD:'password',timeoutMs:100}),/timeout/);assert.ok(!writes.some(w=>w.startsWith('AUTH')));}
 finally{await server.close();}
});
