import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const BASE=process.env.BASE_URL??'http://localhost:5180',OUT=process.env.RECOVERY_DIR??'test/results/recovery';
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['microphone','camera']}),other=await browser.newContext();
const result={checks:[],failures:[],errors:[]};
const run=Date.now().toString(36);
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const releases=[];
await context.addInitScript(()=>{
 localStorage.setItem('concord.settings.v1',JSON.stringify({notificationSounds:false}));
 const NativeSocket=WebSocket;window.__recoverySockets=[];window.__readyCount=0;
 window.WebSocket=class extends NativeSocket{constructor(...args){super(...args);window.__recoverySockets.push(this);this.addEventListener('message',e=>{try{if(JSON.parse(e.data).t==='ready')window.__readyCount++;}catch{}});}};
 const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),NativeAudio=AudioContext;window.__recoveryCaptures=[];window.__recoveryAudio=[];
 navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await gum(constraints);window.__recoveryCaptures.push(stream);return stream;};
 window.AudioContext=class extends NativeAudio{constructor(...args){super(...args);window.__recoveryAudio.push(this);}};
});
const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
async function request(ctx,token,method,path,body){const response=await ctx.request.fetch(`${BASE}/api${path}`,{method,headers:{Authorization:`Bearer ${token}`,'X-Requested-With':'concord'},...(body===undefined?{}:{data:body})});assert.ok(response.ok(),`${method} ${path}: ${response.status()}`);return response.status()===204?null:response.json();}
async function step(name,fn){if(process.env.RECOVERY_CASE&&!name.includes(process.env.RECOVERY_CASE))return;try{await fn();result.checks.push(name);console.log('PASS',name);}catch(e){result.failures.push({name,error:e.message});console.log('FAIL',name,e.message.split('\n')[0]);}finally{for(const release of releases.splice(0))release();await page.keyboard.press('Escape').catch(()=>undefined);await page.unrouteAll({behavior:'wait'});}}
async function settleResponse(response){await response.finished();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function closeThread(){const close=page.getByRole('button',{name:'Закрыть ветку',exact:true});if(await close.isVisible())await close.click();}
async function hold(pattern){const received=deferred(),gate=deferred();releases.push(gate.resolve);await page.route(pattern,async route=>{const response=await route.fetch();received.resolve();await gate.promise;await route.fulfill({response});});return {received:received.promise,release:gate.resolve};}
try{
 await page.goto(`${BASE}/login`);await page.getByLabel('Email').fill('alice@concord.local');await page.getByLabel('Пароль',{exact:true}).fill('demo12345');
 const login=page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');await page.getByRole('button',{name:'Войти',exact:true}).click();
 const alice=await (await login).json();await page.getByText('Друзья',{exact:true}).first().waitFor();await page.getByRole('button',{name:'Demo Server',exact:true}).click();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 const [,,serverId,channelId]=new URL(page.url()).pathname.split('/');
 const bobResponse=await other.request.post(`${BASE}/api/auth/login`,{headers:{'X-Requested-With':'concord'},data:{email:'bob@concord.local',password:'demo12345'}});assert.ok(bobResponse.ok());const bob=await bobResponse.json();
 const send=content=>request(other,bob.accessToken,'POST',`/channels/${channelId}/messages`,{content});
 const sample=await send(`recovery sample ${Date.now()}`);

 await step('lookup discovery ignores results from a previous search',async()=>{
  const base=(await request(context,alice.accessToken,'GET','/servers')).find(s=>s.id===serverId);
  const first=deferred(),release=deferred();releases.push(release.resolve);
  await page.route('**/api/servers/discover*',async route=>{const q=new URL(route.request().url()).searchParams.get('q');if(q==='alpha'){first.resolve();await release.promise;}await route.fulfill({json:[{...base,name:q==='alpha'?'OLD discovered server':'LATEST discovered server'}]});});
  await page.getByRole('button',{name:'Обзор серверов',exact:true}).click();const input=page.getByPlaceholder('Поиск серверов');await input.fill('alpha');await first.promise;await input.fill('beta');await page.getByText('LATEST discovered server',{exact:true}).waitFor();
  const response=page.waitForResponse(r=>r.url().includes('/api/servers/discover?')&&new URL(r.url()).searchParams.get('q')==='alpha');release.resolve();await settleResponse(await response);
  assert.equal(await page.getByText('OLD discovered server',{exact:true}).count(),0);assert.equal(await page.getByText('LATEST discovered server',{exact:true}).count(),1);
 });
 await page.getByRole('button',{name:'Demo Server',exact:true}).click();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 await step('lookup invite ignores an old error after switching to a valid invite',async()=>{
  const base=(await request(context,alice.accessToken,'GET','/servers')).find(s=>s.id===serverId),first=deferred(),release=deferred();releases.push(release.resolve);
  await page.route('**/api/invites/recovery-*',async route=>{if(route.request().url().endsWith('recovery-old')){first.resolve();await release.promise;return route.fulfill({status:404,json:{error:{code:'INVITE_INVALID',message:'Old invite failure'}}});}return route.fulfill({json:{code:'recovery-new',server:{...base,name:'LATEST invited server'},inviter:bob.user,expiresAt:null}});});
  const navigate=path=>page.evaluate(path=>{history.pushState(null,'',path);dispatchEvent(new PopStateEvent('popstate'));},path);
  await navigate('/invite/recovery-old');await first.promise;await navigate('/invite/recovery-new');await page.getByRole('heading',{name:'LATEST invited server',exact:true}).waitFor();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/invites/recovery-old'));release.resolve();await settleResponse(await response);assert.equal(await page.getByRole('heading',{name:'LATEST invited server',exact:true}).count(),1);assert.equal(await page.getByText('Old invite failure',{exact:true}).count(),0);
  await navigate(`/channels/${serverId}/${channelId}`);await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 });

 await step('search ignores older responses and clearing query invalidates pending work',async()=>{
  const first=deferred(),release=deferred();releases.push(release.resolve);
  await page.route('**/api/search?*',r=>r.fulfill({json:{users:[],servers:[],channels:[]}}));
  await page.route('**/api/search/messages?*',async route=>{const q=new URL(route.request().url()).searchParams.get('q');if(q==='alpha'){first.resolve();await release.promise;}await route.fulfill({json:{total:1,results:[{...sample,content:q==='alpha'?'OLD search result':'LATEST search result',channelName:'general'}]}});});
  await page.getByRole('button',{name:'Поиск по сообщениям',exact:true}).click();const input=page.getByPlaceholder('Сообщения, люди, серверы, каналы…');await input.fill('alpha');await first.promise;await input.fill('beta');await page.locator('.modal .pcard-section',{hasText:'LATEST search result'}).waitFor();
  const oldResponse=page.waitForResponse(r=>r.url().includes('/api/search/messages?')&&new URL(r.url()).searchParams.get('q')==='alpha');release.resolve();await settleResponse(await oldResponse);
  assert.equal(await page.locator('.modal .pcard-section',{hasText:'LATEST search result'}).count(),1);assert.equal(await page.locator('.modal .pcard-section',{hasText:'OLD search result'}).count(),0);
  await input.fill('');await page.waitForTimeout(350);assert.equal(await page.locator('.modal .pcard-section').count(),0);
 });

 const parent=await send(`thread parent ${Date.now()}`),oldReply=await request(other,bob.accessToken,'POST',`/channels/${channelId}/messages`,{content:'old thread reply',replyToId:parent.id});
 const openThread=async()=>{await page.locator(`.messages .msg[data-message-id="${parent.id}"]`).click({button:'right'});await page.getByRole('menuitem',{name:'Открыть ветку',exact:true}).click();};
 await step('thread replays new replies, edits and deletions received during initial fetch',async()=>{
  const pending=await hold(`**/api/messages/${parent.id}/thread`);await openThread();await pending.received;
  await request(other,bob.accessToken,'PATCH',`/messages/${parent.id}`,{content:'thread parent edited during load'});
  const reply=await request(other,bob.accessToken,'POST',`/channels/${channelId}/messages`,{content:'live reply during load',replyToId:parent.id});
  await request(other,bob.accessToken,'DELETE',`/messages/${oldReply.id}`);
  await page.locator(`.messages .msg[data-message-id="${reply.id}"]`).waitFor();await page.locator(`.messages .msg[data-message-id="${oldReply.id}"]`).waitFor({state:'detached'});
  const response=page.waitForResponse(r=>r.url().endsWith(`/api/messages/${parent.id}/thread`));pending.release();await settleResponse(await response);
  const thread=page.locator('.thread-panel');await thread.locator('.msg-content',{hasText:'thread parent edited during load'}).waitFor({timeout:3000});assert.equal(await thread.locator('.msg-content',{hasText:'live reply during load'}).count(),1);assert.equal(await thread.locator('.msg-content',{hasText:'old thread reply'}).count(),0);
  await page.getByRole('button',{name:'Закрыть ветку',exact:true}).click();
 });
 await closeThread();
 await step('open thread refreshes missed replies after gateway reconnect',async()=>{
  await openThread();await page.locator('.thread-panel .msg-content').first().waitFor();const ready=await page.evaluate(()=>window.__readyCount);
  await context.setOffline(true);await page.evaluate(()=>window.__recoverySockets.filter(s=>s.url.includes('/api/gateway')).forEach(s=>s.close()));
  await request(other,bob.accessToken,'POST',`/channels/${channelId}/messages`,{content:'reply sent while offline',replyToId:parent.id});
  await context.setOffline(false);await page.waitForFunction(n=>window.__readyCount>n,ready);
  await page.locator('.thread-panel .msg-content',{hasText:'reply sent while offline'}).waitFor({timeout:4000});await page.getByRole('button',{name:'Закрыть ветку',exact:true}).click();
 });
 await context.setOffline(false);await closeThread();

 const dm=await request(other,bob.accessToken,'POST','/dm',{recipientId:alice.user.id});
 const dmSend=content=>request(other,bob.accessToken,'POST',`/channels/${dm.id}/messages`,{content});
 await page.getByRole('button',{name:'Личные сообщения',exact:true}).click();
 const inbox=()=>page.locator('.chan',{hasText:'Уведомления'}).click();
 await step('inbox read acknowledgement preserves notifications arriving after the server update',async()=>{
  await dmSend(`notification before read ${run}`);const pending=await hold('**/api/notifications/read');await inbox();await pending.received;
  await dmSend(`notification after read ${run}`);await page.locator('.modal .pcard-section',{hasText:`notification after read ${run}`}).waitFor();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/notifications/read'));pending.release();await settleResponse(await response);
  const item=page.locator('.modal .pcard-section',{hasText:`notification after read ${run}`});assert.match(await item.getAttribute('style'),/accent-soft/);
 });
 await step('inbox handles a read failure without an unhandled rejection',async()=>{
  const before=result.errors.length;await page.route('**/api/notifications/read',r=>r.fulfill({status:503,json:{error:{code:'OFFLINE',message:'Simulated inbox read failure'}}}));await inbox();
  await page.waitForTimeout(500);assert.equal(result.errors.length,before);await page.getByText('Simulated inbox read failure',{exact:true}).waitFor();
 });
 await step('clearing inbox preserves a notification arriving after the server delete',async()=>{
  const read=page.waitForResponse(r=>r.url().endsWith('/api/notifications/read'));await inbox();await read;
  const pending=await hold('**/api/notifications');await page.getByRole('button',{name:'Очистить всё',exact:true}).click();await pending.received;
  await dmSend(`notification after clear ${run}`);await page.locator('.modal .pcard-section',{hasText:`notification after clear ${run}`}).waitFor();
  const response=page.waitForResponse(r=>r.url().endsWith('/api/notifications')&&r.request().method()==='DELETE');pending.release();await settleResponse(await response);
  assert.equal(await page.locator('.modal .pcard-section',{hasText:`notification after clear ${run}`}).count(),1);
 });
 await step('failed DM close preserves the conversation and a confirmed close leaves it',async()=>{
  const row=page.locator('.sidebar .chan',{hasText:'Bob'}).filter({has:page.locator('[aria-label="Закрыть"]')});await row.click();await row.hover();
  const input=page.getByRole('textbox',{name:'Сообщение для @Bob'});await input.waitFor();
  await page.route(`**/api/dm/${dm.id}`,r=>r.fulfill({status:503,json:{error:{code:'OFFLINE',message:'Simulated DM close failure'}}}));
  await row.getByRole('button',{name:'Закрыть',exact:true}).click();await page.getByText('Simulated DM close failure',{exact:true}).waitFor();assert.equal(await row.count(),1);assert.ok(await input.isVisible());
  await page.unroute(`**/api/dm/${dm.id}`);await row.getByRole('button',{name:'Закрыть',exact:true}).click();await row.waitFor({state:'detached'});await input.waitFor({state:'detached'});
 });

 const startVoice=async label=>{
  const full=await request(context,alice.accessToken,'POST','/servers',{name:`Recovery ${label} ${run}`});
  await page.getByRole('button',{name:full.server.name,exact:true}).click();await page.locator('.sidebar .chan',{hasText:'General'}).last().click();
  await page.getByText('Голосовая связь подключена',{exact:true}).waitFor();await page.waitForFunction(()=>window.__recoveryCaptures.some(s=>s.getAudioTracks().some(t=>t.readyState==='live')));
  return full;
 };
 const captureStopped=()=>page.waitForFunction(()=>window.__recoveryCaptures.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&window.__recoveryAudio.every(c=>c.state!=='running'));
 await step('stale disconnect is ignored and deleting the active channel releases capture',async()=>{
  const full=await startVoice('channel'),voice=full.channels.find(c=>c.type==='voice');
  await page.evaluate(id=>window.__recoverySockets.filter(s=>s.url.includes('/api/gateway')&&s.readyState===1).forEach(s=>s.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({t:'voice:disconnect',d:{channelId:id}})}))),channelId);
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.getByText('Голосовая связь подключена',{exact:true}).count(),1);
  await request(context,alice.accessToken,'DELETE',`/channels/${voice.id}`);await page.locator('.vpanel').waitFor({state:'detached'});await captureStopped();
  await request(context,alice.accessToken,'DELETE',`/servers/${full.server.id}`);
 });
 await step('deleting the active server disconnects the SFU room and releases capture',async()=>{
  const full=await startVoice('server');await request(context,alice.accessToken,'DELETE',`/servers/${full.server.id}`);
  await page.locator('.vpanel').waitFor({state:'detached'});await captureStopped();
 });
 assert.deepEqual(result.failures,[]);assert.deepEqual(result.errors,[]);
}finally{
 for(const release of releases)release();await context.setOffline(false).catch(()=>undefined);await browser.close();await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
