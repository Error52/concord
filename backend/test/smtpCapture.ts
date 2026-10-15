import net from 'node:net';
export async function captureSmtp(){
  const messages:{recipient:string;body:string}[]=[],sockets=new Set<net.Socket>();
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('error',()=>undefined);socket.on('close',()=>sockets.delete(socket));
    socket.write('220 capture SMTP\r\n');let buffer='',recipient='',body:string|null=null;
    socket.on('data',chunk=>{
      buffer+=chunk.toString();let end:number;
      while((end=buffer.indexOf('\r\n'))>=0){
        const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
        if(body!==null){if(line==='.'){messages.push({recipient,body});body=null;socket.write('250 queued\r\n');}else body+=line+'\r\n';continue;}
        if(line.startsWith('RCPT TO:'))recipient=line.match(/<([^>]+)>/)?.[1]??'';
        if(line==='DATA'){body='';socket.write('354 send\r\n');}
        else if(line==='QUIT')socket.end('221 bye\r\n');else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {messages,options:{SMTP_HOST:'127.0.0.1',SMTP_PORT:(server.address() as net.AddressInfo).port,SMTP_USER:undefined,SMTP_PASSWORD:undefined,SMTP_TLS:false,SMTP_STARTTLS:false},
    close:async()=>{sockets.forEach(s=>s.destroy());await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
