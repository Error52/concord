/**
 * Development seed: demo users, a "Demo Server" with text/voice channels, roles, badges and messages.
 * Idempotent — skipped if the demo user already exists. Run: `npm run seed` (or SEED_ON_START=1).
 */
import { pool, queryOne } from './pool.js';
import { register } from '../services/authService.js';
import * as servers from '../services/serverService.js';
import * as messages from '../services/messageService.js';
import * as friends from '../services/friendService.js';
import * as badges from '../services/badgeService.js';
import * as admin from '../services/adminService.js';
import * as dms from '../services/dmService.js';
import { log } from '../logger.js';

const PASSWORD = 'demo12345';
const client = { ip: 'seed', userAgent: 'seed' };

export async function seed(): Promise<void> {
  if (await queryOne(`SELECT 1 FROM users WHERE lower(email) = 'alice@concord.local'`)) {
    log.info('seed: already present, skipping');
    return;
  }
  const mk = async (username: string, displayName: string, theme: { preset: string }, accent: string) =>
    (await register({ username, email: `${username}@concord.local`, password: PASSWORD, displayName, theme, accentColor: accent, bannerColor: accent }, client, true)).user;

  const alice = await mk('alice', 'Alice', { preset: 'purple' }, '#8b5cf6');
  const bob = await mk('bob', 'Bob', { preset: 'blue' }, '#3b82f6');
  const carol = await mk('carol', 'Carol', { preset: 'sunset' }, '#f97316');
  const dave = await mk('dave', 'Dave', { preset: 'cyber' }, '#14b8a6');

  await pool.query(`UPDATE profiles SET bio = $2 WHERE user_id = $1`, [alice.id, 'Создательница Demo Server. Пишите в #general 👋']);
  await pool.query(`UPDATE users SET custom_status = 'Playing Minecraft', custom_status_emoji = '🎮' WHERE id = $1`, [bob.id]);

  const full = await servers.create(alice.id, { name: 'Demo Server', description: 'Сервер для проверки возможностей Concord', isPublic: true });
  const serverId = full.server.id;
  const general = full.channels.find((c) => c.type === 'text')!;
  await servers.updateChannel(general.id, alice.id, { category: 'GENERAL', topic: 'Общий чат' });
  const generalVoice = full.channels.find((c) => c.type === 'voice')!;
  await servers.updateChannel(generalVoice.id, alice.id, { category: 'VOICE' });
  const memes = await servers.createChannel(serverId, alice.id, { name: 'memes', type: 'text', category: 'GENERAL' });
  await servers.createChannel(serverId, alice.id, { name: 'media', type: 'text', category: 'GENERAL' });
  await servers.createChannel(serverId, alice.id, { name: 'games', type: 'text', category: 'GENERAL' });
  await servers.createChannel(serverId, alice.id, { name: 'Gaming', type: 'voice', category: 'VOICE' });
  await servers.createChannel(serverId, alice.id, { name: 'AFK', type: 'voice', category: 'VOICE' });

  const invite = await servers.createInvite(serverId, alice.id, {});
  for (const u of [bob, carol, dave]) await servers.acceptInvite(invite.code, u.id);

  const roleId = (name: string) => full.roles.find((r) => r.name === name)!.id;
  await servers.setMemberRoles(serverId, alice.id, bob.id, [roleId('Moderator')]);
  await servers.setMemberRoles(serverId, alice.id, carol.id, [roleId('Admin')]);

  const early = await badges.create(serverId, alice.id, { name: 'Early User', description: 'Joined during early access.', emoji: '🏆', color: '#f5a623' });
  const dev = await badges.create(serverId, alice.id, { name: 'Developer', description: 'Builds Concord.', emoji: '💻', color: '#22c55e' });
  const vip = await badges.create(serverId, alice.id, { name: 'VIP', description: 'Very important person.', emoji: '💎', color: '#38bdf8' });
  await badges.grant(serverId, alice.id, early.id, alice.id);
  await badges.grant(serverId, alice.id, dev.id, alice.id);
  await badges.grant(serverId, alice.id, early.id, bob.id);
  await badges.grant(serverId, alice.id, vip.id, carol.id);

  // Special (platform-wide) badge from the admin panel. Alice is the first account → platform admin.
  const staff = await admin.createBadge(alice.id, { name: 'Concord Staff', description: 'Команда Concord.', emoji: '🛡️', color: '#5865f2' });
  await admin.grantBadge(alice.id, staff.id, alice.id);

  await messages.create(general.id, alice.id, { content: 'Добро пожаловать на **Demo Server**! 🎉' });
  const q = await messages.create(general.id, bob.id, { content: `Привет! <@${alice.id}> а голосовой канал уже работает?` });
  await messages.create(general.id, alice.id, { content: 'Да, заходи в 🔊 General — там и демонстрация экрана со звуком.', replyToId: q.id });
  await messages.create(general.id, carol.id, { content: 'Пример кода:\n```ts\nconst room = await connect(token);\nroom.on("speaking", console.log);\n```' });
  await messages.create(general.id, dave.id, { content: 'Документация LiveKit: https://docs.livekit.io' });
  await messages.react(q.id, alice.id, '👍', true);
  await messages.react(q.id, carol.id, '👍', true);
  await messages.create(memes.id, bob.id, { content: 'Сюда кидаем мемы 😄' });

  await friends.request(alice.id, { userId: bob.id });
  await friends.accept(bob.id, alice.id);
  await friends.request(carol.id, { userId: alice.id });
  const dm = await dms.open(alice.id, bob.id);
  await messages.create(dm.id, bob.id, { content: 'Это личное сообщение — видно только нам двоим.' });

  log.info('seed: done', { users: ['alice', 'bob', 'carol', 'dave'].map((u) => `${u}@concord.local`), password: '(see README)' });
}
