import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const base = process.env.BASE_URL ?? 'http://localhost:5173';
const dir = process.env.AUDIT_DIR ?? path.resolve('../../audit-results');
await mkdir(dir, {recursive:true});
const browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH || undefined});
const results=[];
const errors=[];
const checks=[];
async function fits(page, selector) {
 const m=await page.locator(selector).evaluate(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:e.scrollWidth,client:e.clientWidth};});
 assert.ok(m.left>=-1 && m.right<=m.width+1 && m.top>=-1 && m.bottom<=m.height+1,`${selector} stays in viewport: ${JSON.stringify(m)}`);
 return m;
}
async function wheel(page, selector) {
 const e=page.locator(selector);
 const before=await e.evaluate(el=>{el.scrollTop=el.scrollHeight;return {top:el.scrollTop,max:el.scrollHeight-el.clientHeight};});
 if(before.max<=2)return;
 await page.waitForFunction(selector=>{const e=document.querySelector(selector),r=e.getBoundingClientRect();return !!document.elementFromPoint(r.x+8,r.y+r.height/2)?.closest(selector);},selector);
 const box=await e.boundingBox();await page.mouse.move(box.x+8,box.y+box.height/2);await page.mouse.wheel(0,-500);
 try {await page.waitForFunction(({selector,top})=>document.querySelector(selector).scrollTop<top-1,{selector,top:before.top},{timeout:3000});}
 catch(err){throw new Error(`wheel ${selector} failed in ${await page.locator('.settings-content h2').first().innerText().catch(()=> 'chat')} at ${await page.evaluate(()=>innerWidth)}: ${JSON.stringify(before)}`,{cause:err});}
 checks.push(`wheel ${selector} at ${await page.evaluate(()=>`${innerWidth}x${innerHeight}`)}`);
}
try {
 const context=await browser.newContext({viewport:{width:1440,height:900}});
 const page=await context.newPage();
 page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/login`);
 await page.getByLabel('Email').fill('alice@concord.local');
 await page.getByLabel('Пароль').fill('demo12345');
 await page.getByRole('button',{name:'Войти',exact:true}).click();
 await page.getByRole('button',{name:'Demo Server',exact:true}).waitFor();
 await page.getByRole('button',{name:'Demo Server',exact:true}).click();
 await page.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 for(const [width,height] of [[1440,900],[1920,1080],[1280,720],[1024,768],[768,1024],[760,600],[390,844],[360,640],[320,568],[667,375]]) {
  await page.setViewportSize({width,height});
  await page.screenshot({path:path.join(dir,`chat-${width}x${height}.png`)});
  const metrics=await page.evaluate(()=>{
   const rect=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();const c=getComputedStyle(e);return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,overflowY:c.overflowY,bg:c.backgroundColor,font:c.fontFamily,fontSize:c.fontSize};};
   return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,app:rect('.app'),main:rect('.main'),chat:rect('.chat'),messages:rect('.messages'),composer:rect('.composer-wrap'),members:rect('.members')};
  });
  results.push(metrics);
  assert.ok(metrics.documentWidth<=width,`no horizontal page overflow at ${width}`);
  await fits(page,'.composer-wrap');
  await wheel(page,'.messages');
 }
 await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:'Настройки',exact:true}).click();
 await page.getByRole('button',{name:'Голос и видео',exact:true}).click();
 for(const [width,height] of [[1440,900],[1024,768],[768,1024],[390,844],[320,568],[667,375]]) {
  await page.setViewportSize({width,height});
  await page.screenshot({path:path.join(dir,`settings-${width}x${height}.png`)});
  results.push(await page.evaluate(()=>{
   const e=document.querySelector('.settings-content'),nav=document.querySelector('.settings-nav');
   const r=e.getBoundingClientRect();
   return {view:'settings',width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,content:{width:r.width,height:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight},navWidth:nav.getBoundingClientRect().width};
  }));
  const m=results.at(-1);
  assert.ok(m.content.scrollWidth<=m.content.clientWidth+1,`voice settings fit at ${width}`);
  await fits(page,'.settings-content');
  await wheel(page,'.settings-content');
 }
 for(const width of [1440,390,320]) {
  await page.setViewportSize({width,height:width===1440?900:568});
  for(const name of ['Моя учётная запись','Профиль','Конфиденциальность','Безопасность','Уведомления','Голос и видео','Внешний вид','Доступность','Язык','Горячие клавиши','Админ-панель']) {
   await page.locator('.settings-nav').getByRole('button',{name,exact:true}).click();
   await page.locator('.settings-content h2').first().waitFor();
   const m=await fits(page,'.settings-content');
   assert.ok(m.scroll<=m.client+1,`${name} has no clipped horizontal content at ${width}: ${JSON.stringify(m)}`);
   await wheel(page,'.settings-content');
   checks.push(`${name} ${width}`);
  }
 }
 await page.getByRole('button',{name:'Закрыть настройки'}).click();
 await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:'Demo Server',exact:true}).first().click({button:'right'});
 await page.getByRole('menuitem',{name:'Настройки сервера',exact:true}).click();
 for(const width of [1440,390,320]) {
  await page.setViewportSize({width,height:width===1440?900:568});
  for(const name of ['Обзор','Роли','Участники','Значки','Приглашения','Баны','Журнал аудита']) {
   await page.locator('.settings-nav').getByRole('button',{name,exact:true}).click();
   await page.locator('.settings-content h2').first().waitFor();
   const m=await fits(page,'.settings-content');assert.ok(m.scroll<=m.client+1,`server ${name} fits at ${width}: ${JSON.stringify(m)}`);
   await wheel(page,'.settings-content');checks.push(`server ${name} ${width}`);
  }
 }
 await page.locator('.settings-close button').click();
 await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:'Добавить сервер',exact:true}).click();
 for(const [width,height] of [[390,844],[320,568],[667,375]]) {
  await page.setViewportSize({width,height});await fits(page,'.modal');await wheel(page,'.modal-body');
  for(let i=0;i<12;i++){await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.querySelector('.modal').contains(document.activeElement)),'dialog keeps keyboard focus');}
  await page.screenshot({path:path.join(dir,`modal-${width}x${height}.png`)});
 }
 await page.keyboard.press('Escape');await page.locator('.modal').waitFor({state:'hidden'});
 await page.setViewportSize({width:390,height:844});
 await page.locator('.msg').first().click({button:'right'});
 await page.getByRole('menuitem',{name:'Открыть ветку',exact:true}).click();
 await page.locator('.thread-panel .msg').first().waitFor();
 await fits(page,'.thread-panel');await fits(page,'.thread-panel .composer-wrap');
 await page.screenshot({path:path.join(dir,'thread-390x844.png')});
 await page.getByRole('button',{name:'Закрыть ветку'}).click();
 await page.getByRole('button',{name:'Эмодзи',exact:true}).click();await fits(page,'.picker');await wheel(page,'.picker-body');
 await page.keyboard.press('Escape');
 await page.locator('.msg').first().click({button:'right'});await page.getByRole('menuitem',{name:'Добавить реакцию',exact:true}).click();
 for(const [width,height] of [[390,844],[320,568],[667,375]]) {await page.setViewportSize({width,height});await fits(page,'.picker');await wheel(page,'.picker-body');}
 await page.keyboard.press('Escape');await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Меню',exact:true}).first().click();await page.locator('.app.nav-open').waitFor();
 await page.keyboard.press('Escape');await page.locator('.app.nav-open').waitFor({state:'hidden'});
 const guest=await browser.newContext({viewport:{width:320,height:568},isMobile:true,hasTouch:true});
 const auth=await guest.newPage();auth.on('pageerror',e=>errors.push(e.message));
 for(const route of ['login','register','forgot','reset-password','verify-email']) {
  await auth.goto(`${base}/${route}`);await auth.locator('.auth-card').waitFor();
  for(const [width,height] of [[320,568],[667,375]]) {
   await auth.setViewportSize({width,height});
   const m=await auth.locator('.auth-shell').evaluate(e=>({scroll:e.scrollWidth,client:e.clientWidth}));assert.ok(m.scroll<=m.client,`${route} fits ${width}`);
   await wheel(auth,'.auth-shell');checks.push(`auth ${route} ${width}`);
  }
 }
 await auth.setViewportSize({width:390,height:844});await auth.goto(`${base}/login`);
 await auth.getByLabel('Email').fill('alice@concord.local');await auth.getByLabel('Пароль').fill('demo12345');await auth.getByRole('button',{name:'Войти',exact:true}).click();
 await auth.getByRole('button',{name:'Меню',exact:true}).first().click();await auth.locator('.rail').getByRole('button',{name:'Demo Server',exact:true}).click();
 await auth.getByRole('textbox',{name:'Написать в #general'}).waitFor();
 await auth.locator('.messages .msg').first().waitFor();
 await auth.waitForFunction(()=>{const e=document.querySelector('.messages'),r=e.getBoundingClientRect();return e.scrollHeight>e.clientHeight+20 && document.elementFromPoint(20,300)?.closest('.messages');});
 await auth.locator('.messages').evaluate(e=>e.scrollTop=e.scrollHeight);
 const top=await auth.locator('.messages').evaluate(e=>e.scrollTop);
 const cdp=await guest.newCDPSession(auth);
 await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:200,y:250}]});
 for(let y=270;y<=550;y+=20){await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:200,y}]});await auth.waitForTimeout(16);}
 await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 try {await auth.waitForFunction(top=>document.querySelector('.messages').scrollTop<top,top,{timeout:3000});}
 catch(error){console.log(await auth.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight,scale:visualViewport.scale},messages:{top:document.querySelector('.messages').scrollTop,max:document.querySelector('.messages').scrollHeight-document.querySelector('.messages').clientHeight},hit:document.elementFromPoint(200,300)?.outerHTML.slice(0,150)})));throw error;}
 assert.ok(await auth.locator('.messages').evaluate(e=>e.scrollTop)<top,'touch swipe scrolls history');checks.push('touch swipe chat');
 await auth.setViewportSize({width:390,height:360});await fits(auth,'.composer-wrap');checks.push('chat with reduced keyboard viewport');
 await guest.close();
 assert.equal(errors.length,0,'no unhandled browser exceptions');
 await writeFile(path.join(dir,'metrics.json'),JSON.stringify({results,checks,errors},null,2));
 console.log(JSON.stringify({checks:checks.length,layouts:results.length,errors}));
} finally {await browser.close();}
