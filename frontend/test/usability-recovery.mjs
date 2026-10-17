import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const BASE=process.env.BASE_URL??'http://localhost:5181',OUT=process.env.USABILITY_DIR??'test/results/usability';
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();
const result={checks:[],failures:[],errors:[]},releases=[];
page.setDefaultTimeout(6000);page.on('pageerror',e=>result.errors.push(e.message));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const respond=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
const unavailable=route=>respond(route,{error:{code:'TEST_OFFLINE',message:'Временная ошибка проверки'}},503);
const navigate=path=>page.evaluate(path=>{history.pushState(null,'',path);dispatchEvent(new PopStateEvent('popstate'));},path);
async function step(name,fn){
 if(process.env.USABILITY_CASE&&!name.includes(process.env.USABILITY_CASE))return;
 try{await fn();result.checks.push(name);console.log('PASS',name);}
 catch(e){result.failures.push({name,error:e.message});console.log('FAIL',name,e.message.split('\n')[0]);}
 finally{for(const release of releases.splice(0))release();await page.unrouteAll({behavior:'wait'});await page.keyboard.press('Escape').catch(()=>undefined);}
}
let alice,serverId,channelId,original;
const general=async()=>{await page.getByRole('button',{name:'Demo Server',exact:true}).click();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();};
const api=async(method,path,body)=>{
 const response=await context.request.fetch(`${BASE}/api${path}`,{method,headers:{Authorization:`Bearer ${alice.accessToken}`,'X-Requested-With':'concord'},...(body===undefined?{}:{data:body})});
 assert.ok(response.ok(),`${method} ${path}: ${response.status()}`);return response.status()===204?null:response.json();
};
try{
 await page.goto(`${BASE}/login`);await page.getByLabel('Email').fill('alice@concord.local');await page.getByLabel('Пароль',{exact:true}).fill('demo12345');
 const logged=page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');await page.getByRole('button',{name:'Войти',exact:true}).click();alice=await(await logged).json();
 await page.getByText('Друзья',{exact:true}).first().waitFor();await general();[,,serverId,channelId]=new URL(page.url()).pathname.split('/');original=new URL(page.url()).pathname;

 await step('failed initial history has a visible retry without leaving the channel',async()=>{
  let calls=0;await page.route(`**/api/channels/${channelId}/messages*`,route=>route.request().method()==='GET'&&++calls===1?unavailable(route):route.continue());
  await page.reload();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
  const retry=page.getByRole('button',{name:'Повторить загрузку сообщений',exact:true});await retry.waitFor();
  assert.equal(await page.locator('.messages .skeleton').count(),0);await retry.click();await page.locator('.messages .msg[data-message-id]').first().waitFor();
  assert.ok(calls>=2);assert.equal(await retry.count(),0);
 });
 await page.reload();await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();

 await step('a pinned direct message navigates to its history position',async()=>{
  const users=await api('GET','/search?q=bob'),bob=users.users.find(u=>u.username==='bob');assert.ok(bob);
  const dm=await api('POST','/dm',{recipientId:bob.id});await navigate(`/channels/@me/${dm.id}`);await page.locator('.composer textarea').waitFor();
  const message={id:'9223372036854000001',channelId:dm.id,serverId:null,author:bob,kind:'default',content:'Pinned direct-message jump',replyTo:null,attachments:[],embeds:[],reactions:[],mentionIds:[],mentionsEveryone:false,pinned:true,editedAt:null,createdAt:new Date().toISOString()};
  await page.route(`**/api/channels/${dm.id}/pins`,route=>respond(route,[message]));
  await page.route(`**/api/channels/${dm.id}/messages?around=*`,route=>respond(route,[message]));
  await page.getByRole('button',{name:'Закреплённые сообщения',exact:true}).click();await page.locator('.menu-item').filter({hasText:message.content}).click();
  await page.waitForURL(`**/channels/@me/${dm.id}/${message.id}`);await page.locator(`.messages .msg[data-message-id="${message.id}"]`).waitFor();
 });
 await general();

 await step('failed server creation retains its dialog and entered name for retry',async()=>{
  await page.route('**/api/servers',route=>route.request().method()==='POST'?unavailable(route):route.continue());
  await page.getByRole('button',{name:'Добавить сервер',exact:true}).click();const name=page.getByLabel('Название сервера');await name.fill('Keep this server draft');
  await page.getByRole('button',{name:'Создать',exact:true}).click();await page.getByText('Временная ошибка проверки',{exact:true}).last().waitFor();
  assert.equal(await name.isVisible(),true);assert.equal(await name.inputValue(),'Keep this server draft');assert.equal(await page.getByRole('button',{name:'Создать',exact:true}).isEnabled(),true);
 });

 await step('failed channel creation retains its dialog and entered name for retry',async()=>{
  await page.route(`**/api/servers/${serverId}/channels`,route=>route.request().method()==='POST'?unavailable(route):route.continue());
  await page.getByRole('button',{name:'Создать канал',exact:true}).first().click();const name=page.getByLabel('Название',{exact:true});await name.fill('keep-channel-draft');
  await page.getByRole('button',{name:'Создать канал',exact:true}).last().click();await page.getByText('Временная ошибка проверки',{exact:true}).last().waitFor();
  assert.equal(await name.isVisible(),true);assert.equal(await name.inputValue(),'keep-channel-draft');assert.equal(await page.locator('.modal').getByRole('button',{name:'Создать канал',exact:true}).isEnabled(),true);
 });

 await step('repeated Enter sends one pending channel creation',async()=>{
  let calls=0;const gate=deferred(),arrived=deferred();releases.push(gate.resolve);
  await page.route(`**/api/servers/${serverId}/channels`,async route=>{if(route.request().method()!=='POST')return route.continue();calls++;arrived.resolve();await gate.promise;return unavailable(route);});
  await page.getByRole('button',{name:'Создать канал',exact:true}).first().click();const name=page.getByLabel('Название',{exact:true});await name.fill('single-pending-channel');await name.press('Enter');await arrived.promise;await name.press('Enter');await page.waitForTimeout(120);
  assert.equal(calls,1);gate.resolve();await page.locator('.modal').getByRole('button',{name:'Создать канал',exact:true}).waitFor();
 });

 await step('2FA setup reports a server failure and remains retryable without a page error',async()=>{
  const errorCount=result.errors.length;await page.route('**/api/auth/2fa/setup',unavailable);
  await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('button',{name:'Безопасность',exact:true}).click();
  const setup=page.getByRole('button',{name:'Включить 2FA',exact:true});await setup.click();await page.getByText('Временная ошибка проверки',{exact:true}).last().waitFor();
  assert.equal(await setup.isEnabled(),true);assert.equal(result.errors.length,errorCount);
  await page.getByRole('button',{name:'Закрыть настройки',exact:true}).click();
 });
 if(await page.getByRole('button',{name:'Закрыть настройки',exact:true}).isVisible())await page.getByRole('button',{name:'Закрыть настройки',exact:true}).click();
 await navigate(original);
 assert.deepEqual(result.failures,[]);assert.deepEqual(result.errors,[]);
}finally{for(const release of releases)release();await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
