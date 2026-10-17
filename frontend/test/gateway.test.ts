import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {Gateway} from '../src/websocket/gateway';
import {getAccessToken,setAccessToken} from '../src/api/client';

class Socket {
 static OPEN=1;static CONNECTING=0;static instances:Socket[]=[];
 readyState=0;sent:string[]=[];closes:number[]=[];
 onopen:(()=>void)|null=null;
 onmessage:((event:{data:string})=>void)|null=null;
 onclose:((event:{code:number})=>Promise<void>)|null=null;
 constructor(){Socket.instances.push(this);}
 open(){this.readyState=1;this.onopen?.();}
 send(text:string){this.sent.push(text);}
 message(t:string,d:unknown={}){this.onmessage?.({data:JSON.stringify({t,d})});}
 close(code=1000){this.readyState=3;this.closes.push(code);void this.onclose?.({code});}
}
const flush=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function harness(t:TestContext){
 const saved=new Map<string,PropertyDescriptor|undefined>();
 const win=Object.assign(new EventTarget(),{setTimeout,clearTimeout,setInterval,clearInterval});
 const doc=Object.assign(new EventTarget(),{visibilityState:'visible'});
 for(const [key,value] of Object.entries({window:win,document:doc,location:{protocol:'http:',host:'localhost'},navigator:{onLine:true},WebSocket:Socket})){
  saved.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
 }
 Socket.instances=[];setAccessToken('session');let revoked=0;
 t.mock.timers.enable({apis:['setTimeout','setInterval','Date'],now:1000});
 win.setTimeout=setTimeout;win.setInterval=setInterval;win.clearInterval=clearInterval;win.clearTimeout=clearTimeout;
 const gateway=new Gateway(()=>revoked++);
 t.after(async()=>{gateway.stop();await flush();t.mock.timers.tick(0);for(const [key,value] of saved){if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);}setAccessToken(null);});
 return {gateway,win,revoked:()=>revoked};
}

test('gateway retries a transient refresh failure without losing the session',async(t)=>{
 const h=harness(t);t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'BUSY',message:'busy'}},{status:503}));
 h.gateway.start();const first=Socket.instances[0]!;first.open();first.close(4001);await flush();
 assert.equal(h.revoked(),0);assert.equal(getAccessToken(),'session');assert.equal(h.gateway.status,'reconnecting');
 t.mock.timers.tick(1000);assert.equal(Socket.instances.length,2);
});

test('old socket callbacks cannot revoke a new connection or stop its heartbeats',async(t)=>{
 const h=harness(t);h.gateway.start();const old=Socket.instances[0]!;old.open();old.close(1006);
 h.win.dispatchEvent(new Event('online'));const current=Socket.instances[1]!;current.open();
 current.message('hello',{heartbeatInterval:1000});current.message('heartbeat:ack');current.message('ready');
 const before=current.sent.length;await old.onclose?.({code:4003});old.message('hello',{heartbeatInterval:999999});
 t.mock.timers.tick(1000);assert.equal(h.revoked(),0);assert.equal(h.gateway.status,'connected');assert.equal(current.sent.length,before+1);
});

test('missing heartbeat acknowledgement recovers a silent open socket',async(t)=>{
 const h=harness(t);h.gateway.start();const socket=Socket.instances[0]!;socket.open();socket.message('hello',{heartbeatInterval:1000});socket.message('ready');
 t.mock.timers.tick(10_000);assert.ok(socket.closes.includes(4000));await flush();
 t.mock.timers.tick(1000);assert.equal(Socket.instances.length,2);assert.equal(h.revoked(),0);
});

test('a stalled websocket handshake times out and can reconnect',async(t)=>{
 const h=harness(t);h.gateway.start();const connecting=Socket.instances[0]!;
 t.mock.timers.tick(15_000);await flush();assert.ok(connecting.closes.includes(4000));
 t.mock.timers.tick(1000);assert.equal(Socket.instances.length,2);assert.equal(h.revoked(),0);
});

test('heartbeats cannot leave an authenticated socket waiting for ready forever',async(t)=>{
 const h=harness(t);h.gateway.start();const socket=Socket.instances[0]!;socket.open();socket.message('hello',{heartbeatInterval:1000});
 for(let i=0;i<30;i++){socket.message('heartbeat:ack');t.mock.timers.tick(1000);}
 await flush();assert.ok(socket.closes.includes(4000));assert.equal(h.revoked(),0);
});

test('logout during refresh cannot revive the gateway or the old access token',async(t)=>{
 const h=harness(t);let complete!:(response:Response)=>void;
 t.mock.method(globalThis,'fetch',()=>new Promise<Response>(resolve=>{complete=resolve;}));
 h.gateway.start();const old=Socket.instances[0]!;old.open();old.close(4001);
 h.gateway.stop();setAccessToken(null);complete(Response.json({accessToken:'obsolete'}));await flush();t.mock.timers.tick(30_000);
 assert.equal(Socket.instances.length,1);assert.equal(h.gateway.status,'offline');assert.equal(getAccessToken(),null);assert.equal(h.revoked(),0);
});

test('repeated start is idempotent and offline/online creates one fresh connection',async(t)=>{
 const h=harness(t);h.gateway.start();h.gateway.start();assert.equal(Socket.instances.length,1);Socket.instances[0]!.open();
 Object.assign(navigator,{onLine:false});h.win.dispatchEvent(new Event('offline'));t.mock.timers.tick(60_000);assert.equal(Socket.instances.length,1);
 Object.assign(navigator,{onLine:true});h.win.dispatchEvent(new Event('online'));assert.equal(Socket.instances.length,2);
});
