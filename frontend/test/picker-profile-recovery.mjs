import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const BASE=process.env.BASE_URL??'http://localhost:5180',OUT=process.env.PICKER_DIR??'test/results/picker-profile';
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const result={checks:[],errors:[]};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const gif=id=>({id,title:`GIF ${id}`,url:'https://media.tenor.com/concord-test.gif',previewUrl:'/favicon.svg',width:100,height:100});
const respond=(route,body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
try{
 const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();let ready;
 page.on('pageerror',e=>result.errors.push(e.message));
 // Enable only this test's mocked GIF endpoint. No provider key or external request is used.
 await page.routeWebSocket('**/api/gateway',ws=>{const server=ws.connectToServer();server.onMessage(message=>{let payload;try{payload=JSON.parse(String(message));}catch{}if(payload?.t==='ready'){ready=payload.d;payload.d.features.gif.enabled=true;ws.send(JSON.stringify(payload));}else ws.send(message);});});
 const requests=new Map(),arrivals=new Map(),pending=new Map();
 const arrival=key=>{if(requests.has(key))return Promise.resolve();let d=arrivals.get(key);if(!d)arrivals.set(key,d=deferred());return d.promise;};
 await page.route('**/api/gifs/**',async route=>{
  const url=new URL(route.request().url());if(url.pathname.endsWith('/categories'))return respond(route,[]);
  const key=url.pathname.endsWith('/trending')?'trending':url.searchParams.get('q');requests.set(key,(requests.get(key)??0)+1);arrivals.get(key)?.resolve();
  const gate=pending.get(key);if(gate)await gate.promise;
  return respond(route,{items:[gif(key)],next:key==='old'||key==='cleared'?'stale-cursor':null});
 });
 await page.goto(`${BASE}/login`);await page.getByLabel('Email').fill('alice@concord.local');await page.getByLabel('Пароль',{exact:true}).fill('demo12345');await page.getByRole('button',{name:'Войти',exact:true}).click();await page.getByText('Друзья',{exact:true}).first().waitFor();
 await page.getByRole('button',{name:'Demo Server',exact:true}).click();const input=page.getByRole('textbox',{name:'Написать в #general'});await input.waitFor();
 await page.getByRole('button',{name:'GIF',exact:true}).click();const search=page.getByPlaceholder('Поиск GIF');await search.waitFor();
 pending.set('old',deferred());await search.fill('old');await arrival('old');await search.fill('new');await page.getByRole('button',{name:'GIF new',exact:true}).waitFor();
 const delayedSearch=page.waitForResponse(r=>r.url().includes('/gifs/search')&&new URL(r.url()).searchParams.get('q')==='old');pending.get('old').resolve();await delayedSearch;await page.waitForTimeout(150);
 assert.equal(await page.getByRole('button',{name:'GIF new',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'GIF old',exact:true}).count(),0);result.checks.push('a late GIF search response cannot replace the current query');
 pending.set('cleared',deferred());await search.fill('cleared');await arrival('cleared');await search.fill('');await page.getByRole('button',{name:'🔥 Популярные',exact:true}).waitFor();
 const oldResponse=page.waitForResponse(r=>r.url().includes('/gifs/search')&&new URL(r.url()).searchParams.get('q')==='cleared');pending.get('cleared').resolve();await oldResponse;await page.waitForTimeout(150);
 assert.equal(await page.getByRole('button',{name:'🔥 Популярные',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'GIF cleared',exact:true}).count(),0);result.checks.push('clearing GIF search rejects late results and their pagination cursor');
 await page.getByRole('button',{name:'🔥 Популярные',exact:true}).click();await page.getByRole('button',{name:'GIF trending',exact:true}).waitFor();
 await input.fill('keep my text when sending a GIF');let sentGif=false;
 await page.route('**/api/channels/*/messages',async route=>{if(route.request().method()!=='POST')return route.continue();const body=route.request().postDataJSON();if(!body.gif)return route.continue();sentGif=true;const channelId=new URL(route.request().url()).pathname.split('/')[3];return respond(route,{id:'9223372036854000000',channelId,serverId:ready.servers.find(s=>s.channels.some(c=>c.id===channelId))?.server.id??null,author:ready.user,kind:'default',content:'',replyTo:null,attachments:[],embeds:[{...body.gif,type:'gif',provider:'test'}],reactions:[],mentionIds:[],mentionsEveryone:false,pinned:false,editedAt:null,createdAt:new Date().toISOString(),nonce:body.nonce},201);});
 const gifResponse=page.waitForResponse(r=>r.request().method()==='POST'&&/\/channels\/[^/]+\/messages$/.test(r.url()));await page.getByRole('button',{name:'GIF trending',exact:true}).click();assert.equal((await gifResponse).status(),201);await search.waitFor({state:'detached'});assert.equal(await input.inputValue(),'keep my text when sending a GIF');assert.equal(sentGif,true);result.checks.push('sending a GIF preserves the current text draft');
 const members=ready.servers.find(s=>s.server.name==='Demo Server').members.map(m=>m.user),alice=ready.user,bob=members.find(u=>u.username==='bob');assert.ok(bob);
 const profile=(user,old=false)=>({user,relationship:user.id===alice.id?'self':'friend',mutualServers:old?[{id:'old-server',name:'OLD PRIVATE SNAPSHOT',iconUrl:null}]:[],mutualFriends:[]});
 for(const fail of [false,true]){
  const gate=deferred(),seen=deferred();const pattern=`**/api/users/${alice.id}`;
  await page.route(pattern,async route=>{seen.resolve();await gate.promise;return fail?respond(route,{error:{code:'OFFLINE',message:'Stale profile error'}},503):respond(route,profile(alice,true));});
  await page.route(`**/api/users/${bob.id}`,route=>respond(route,profile(bob)));
  const member=user=>page.locator('.members .member').filter({hasText:user.displayName||user.username}).first();
  await member(alice).click();await seen.promise;await member(bob).click();await page.locator('.profile-popover .pcard-name').filter({hasText:bob.displayName||bob.username}).waitFor();
  const finished=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/users/${alice.id}`);gate.resolve();await finished;await page.waitForTimeout(150);
  assert.equal(await page.locator('.profile-popover .pcard-name').textContent(),bob.displayName||bob.username);assert.equal(await page.getByText('OLD PRIVATE SNAPSHOT',{exact:true}).count(),0);assert.equal(await page.getByText('Stale profile error',{exact:true}).count(),0);
  result.checks.push(fail?'a stale profile failure cannot close a newer profile':'a stale profile response cannot replace the selected user or mutual servers');await page.keyboard.press('Escape');await page.unroute(pattern);await page.unroute(`**/api/users/${bob.id}`);
 }
 assert.deepEqual(result.errors,[]);await context.close();
}catch(error){result.failure=error.message;throw error;}
finally{await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
