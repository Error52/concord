import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const BASE=process.env.BASE_URL??'http://localhost:5180',OUT=process.env.COMPOSER_DIR??'test/results/composer';
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const result={checks:[],errors:[]};
async function session(){
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 await context.addInitScript(()=>{
  window.__blobs=new Set();window.__uploadAborts=0;
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
  URL.createObjectURL=b=>{const u=create(b);window.__blobs.add(u);return u;};
  URL.revokeObjectURL=u=>{window.__blobs.delete(u);revoke(u);};
  const open=XMLHttpRequest.prototype.open,abort=XMLHttpRequest.prototype.abort;
  XMLHttpRequest.prototype.open=function(method,url,...rest){this.__attachment=String(url).endsWith('/attachments');return open.call(this,method,url,...rest);};
  XMLHttpRequest.prototype.abort=function(){if(this.__attachment&&this.readyState!==4)window.__uploadAborts++;return abort.call(this);};
 });
 const page=await context.newPage();page.on('pageerror',e=>result.errors.push(e.message));
 await page.goto(`${BASE}/login`);await login(page,'alice');
 await page.getByRole('button',{name:'Demo Server',exact:true}).click();
 const input=page.getByRole('textbox',{name:'Написать в #general'});await input.waitFor();
 return {context,page,input};
}
async function login(page,name){await page.getByLabel('Email').fill(`${name}@concord.local`);await page.getByLabel('Пароль',{exact:true}).fill('demo12345');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByText('Друзья',{exact:true}).first().waitFor();}
async function upload(page){await page.locator('.composer-wrap input[type=file]').setInputFiles('test/fixtures/avatar.png');await page.locator('.upload .muted').waitFor();}
try{
 {
  const {context,page,input}=await session();await input.fill('draft survives a round trip');
  await page.getByRole('button',{name:'Личные сообщения',exact:true}).click();await input.waitFor({state:'detached'});
  await page.getByRole('button',{name:'Demo Server',exact:true}).click();await input.waitFor();assert.equal(await input.inputValue(),'draft survives a round trip');
  result.checks.push('reopening a channel restores the account draft');await context.close();
 }
 {
  const {context,page,input}=await session();let received,release,firstNonce;const waiting=new Promise(r=>received=r),gate=new Promise(r=>release=r),pattern='**/api/channels/*/messages';
  await page.route(pattern,async route=>{if(route.request().method()!=='POST')return route.continue();firstNonce=route.request().postDataJSON().nonce;received();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'OFFLINE',message:'Late simulated failure'}})});});
  await input.fill('restore after returning');await input.press('Enter');await waiting;
  await page.getByRole('button',{name:'Личные сообщения',exact:true}).click();await input.waitFor({state:'detached'});
  await page.getByRole('button',{name:'Demo Server',exact:true}).click();await input.waitFor();assert.equal(await input.inputValue(),'');release();
  await page.waitForFunction(()=>document.querySelector('textarea[aria-label="Написать в #general"]')?.value==='restore after returning');
  await page.unroute(pattern);let retryNonce;
  await page.route(pattern,async route=>{if(route.request().method()==='POST')retryNonce=route.request().postDataJSON().nonce;return route.continue();});
  const sent=page.waitForResponse(response=>response.request().method()==='POST'&&/\/channels\/[^/]+\/messages$/.test(response.url()));
  await input.press('Enter');assert.equal((await sent).status(),201);assert.equal(retryNonce,firstNonce);
  result.checks.push('late send failure reaches the reopened editor and its retry retains the original nonce');await context.close();
 }
 {
  const {context,page,input}=await session(),run=Date.now().toString(36),firstText=`uncertain first ${run}`,secondText=`uncertain second ${run}`;
  const recorded=[],gates=[],arrivals=[];
  for(let i=0;i<2;i++){
   let release,received;gates.push({promise:new Promise(r=>release=r),release:()=>release()});arrivals.push({promise:new Promise(r=>received=r),received:()=>received()});
  }
  const pattern='**/api/channels/*/messages';
  await page.route(pattern,async route=>{
   if(route.request().method()!=='POST')return route.continue();
   const index=recorded.length;
   if(index>=2)return route.continue();
   const body=route.request().postDataJSON(),response=await route.fetch();assert.equal(response.status(),201);
   recorded.push({body,message:await response.json(),url:route.request().url(),headers:route.request().headers()});
   arrivals[index].received();await gates[index].promise;
   return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'LOST_RESPONSE',message:`Lost response ${index+1}`}})});
  });
  await input.fill(firstText);await input.press('Enter');await arrivals[0].promise;
  await input.fill(secondText);gates[0].release();await page.getByText('Lost response 1',{exact:true}).waitFor();
  assert.equal(await input.inputValue(),secondText);await input.press('Enter');await arrivals[1].promise;gates[1].release();
  await page.getByText('Lost response 2',{exact:true}).waitFor();await input.fill(firstText);
  let retryNonce;await page.unroute(pattern);
  await page.route(pattern,route=>{if(route.request().method()==='POST')retryNonce=route.request().postDataJSON().nonce;return route.continue();});
  const retried=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===recorded[0].url);await input.press('Enter');const response=await retried;
  assert.equal(response.status(),201);assert.equal(retryNonce,recorded[0].body.nonce);assert.equal((await response.json()).id,recorded[0].message.id);
  const history=await context.request.get(recorded[0].url,{headers:{Authorization:recorded[0].headers.authorization}});assert.equal(history.status(),200);
  const messages=await history.json();assert.equal(messages.filter(m=>m.content===firstText).length,1);assert.equal(messages.filter(m=>m.content===secondText).length,1);
  result.checks.push('two committed sends with lost replies retain their own nonce; retrying the first creates no duplicate');await context.close();
 }
 {
  const {context,page}=await session();
  await upload(page);assert.equal(await page.evaluate(()=>window.__blobs.size),1);
  await page.getByRole('button',{name:'Убрать файл',exact:true}).click();
  await page.waitForFunction(()=>window.__blobs.size===0,{},{timeout:3000});result.checks.push('removed attachment releases its preview');
  await context.close();
 }
 {
  const {context,page,input}=await session();await upload(page);
  let release,received;const waiting=new Promise(r=>received=r),gate=new Promise(r=>release=r);
  const pattern='**/api/channels/*/messages';
  await page.route(pattern,async route=>{if(route.request().method()!=='POST')return route.continue();received();await gate;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'OFFLINE',message:'Simulated connection failure'}})});});
  await input.fill('original draft');await input.press('Enter');await waiting;await input.fill('new draft while sending');release();
  await page.getByText('Simulated connection failure',{exact:true}).waitFor();
  assert.equal(await input.inputValue(),'new draft while sending');assert.equal(await page.locator('.upload').count(),1);
  await page.unroute(pattern);await input.press('Enter');await page.waitForFunction(()=>window.__blobs.size===0);await page.locator('.upload').waitFor({state:'detached'});
  result.checks.push('failed send retains attachments and a newly typed draft; retry succeeds');await context.close();
 }
 {
  const {context,page,input}=await session();let received,release;const waiting=new Promise(r=>received=r),gate=new Promise(r=>release=r);
  await page.route('**/api/channels/*/attachments',async route=>{received();await gate;await route.abort().catch(()=>undefined);});
  await page.locator('.composer-wrap input[type=file]').setInputFiles('test/fixtures/avatar.png');await waiting;
  await page.getByRole('button',{name:'Личные сообщения',exact:true}).click();await input.waitFor({state:'detached'});
  assert.equal(await page.evaluate(()=>window.__blobs.size),0);assert.ok(await page.evaluate(()=>window.__uploadAborts)>0);release();
  result.checks.push('leaving a channel aborts the pending upload and releases its preview');await context.close();
 }
 {
  const {context,page,input}=await session();await input.fill('private unsent Alice draft');
  await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('button',{name:'Выйти',exact:true}).click();
  await page.getByRole('heading',{name:'С возвращением!',exact:true}).waitFor();await login(page,'bob');
  await page.getByRole('button',{name:'Demo Server',exact:true}).click();const bob=page.getByRole('textbox',{name:'Написать в #general'});await bob.waitFor();assert.equal(await bob.inputValue(),'');
  result.checks.push('switching accounts does not expose the former account draft');await context.close();
 }
 assert.deepEqual(result.errors,[]);
}catch(e){result.failure=e.message;throw e;}
finally{await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
