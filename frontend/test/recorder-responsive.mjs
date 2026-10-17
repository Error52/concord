import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const BASE=process.env.BASE_URL??'http://localhost:5181',OUT=process.env.RECORDER_LAYOUT_DIR??'test/results/recorder-responsive';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(BASE).hostname),'Synthetic recorder fault injection is restricted to local QA');
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
const context=await browser.newContext({viewport:{width:320,height:740},permissions:['microphone']}),page=await context.newPage(),result={checks:[],errors:[]};
page.on('pageerror',error=>result.errors.push(error.message));
await context.addInitScript(()=>{
 localStorage.setItem('concord.settings.v1',JSON.stringify({fontScale:1.3}));
 const stop=MediaRecorder.prototype.stop;
 MediaRecorder.prototype.stop=function(){const callback=this.onstop;this.onstop=event=>{window.__releaseRecorder=()=>callback?.call(this,event);};return stop.call(this);};
});
try{
 await page.goto(`${BASE}/login`);await page.getByLabel('Email или имя пользователя',{exact:true}).fill('alice');await page.getByLabel('Пароль',{exact:true}).fill('demo12345');
 const logged=page.waitForResponse(response=>response.url().endsWith('/api/auth/login'));await page.getByRole('button',{name:'Войти',exact:true}).click();const auth=await(await logged).json();
 const headers={Authorization:`Bearer ${auth.accessToken}`};const servers=await(await context.request.get(`${BASE}/api/servers`,{headers})).json();
 const server=servers.find(item=>item.name==='Demo Server'),full=await(await context.request.get(`${BASE}/api/servers/${server.id}`,{headers})).json(),channel=full.channels.find(item=>item.type==='text'&&item.name==='general');
 await page.goto(`${BASE}/channels/${server.id}/${channel.id}`);
 await page.getByRole('textbox',{name:'Написать в #general'}).fill('layout check only, never sent');
 await page.getByRole('button',{name:'Записать голосовое сообщение',exact:true}).click();await page.getByRole('button',{name:'Завершить запись',exact:true}).waitFor();await page.waitForTimeout(400);
 await page.getByRole('button',{name:'Завершить запись',exact:true}).click();await page.getByRole('status',{name:'Обработка записи'}).waitFor();
 const bounds=await page.locator('.composer-row').evaluate(row=>({width:row.clientWidth,contentWidth:row.scrollWidth,documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,textareaWidth:row.querySelector('textarea').clientWidth}));
 result.bounds=bounds;await page.screenshot({path:`${OUT}/processing-320.png`});
 await page.getByRole('button',{name:'Отменить запись',exact:true}).click();await page.evaluate(()=>window.__releaseRecorder?.());
 assert.ok(bounds.contentWidth<=bounds.width,'recording processing controls fit the composer at 320px and 130% text');
 assert.ok(bounds.documentWidth<=bounds.viewport,'recording processing does not widen the page');
 assert.ok(bounds.textareaWidth>=24,'the message field retains room for a character and cursor');
 result.checks.push('processing controls and message input fit 320px at 130% text without changing the visual theme');
 assert.deepEqual(result.errors,[]);
}catch(error){result.failure=error.message.split('\n')[0];throw error;}
finally{await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
