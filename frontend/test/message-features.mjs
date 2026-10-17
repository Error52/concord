import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const BASE=process.env.BASE_URL??'http://localhost:5181',OUT=process.env.FEATURE_DIR??'test/results/message-features';
const PASSWORD=process.env.FEATURE_PASSWORD??'demo12345',SERVER=process.env.FEATURE_SERVER??'Demo Server';
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const result={checks:[],errors:[]};
async function user(name){
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['microphone']});
 await context.addInitScript(()=>{
  window.__recordedStreams=[];
  const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia=async constraints=>{
   if(window.__denyRecording){window.__denyRecording=false;throw new DOMException('test denied','NotAllowedError');}
   const stream=await original(constraints);window.__recordedStreams.push(stream);
   if(window.__delayRecording){const ms=window.__delayRecording;window.__delayRecording=0;await new Promise(resolve=>setTimeout(resolve,ms));}
   return stream;
  };
 });
 const page=await context.newPage();page.on('pageerror',error=>result.errors.push(error.message));
 await page.goto(`${BASE}/login`);await page.getByLabel(/Email/).fill(name.includes('@')?name:`${name}@concord.local`);await page.getByLabel('Пароль',{exact:true}).fill(PASSWORD);await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByText('Друзья',{exact:true}).first().waitFor();await page.getByRole('button',{name:SERVER,exact:true}).first().click();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 return {context,page};
}
const noCapture=page=>page.waitForFunction(()=>window.__recordedStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended')));
try{
 const a=await user(process.env.FEATURE_A??'alice'),b=await user(process.env.FEATURE_B??'bob'),page=a.page;
 await page.getByRole('button',{name:'Записать голосовое сообщение',exact:true}).click();await page.getByRole('button',{name:'Завершить запись',exact:true}).waitFor();await page.waitForTimeout(1300);
 const uploaded=page.waitForResponse(response=>response.request().method()==='POST'&&/\/channels\/[^/]+\/attachments$/.test(response.url()));
 await page.getByRole('button',{name:'Завершить запись',exact:true}).click();await noCapture(page);
 const uploadResponse=await uploaded;assert.equal(uploadResponse.status(),201);const attachment=await uploadResponse.json();assert.equal(attachment.kind,'audio');assert.equal(attachment.mime,'audio/webm');assert.ok(attachment.size>100);
 const stored=await a.context.request.get(new URL(attachment.url,BASE).href);assert.equal(stored.status(),200);const captured=await stored.body();assert.ok(captured.length>100);await writeFile(`${OUT}/recorded-opus.webm.base64`,captured.toString('base64')+'\n');
 await page.locator('.upload .muted').waitFor();const sent=page.waitForResponse(response=>response.request().method()==='POST'&&/\/channels\/[^/]+\/messages$/.test(response.url()));
 await page.getByRole('button',{name:'Отправить',exact:true}).click();const sentResponse=await sent;assert.equal(sentResponse.status(),201);const message=await sentResponse.json();
 const audio=b.page.locator(`.msg[data-message-id="${message.id}"] audio`);await audio.waitFor();await audio.evaluate(element=>element.play());await b.page.waitForFunction(id=>document.querySelector(`.msg[data-message-id="${id}"] audio`)?.currentTime>.1,message.id);
 const ranged=await b.context.request.get(new URL(attachment.url,BASE).href,{headers:{Range:'bytes=0-9'}});assert.equal(ranged.status(),206);assert.equal((await ranged.body()).length,10);assert.match(ranged.headers()['content-type'],/^audio\/webm/);
 result.recording={mime:attachment.mime,size:attachment.size};result.checks.push('real Opus recording uploads as audio, reaches the second client, decodes and supports seeking ranges');
 await page.evaluate(()=>{window.__delayRecording=1000;});await page.getByRole('button',{name:'Записать голосовое сообщение',exact:true}).click();await page.getByRole('button',{name:'Отменить запись',exact:true}).click();await page.waitForTimeout(1200);await noCapture(page);assert.equal(await page.locator('.upload').count(),0);result.checks.push('cancelled microphone permission completion cannot attach a late recording');
 await page.evaluate(()=>{window.__denyRecording=true;});await page.getByRole('button',{name:'Записать голосовое сообщение',exact:true}).click();await page.getByText('Разрешите доступ к микрофону, чтобы записать сообщение',{exact:true}).waitFor();await page.getByRole('button',{name:'Записать голосовое сообщение',exact:true}).waitFor();result.checks.push('a denied microphone returns the recorder to a usable state');
 await page.getByRole('button',{name:'Записать голосовое сообщение',exact:true}).click();await page.getByRole('button',{name:'Завершить запись',exact:true}).waitFor();await page.getByRole('button',{name:'Личные сообщения',exact:true}).click();await noCapture(page);await page.getByRole('button',{name:SERVER,exact:true}).first().click();assert.equal(await page.locator('.upload').count(),0);result.checks.push('leaving the channel stops capture and discards the cancelled recording');
 await page.getByRole('button',{name:'GIF',exact:true}).click();await page.getByRole('button',{name:'🔥 Популярные',exact:true}).click();await page.locator('.gif-grid button').first().waitFor();assert.equal(await page.locator('.gif-grid button').count(),6);
 const search=page.getByPlaceholder('Поиск GIF');await search.fill('trending');await page.waitForFunction(()=>document.querySelectorAll('.gif-grid button').length===1);await page.getByRole('button',{name:'Огонь',exact:true}).waitFor();assert.equal(await page.locator('.gif-grid button').count(),1);result.checks.push('the word trending performs a real local search instead of switching to popular GIFs');
 await search.fill('сердце');await page.getByRole('button',{name:'Любовь',exact:true}).waitFor();const sentGif=page.waitForResponse(response=>response.request().method()==='POST'&&/\/channels\/[^/]+\/messages$/.test(response.url()));await page.getByRole('button',{name:'Любовь',exact:true}).click();const gifResponse=await sentGif;assert.equal(gifResponse.status(),201);const gifMessage=await gifResponse.json(),gif=gifMessage.embeds[0];assert.equal(new URL(gif.url).origin,new URL(BASE).origin);assert.equal(gif.url,gif.previewUrl);
 const received=b.page.locator(`.msg[data-message-id="${gifMessage.id}"] .gif-embed`);await received.waitFor();await received.evaluate(image=>image.decode());
 // Canvas drawImage uses the default frame of an animated image (HTML Standard).
 // Sample the rendered element instead, so this proves actual browser animation.
 await received.scrollIntoViewIfNeeded();await b.page.bringToFront();
 const frames=new Set();for(let i=0;i<8;i++){frames.add((await received.screenshot({animations:'allow'})).toString('base64'));await b.page.waitForTimeout(115);}
 assert.ok(frames.size>1,'the received GIF is actually animated');
 const anonymous=await browser.newContext(),asset=await anonymous.request.get(gif.url);assert.equal(asset.status(),200);assert.match(asset.headers()['content-type'],/^image\/gif/);await anonymous.close();
 const headers=gifResponse.request().headers(),forged=await a.context.request.post(gifResponse.url(),{headers:{Authorization:headers.authorization,'X-Requested-With':'concord'},data:{content:'',gif:{...gif,previewUrl:'https://example.com/untrusted.gif'}}});assert.equal(forged.status(),400);
 result.checks.push('a same-origin animated local GIF reaches the second client, loads without authentication and rejects foreign preview injection');
 assert.deepEqual(result.errors,[]);await a.context.close();await b.context.close();
}catch(error){result.failure=error.message.split('\n')[0];result.toasts=await Promise.all(browser.contexts().flatMap(context=>context.pages()).map(page=>page.locator('.toast').allTextContents().catch(()=>[])));throw error;}
finally{await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
