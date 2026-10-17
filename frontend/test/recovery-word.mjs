// Isolated local QA only. Creates one synthetic user and updates the supplied disposable legacy fixtures.
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const BASE=process.env.BASE_URL??'http://localhost:5181',OUT=process.env.WORD_DIR??'test/results/recovery-word';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(BASE).hostname),'Recovery mutations are restricted to isolated loopback QA');
await mkdir(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined});
const result={checks:[],errors:[],skipped:[]},contexts=[],releases=[];
const makePage=async()=>{const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage();contexts.push(context);page.setDefaultTimeout(12000);page.on('pageerror',e=>result.errors.push(e.message));return {context,page};};
const respond=(route,status,code,message)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({error:{code,message}})});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const check=name=>{result.checks.push(name);console.log('PASS',name);};
const login=async(target,identifier,password)=>{
  await target.page.goto(`${BASE}/login`);await target.page.getByLabel('Email или имя пользователя',{exact:true}).fill(identifier);await target.page.getByLabel('Пароль',{exact:true}).fill(password);
  const response=target.page.waitForResponse(r=>r.url().endsWith('/api/auth/login')&&r.request().method()==='POST');await target.page.getByRole('button',{name:'Войти',exact:true}).click();
  const logged=await response;assert.equal(logged.status(),200,'Disposable fixture login succeeds');return logged.json();
};
const authHeaders=token=>({Authorization:`Bearer ${token}`,'X-Requested-With':'concord'});
const security=async page=>{await page.getByRole('button',{name:'Настройки',exact:true}).click();await page.getByRole('button',{name:'Безопасность',exact:true}).click();};
const fillRecovery=async(page,identifier,word,password,nextWord)=>{
  await page.getByLabel('Email или имя пользователя',{exact:true}).fill(identifier);await page.getByLabel('Секретное слово',{exact:true}).fill(word);
  await page.getByLabel('Новый пароль',{exact:true}).fill(password);await page.getByLabel('Повторите пароль',{exact:true}).fill(password);
  await page.getByLabel('Новое секретное слово',{exact:true}).fill(nextWord);await page.getByLabel('Повторите секретное слово',{exact:true}).fill(nextWord);
};

