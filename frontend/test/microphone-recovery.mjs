// Real capture + LiveKit with a single injected publication failure. Requires the local test-only media build.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const BASE=process.env.BASE_URL??'http://localhost:5181',OUT=process.env.MIC_RECOVERY_DIR??'test/results/microphone-recovery';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(BASE).hostname),'Engine fault injection is restricted to local QA');
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({permissions:['microphone']}),page=await context.newPage(),result={checks:[],errors:[]};
page.on('pageerror',error=>result.errors.push(error.message));
try{
 await page.goto(`${BASE}/login`);await page.getByLabel('Email или имя пользователя',{exact:true}).fill('alice');await page.getByLabel('Пароль',{exact:true}).fill('demo12345');
 const logged=page.waitForResponse(response=>response.url().endsWith('/api/auth/login'));await page.getByRole('button',{name:'Войти',exact:true}).click();const auth=await(await logged).json(),headers={Authorization:`Bearer ${auth.accessToken}`};
 const servers=await(await context.request.get(`${BASE}/api/servers`,{headers})).json(),server=servers.find(item=>item.name==='Demo Server');
 const full=await(await context.request.get(`${BASE}/api/servers/${server.id}`,{headers})).json(),channel=full.channels.find(item=>item.type==='voice');
 await page.goto(`${BASE}/channels/${server.id}/${channel.id}`);await page.getByRole('button',{name:'Подключиться',exact:true}).click();
 await page.waitForFunction(()=>window.__concordTestVoice?.micPub?.track?.mediaStreamTrack.readyState==='live');
 await page.evaluate(async()=>{
  const voice=window.__concordTestVoice,room=voice.room,pub=voice.micPub;
  await room.localParticipant.unpublishTrack(pub.track);voice.releaseMicrophone();
  const publish=room.localParticipant.publishTrack.bind(room.localParticipant);let failed=false;
  room.localParticipant.publishTrack=async(...args)=>{if(!failed&&args[1]?.source==='microphone'){failed=true;throw new Error('Synthetic one-off publication failure');}return publish(...args);};
  window.__restoreMicPublication=()=>{room.localParticipant.publishTrack=publish;};
  await voice.startMicrophone();
 });
 const failed=await page.evaluate(()=>({muted:window.__concordTestVoiceStore.get().selfMute,captureReleased:window.__concordTestVoice.micStream===null,contextReleased:window.__concordTestVoice.ctx===null,publication:!!window.__concordTestVoice.micPub}));
 assert.deepEqual(failed,{muted:true,captureReleased:true,contextReleased:true,publication:false});result.checks.push('a real publication failure releases microphone/context and displays mute instead of silently losing voice');
 await page.evaluate(()=>window.__restoreMicPublication());await page.locator('.stage-controls').getByRole('button',{name:'Микрофон',exact:true}).click();
 await page.waitForFunction(()=>window.__concordTestVoice?.micPub?.track?.mediaStreamTrack.readyState==='live');
 const bytes=()=>page.evaluate(async()=>{const report=await window.__concordTestVoice.micPub.track.getRTCStatsReport();return [...report.values()].filter(row=>row.type==='outbound-rtp'&&row.kind==='audio').reduce((sum,row)=>sum+(row.bytesSent??0),0);});
 const before=await bytes();await page.waitForTimeout(700);assert.ok(await bytes()>before);result.checks.push('one unmute republishes a live microphone and sends new audio bytes through the SFU');
 await page.bringToFront();await page.evaluate(()=>window.__concordTestSettings.set({muteOnBlur:true,vadAuto:false,vadThresholdDb:-70}));
 await page.waitForFunction(()=>document.hasFocus()&&window.__concordTestVoiceStore.get().gateOpen);
 // Headless Chromium can report every tab as focused; inject only the focus signal.
 // Capture, WebAudio gating and the SFU connection remain real.
 await page.evaluate(()=>{
  window.__setTestFocus=value=>{document.hasFocus=()=>value;window.dispatchEvent(new Event(value?'focus':'blur'));};
  window.__setTestFocus(false);
 });
 await page.waitForFunction(()=>!document.hasFocus()&&!window.__concordTestVoiceStore.get().gateOpen);
 await page.evaluate(async id=>{const voice=window.__concordTestVoice;await voice.disconnect(false);await voice.join(id);},channel.id);
 await page.waitForFunction(()=>window.__concordTestVoiceStore.get().status==='connected'&&window.__concordTestVoice?.micPub?.track?.mediaStreamTrack.readyState==='live');
 assert.equal(await page.evaluate(()=>window.__concordTestVoice.computeGate()),false);assert.equal(await page.evaluate(()=>window.__concordTestVoiceStore.get().gateOpen),false);
 await page.evaluate(()=>window.__setTestFocus(true));await page.waitForFunction(()=>window.__concordTestVoiceStore.get().gateOpen);result.checks.push('simulated focus loss keeps the real audio gate closed across a background rejoin until focus returns');
 await page.locator('.stage-controls').getByRole('button',{name:'Отключиться',exact:true}).click();
 await page.waitForFunction(()=>window.__concordTestVoiceStore.get().status==='idle'&&window.__concordTestVoice.micStream===null&&window.__concordTestVoice.ctx===null);
 result.checks.push('disconnect releases the retried microphone and audio context');assert.deepEqual(result.errors,[]);
}catch(error){result.failure=error.message.split('\n')[0];throw error;}
finally{await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
