import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const BASE=process.env.BASE_URL??'http://localhost:5180',OUT=process.env.EDGE_DIR??'test/results/edge-cases';
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream','--autoplay-policy=no-user-gesture-required']});
const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['microphone','camera']}),other=await browser.newContext({viewport:{width:1440,height:900},permissions:['microphone','camera']});
const result={browser:browser.version(),checks:[],failures:[],errors:[]};
const run=Date.now().toString(36),servers=[];
await other.addInitScript(()=>{
 const gum=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);window.__edgeCaptures=[];window.__edgeAudio=[];window.__edgePeers=[];
 navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await gum(constraints);window.__edgeCaptures.push(stream);return stream;};
 const NativeAudio=AudioContext;window.AudioContext=class extends NativeAudio{constructor(...args){super(...args);window.__edgeAudio.push(this);}};
 const NativePC=RTCPeerConnection;window.RTCPeerConnection=class extends NativePC{constructor(...args){super(...args);window.__edgePeers.push(this);}};
});
const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
async function request(ctx,token,method,path,body){const res=await ctx.request.fetch(`${BASE}/api${path}`,{method,headers:{Authorization:`Bearer ${token}`,'X-Requested-With':'concord'},...(body===undefined?{}:{data:body})});assert.ok(res.ok(),`${method} ${path}: ${res.status()}`);return res.status()===204?null:res.json();}
async function login(page,email){await page.goto(`${BASE}/login`);await page.getByLabel('Email').fill(email);await page.getByLabel('Пароль',{exact:true}).fill('demo12345');const response=page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');await page.getByRole('button',{name:'Войти',exact:true}).click();const auth=await (await response).json();await page.getByText('Друзья',{exact:true}).first().waitFor();return auth;}
async function step(name,fn){if(process.env.EDGE_CASE&&!name.includes(process.env.EDGE_CASE))return;try{await fn();result.checks.push(name);console.log('PASS',name);}catch(e){result.failures.push({name,error:e.message});console.log('FAIL',name,e.message.split('\n')[0]);await page.screenshot({path:`${OUT}/failure-${result.failures.length}.png`}).catch(()=>undefined);}finally{await page.keyboard.press('Escape').catch(()=>undefined);await page.unrouteAll({behavior:'wait'});}}
let alice;
try{
 alice=await login(page,'alice@concord.local');await page.getByRole('button',{name:'Demo Server',exact:true}).click();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 const [,,serverId,channelId]=new URL(page.url()).pathname.split('/');
 const sample=await request(context,alice.accessToken,'POST',`/channels/${channelId}/messages`,{content:`edge bookmark ${run}`});
 await request(context,alice.accessToken,'PUT',`/messages/${sample.id}/bookmark`);
 const bookmarks=async()=>{await page.getByRole('button',{name:'Личные сообщения',exact:true}).click();await page.locator('.sidebar .chan',{hasText:'Закладки'}).click();};
 await step('bookmarks load failure stops the skeleton and retries successfully',async()=>{
  let fail=true;await page.route('**/api/bookmarks',async route=>fail?route.fulfill({status:503,json:{error:{code:'OFFLINE',message:'Simulated bookmark load failure'}}}):route.continue());
  await bookmarks();await page.getByRole('alert').filter({hasText:'Simulated bookmark load failure'}).waitFor();assert.equal(await page.locator('.modal .skeleton').count(),0);
  fail=false;await page.getByRole('button',{name:'Повторить загрузку',exact:true}).click();await page.locator('.modal .pcard-section',{hasText:sample.content}).waitFor();
 });
 await step('failed bookmark removal keeps the item and can be retried',async()=>{
  await page.route(`**/api/messages/${sample.id}/bookmark`,r=>r.fulfill({status:503,json:{error:{code:'OFFLINE',message:'Simulated bookmark removal failure'}}}));
  await bookmarks();const row=page.locator('.modal .pcard-section',{hasText:sample.content});await row.getByRole('button',{name:'Убрать',exact:true}).click();await page.getByText('Simulated bookmark removal failure',{exact:true}).waitFor();assert.equal(await row.count(),1);assert.equal(await row.getByRole('button',{name:'Убрать',exact:true}).isEnabled(),true);
  await page.unroute(`**/api/messages/${sample.id}/bookmark`);await row.getByRole('button',{name:'Убрать',exact:true}).click();await row.waitFor({state:'detached'});
 });
 await page.getByRole('button',{name:'Demo Server',exact:true}).click();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 await step('rapid sends queue in order while the first response is delayed',async()=>{
  let release,received,count=0;const gate=new Promise(r=>release=r),waiting=new Promise(r=>received=r);
  await page.route(`**/api/channels/${channelId}/messages`,async route=>{if(route.request().method()!=='POST')return route.continue();if(++count===1){received();await gate;}await route.continue();});
  try{const input=page.getByRole('textbox',{name:'Написать в #general'});await input.fill(`queued first ${run}`);await input.press('Enter');await waiting;await input.fill(`queued second ${run}`);await input.press('Enter');assert.equal(await input.inputValue(),'');assert.equal(count,1);release();await page.locator('.messages .msg-content',{hasText:`queued second ${run}`}).waitFor();const messages=await request(context,alice.accessToken,'GET',`/channels/${channelId}/messages`);assert.ok(BigInt(messages.find(m=>m.content===`queued first ${run}`).id)<BigInt(messages.find(m=>m.content===`queued second ${run}`).id));}finally{release();}
 });
 await step('search pagination retains the current page while loading the next',async()=>{
  let release,received;const gate=new Promise(r=>release=r),waiting=new Promise(r=>received=r);
  await page.route('**/api/search/messages?*',async route=>{const offset=Number(new URL(route.request().url()).searchParams.get('offset'));if(offset){received();await gate;}await route.fulfill({json:{total:50,results:[{...sample,content:offset?'Next search page':'Current search page',channelName:'general'}]}});});
  try{await page.getByRole('button',{name:'Поиск по сообщениям',exact:true}).click();await page.getByPlaceholder('Сообщения, люди, серверы, каналы…').fill('page');await page.locator('.modal .pcard-section',{hasText:'Current search page'}).waitFor();await page.getByRole('button',{name:'Далее →',exact:true}).click();await waiting;assert.equal(await page.locator('.modal .pcard-section',{hasText:'Current search page'}).count(),1);release();await page.locator('.modal .pcard-section',{hasText:'Next search page'}).waitFor();}finally{release();}
 });
 await step('thread images open in the shared viewer and Escape keeps the thread open',async()=>{
  const upload=await context.request.post(`${BASE}/api/channels/${channelId}/attachments`,{headers:{Authorization:`Bearer ${alice.accessToken}`,'X-Requested-With':'concord','X-File-Name':'edge-image.png','Content-Type':'image/png'},data:await readFile('test/fixtures/avatar.png')});assert.equal(upload.status(),201);
  const attachment=await upload.json(),parent=await request(context,alice.accessToken,'POST',`/channels/${channelId}/messages`,{content:`thread image ${run}`,attachmentIds:[attachment.id]});
  const row=page.locator(`.messages .msg[data-message-id="${parent.id}"]`);await row.click({button:'right'});await page.getByRole('menuitem',{name:'Открыть ветку',exact:true}).click();const thread=page.locator('.thread-panel');await thread.locator('.att-image').click();await page.locator('.lightbox img').waitFor();assert.equal(await page.locator('.lightbox img').getAttribute('alt'),'edge-image.png');
  await page.keyboard.press('Escape');await page.locator('.lightbox').waitFor({state:'detached'});assert.equal(await thread.count(),1);await page.getByRole('button',{name:'Закрыть ветку',exact:true}).click();
  let rejected=false;
  await page.route('**/api/attachments/**',async route=>{if(route.request().url().includes('compatibility-probe')&&!rejected){rejected=true;return route.fulfill({status:401,json:{error:{code:'UNAUTHORIZED'}}});}return route.continue();});
  const refresh=page.waitForResponse(r=>r.url().endsWith('/api/auth/refresh')&&r.request().method()==='POST');
  await row.locator('.att-image').evaluate((img,url)=>{img.src=url+'?compatibility-probe=1';},attachment.url);
  assert.equal((await refresh).status(),200);await row.locator('.att-image').evaluate(img=>img.scrollIntoView());await page.waitForFunction(id=>{const img=document.querySelector(`.messages .msg[data-message-id="${id}"] .att-image`);return img?.complete&&img.naturalWidth>0;},parent.id);assert.equal(rejected,true);
 });
 await step('late server response cannot restore a deleted server in the sidebar',async()=>{
  const full=await request(context,alice.accessToken,'POST','/servers',{name:`Edge remove ${run}`});servers.push(full.server.id);await page.getByRole('button',{name:full.server.name,exact:true}).waitFor();
  let release,received;const gate=new Promise(r=>release=r),waiting=new Promise(r=>received=r);await page.route(`**/api/servers/${full.server.id}`,async route=>{if(route.request().method()!=='GET')return route.continue();const response=await route.fetch();received();await gate;await route.fulfill({response});});
  try{
   const role=full.roles.find(r=>r.isDefault);await request(context,alice.accessToken,'PATCH',`/servers/${full.server.id}/roles/${role.id}`,{permissions:role.permissions});await waiting;
   await request(context,alice.accessToken,'DELETE',`/servers/${full.server.id}`);await page.getByRole('button',{name:full.server.name,exact:true}).waitFor({state:'detached'});
   const response=page.waitForResponse(r=>r.url().endsWith(`/api/servers/${full.server.id}`)&&r.request().method()==='GET');release();await (await response).finished();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await page.getByRole('button',{name:full.server.name,exact:true}).count(),0);
  }finally{release();}
 });
 await step('notification read and clear from another tab update the open inbox',async()=>{
  const tab=await context.newPage();tab.on('pageerror',e=>result.errors.push(e.message));
  try{
   const login=await other.request.post(`${BASE}/api/auth/login`,{headers:{'X-Requested-With':'concord'},data:{email:'bob@concord.local',password:'demo12345'}});assert.ok(login.ok());const bob=await login.json();
   const dm=await request(other,bob.accessToken,'POST','/dm',{recipientId:alice.user.id});
   await tab.goto(`${BASE}/channels/@me`);await tab.locator('.sidebar .chan',{hasText:'Уведомления'}).waitFor();
   await tab.route('**/api/notifications/read',r=>r.fulfill({status:503,json:{error:{code:'OFFLINE',message:'Test tab does not mark read'}}}));
   const content=`cross tab notification ${run}`;await request(other,bob.accessToken,'POST',`/channels/${dm.id}/messages`,{content});
   await tab.locator('.sidebar .chan',{hasText:'Уведомления'}).click();const item=tab.locator('.modal .pcard-section',{hasText:content});await item.waitFor();assert.match(await item.getAttribute('style'),/accent-soft/);
   await request(context,alice.accessToken,'POST','/notifications/read',{ids:'all'});await tab.waitForFunction(text=>{const row=[...document.querySelectorAll('.modal .pcard-section')].find(e=>e.textContent.includes(text));return row&&!row.getAttribute('style').includes('accent-soft');},content);
   await request(context,alice.accessToken,'DELETE','/notifications');await item.waitFor({state:'detached'});
  }finally{await tab.close();await other.clearCookies();}
 });
 await step('revoking voice sources releases captures, restoring SPEAK republishes, CONNECT removal disconnects',async()=>{
  const bobPage=await other.newPage();bobPage.on('pageerror',e=>result.errors.push(e.message));const bob=await login(bobPage,'bob@concord.local');
  const full=await request(context,alice.accessToken,'POST','/servers',{name:`Edge voice ${run}`});servers.push(full.server.id);
  const invite=await request(context,alice.accessToken,'POST',`/servers/${full.server.id}/invites`,{});await request(other,bob.accessToken,'POST',`/invites/${invite.code}`);
  await bobPage.getByRole('button',{name:full.server.name,exact:true}).click();await bobPage.locator('.sidebar .chan',{hasText:'General'}).last().click();await bobPage.getByText('Голосовая связь подключена',{exact:true}).waitFor();await bobPage.waitForFunction(()=>window.__edgeCaptures.some(s=>s.getAudioTracks().some(t=>t.readyState==='live')));
  const role=full.roles.find(r=>r.isDefault),connect=1n<<16n,speak=1n<<17n;
  await request(context,alice.accessToken,'PATCH',`/servers/${full.server.id}/roles/${role.id}`,{permissions:connect.toString()});
  await bobPage.waitForFunction(()=>window.__edgeCaptures.every(s=>s.getTracks().every(t=>t.readyState==='ended')),null,{timeout:5000});
  const captured=await bobPage.evaluate(()=>window.__edgeCaptures.length);
  await request(context,alice.accessToken,'PATCH',`/servers/${full.server.id}/roles/${role.id}`,{permissions:(connect|speak).toString()});
  await bobPage.waitForFunction(n=>window.__edgeCaptures.length>n&&window.__edgeCaptures.at(-1).getAudioTracks().some(t=>t.readyState==='live'),captured);
  await request(context,alice.accessToken,'PATCH',`/servers/${full.server.id}/roles/${role.id}`,{permissions:'0'});await bobPage.locator('.vpanel').waitFor({state:'detached'});await bobPage.waitForFunction(()=>window.__edgeCaptures.every(s=>s.getTracks().every(t=>t.readyState==='ended'))&&window.__edgeAudio.every(c=>c.state!=='running'));await bobPage.close();
 });
 assert.deepEqual(result.failures,[]);assert.deepEqual(result.errors,[]);
}finally{
 if(alice)for(const id of servers)await request(context,alice.accessToken,'DELETE',`/servers/${id}`).catch(()=>undefined);
 await browser.close();await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
}
