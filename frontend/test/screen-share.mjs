import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
const BASE=process.env.BASE_URL ?? 'http://localhost:5180';
const dir=process.env.SCREEN_DIR ?? path.resolve('../../qa-data/screen');
await mkdir(dir,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const result={errors:[]};
let a,b;
async function user(email, capture=false) {
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['microphone','camera']});
 await context.addInitScript(({capture})=>{
  const Native=window.RTCPeerConnection;
  window.__qaPeers=[];
  window.RTCPeerConnection=class extends Native {constructor(...args){super(...args);window.__qaPeers.push(this);}};
  if(!capture)return;
  // Entirely synthetic test picture and tone; no desktop or user files are captured.
  navigator.mediaDevices.getDisplayMedia=async()=>{
   const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;
   const ctx=canvas.getContext('2d');let n=0;
   const draw=()=>{
    ctx.fillStyle='#fff';ctx.fillRect(0,0,1920,1080);
    ctx.fillStyle='#000';ctx.font='32px monospace';ctx.fillText('Concord — проверка чёткой демонстрации 1920 × 1080',40,70);
    for(let i=0;i<64;i++){ctx.fillStyle=i%2?'#fff':'#000';ctx.fillRect(40+i*8,160,8,100);}
    ctx.fillStyle='#7c6cff';ctx.fillRect(40+(n++*8)%1700,500,160,160);
   };
   draw();const timer=setInterval(draw,1000/30);
   const stream=canvas.captureStream(30);
   const audio=new AudioContext({sampleRate:48000});await audio.resume();
   const oscillator=audio.createOscillator(),gain=audio.createGain(),dest=audio.createMediaStreamDestination();
   oscillator.frequency.value=220;gain.gain.value=0.04;oscillator.connect(gain).connect(dest);oscillator.start();
   stream.addTrack(dest.stream.getAudioTracks()[0]);
   window.__qaCapture={stream,timer,audio};
   return stream;
  };
 },{capture});
 const page=await context.newPage();
 page.on('pageerror',e=>result.errors.push(e.message.replace(/access_token=[^&\s'"]+/g,'access_token=[redacted]').slice(0,200)));
 page.on('console',m=>{if(['warning','error'].includes(m.type())) console.log(m.text().replace(/access_token=[^&\s'"]+/g,'access_token=[redacted]').slice(0,300));});
 await page.goto(`${BASE}/login`);
 await page.getByLabel('Email').fill(email);
 await page.getByLabel('Пароль').fill('demo12345');
 await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('button',{name:'Demo Server',exact:true}).waitFor();
 await page.getByRole('button',{name:'Demo Server',exact:true}).click();
 await page.locator('.chan',{hasText:'General'}).last().click();
 await page.getByText('Голосовая связь подключена').waitFor({timeout:20000});
 return page;
}
async function stats(page) {
 return page.evaluate(async()=>{
  const out=[];
  for(const pc of window.__qaPeers){
   out.push({connection:pc.connectionState,ice:pc.iceConnectionState,signaling:pc.signalingState});
   const report=await pc.getStats();
   report.forEach(row=>{
    if(row.type==='transport')out.push({type:row.type,dtls:row.dtlsState,selected:row.selectedCandidatePairId,bytesSent:row.bytesSent,bytesReceived:row.bytesReceived});
    if(row.type==='candidate-pair' && (row.nominated || row.state==='succeeded'))out.push({type:row.type,state:row.state,nominated:row.nominated,rtt:row.currentRoundTripTime,availableBitrate:row.availableOutgoingBitrate,bytesSent:row.bytesSent,bytesReceived:row.bytesReceived});
    if(!['outbound-rtp','inbound-rtp'].includes(row.type))return;
    const codec=report.get(row.codecId);
    out.push({type:row.type,kind:row.kind,codec:codec?.mimeType,bytes:row.bytesSent ?? row.bytesReceived,framesEncoded:row.framesEncoded,framesDecoded:row.framesDecoded,framesDropped:row.framesDropped,width:row.frameWidth,height:row.frameHeight,fps:row.framesPerSecond,encoder:row.encoderImplementation,powerEfficient:row.powerEfficientEncoder,encodeMs:row.framesEncoded?row.totalEncodeTime*1000/row.framesEncoded:undefined,limited:row.qualityLimitationReason});
   });
  }
  return out;
 });
}
try {
 a=await user('alice@concord.local',true);b=await user('bob@concord.local');
 await a.locator('.stage-controls').getByRole('button',{name:'Демонстрация экрана',exact:true}).click();
 await a.locator('.stage-controls').getByRole('button',{name:'Демонстрация экрана',exact:true}).waitFor();
 await b.locator('.tile.screen video').waitFor({timeout:20000});
 await b.waitForFunction(()=>{const v=document.querySelector('.tile.screen video');return v && v.videoWidth>=1280 && v.videoHeight>=720 && v.readyState>=2;},null,{timeout:20000});
 for(let i=0;i<40;i++) {
  const frames=(await stats(b)).filter(s=>s.kind==='video' && s.type==='inbound-rtp').map(s=>s.framesDecoded??0);
  if(Math.max(0,...frames)>=180)break;
  await b.waitForTimeout(500);
 }
 result.publisher=await stats(a);result.receiver=await stats(b);
 result.voicePanel=await a.locator('.vpanel-sub').innerText();
 result.contrast=await b.locator('.tile.screen video').evaluate(v=>{
  const canvas=document.createElement('canvas');canvas.width=v.videoWidth;canvas.height=v.videoHeight;
  const ctx=canvas.getContext('2d');ctx.drawImage(v,0,0);
  const scale=v.videoWidth/1920,values=[];
  for(let i=0;i<8;i++)values.push(ctx.getImageData(Math.round((44+i*8)*scale),Math.round(210*scale),1,1).data[0]);
  return Math.max(...values)-Math.min(...values);
 });
 assert.ok(result.receiver.some(s=>s.kind==='video' && s.framesDecoded>=180),'receiver continuously decodes at least 180 screen frames');
 assert.ok(result.publisher.some(s=>s.kind==='video' && s.codec==='video/H264'),'H.264 negotiated');
 assert.ok(result.receiver.filter(s=>s.kind==='audio' && s.bytes>0).length>=2,'microphone and screen audio both arrive');
 assert.ok(result.contrast>180,'fine black/white detail survives encoding');
 await b.screenshot({path:`${dir}/received-screen.png`});
 await a.locator('.stage-controls').getByRole('button',{name:'Качество демонстрации',exact:true}).click();
 await a.getByRole('menuitem',{name:/Текст и код/}).click();
 await a.getByText(/Качество демонстрации: Текст и код/).waitFor();
 await a.locator('.stage-controls').getByRole('button',{name:'Качество демонстрации',exact:true}).click();
 await a.getByRole('menuitem',{name:/Авто/}).click();
 await a.getByText(/Качество демонстрации: Авто/).waitFor();
 const mic=a.locator('.stage-controls').getByRole('button',{name:'Микрофон',exact:true});
 await mic.click();assert.equal(await mic.getAttribute('aria-pressed'),'false');await mic.click();
 const sound=a.locator('.stage-controls').getByRole('button',{name:'Звук',exact:true});
 await sound.click();assert.equal(await sound.getAttribute('aria-pressed'),'false');await sound.click();
 await a.locator('.stage-controls').getByRole('button',{name:'Камера',exact:true}).click();
 await b.waitForFunction(()=>[...document.querySelectorAll('.tile:not(.screen) video')].some(v=>v.videoWidth>0 && v.readyState>=2));
 await a.locator('.stage-controls').getByRole('button',{name:'Камера',exact:true}).click();
 await b.locator('.tile.screen').hover();
 await b.locator('.tile.screen').getByRole('button',{name:'Прекратить просмотр'}).click();
 await b.getByRole('button',{name:'Смотреть трансляцию',exact:true}).click();
 await b.waitForFunction(()=>document.querySelector('.tile.screen video')?.videoWidth>=1280);
 await b.locator('.tile.screen').hover();await b.locator('.tile.screen').getByRole('button',{name:'Мини-плеер',exact:true}).click();
 for(const [width,height] of [[390,844],[320,568],[667,375]]) {
  await b.setViewportSize({width,height});
  await b.waitForFunction(()=>{const r=document.querySelector('.mini-player').getBoundingClientRect();return r.right<=innerWidth && r.bottom<=innerHeight;});
  const m=await b.locator('.mini-player').evaluate(e=>{const r=e.getBoundingClientRect();return {right:r.right,bottom:r.bottom,w:innerWidth,h:innerHeight};});
  assert.ok(m.right<=m.w && m.bottom<=m.h,'mini-player remains in viewport');
  await b.screenshot({path:`${dir}/stage-${width}x${height}.png`});
  const controls=await b.locator('.stage-controls').boundingBox();assert.ok(controls.y+controls.height<=height+1,'call controls remain visible');
 }
 await b.locator('.mini-player').hover();await b.getByRole('button',{name:'Вернуться к звонку'}).click();
 await b.locator('.mini-player').waitFor({state:'hidden'});
 await b.setViewportSize({width:1440,height:900});
 console.log('Screen delivery, audio, detail and live quality switching: OK');
 await a.locator('.stage-controls').getByRole('button',{name:'Демонстрация экрана',exact:true}).click();
 await b.locator('.tile.screen').waitFor({state:'hidden',timeout:10000});
 result.screenStopped=true;
 await a.locator('.stage-controls').getByRole('button',{name:'Отключиться',exact:true}).click();
 await a.getByRole('button',{name:'Подключиться',exact:true}).waitFor();
 await a.getByRole('button',{name:'Подключиться',exact:true}).click();await a.getByText('Голосовая связь подключена').waitFor();
 await a.waitForFunction(()=>document.querySelector('.vpanel-sub')?.textContent.includes('мс'));
 result.cameraMuteDeafenWatchMiniPlayerRejoin=true;
 assert.equal(result.errors.length,0,'no unhandled browser exceptions');
} catch(error) {
 result.failure=error.message.split('\n')[0];
 if(a){result.publisher=await stats(a);result.voicePanel=await a.locator('.vpanel-sub').innerText().catch(()=>null);await a.screenshot({path:`${dir}/failure-publisher.png`});}
 if(b){result.receiver=await stats(b);await b.screenshot({path:`${dir}/failure-receiver.png`});}
 throw error;
} finally {
 await writeFile(`${dir}/results.json`,JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
 await browser.close();
}