try{
  const A=await makePage(),page=A.page,name=`word${Date.now().toString(36)}`,password='uniquePassword123',firstWord='Радужный',nextWord='Северный',nextPassword='changedPassword456',thirdWord='Солнечно';
  let optionsCalls=0;
  await page.route('**/api/auth/options',route=>++optionsCalls===1?respond(route,503,'TEST_OPTIONS_BUSY','Временная ошибка настроек'):route.continue());
  await page.goto(`${BASE}/register`);await page.getByRole('alert').filter({hasText:'Временная ошибка настроек'}).waitFor();assert.equal(await page.getByRole('button',{name:'Продолжить',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Повторить загрузку настроек'}).click();await page.getByLabel('Секретное слово',{exact:true}).waitFor();await page.unroute('**/api/auth/options');check('registration retries a failed options request without guessing its verification mode');
  await page.setViewportSize({width:320,height:568});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.getByRole('button',{name:'Продолжить',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`${OUT}/register-mobile.png`});await page.setViewportSize({width:1440,height:900});check('registration with recovery fields remains scrollable at 320px');
  await page.getByLabel('Имя пользователя',{exact:true}).fill(name);await page.getByLabel('Email',{exact:true}).fill(`${name}@e2e.test`);
  await page.getByLabel('Пароль',{exact:true}).fill(password);await page.getByLabel('Повторите пароль',{exact:true}).fill('differentPassword123');
  await page.getByLabel('Секретное слово',{exact:true}).fill(firstWord);await page.getByLabel('Повторите секретное слово',{exact:true}).fill(firstWord);
  let registrationCalls=0,allowRegistration=false;const arrived=deferred(),gate=deferred();releases.push(gate.resolve);
  await page.route('**/api/auth/register',async route=>{registrationCalls++;if(!allowRegistration)return respond(route,400,'TEST_UNEXPECTED_REQUEST','Неожиданная регистрация');arrived.resolve();await gate.promise;return route.continue();});
  const wordInput=page.getByLabel('Секретное слово',{exact:true});assert.equal(await wordInput.getAttribute('minlength'),'8');await wordInput.fill('радужны');await page.getByLabel('Повторите секретное слово',{exact:true}).fill('радужны');await page.getByRole('button',{name:'Продолжить',exact:true}).click();assert.equal(await wordInput.evaluate(input=>input.checkValidity()),false);assert.equal(registrationCalls,0);await wordInput.fill(firstWord);await page.getByLabel('Повторите секретное слово',{exact:true}).fill(firstWord);check('signup rejects seven Cyrillic characters before accepting an eight-character word');
  await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByText('Пароли не совпадают',{exact:true}).waitFor();assert.equal(registrationCalls,0);check('signup rejects mismatched passwords before sending a request');
  await page.getByLabel('Повторите пароль',{exact:true}).fill(password);await page.getByLabel('Повторите секретное слово',{exact:true}).fill('another saved phrase 27');
  await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByText('Секретные слова не совпадают',{exact:true}).waitFor();assert.equal(registrationCalls,0);check('signup rejects a mismatched recovery confirmation');
  await page.getByLabel('Секретное слово',{exact:true}).fill(`  ${password.toUpperCase()}  `);await page.getByLabel('Повторите секретное слово',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Продолжить',exact:true}).click();await page.getByText('Секретное слово должно отличаться от пароля',{exact:true}).waitFor();assert.equal(registrationCalls,0);check('signup rejects normalized password reuse as a recovery word');
  await page.getByLabel('Секретное слово',{exact:true}).fill(firstWord);await page.getByLabel('Повторите секретное слово',{exact:true}).fill(' РАДУЖНЫЙ ');allowRegistration=true;
  const registered=page.waitForResponse(r=>r.url().endsWith('/api/auth/register')&&r.request().method()==='POST');await page.getByRole('button',{name:'Продолжить',exact:true}).click();await arrived.promise;
  await page.locator('form.auth-card').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});assert.equal(registrationCalls,1);gate.resolve();
  const registeredResponse=await registered;assert.equal(registeredResponse.status(),201);const firstSession=await registeredResponse.json();
  assert.equal(firstSession.user.accountReady,true);assert.equal(firstSession.user.emailVerified,false);assert.equal(firstSession.user.hasRecoveryWord,true);
  await page.getByText('Друзья',{exact:true}).first().waitFor();await page.reload();await page.getByText('Друзья',{exact:true}).first().waitFor();check('one signup opens chat immediately and persists without claiming email verification');
  const B=await makePage(),secondSession=await login(B,name.toUpperCase(),password);await B.page.getByText('Друзья',{exact:true}).first().waitFor();check('username login is case insensitive and opens a second session');
  const recovery=await makePage();await recovery.page.goto(`${BASE}/forgot`);await recovery.page.getByLabel('Секретное слово',{exact:true}).waitFor();
  await recovery.page.setViewportSize({width:320,height:568});await recovery.page.getByRole('button',{name:'Восстановить доступ'}).scrollIntoViewIfNeeded();assert.equal(await recovery.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await recovery.page.screenshot({path:`${OUT}/recovery-mobile.png`});await recovery.page.setViewportSize({width:1440,height:900});
  await fillRecovery(recovery.page,name,'incorrect recovery word',nextPassword,nextWord);
  const wrongResponse=recovery.page.waitForResponse(r=>r.url().endsWith('/api/auth/recovery-word/reset'));await recovery.page.getByRole('button',{name:'Восстановить доступ'}).click();const wrong=await wrongResponse;assert.equal(wrong.status(),400);const wrongBody=await wrong.json();
  await recovery.page.getByRole('alert').waitFor();assert.equal(await recovery.page.getByLabel('Новый пароль',{exact:true}).inputValue(),nextPassword);check('a wrong recovery word gives a retryable error without clearing the form');
  await recovery.page.getByLabel('Секретное слово',{exact:true}).fill('  РАДУЖНЫЙ ');await recovery.page.getByRole('button',{name:'Восстановить доступ'}).click();await recovery.page.getByRole('heading',{name:'С возвращением!'}).waitFor();
  for(const session of [firstSession,secondSession]){const response=await A.context.request.get(`${BASE}/api/users/me`,{headers:authHeaders(session.accessToken)});assert.equal(response.status(),401,'Recovery revokes every earlier access session');}
  check('recovery rotates the password and word, revokes both sessions and requires a fresh login');
  const replay=await recovery.context.request.post(`${BASE}/api/auth/recovery-word/reset`,{headers:{'X-Requested-With':'concord'},data:{identifier:name,recoveryWord:firstWord,newPassword:'futurePassword789',newRecoveryWord:'future moonlight phrase 27'}});assert.equal(replay.status(),400);assert.deepEqual((await replay.json()).error,wrongBody.error);check('the previous recovery word cannot be replayed and returns the same generic failure');
  await page.reload();await page.getByRole('heading',{name:'С возвращением!'}).waitFor();await login(A,name,nextPassword);await page.getByText('Друзья',{exact:true}).first().waitFor();
  const C=await makePage(),otherSession=await login(C,name,nextPassword);await C.page.getByText('Друзья',{exact:true}).first().waitFor();
  await security(page);await page.getByLabel('Текущий пароль',{exact:true}).fill(nextPassword);await page.getByLabel('Текущее секретное слово',{exact:true}).fill('not the current word');
  await page.getByLabel('Новое секретное слово',{exact:true}).fill(thirdWord);await page.getByLabel('Повторите секретное слово',{exact:true}).fill(thirdWord);await page.getByRole('button',{name:'Изменить секретное слово'}).click();await page.getByRole('alert').waitFor();
  await page.getByLabel('Текущее секретное слово',{exact:true}).fill(nextWord);await page.getByRole('button',{name:'Изменить секретное слово'}).click();await page.getByText('Секретное слово сохранено',{exact:true}).last().waitFor();
  const revokedOther=await A.context.request.get(`${BASE}/api/users/me`,{headers:authHeaders(otherSession.accessToken)});assert.equal(revokedOther.status(),401);assert.equal(await page.getByRole('heading',{name:'Безопасность',exact:true}).isVisible(),true);check('changing a recovery word requires the old word and preserves only the current session family');
  const settingsReplay=await recovery.context.request.post(`${BASE}/api/auth/recovery-word/reset`,{headers:{'X-Requested-With':'concord'},data:{identifier:name,recoveryWord:nextWord,newPassword:'futurePassword789',newRecoveryWord:'future moonlight phrase 27'}});assert.equal(settingsReplay.status(),400);assert.deepEqual((await settingsReplay.json()).error,wrongBody.error);check('a word replaced in account settings cannot recover the account');
  const legacy=await makePage(),legacySession=await login(legacy,process.env.WORD_LEGACY_USER??'bob',process.env.WORD_LEGACY_PASSWORD??'demo12345');assert.equal(legacySession.user.isPlatformAdmin,false);assert.equal(legacySession.user.hasRecoveryWord,false,'Legacy fixture must start without a recovery word');
  await legacy.page.getByText('Друзья',{exact:true}).first().waitFor();await security(legacy.page);await legacy.page.getByLabel('Текущий пароль',{exact:true}).fill(process.env.WORD_LEGACY_PASSWORD??'demo12345');await legacy.page.getByLabel('Новое секретное слово',{exact:true}).fill('legacy willow phrase 42');await legacy.page.getByLabel('Повторите секретное слово',{exact:true}).fill('legacy willow phrase 42');
  await legacy.page.getByRole('button',{name:'Сохранить секретное слово'}).click();await legacy.page.getByLabel('Текущее секретное слово',{exact:true}).waitFor();check('an existing nonadmin can add its first recovery word in security settings');
  const admin=await makePage(),adminIdentifier=process.env.WORD_ADMIN_USER??'alice',adminSession=await login(admin,adminIdentifier,process.env.WORD_ADMIN_PASSWORD??'demo12345');assert.equal(adminSession.user.isPlatformAdmin,true,'Admin fixture must be an isolated QA platform admin');assert.equal(adminSession.user.accountReady,true);assert.equal(adminSession.user.recoveryWordAllowed,false);
  await admin.page.getByText('Друзья',{exact:true}).first().waitFor();await security(admin.page);await admin.page.getByText(/Для администраторов восстановление секретным словом отключено/).waitFor();assert.equal(await admin.page.getByRole('button',{name:'Сохранить секретное слово'}).count(),0);
  const deniedAdmin=await recovery.context.request.post(`${BASE}/api/auth/recovery-word/reset`,{headers:{'X-Requested-With':'concord'},data:{identifier:adminIdentifier,recoveryWord:'not admin word 42',newPassword:'futurePassword789',newRecoveryWord:'future moonlight phrase 27'}});assert.equal(deniedAdmin.status(),400);assert.deepEqual((await deniedAdmin.json()).error,wrongBody.error);
  const currentAdmin=await admin.context.request.get(`${BASE}/api/users/me`,{headers:authHeaders(adminSession.accessToken)});assert.equal(currentAdmin.status(),200);check('an existing QA admin retains normal access while self-service word recovery stays unavailable');
  if(process.env.WORD_PENDING_USER){
    const pending=await makePage(),pendingSession=await login(pending,process.env.WORD_PENDING_USER,process.env.WORD_PENDING_PASSWORD??'password123');assert.equal(pendingSession.user.accountReady,false);assert.equal(pendingSession.user.hasRecoveryWord,false);
    await pending.page.getByRole('heading',{name:'Завершите регистрацию',exact:true}).waitFor();await pending.page.getByLabel('Текущий пароль',{exact:true}).fill(process.env.WORD_PENDING_PASSWORD??'password123');await pending.page.getByLabel('Новое секретное слово',{exact:true}).fill('pending willow phrase 42');await pending.page.getByLabel('Повторите секретное слово',{exact:true}).fill('pending willow phrase 42');
    await pending.page.getByRole('button',{name:'Сохранить секретное слово'}).click();await pending.page.getByText('Друзья',{exact:true}).first().waitFor();check('a legacy pending registration completes with a first word instead of creating another account');
  }else result.skipped.push('legacy pending fixture was not supplied');
  assert.deepEqual(result.errors,[]);
}catch(err){result.failure=err.message.split('\n')[0];throw err;}
finally{for(const release of releases)release();await writeFile(`${OUT}/results.json`,JSON.stringify(result,null,2)+'\n');await browser.close();console.log(JSON.stringify(result,null,2));}
