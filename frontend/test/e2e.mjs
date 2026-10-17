// End-to-end UI test with Playwright (Chromium with fake camera/microphone).
//   BASE_URL=http://localhost node test/e2e.mjs
// Exercises: registration, server creation, invites, realtime chat across two users, reactions,
// friend requests, DMs with unread badges, search, profile popover, mic test (real audio level from
// the fake device), and — when an SFU is reachable — joining a voice channel.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { mailLink } from './mailbox.mjs';

const BASE = process.env.BASE_URL ?? 'http://localhost';
const SHOTS = process.env.SHOTS_DIR ?? 'test/screenshots';
const EXPECT_VOICE = process.env.EXPECT_VOICE === '1';
const run = process.env.E2E_RUN ?? Date.now().toString(36).slice(-5);
const mode = process.env.AUTH_MODE ?? (await (await fetch(`${BASE}/api/auth/options`)).json()).verificationMode;
assert.ok(['email','secret-word'].includes(mode));
const wordMode=mode==='secret-word';
const ignoreHTTPSErrors=process.env.ALLOW_SELF_SIGNED==='1';
await mkdir(SHOTS, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const results = [];
const pageErrors=[];
const fixtures=[];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(['✔', name, Date.now() - t]);
  } catch (err) {
    results.push(['✘', name, Date.now() - t, err.message.split('\n')[0]]);
    throw err;
  }
}

async function newUser(name) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone', 'camera'], ignoreHTTPSErrors });
  await ctx.addInitScript(()=>{const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);window.__signupPreviews=new Set();URL.createObjectURL=b=>{const u=create(b);window.__signupPreviews.add(u);return u;};URL.revokeObjectURL=u=>{window.__signupPreviews.delete(u);revoke(u);};});
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message.slice(0,200)));
  await page.goto(`${BASE}/register`);
  await page.getByLabel('Имя пользователя').fill(name);
  await page.getByLabel('Отображаемое имя').fill(name.toUpperCase());
  await page.getByLabel('Email').fill(`${name}@e2e.test`);
  await page.getByLabel('Пароль', { exact: true }).fill('password123');
  await page.getByLabel('Повторите пароль').fill('password123');
  if(wordMode){await page.getByLabel('Секретное слово',{exact:true}).fill(`cosmic violet owl ${name}`);await page.getByLabel('Повторите секретное слово',{exact:true}).fill(`cosmic violet owl ${name}`);}
  await page.getByLabel('Аватар',{exact:true}).setInputFiles('test/fixtures/avatar.png');
  await page.waitForFunction(()=>window.__signupPreviews.size===1);
  await page.getByRole('button', { name: 'Продолжить' }).click();
  if(!wordMode){
  await page.getByRole('heading',{name:'Подтвердите почту',exact:true}).waitFor();
  await page.waitForFunction(()=>window.__signupPreviews.size===0);
  const verification=await mailLink(`${name}@e2e.test`,'подтвердите почту','/verify-email');
  await page.goto(verification);
  await page.getByRole('button',{name:'Подтвердить почту',exact:true}).click();
  }
  await page.getByText('Друзья').first().waitFor();
  await page.waitForFunction(()=>window.__signupPreviews.size===0);
  fixtures.push(name);
  return { ctx, page };
}

