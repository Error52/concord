import {test} from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
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
