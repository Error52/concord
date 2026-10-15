import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {lanBrowserArgs} from './lan-tls.mjs';
import path from 'node:path';

const BASE=process.env.BASE_URL ?? 'http://localhost:5180';
const OUT=process.env.MEDIA_DIR ?? path.resolve('../../qa-data/media-benchmark');
const QUALITY=process.env.QUALITY ?? 'auto';
const MOTION=process.env.MOTION !== '0';
const BENCH_ONLY=process.env.BENCH_ONLY === '1';
await mkdir(OUT,{recursive:true});
const browserArgs=['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required'];
browserArgs.push(...await lanBrowserArgs(BASE,process.env.LAN_CA_FILE));
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:browserArgs});
const result={source:'synthetic 1920x1080 canvas at 60 fps + stereo 220/880 Hz tones',browser:browser.version(),node:process.version,platform:process.platform,quality:QUALITY,motion:MOTION,errors:[]};
let a,b;
async function login(email,capture=false) {
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['microphone','camera']});
 await context.addInitScript(({capture,quality,motion})=>{
  localStorage.setItem('concord.settings.v1',JSON.stringify({streamQuality:quality}));
  const NativePC=window.RTCPeerConnection,NativeAudio=window.AudioContext;
  window.__mediaPeers=[];window.__mediaContexts=[];window.__mediaCaptures=[];window.__mediaRemoteCandidates=[];
  const NativeSocket=window.WebSocket;window.__mediaSockets=[];
  window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.__mediaSockets.push(this);}};
  window.RTCPeerConnection=class extends NativePC{
   constructor(...args){super(...args);window.__mediaPeers.push(this);}
   addIceCandidate(candidate){if(candidate?.candidate)window.__mediaRemoteCandidates.push(candidate.candidate);return super.addIceCandidate(candidate);}
  };
  window.AudioContext=class extends NativeAudio{constructor(...args){super(...args);window.__mediaContexts.push(this);}};
  const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async(o)=>{
   if(o.audio && window.__mediaDenyNextMic){window.__mediaDenyNextMic=false;throw new DOMException('Test permission denied','NotAllowedError');}
   const delay=o.audio?window.__mediaDelayNextMic:window.__mediaDelayNextCamera;
   if(o.audio)window.__mediaDelayNextMic=0;else window.__mediaDelayNextCamera=0;
   const stream=await gum(o);window.__mediaCaptures.push(stream);
   if(delay)await new Promise(r=>setTimeout(r,delay));
   return stream;
  };
  if(!capture)return;
  navigator.mediaDevices.getDisplayMedia=async()=>{
   const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
   const ctx=canvas.getContext('2d');let frame=0;
   const draw=()=>{
    const t=Date.now()>>>0;
    ctx.fillStyle='#fff';ctx.fillRect(0,0,1920,1080);
    ctx.fillStyle='#000';ctx.font='32px monospace';ctx.fillText('Concord · 1080p / 60 fps · video and stereo audio',40,70);
    for(let i=0;i<64;i++){ctx.fillStyle=i%2?'#fff':'#000';ctx.fillRect(40+i*8,160,8,100);}
    for(let i=0;i<32;i++){ctx.fillStyle=(t>>>i)&1?'#fff':'#000';ctx.fillRect(40+i*14,320,14,40);}
    if(motion){
     const x=(frame++*13)%1700;
     ctx.fillStyle='#7c6cff';ctx.fillRect(x,470,180,180);
     ctx.fillStyle='#14b8a6';ctx.fillRect(1700-x,720,180,180);
    }
   };
   draw();const timer=setInterval(draw,1000/60),stream=canvas.captureStream(60);
   const audio=new AudioContext({sampleRate:48000});await audio.resume();
   const dest=audio.createMediaStreamDestination(),merger=audio.createChannelMerger(2),osc=[];
   [220,880].forEach((freq,i)=>{const o=audio.createOscillator(),g=audio.createGain();o.frequency.value=freq;g.gain.value=.04;o.connect(g).connect(merger,0,i);o.start();osc.push(o);});
   merger.connect(dest);stream.addTrack(dest.stream.getAudioTracks()[0]);
   const video=stream.getVideoTracks()[0],stop=video.stop.bind(video);
   let stopped=false;
   video.stop=()=>{if(stopped)return;stopped=true;stop();clearInterval(timer);osc.forEach(o=>o.stop());stream.getAudioTracks().forEach(t=>t.stop());void audio.close();};
   window.__mediaCaptures.push(stream);
   const delay=window.__mediaDelayNextScreen;window.__mediaDelayNextScreen=0;
   if(delay)await new Promise(r=>setTimeout(r,delay));
   return stream;
  };
 },{capture,quality:QUALITY,motion:MOTION});
 const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message.slice(0,250)));
 await page.goto(`${BASE}/login`);await page.getByLabel('Email').fill(email);await page.getByLabel('Пароль').fill('demo12345');
 await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByRole('button',{name:'Demo Server',exact:true}).first().click();
 await page.locator('.chan',{hasText:'General'}).last().click();await page.getByText('Голосовая связь подключена').waitFor({timeout:20000});
 return page;
}
async function rtc(page) {
 return page.evaluate(async()=>{
  const rows=[];
  for(const pc of window.__mediaPeers){const s=await pc.getStats();for(const r of s.values()){
   if(r.type==='outbound-rtp'||r.type==='inbound-rtp')rows.push({type:r.type,kind:r.kind,ssrc:r.ssrc,codec:s.get(r.codecId)?.mimeType,bytes:r.bytesSent??r.bytesReceived,frames:r.framesDecoded??r.framesEncoded,width:r.frameWidth,height:r.frameHeight,fps:r.framesPerSecond,dropped:r.framesDropped,limited:r.qualityLimitationReason,encodeMs:r.framesEncoded?1000*r.totalEncodeTime/r.framesEncoded:null,bufferMs:r.jitterBufferEmittedCount?1000*r.jitterBufferDelay/r.jitterBufferEmittedCount:null,packetsLost:r.packetsLost});
  }}
  return rows;
 });
}
async function noCapture(page) {
 try {await page.waitForFunction(()=>window.__mediaCaptures.every(s=>s.getTracks().every(t=>t.readyState==='ended')) && window.__mediaContexts.every(c=>c.state!=='running'),null,{timeout:10000});}
 catch(error){console.log('Capture cleanup',await page.evaluate(()=>({streams:window.__mediaCaptures.map(s=>s.getTracks().map(t=>({kind:t.kind,state:t.readyState}))),contexts:window.__mediaContexts.map(c=>c.state)})));throw error;}
}
try {
 a=await login('alice@concord.local',true);b=await login('bob@concord.local');
 result.logicalCores=await a.evaluate(()=>navigator.hardwareConcurrency);
 const start=Date.now();await a.locator('.stage-controls').getByRole('button',{name:'Демонстрация экрана',exact:true}).click();
 await b.waitForFunction(()=>document.querySelector('.tile.screen video')?.readyState>=2);
 result.firstFrameMs=Date.now()-start;
 result.latency=await b.locator('.tile.screen video').evaluate(v=>new Promise((resolve,reject)=>{
  const canvas=document.createElement('canvas');canvas.width=448;canvas.height=40;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});const delays=[];let callbacks=0,invalid=0;
  const started=performance.now(),deadline=setTimeout(()=>reject(new Error('No sustained decoded video')),16000);
  const next=(_now,meta)=>{
   callbacks++;
   if(callbacks%3===0){
    const scale=v.videoWidth/1920;ctx.drawImage(v,40*scale,320*scale,448*scale,40*scale,0,0,448,40);
    const pixels=ctx.getImageData(0,20,448,1).data;let time=0;
    for(let i=0;i<32;i++)if(pixels[(i*14+7)*4]>127)time=(time | (1<<i))>>>0;
    const displayed=(performance.timeOrigin+meta.expectedDisplayTime)%4294967296;
    const delta=(displayed-time+4294967296)%4294967296;
    if(delta<2000)delays.push(delta);else invalid++;
   }
   if(performance.now()-started>=10000 && delays.length>=30){
    clearTimeout(deadline);const sorted=delays.toSorted((x,y)=>x-y);
    resolve({samples:delays.length,invalid,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],presentedFps:callbacks*1000/(performance.now()-started),width:v.videoWidth,height:v.videoHeight});
   }else v.requestVideoFrameCallback(next);
  };v.requestVideoFrameCallback(next);
 }));
 result.publisher=await rtc(a);result.receiver=await rtc(b);
 result.transport=await b.evaluate(async()=>{
  const rows=[];for(const pc of window.__mediaPeers){const s=await pc.getStats();for(const r of s.values()){
   if(r.type==='candidate-pair'&&r.state==='succeeded'&&r.nominated){const remote=s.get(r.remoteCandidateId);rows.push({remoteAddress:remote?.address,remotePort:remote?.port,protocol:remote?.protocol,remoteType:remote?.candidateType});}
  }}return rows;
 });
 result.advertisedMediaAddresses=await b.evaluate(()=>[...new Set([
  ...window.__mediaRemoteCandidates,
  ...window.__mediaPeers.flatMap(pc=>(pc.remoteDescription?.sdp??'').split('\r\n').filter(l=>l.startsWith('a=candidate:'))),
 ].map(line=>line.split(' ')[4]).filter(Boolean))]);
 if(process.env.LAN_CA_FILE){
  assert.ok(result.advertisedMediaAddresses.includes(new URL(BASE).hostname),'LiveKit advertises the configured LAN server');
  assert.ok(result.transport.some(r=>r.remotePort===7882&&r.protocol==='udp'),'media flows over the configured UDP port');
 }
 assert.ok(result.latency.samples>=30 && result.latency.invalid<result.latency.samples*.1,'frame timestamp survives encoding');
 assert.ok(result.latency.p95Ms<500,'local source-to-display p95 below 500 ms');
 assert.ok(result.latency.width>=1280 && result.latency.height>=720,'received video remains HD');
 if(QUALITY==='720p30')assert.ok(result.latency.width<=1280 && result.latency.height<=720,'720p mode caps actual encoded pixels even if capture ignores ideal dimensions');
 if(QUALITY.startsWith('1080p'))assert.ok(result.latency.width<=1920 && result.latency.height<=1080,'1080p mode caps actual encoded pixels');
 assert.ok(result.receiver.some(r=>r.kind==='video'&&r.frames>(QUALITY==='text'?90:180)),'sustained video decoded');
 assert.ok(result.receiver.filter(r=>r.kind==='audio'&&r.bytes>0).length>=2,'voice and stereo source both delivered');
 await b.screenshot({path:path.join(OUT,'stream.png')});
 result.stereo=await b.evaluate(async()=>{
  const ctx=new AudioContext({sampleRate:48000});await ctx.resume();
  try {
   for(const pc of window.__mediaPeers)for(const receiver of pc.getReceivers()){
    if(receiver.track.kind!=='audio'||receiver.track.readyState!=='live')continue;
    const src=ctx.createMediaStreamSource(new MediaStream([receiver.track])),split=ctx.createChannelSplitter(2),analysers=[ctx.createAnalyser(),ctx.createAnalyser()];
    src.connect(split);analysers.forEach((x,i)=>{x.fftSize=8192;split.connect(x,i);});
    await new Promise(r=>setTimeout(r,350));
    const levels=analysers.map(x=>{
     const data=new Float32Array(x.frequencyBinCount);x.getFloatFrequencyData(data);
     const peak=f=>Math.max(...data.slice(Math.round((f-15)*x.fftSize/ctx.sampleRate),Math.round((f+15)*x.fftSize/ctx.sampleRate)));
     return {low:peak(220),high:peak(880)};
    });src.disconnect();split.disconnect();
    if(levels[0].low>-60 && levels[1].high>-60 && levels[0].low-levels[0].high>15 && levels[1].high-levels[1].low>15)return levels;
   }
   return null;
  }finally{await ctx.close();}
 });
 assert.ok(result.stereo,'left and right test tones stay separated after Opus stereo delivery');
 if(BENCH_ONLY){for(const p of [a,b]){await p.locator('.stage-controls').getByRole('button',{name:'Отключиться',exact:true}).click();await noCapture(p);}result.cleanDisconnect=true;}
 else {
 await b.context().setOffline(true);
 await b.evaluate(()=>{for(const s of window.__mediaSockets)if(s.readyState===WebSocket.OPEN)s.close(4000,'test signaling interruption');});
 await b.waitForTimeout(2000);await b.context().setOffline(false);
 await b.waitForFunction(()=>window.__mediaSockets.some(s=>s.url.includes('/livekit')&&s.readyState===WebSocket.OPEN),null,{timeout:20000});
 await b.locator('.tile.screen video').evaluate(v=>new Promise((resolve,reject)=>{
  let n=0;const timeout=setTimeout(()=>reject(new Error('Video did not resume after signaling interruption')),10000);
  const frame=()=>{if(++n>=4){clearTimeout(timeout);resolve(true);}else v.requestVideoFrameCallback(frame);};v.requestVideoFrameCallback(frame);
 }));result.signalingRecovery=true;
 const bob=a.locator('.tile:not(.screen)',{has:a.locator('.tile-label button',{hasText:'Bob'})});
 await bob.click({button:'right'});await a.getByRole('menuitem',{name:'Серверный мут',exact:true}).click();
 await b.getByText('Модератор отключил вам микрофон на сервере').waitFor();
 await bob.click({button:'right'});await a.getByRole('menuitem',{name:'Снять серверный мут',exact:true}).click();
 await b.waitForFunction(()=>window.__mediaPeers.some(pc=>pc.getSenders().some(s=>s.track?.kind==='audio'&&s.track.readyState==='live')));
 // The unmuted publication must actually carry new bytes, rather than merely show an icon.
 const old=await rtc(b);await b.waitForTimeout(1500);const resumed=await rtc(b);
 assert.ok(resumed.some(r=>r.type==='outbound-rtp'&&r.kind==='audio'&&r.bytes>(old.find(o=>o.ssrc===r.ssrc)?.bytes??0)+100),'server unmute restores actual voice transmission');result.serverMuteRecovery=true;
 const mic=b.locator('.stage-controls').getByRole('button',{name:'Микрофон',exact:true});
 await mic.click();const deaf=b.locator('.stage-controls').getByRole('button',{name:'Звук',exact:true});await deaf.click();await deaf.click();
 assert.equal(await mic.getAttribute('aria-pressed'),'false','undeafen preserves a deliberately muted mic');await mic.click();result.mutePreserved=true;
 await a.locator('.stage-controls').getByRole('button',{name:'Сменить источник демонстрации',exact:true}).click();
 await b.waitForFunction(()=>document.querySelector('.tile.screen video')?.readyState>=2);
 result.sourceSwitch=true;
 for(const p of [a,b])await p.locator('.stage-controls').getByRole('button',{name:'Отключиться',exact:true}).click();
 await noCapture(a);await noCapture(b);result.cleanDisconnect=true;
 await a.evaluate(()=>{window.__mediaDelayNextMic=800;});
 await a.getByRole('button',{name:'Подключиться',exact:true}).click();await a.locator('.stage-controls').waitFor();
 await a.locator('.stage-controls').getByRole('button',{name:'Отключиться',exact:true}).click();await a.waitForTimeout(1000);await noCapture(a);result.cancelPendingMic=true;
 await a.evaluate(()=>{window.__mediaDenyNextMic=true;});
 await a.getByRole('button',{name:'Подключиться',exact:true}).click();await a.getByText(/Нет разрешения на использование микрофона/).waitFor();
 const retry=a.locator('.stage-controls').getByRole('button',{name:'Микрофон',exact:true});
 assert.equal(await retry.getAttribute('aria-pressed'),'false');await retry.click();
 await a.waitForFunction(()=>window.__mediaPeers.some(pc=>pc.getSenders().some(s=>s.track?.kind==='audio'&&s.track.readyState==='live')));result.permissionRetry=true;
 await a.evaluate(()=>{window.__mediaDelayNextScreen=800;});await a.locator('.stage-controls').getByRole('button',{name:'Демонстрация экрана',exact:true}).click();
 await a.locator('.stage-controls').getByRole('button',{name:'Отключиться',exact:true}).click();await a.waitForTimeout(1100);await noCapture(a);result.cancelPendingScreen=true;
 await a.getByRole('button',{name:'Подключиться',exact:true}).click();await a.locator('.stage-controls').waitFor();
 await a.evaluate(()=>{window.__mediaDelayNextCamera=800;});await a.locator('.stage-controls').getByRole('button',{name:'Камера',exact:true}).click();
 await a.locator('.stage-controls').getByRole('button',{name:'Отключиться',exact:true}).click();await a.waitForTimeout(1100);await noCapture(a);result.cancelPendingCamera=true;
 }
 assert.equal(result.errors.length,0,'no unhandled browser errors');
 console.log(JSON.stringify(result,null,2));
}catch(error){result.failure=error.message.split('\n')[0];if(a)await a.screenshot({path:path.join(OUT,'failure-a.png')});if(b)await b.screenshot({path:path.join(OUT,'failure-b.png')});console.log(JSON.stringify(result,null,2));throw error;}
finally{await writeFile(path.join(OUT,'results.json'),JSON.stringify(result,null,2));await browser.close();}