try {
  let A, B, inviteLink;
  const nameA = `alpha${run}`;
  const nameB = `bravo${run}`;

  await step('guest is redirected to login; registration validates passwords', async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/channels/@me`);
    await page.getByRole('heading', { name: 'С возвращением!' }).waitFor();
    await page.screenshot({ path: `${SHOTS}/01-login.png` });
    await page.goto(`${BASE}/register`);
    await page.getByLabel('Имя пользователя').fill('somebody');
    await page.getByLabel('Email').fill('x@e2e.test');
    await page.getByLabel('Пароль', { exact: true }).fill('password123');
    await page.getByLabel('Повторите пароль').fill('different1');
    if(wordMode){await page.getByLabel('Секретное слово',{exact:true}).fill('cosmic violet test owl');await page.getByLabel('Повторите секретное слово',{exact:true}).fill('cosmic violet test owl');}
    await page.getByRole('button', { name: 'Продолжить' }).click();
    await page.getByText('Пароли не совпадают').waitFor();
    await page.screenshot({ path: `${SHOTS}/02-register.png` });
    await ctx.close();
  });

  await step('two users register', async () => {
    A = await newUser(nameA);
    B = await newUser(nameB);
  });

  await step('wrong password shows an error', async () => {
    const ctx = await browser.newContext({ ignoreHTTPSErrors });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Email').fill(`${nameA}@e2e.test`);
    await page.getByLabel('Пароль').fill('wrong-password');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByText('Неверный email или пароль').waitFor();
    await ctx.close();
  });

  await step('A creates a server and lands in #general', async () => {
    await A.page.getByRole('button', { name: 'Добавить сервер' }).click();
    await A.page.getByLabel('Название сервера').fill(`E2E ${run}`);
    await A.page.getByRole('button', { name: 'Создать', exact: true }).click();
    await A.page.getByRole('heading', { name: 'Добро пожаловать в #general!' }).waitFor();
  });

  await step('A creates an invite; B joins through /invite/:code', async () => {
    await A.page.locator('button.sidebar-head').click();
    await A.page.getByRole('menuitem', { name: 'Пригласить людей' }).click();
    const input = A.page.locator('.modal input[readonly]');
    await A.page.waitForFunction(() => document.querySelector('.modal input[readonly]')?.value.includes('/invite/'));
    inviteLink = await input.inputValue();
    await A.page.keyboard.press('Escape');
    await B.page.goto(inviteLink.replace(/^https?:\/\/[^/]+/, BASE));
    await B.page.getByRole('button', { name: 'Принять приглашение' }).click();
    await B.page.getByRole('heading', { name: 'Добро пожаловать в #general!' }).waitFor();
  });

  await step('realtime chat: markdown, mention, delivery to the other user', async () => {
    const box = A.page.getByRole('textbox', { name: 'Написать в #general' });
    await box.fill(`Привет, **мир**! @${nameB}`);
    await A.page.locator('.mention-suggest button').first().click();
    await box.press('Enter');
    await B.page.locator('.msg-content strong', { hasText: 'мир' }).waitFor();
    await B.page.locator('.msg.mentioned').waitFor();
    await B.page.getByRole('textbox', { name: 'Написать в #general' }).fill('```js\nconsole.log(42)\n```');
    await B.page.getByRole('textbox', { name: 'Написать в #general' }).press('Enter');
    await A.page.locator('.md-codeblock code', { hasText: 'console.log(42)' }).waitFor();
  });

  await step('typing indicator + reactions sync', async () => {
    await B.page.waitForTimeout(3200); // typing events are throttled to one per 3 s
    await B.page.getByRole('textbox', { name: 'Написать в #general' }).pressSequentially('печатаю', { delay: 30 });
    await A.page.locator('.typing', { hasText: 'печатает' }).waitFor();
    const msg = A.page.locator('.msg', { hasText: 'console.log(42)' });
    await msg.hover();
    await msg.getByRole('button', { name: 'Реакция 👍' }).click();
    await B.page.locator('.reaction', { hasText: '👍' }).waitFor();
    await B.page.getByRole('textbox', { name: 'Написать в #general' }).fill('');
    await A.page.screenshot({ path: `${SHOTS}/03-chat.png` });
  });

  await step('editing keeps reactions personal and threads receive reaction updates',async()=>{
    const bmsg=B.page.locator('.msg',{hasText:'console.log(42)'});await bmsg.hover();
    await bmsg.getByRole('button',{name:'Редактировать',exact:true}).click();
    await B.page.locator('.msg .composer textarea').fill('```js\nconsole.log(43)\n```');await B.page.locator('.msg .composer textarea').press('Enter');
    const amsg=A.page.locator('.msg',{hasText:'console.log(43)'});await amsg.waitFor();
    await A.page.waitForFunction(()=>[...document.querySelectorAll('.msg')].find(e=>e.textContent.includes('console.log(43)'))?.querySelector('.reaction.me'));
    assert.equal(await B.page.locator('.msg',{hasText:'console.log(43)'}).locator('.reaction.me').count(),0);
    await B.page.locator('.msg',{hasText:'console.log(43)'}).click({button:'right'});await B.page.getByRole('menuitem',{name:'Открыть ветку',exact:true}).click();
    const thread=B.page.locator('.thread-panel');await thread.locator('.reaction',{hasText:'👍'}).waitFor();
    await amsg.locator('.reaction',{hasText:'👍'}).click();await thread.locator('.reaction',{hasText:'👍'}).waitFor({state:'detached'});
    await amsg.hover();await amsg.getByRole('button',{name:'Реакция 👍',exact:true}).click();await thread.locator('.reaction',{hasText:'👍'}).waitFor();
    assert.equal(await thread.locator('.reaction.me').count(),0);await B.page.getByRole('button',{name:'Закрыть ветку',exact:true}).click();
  });

  await step('edit and delete own message', async () => {
    const box = A.page.getByRole('textbox', { name: 'Написать в #general' });
    await box.fill('опечатка');
    await box.press('Enter');
    const msg = A.page.locator('.msg', { hasText: 'опечатка' }).last();
    await msg.hover();
    await msg.getByRole('button', { name: 'Редактировать' }).click();
    const edit = A.page.locator('.msg .composer textarea');
    await edit.fill('исправлено');
    await edit.press('Enter');
    await B.page.locator('.msg-content', { hasText: 'исправлено' }).waitFor();
    await B.page.locator('.msg-edited').first().waitFor();
    A.page.once('dialog', (d) => d.accept());
    const fixed = A.page.locator('.msg', { hasText: 'исправлено' }).last();
    await fixed.click({ button: 'right' });
    await A.page.getByRole('menuitem', { name: 'Удалить' }).click();
    await B.page.locator('.msg-content', { hasText: 'исправлено' }).waitFor({ state: 'detached' });
  });

  await step('profile popover opens with banner/badges/roles and quick message', async () => {
    await B.page.locator('.msg-author', { hasText: nameA.toUpperCase() }).first().click();
    await B.page.locator('.profile-popover .pcard-name', { hasText: nameA.toUpperCase() }).waitFor();
    await B.page.screenshot({ path: `${SHOTS}/04-profile-popover.png` });
    await B.page.keyboard.press('Escape');
  });

  await step('friend request → accept → DM with unread badge', async () => {
    await B.page.getByRole('button', { name: 'Личные сообщения' }).click();
    await B.page.getByRole('button', { name: 'Добавить в друзья' }).click();
    await B.page.getByPlaceholder('Имя пользователя').fill(nameA);
    await B.page.getByRole('button', { name: 'Отправить запрос' }).click();
    await B.page.getByText('Запрос в друзья отправлен').waitFor();
    await A.page.getByRole('button', { name: 'Личные сообщения' }).click();
    await A.page.getByRole('tab', { name: /Ожидание/ }).click();
    await A.page.getByRole('button', { name: 'Принять' }).click();
    await A.page.getByRole('tab', { name: 'Все' }).click();
    await A.page.getByRole('button', { name: 'Написать' }).click();
    const dmBox = A.page.getByRole('textbox', { name: `Сообщение для @${nameB.toUpperCase()}` });
    await dmBox.fill('личное сообщение 👋');
    await dmBox.press('Enter');
    await B.page.locator('.rail .badge-count').first().waitFor();
    await B.page.locator('.chan', { hasText: nameA.toUpperCase() }).click();
    await B.page.locator('.msg-content', { hasText: 'личное сообщение' }).waitFor();
    await B.page.screenshot({ path: `${SHOTS}/05-dm.png` });
  });

  await step('notification inbox lists the DM; bookmarks open', async () => {
    await B.page.getByRole('button', { name: 'Личные сообщения' }).click();
    await B.page.locator('.chan', { hasText: 'Уведомления' }).click();
    await B.page.locator('.modal', { hasText: `Новое сообщение от ${nameA.toUpperCase()}` }).first().waitFor();
    await B.page.keyboard.press('Escape');
    await B.page.locator('.chan', { hasText: 'Закладки' }).click();
    await B.page.locator('.modal', { hasText: 'Закладки' }).waitFor();
    await B.page.keyboard.press('Escape');
  });

  await step('server-side search finds messages with filters', async () => {
    await A.page.keyboard.press('Escape');
    await A.page.getByRole('button', { name: 'Поиск по сообщениям' }).click();
    await A.page.getByPlaceholder('Сообщения, люди, серверы, каналы…').fill('личное');
    await A.page.getByRole('button', { name: 'Везде' }).click();
    await A.page.locator('.modal .pcard-section', { hasText: 'личное сообщение' }).waitFor();
    await A.page.screenshot({ path: `${SHOTS}/06-search.png` });
    await A.page.keyboard.press('Escape');
  });

  await step('voice settings: device list + real mic level from the (fake) microphone', async () => {
    await A.page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await A.page.getByRole('button', { name: 'Голос и видео' }).click();
    await A.page.getByRole('button', { name: 'Проверить', exact: true }).click();
    await A.page.waitForFunction(() => Number(document.querySelector('[role=meter]')?.getAttribute('aria-valuenow')) > -60, null, { timeout: 8000 });
    const level = await A.page.locator('[role=meter]').getAttribute('aria-valuenow');
    assert.ok(Number(level) > -60, `expected signal, got ${level} dBFS`);
    await A.page.screenshot({ path: `${SHOTS}/07-voice-settings.png` });
    await A.page.getByRole('button', { name: 'Остановить' }).click();
    await A.page.getByRole('button', { name: 'Горячие клавиши' }).click();
    await A.page.locator('.keybind-row .kbd').first().click();
    await A.page.keyboard.press('KeyB');
    await A.page.locator('.keybind-row .kbd', { hasText: /^B$/ }).waitFor();
    await A.page.getByRole('button', { name: 'Закрыть настройки' }).click();
  });

  await step('profile editor rejects unreadable theme colours', async () => {
    await A.page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await A.page.getByRole('button', { name: 'Профиль', exact: true }).click();
    await A.page.locator('.profile-editor input[type=color]').nth(2).evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '#777777');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await A.page.locator('.profile-editor input[type=color]').nth(3).evaluate((el) => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, '#888888');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await A.page.getByText('нечитаемым').first().waitFor();
    await A.page.screenshot({ path: `${SHOTS}/08-profile-editor.png` });
    await A.page.getByRole('button', { name: 'Сбросить' }).click();
    await A.page.getByRole('button', { name: 'Закрыть настройки' }).click();
  });

  await step('voice channel join', async () => {
    await A.page.getByRole('button', { name: `E2E ${run}` }).first().click();
    await A.page.locator('.chan', { hasText: 'General' }).last().click();
    if (EXPECT_VOICE) {
      await A.page.getByText('Голосовая связь подключена').waitFor({ timeout: 15000 });
      await A.page.waitForFunction(() => document.querySelector('.vpanel-sub')?.textContent?.includes('мс'), null, { timeout: 15000 });
    } else {
      // Without an SFU the client must report the failure instead of faking a connection.
      await A.page.getByText(/Не удалось подключиться к голосовому каналу|SFU unreachable/).waitFor({ timeout: 15000 });
    }
    await A.page.screenshot({ path: `${SHOTS}/09-voice.png` });
  });

  if (process.env.SEEDED === '1') {
    await step('seed data: Demo Server, roles and badges on the profile card', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors });
      const page = await ctx.newPage();
      await page.goto(`${BASE}/login`);
      await page.getByLabel('Email').fill('alice@concord.local');
      await page.getByLabel('Пароль').fill('demo12345');
      await page.getByRole('button', { name: 'Войти' }).click();
      await page.getByRole('button', { name: 'Demo Server' }).click();
      await page.locator('.member', { hasText: 'Bob' }).click();
      await page.locator('.profile-popover .badge-icon').first().waitFor();
      await page.locator('.profile-popover .pill', { hasText: 'Moderator' }).waitFor();
      await page.screenshot({ path: `${SHOTS}/11-seeded-profile.png` });
      await ctx.close();
    });
  }

  await step('mobile layout: drawer navigation', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.getByLabel('Email').fill(`${nameB}@e2e.test`);
    await page.getByLabel('Пароль').fill('password123');
    await page.getByRole('button', { name: 'Войти' }).click();
    await page.getByRole('button', { name: 'Меню' }).first().click();
    await page.locator('.app.nav-open').waitFor();
    await page.waitForTimeout(400); // drawer slide-in transition
    await page.screenshot({ path: `${SHOTS}/10-mobile.png` });
    await ctx.close();
  });
} finally {
  for (const r of results) console.log(r.join('  '));
  if(process.env.E2E_RESULTS)await writeFile(process.env.E2E_RESULTS,JSON.stringify({verificationMode:mode,checks:results,errors:pageErrors,fixtures},null,2)+'\n');
  await browser.close();
}
assert.deepEqual(pageErrors,[]);
