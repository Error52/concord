import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {X509Certificate,createHash} from 'node:crypto';

// Validate the real certificate chain against the supplied CA, then pin the server leaf
// in the isolated test Chrome. No OS trust-store changes or blanket certificate bypass.
export async function lanBrowserArgs(base,caFile){
  if(!caFile)return [];
  const ca=await readFile(caFile);
  const pin=await new Promise((resolve,reject)=>{
    const req=https.get(base+'/api/health',{ca,timeout:5000},res=>{
      try{
        if(res.statusCode!==200||!res.socket.authorized)throw new Error('LAN HTTPS validation failed');
        const leaf=new X509Certificate(res.socket.getPeerCertificate().raw);
        resolve(createHash('sha256').update(leaf.publicKey.export({type:'spki',format:'der'})).digest('base64'));
        res.resume();
      }catch(err){reject(err);res.destroy();}
    });
    req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('LAN TLS timed out')));
  });
  return ['--ignore-certificate-errors-spki-list='+pin];
}
