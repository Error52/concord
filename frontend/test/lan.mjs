// Real HTTPS/API/UI against the configured LAN endpoint; requires DEMO_MAILBOX=1.
// Creates one disposable test account. The browser trusts only the supplied LAN CA in its isolated profile.
import {chromium} from 'playwright';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {lanBrowserArgs} from './lan-tls.mjs';
import https from 'node:https';
import assert from 'node:assert/strict';
const BASE=process.env.BASE_URL,OUT=process.env.LAN_DIR??'test/results/lan';
assert.ok(BASE?.startsWith('https://')&&process.env.LAN_CA_FILE,'Set BASE_URL and LAN_CA_FILE');
const ca=await readFile(process.env.LAN_CA_FILE);
await mkdir(OUT,{recursive:true});
const result={origin:BASE,errors:[],testCertificateTrust:'explicit CA for Node; validated server leaf SPKI in isolated Chrome',physicalSecondDevice:false};
const health=await new Promise((resolve,reject)=>https.get(BASE+'/api/health',{ca},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(b),authorized:res.socket?.authorized});}catch(e){reject(e);}});}).on('error',reject));
assert.equal(health.status,200);assert.equal(health.body.ok,true);result.https=true;
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:await lanBrowserArgs(BASE,process.env.LAN_CA_FILE)});
let page;
try{
 const context=await browser.newContext({viewport:{width:320,height:568}});page=await context.newPage();
 page.on('pageerror',e=>result.errors.push(e.message.replace(/token=[^\s&]+/g,'token=[redacted]')));
 await page.goto(BASE+'/register');
 assert.equal(await page.evaluate(()=>window.isSecureContext&&typeof navigator.mediaDevices?.getUserMedia==='function'&&typeof navigator.mediaDevices?.getDisplayMedia==='function'),true);result.secureMediaContext=true;
 const name='lan'+Date.now().toString(36),password=randomBytes(20).toString('base64url');
 await page.getByLabel('Имя пользователя').fill(name);await page.getByLabel('Email').fill(name+'@lan-test.invalid');
 await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByLabel('Повторите пароль').fill(password);
 await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByRole('heading',{name:'Подтвердите почту',exact:true}).waitFor();
 assert.ok((await context.cookies()).some(c=>c.name==='cc_refresh'&&c.secure&&c.httpOnly&&c.sameSite==='Strict'));result.secureSessionCookie=true;
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:OUT+'/pending-mobile.png',fullPage:true});result.mobile=true;
 const bottom=page.getByRole('button',{name:'Выйти и использовать другой аккаунт'});await bottom.scrollIntoViewIfNeeded();
 const box=await bottom.boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=568,'bottom actions reachable on a short phone viewport');
 result.mobileScroll=true;await page.screenshot({path:OUT+'/pending-mobile-bottom.png'});
 await page.reload();await page.getByRole('heading',{name:'Подтвердите почту',exact:true}).waitFor();result.pendingSession=true;
 await page.getByRole('button',{name:'Открыть письмо в демопочте'}).click();
 await page.getByRole('button',{name:'Подтвердить почту',exact:true}).click();await page.getByText('Друзья',{exact:true}).first().waitFor();result.registration=true;
 await page.reload();await page.getByText('Друзья',{exact:true}).first().waitFor();result.sessionPersists=true;
 const denied=await page.evaluate(async()=>{const r=await fetch('/api/auth/logout',{method:'POST',headers:{'X-Requested-With':'invalid'}});return r.status;});assert.equal(denied,403);result.csrf=true;
 // Two independent sessions authenticate against the same backend and exchange a real message over WSS.
 const a=await browser.newContext(),b=await browser.newContext();const ap=await a.newPage(),bp=await b.newPage();
 for(const [p,email] of [[ap,'alice@concord.local'],[bp,'bob@concord.local']]){
  p.on('pageerror',e=>result.errors.push(e.message));
  await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Пароль',{exact:true}).fill('demo12345');
  await p.getByRole('button',{name:'Войти',exact:true}).click();await p.getByRole('button',{name:'Demo Server',exact:true}).first().click();
  await p.locator('.chan',{hasText:'general'}).first().click();
 }
 const message='LAN check '+Date.now();const composer=ap.locator('textarea').last();await composer.fill(message);await composer.press('Enter');
 await bp.getByText(message,{exact:true}).first().waitFor({timeout:10000});result.sharedRealtimeChat=true;
 await ap.screenshot({path:OUT+'/chat.png'});
 assert.equal(result.errors.length,0);console.log(JSON.stringify(result,null,2));
}catch(err){result.failure=err.message.split('\n')[0].replace(/token=[^\s&]+/g,'token=[redacted]');if(page)await page.screenshot({path:OUT+'/failure.png'});throw err;}
finally{await writeFile(OUT+'/results.json',JSON.stringify(result,null,2));await browser.close();}
