import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';

/**
 * Minimal SMTP client (EHLO, optional STARTTLS, AUTH PLAIN). Enough for Mailpit in development
 * and for typical transactional relays in production.
 */
type Sock = net.Socket | tls.TLSSocket;

class SmtpSession {
  private buffer = '';
  private replies: string[] = [];
  private failure: Error | null = null;
  private waiters: Array<{resolve:(line:string)=>void;reject:(err:Error)=>void;timer:NodeJS.Timeout}> = [];
  private onData = (chunk:string) => {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.search(/^\d{3} .*\r\n/m)) >= 0) {
      const end = this.buffer.indexOf('\r\n', idx) + 2;
      const reply = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const waiter=this.waiters.shift();
      if(waiter){clearTimeout(waiter.timer);waiter.resolve(reply);}else this.replies.push(reply);
    }
  };
  private onError = (err:Error) => this.fail(err);
  private onClose = () => this.fail(new Error('SMTP connection closed'));

  private fail(err:Error):void {
    this.failure ??= err;
    for(const waiter of this.waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject(err);}
  }

  constructor(private sock: Sock, private timeoutMs: number) {
    this.attach(sock);
  }

  private attach(sock: Sock): void {
    sock.setEncoding('utf8');
    sock.on('data',this.onData).on('error',this.onError).on('close',this.onClose);
    sock.setTimeout(this.timeoutMs,()=>{this.fail(new Error('SMTP timeout'));sock.destroy();});
  }

  read(): Promise<string> {
    if(this.failure)return Promise.reject(this.failure);
    const reply=this.replies.shift();
    if(reply)return Promise.resolve(reply);
    return new Promise((resolve, reject) => {
      const timer=setTimeout(()=>{this.fail(new Error('SMTP timeout'));this.sock.destroy();},this.timeoutMs);
      this.waiters.push({resolve,reject,timer});
    });
  }

  async cmd(line: string, expect: number): Promise<string> {
    this.sock.write(line + '\r\n');
    const reply = await this.read();
    if (!reply.startsWith(String(expect))) throw new Error(`SMTP unexpected reply to ${line.split(' ')[0]}: ${reply.slice(0, 3)}`);
    return reply;
  }

  async upgrade(host: string): Promise<void> {
    const old=this.sock;
    old.off('data',this.onData).off('error',this.onError).off('close',this.onClose);
    old.setTimeout(0);
    // RFC 3207: no pre-TLS reply or capability is trusted after STARTTLS.
    this.buffer='';this.replies=[];
    this.sock=tls.connect({socket:old as net.Socket,host,servername:net.isIP(host)?undefined:host});
    this.attach(this.sock);
    await this.connected(true);
  }

  connected(secure: boolean): Promise<void> {
    const socket=this.sock,event=secure?'secureConnect':'connect';
    return new Promise((resolve,reject)=>{
      const finish=(err?:Error)=>{clearTimeout(timer);socket.off(event,onReady);socket.off('error',onFailure);socket.off('close',onClosed);err?reject(err):resolve();};
      const onReady=()=>finish(),onFailure=(err:Error)=>finish(err),onClosed=()=>finish(this.failure??new Error('SMTP connection closed before handshake'));
      const timer=setTimeout(()=>{const err=new Error('SMTP connection/handshake timeout');this.fail(err);finish(err);socket.destroy();},this.timeoutMs);
      socket.once(event,onReady).once('error',onFailure).once('close',onClosed);
    });
  }

  end(): void {
    this.sock.destroy();
  }
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`;
}

export type SmtpOptions = Pick<typeof config,'SMTP_HOST'|'SMTP_PORT'|'SMTP_TLS'|'SMTP_STARTTLS'|'SMTP_USER'|'SMTP_PASSWORD'|'MAIL_FROM'> & {timeoutMs?:number};

export async function sendMail(mail: Mail, options:SmtpOptions=config): Promise<void> {
  if (!options.SMTP_HOST) throw new Error('SMTP is not configured');
  if ((options.SMTP_USER || options.SMTP_PASSWORD) && !(options.SMTP_USER && options.SMTP_PASSWORD)) throw new Error('SMTP requires both username and password');
  if (options.SMTP_USER && !options.SMTP_TLS && !options.SMTP_STARTTLS) throw new Error('SMTP authentication requires TLS or STARTTLS');
  if([mail.to,mail.subject,options.MAIL_FROM].some(v=>/[\r\n]/.test(v)))throw new Error('Invalid email header');
  const host = options.SMTP_HOST;
  const sock = options.SMTP_TLS ? tls.connect({host,port:options.SMTP_PORT,servername:net.isIP(host)?undefined:host}) : net.connect({ host, port: options.SMTP_PORT });
  // Listen before connect: the server may send its greeting immediately.
  const s = new SmtpSession(sock,options.timeoutMs??15_000);
  try {
    await s.connected(options.SMTP_TLS);
    const greeting=await s.read();
    if(!greeting.startsWith('220'))throw new Error('SMTP invalid greeting');
    await s.cmd(`EHLO concord.local`, 250);
    if (options.SMTP_STARTTLS && !options.SMTP_TLS) {
      await s.cmd('STARTTLS', 220);
      await s.upgrade(host);
      await s.cmd(`EHLO concord.local`, 250);
    }
    if (options.SMTP_USER && options.SMTP_PASSWORD) {
      const token = Buffer.from(`\0${options.SMTP_USER}\0${options.SMTP_PASSWORD}`).toString('base64');
      await s.cmd(`AUTH PLAIN ${token}`, 235);
    }
    const from = /<([^>]+)>/.exec(options.MAIL_FROM)?.[1] ?? options.MAIL_FROM;
    await s.cmd(`MAIL FROM:<${from}>`, 250);
    await s.cmd(`RCPT TO:<${mail.to}>`, 250);
    await s.cmd('DATA', 354);
    const boundary = `b_${randomUUID()}`;
    const body = [
      `From: ${options.MAIL_FROM}`,
      `To: <${mail.to}>`,
      `Subject: ${encodeHeader(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomUUID()}@concord.local>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(mail.text).toString('base64').replace(/.{76}/g, '$&\r\n'),
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(mail.html).toString('base64').replace(/.{76}/g, '$&\r\n'),
      `--${boundary}--`,
      '.',
    ].join('\r\n');
    await s.cmd(body, 250);
    await s.cmd('QUIT', 221).catch(() => undefined);
  } finally {
    s.end();
  }
}
