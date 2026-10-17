import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const BASE=process.env.BASE_URL??'http://localhost:5181',OUT=process.env.WORD_RETRY_DIR??'test/results/recovery-word-setup-recovery';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(BASE).hostname),'This mutable fixture test is restricted to local QA');
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const context=await browser.newContext(),page=await context.newPage(),result={checks:[],errors:[]};
page.on('pageerror',error=>result.errors.push(error.message));
const open=async()=>{await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('button',{name:'Безопасность',exact:true}).click();};
try{
  await page.goto(`${BASE}/login`);await page.getByLabel('Email или имя пользователя',{exact:true}).fill(process.env.WORD_RETRY_USER??'legacywordretry');await page.getByLabel('Пароль',{exact:true}).fill(process.env.WORD_RETRY_PASSWORD??'demo12345');
  const logged=page.waitForResponse(response=>response.url().endsWith('/api/auth/login'));await page.getByRole('button',{name:'Войти',exact:true}).click();const session=await(await logged).json();assert.equal(session.user.hasRecoveryWord,false,'A fresh legacy fixture starts without a word');await page.getByText('Друзья',{exact:true}).first().waitFor();
  await open();let refreshFailures=0,setupCalls=0;
  await page.route('**/api/auth/recovery-word',route=>{setupCalls++;return route.continue();});
  await page.route('**/api/auth/refresh',route=>refreshFailures++===0?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_REFRESH_BUSY',message:'Временная ошибка обновления сеанса'}})}):route.continue());
  await page.getByLabel('Текущий пароль',{exact:true}).fill(process.env.WORD_RETRY_PASSWORD??'demo12345');await page.getByLabel('Новое секретное слово',{exact:true}).fill('first willow phrase 42');await page.getByLabel('Повторите секретное слово',{exact:true}).fill('first willow phrase 42');await page.getByRole('button',{name:'Сохранить секретное слово'}).click();await page.getByRole('alert').filter({hasText:'Временная ошибка обновления сеанса'}).waitFor();
  await page.getByRole('status').filter({hasText:'Секретное слово сохранено.'}).waitFor();assert.equal(setupCalls,1);result.checks.push('a successful first-word write is retained when session refresh fails');
  await page.getByRole('button',{name:'Закрыть настройки',exact:true}).click();await open();await page.getByLabel('Текущее секретное слово',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Сохранить секретное слово'}).count(),0);result.checks.push('reopening settings asks for the current word instead of retrying first-time setup');
  await page.getByLabel('Текущий пароль',{exact:true}).fill(process.env.WORD_RETRY_PASSWORD??'demo12345');await page.getByLabel('Текущее секретное слово',{exact:true}).fill('first willow phrase 42');await page.getByLabel('Новое секретное слово',{exact:true}).fill('second cedar phrase 73');await page.getByLabel('Повторите секретное слово',{exact:true}).fill('second cedar phrase 73');await page.getByRole('button',{name:'Изменить секретное слово'}).click();await page.getByText('Секретное слово сохранено',{exact:true}).last().waitFor();assert.equal(setupCalls,2);result.checks.push('the reopened form changes the saved word successfully without creating a duplicate account');
  assert.deepEqual(result.errors,[]);
}catch(error){result.failure=error.message.split('\n')[0];throw error;}
finally{await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
