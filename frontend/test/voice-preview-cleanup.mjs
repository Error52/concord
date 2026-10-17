// A synthetic deferred camera and real WebAudio destinations verify settings capture ownership.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const BASE=process.env.BASE_URL??'http://localhost:5181',OUT=process.env.PREVIEW_DIR??'test/results/voice-preview-cleanup';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(BASE).hostname),'Media fault injection is restricted to local QA');
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({permissions:['microphone','camera'],viewport:{width:1440,height:900}}),page=await context.newPage();
const result={checks:[],errors:[]};page.setDefaultTimeout(10000);page.on('pageerror',error=>result.errors.push(error.message));
const check=name=>{result.checks.push(name);console.log('PASS',name);};
await context.addInitScript(()=>{
  window.__cameraRequests=[];window.__speakerOutputs=[];window.__speakerAudios=[];window.__rejectSpeakerPlay=false;
  window.__micStreams=[];window.__micContexts=[];window.__pendingWorklets=[];window.__pendingMics=[];window.__deferWorklet=false;window.__deferMic=false;
  const originalCapture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=constraints=>{
    if(!constraints.video){
      const capture=()=>originalCapture(constraints).then(stream=>{window.__micStreams.push(stream);return stream;});
      if(window.__deferMic)return new Promise((resolve,reject)=>window.__pendingMics.push({release:()=>capture().then(resolve,reject)}));
      return capture();
    }
    const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;
    const stream=canvas.captureStream(1);let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
    window.__cameraRequests.push({stream,resolve,reject});return promise;
  };
  const destination=AudioContext.prototype.createMediaStreamDestination;
  AudioContext.prototype.createMediaStreamDestination=function(){const node=destination.call(this);window.__speakerOutputs.push({stream:node.stream,context:this});return node;};
  const source=AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource=function(stream){window.__micContexts.push(this);return source.call(this,stream);};
  const addModule=AudioWorklet.prototype.addModule;
  AudioWorklet.prototype.addModule=function(...args){if(!window.__deferWorklet)return addModule.apply(this,args);return new Promise((resolve,reject)=>window.__pendingWorklets.push({resolve,reject}));};
  const play=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(){
    if(this instanceof HTMLAudioElement && window.__speakerOutputs.some(output=>output.stream===this.srcObject)){
      window.__speakerAudios.push(this);
      if(window.__rejectSpeakerPlay)return Promise.reject(new DOMException('Synthetic autoplay denial','NotAllowedError'));
    }
    return play.call(this);
  };
});
const open=async()=>{await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('button',{name:'Голос и видео',exact:true}).click();};
const close=()=>page.getByRole('button',{name:'Закрыть настройки',exact:true}).click();
const allReleased=()=>page.waitForFunction(()=>window.__speakerOutputs.every(output=>output.context.state==='closed'&&output.stream.getTracks().every(track=>track.readyState==='ended'))&&window.__speakerAudios.every(audio=>audio.paused&&audio.srcObject===null));
try{
  await page.goto(`${BASE}/login`);await page.getByLabel('Email или имя пользователя',{exact:true}).fill(process.env.PREVIEW_USER??'alice');await page.getByLabel('Пароль',{exact:true}).fill(process.env.PREVIEW_PASSWORD??'demo12345');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByText('Друзья',{exact:true}).first().waitFor();
  await open();await page.getByRole('button',{name:'Проверить камеру',exact:true}).click();await page.waitForFunction(()=>window.__cameraRequests.length===1);
  await close();await page.evaluate(()=>{const request=window.__cameraRequests[0];request.resolve(request.stream);});await page.waitForFunction(()=>window.__cameraRequests[0].stream.getTracks().every(track=>track.readyState==='ended'));
  await open();assert.equal(await page.locator('video.camera-preview').count(),0);await page.getByRole('button',{name:'Проверить камеру',exact:true}).waitFor();check('a camera granted after settings close is stopped and cannot revive the preview');
  await page.getByRole('button',{name:'Проверить камеру',exact:true}).click();await page.waitForFunction(()=>window.__cameraRequests.length===2);await page.getByRole('button',{name:'Выключить предпросмотр',exact:true}).click();
  await page.evaluate(()=>{const request=window.__cameraRequests[1];request.resolve(request.stream);});await page.waitForFunction(()=>window.__cameraRequests[1].stream.getTracks().every(track=>track.readyState==='ended'));assert.equal(await page.locator('video.camera-preview').count(),0);check('turning preview off before permission resolves releases the late camera');
  await page.getByRole('button',{name:'Проверить камеру',exact:true}).click();await page.waitForFunction(()=>window.__cameraRequests.length===3);await close();
  await page.evaluate(()=>window.__cameraRequests[2].reject(new DOMException('Synthetic late denial','NotAllowedError')));await page.waitForTimeout(80);assert.equal(await page.getByText(/Нет разрешения на использование камеры/).count(),0);check('a late camera denial after closing settings does not show a stale error');
  await open();await page.getByRole('button',{name:'Проверить динамики',exact:true}).click();await page.waitForFunction(()=>window.__speakerOutputs.length===1);await allReleased();check('speaker test completion stops destination tracks and detaches its audio element');
  await page.getByRole('button',{name:'Проверить динамики',exact:true}).click();await page.waitForFunction(()=>window.__speakerOutputs.length===2);await page.getByRole('button',{name:'Проверить динамики',exact:true}).click();await page.waitForFunction(()=>window.__speakerOutputs.length===3&&window.__speakerOutputs[1].stream.getTracks().every(track=>track.readyState==='ended'));
  await close();await allReleased();check('repeating a speaker test stops the prior sound and closing settings releases the current sound');
  await open();await page.evaluate(()=>{window.__rejectSpeakerPlay=true;});await page.getByRole('button',{name:'Проверить динамики',exact:true}).click();await page.getByText('Браузер заблокировал воспроизведение',{exact:true}).waitFor();await allReleased();check('blocked speaker playback releases every audio resource and reports the failure');
  await page.evaluate(()=>{window.__deferWorklet=true;});await page.getByRole('button',{name:'Проверить',exact:true}).click();await page.waitForFunction(()=>window.__pendingWorklets.length===1);await close();
  await page.waitForFunction(()=>window.__micContexts.every(context=>context.state==='closed')&&window.__micStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')));check('closing settings stops the microphone immediately while its worklet is still pending');
  await page.evaluate(()=>{window.__deferWorklet=false;window.__pendingWorklets[0].reject(new Error('Synthetic delayed worklet rejection'));});
  await open();await page.evaluate(()=>{window.__deferMic=true;});await page.getByRole('button',{name:'Проверить',exact:true}).click();await page.waitForFunction(()=>window.__pendingMics.length===1);await close();await page.evaluate(()=>window.__pendingMics[0].release());
  await page.waitForFunction(()=>window.__micStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')));check('microphone permission granted after closing settings releases the late capture');
  assert.deepEqual(result.errors,[]);
}catch(error){result.failure=error.message.split('\n')[0];throw error;}
finally{await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
