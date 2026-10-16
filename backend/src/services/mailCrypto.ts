import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {config} from '../config.js';

const prefix='sealed:v1:';
const key=()=>createHash('sha256').update('concord-mail-v1\0').update(config.MAIL_ENCRYPTION_KEY??config.JWT_SECRET).digest();
export function sealMail(text:string,html:string):string {
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(),iv);
  const ciphertext=Buffer.concat([cipher.update(JSON.stringify({text,html}),'utf8'),cipher.final()]);
  return prefix+Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64');
}
export function openMail(row:{text_body:string;html_body:string}):{text:string;html:string} {
  if(!row.text_body.startsWith(prefix))return {text:row.text_body,html:row.html_body};
  const bytes=Buffer.from(row.text_body.slice(prefix.length),'base64');
  if(bytes.length<29)throw new Error('Invalid encrypted mail');
  const decipher=createDecipheriv('aes-256-gcm',key(),bytes.subarray(0,12));decipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
}
