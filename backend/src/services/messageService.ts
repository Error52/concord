import { execute, query, queryOne, tx } from '../db/pool.js';
import { redis } from '../redis.js';
import { Errors, AppError } from '../http/errors.js';
import { Perm, has } from '../models/permissions.js';
import { assertPerm, canManage, requireChannel, type ChannelAccess } from './permissionService.js';
import { findMessage, hydrate, MESSAGE_COLUMNS, type MessageRow } from '../repositories/messageRepo.js';
import { memberIds } from '../repositories/serverRepo.js';
import { emit, type Target } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { notify } from './notificationService.js';
import { audit, AuditAction } from './auditService.js';
import { loadPublicUser } from '../repositories/userRepo.js';
import { storage } from '../storage/index.js';
import type { EmbedDTO, MessageDTO } from '../models/dto.js';

export const MAX_CONTENT = 4000;
const URL_RE = /\bhttps?:\/\/[^\s<>]+/i;
const MENTION_RE = /<@([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>/gi;

export function targetOf(ca: ChannelAccess): Target {
  return ca.channel.server_id ? { server: ca.channel.server_id } : { users: ca.dmPeers };
}

export async function list(
  channelId: string,
  userId: string,
  opts: { before?: string; after?: string; around?: string; limit?: number },
): Promise<MessageDTO[]> {
  await requireChannel(channelId, userId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const sel = `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.channel_id = $1`;
  let rows: MessageRow[];
  if (opts.around) {
    const half = Math.floor(limit / 2);
    const older = await query<MessageRow>(`${sel} AND m.id <= $2 ORDER BY m.id DESC LIMIT $3`, [channelId, opts.around, half + 1]);
    const newer = await query<MessageRow>(`${sel} AND m.id > $2 ORDER BY m.id ASC LIMIT $3`, [channelId, opts.around, half]);
    rows = [...older.reverse(), ...newer];
  } else if (opts.after) {
    rows = await query<MessageRow>(`${sel} AND m.id > $2 ORDER BY m.id ASC LIMIT $3`, [channelId, opts.after, limit]);
  } else {
    rows = (
      await query<MessageRow>(`${sel} AND ($2::bigint IS NULL OR m.id < $2::bigint) ORDER BY m.id DESC LIMIT $3`, [channelId, opts.before ?? null, limit])
    ).reverse();
  }
  return hydrate(rows, userId);
}

export interface CreateInput {
  content: string;
  replyToId?: string | null;
  attachmentIds?: string[];
  gif?: EmbedDTO | null;
  nonce?: string;
}

async function assertNotBlocked(ca: ChannelAccess, userId: string): Promise<void> {
  if (ca.channel.server_id) return;
  const others = ca.dmPeers.filter((p) => p !== userId);
  const blocked = await queryOne(
    `SELECT 1 FROM blocks WHERE (blocker_id = ANY($2::uuid[]) AND blocked_id = $1) OR (blocker_id = $1 AND blocked_id = ANY($2::uuid[]))`,
    [userId, others],
  );
  if (blocked) throw Errors.forbidden('Вы не можете отправить сообщение этому пользователю');
}

async function enforceSlowmode(ca: ChannelAccess, userId: string): Promise<void> {
  const seconds = ca.channel.slowmode_seconds;
  if (!seconds || canManage(ca, Perm.MANAGE_MESSAGES) || canManage(ca, Perm.MANAGE_CHANNELS)) return;
  const key = `slowmode:${ca.channel.id}:${userId}`;
  if ((await redis.set(key, '1', 'EX', seconds, 'NX')) !== 'OK') {
    const ttl = await redis.ttl(key);
    throw new AppError(429, 'SLOWMODE', `Медленный режим: подождите ${ttl} с`, { retryAfter: ttl });
  }
}

export async function create(channelId: string, userId: string, input: CreateInput): Promise<MessageDTO> {
  const ca = await requireChannel(channelId, userId);
  if (ca.channel.type === 'voice') throw Errors.badRequest('В голосовой канал нельзя писать');
  assertPerm(ca, Perm.SEND_MESSAGES, 'Нет права отправлять сообщения');
  const attachmentIds = [...new Set(input.attachmentIds ?? [])].slice(0, 10);
  if (attachmentIds.length) assertPerm(ca, Perm.ATTACH_FILES, 'Нет права прикреплять файлы');
  await assertNotBlocked(ca, userId);

  const content = input.content.trim();
  if (!content && attachmentIds.length === 0 && !input.gif) throw Errors.badRequest('Пустое сообщение');
  if (content.length > MAX_CONTENT) throw Errors.badRequest(`Сообщение длиннее ${MAX_CONTENT} символов`);
  await enforceSlowmode(ca, userId);

  // Mentions: only real members/participants count; @everyone needs the permission.
  const requested = [...content.matchAll(MENTION_RE)].map((m) => m[1]!.toLowerCase());
  let mentionIds: string[] = [];
  if (requested.length) {
    const audience = ca.channel.server_id ? await memberIds(ca.channel.server_id) : ca.dmPeers;
    const set = new Set(audience);
    mentionIds = [...new Set(requested)].filter((id) => set.has(id) && id !== userId);
  }
  const mentionsEveryone = /(^|\s)@(everyone|here)\b/.test(content) && !!ca.access && has(ca.access.perms, Perm.MENTION_EVERYONE);
  const mentionedUsers=mentionsEveryone
    ? [...new Set([...mentionIds,...(await memberIds(ca.channel.server_id!)).filter(id=>id!==userId)])]
    : mentionIds;

  if (input.replyToId) {
    const parent = await queryOne(`SELECT 1 FROM messages WHERE id = $1 AND channel_id = $2`, [input.replyToId, channelId]);
    if (!parent) throw Errors.badRequest('Сообщение для ответа не найдено');
  }

  const embeds = input.gif ? [input.gif] : [];
  const row = await tx(async (db) => {
    let hasImage = false;
    let hasFile = false;
    if (attachmentIds.length) {
      const pending = await query<{ id: string; kind: string }>(
        `SELECT id, kind FROM attachments WHERE id = ANY($1::uuid[]) AND uploader_id = $2 AND channel_id = $3 AND message_id IS NULL FOR UPDATE`,
        [attachmentIds, userId, channelId],
        db,
      );
      if (pending.length !== attachmentIds.length) throw Errors.badRequest('Вложение не найдено или уже использовано');
      hasImage = pending.some((p) => p.kind === 'image');
      hasFile = pending.some((p) => p.kind !== 'image');
    }
    const msg = await queryOne<{ id: string }>(
      `INSERT INTO messages (channel_id, author_id, content, reply_to_id, embeds, mention_ids, mentions_everyone, has_link, has_image, has_file, has_gif)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        channelId,
        userId,
        content,
        input.replyToId ?? null,
        JSON.stringify(embeds),
        mentionIds,
        mentionsEveryone,
        URL_RE.test(content),
        hasImage,
        hasFile,
        embeds.length > 0,
      ],
      db,
    );
    const id = msg!.id;
    if (attachmentIds.length) await execute(`UPDATE attachments SET message_id = $1 WHERE id = ANY($2::uuid[])`, [id, attachmentIds], db);
    await execute(`UPDATE channels SET last_message_id = $2 WHERE id = $1`, [channelId, id], db);
    await execute(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES ($1, $2, $3, 0)
       ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_id = EXCLUDED.last_read_id, mention_count = 0`,
      [userId, channelId, id],
      db,
    );
    if (mentionedUsers.length) {
      await execute(
        `INSERT INTO read_states (user_id, channel_id, mention_count) SELECT unnest($1::uuid[]), $2, 1
         ON CONFLICT (user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1`,
        [mentionedUsers, channelId],
        db,
      );
    }
    if (!ca.channel.server_id) {
      // Re-show a DM that the other side had closed.
      await execute(`UPDATE channel_members SET hidden = false WHERE channel_id = $1 AND hidden`, [channelId], db);
    }
    return (await findMessageTx(id, db))!;
  });

  const [dto] = await hydrate([row], userId);
  const payload = { ...dto!, nonce: input.nonce };
  await emit(Ev.MessageNew, payload, targetOf(ca));
  await fanOutNotifications(ca, userId, dto!, mentionIds, mentionsEveryone);
  return payload;
}

async function findMessageTx(id: string, db: Parameters<typeof query>[2]): Promise<MessageRow | null> {
  return queryOne<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = $1`, [id], db);
}

async function fanOutNotifications(ca: ChannelAccess, authorId: string, msg: MessageDTO, mentionIds: string[], everyone: boolean): Promise<void> {
  const preview = { messageId: msg.id, channelId: msg.channelId, serverId: msg.serverId, channelName: ca.channel.name, author: msg.author, content: msg.content.slice(0, 140) };
  if (!ca.channel.server_id) {
    await notify(ca.dmPeers.filter((p) => p !== authorId), 'dm', preview);
    return;
  }
  if (mentionIds.length) await notify(mentionIds, 'mention', preview);
  if (everyone) {
    const all = (await memberIds(ca.channel.server_id)).filter((id) => id !== authorId && !mentionIds.includes(id));
    await notify(all, 'everyone', preview);
  }
}

/** System messages (member joined, call ended…) are broadcast like normal messages. */
export async function postSystem(channelId: string, actorId: string, content: string): Promise<void> {
  const ca = await requireChannel(channelId, actorId).catch(() => null);
  if (!ca) return;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO messages (channel_id, author_id, content, kind) VALUES ($1, $2, $3, 'system') RETURNING id`,
    [channelId, actorId, content],
  );
  await execute(`UPDATE channels SET last_message_id = $2 WHERE id = $1`, [channelId, row!.id]);
  const full = await findMessage(row!.id);
  const [dto] = await hydrate([full!], actorId);
  await emit(Ev.MessageNew, dto, targetOf(ca));
}

export async function edit(messageId: string, userId: string, content: string): Promise<MessageDTO> {
  const msg = await findMessage(messageId);
  if (!msg) throw Errors.notFound('Сообщение');
  const ca = await requireChannel(msg.channel_id, userId);
  if (msg.author_id !== userId) throw Errors.forbidden('Можно редактировать только свои сообщения');
  if (msg.kind === 'system') throw Errors.badRequest('Системное сообщение нельзя изменить');
  const text = content.trim();
  if (!text) throw Errors.badRequest('Пустое сообщение');
  if (text.length > MAX_CONTENT) throw Errors.badRequest(`Сообщение длиннее ${MAX_CONTENT} символов`);
  await execute(`UPDATE messages SET content = $2, edited_at = now(), has_link = $3 WHERE id = $1`, [messageId, text, URL_RE.test(text)]);
  const [dto] = await hydrate([(await findMessage(messageId))!], userId);
  await emit(Ev.MessageUpdate, dto, targetOf(ca));
  return dto!;
}

export async function remove(messageId: string, userId: string): Promise<void> {
  const msg = await findMessage(messageId);
  if (!msg) throw Errors.notFound('Сообщение');
  const ca = await requireChannel(msg.channel_id, userId);
  const own = msg.author_id === userId;
  if (!own && !canManage(ca, Perm.MANAGE_MESSAGES)) throw Errors.forbidden('Нет права удалять чужие сообщения');
  const keys = await query<{ storage_key: string; preview_key: string | null }>(`SELECT storage_key, preview_key FROM attachments WHERE message_id = $1`, [messageId]);
  await execute(`DELETE FROM messages WHERE id = $1`, [messageId]);
  if (!own && ca.channel.server_id) {
    await audit(ca.channel.server_id, userId, AuditAction.MessageDelete, { type: 'user', id: msg.author_id ?? '' }, {
      channelId: msg.channel_id,
      channelName: ca.channel.name,
      content: msg.content.slice(0, 200),
    });
  }
  await emit(Ev.MessageDelete, { id: messageId, channelId: msg.channel_id, serverId: msg.server_id }, targetOf(ca));
  // Files are removed after the row so a failure here never resurrects a deleted message.
  for (const k of keys) {
    await storage.delete(k.storage_key).catch(() => undefined);
    if (k.preview_key) await storage.delete(k.preview_key).catch(() => undefined);
  }
}

const EMOJI_MAX = 64;

export async function react(messageId: string, userId: string, emoji: string, on: boolean): Promise<void> {
  if (!emoji || emoji.length > EMOJI_MAX || /\s/.test(emoji)) throw Errors.badRequest('Некорректная реакция');
  const msg = await findMessage(messageId);
  if (!msg) throw Errors.notFound('Сообщение');
  const ca = await requireChannel(msg.channel_id, userId);
  if (on) {
    assertPerm(ca, Perm.ADD_REACTIONS, 'Нет права добавлять реакции');
    await assertNotBlocked(ca, userId);
  }
  const userIds=await tx(async db=>{
    // Serialize changes to one message so concurrent new emoji cannot exceed the limit.
    if(!await queryOne(`SELECT id FROM messages WHERE id=$1 FOR UPDATE`,[messageId],db))throw Errors.notFound('Сообщение');
    if(on){
    const distinct = await queryOne<{ n: number; existing:boolean }>(`SELECT count(DISTINCT emoji)::int AS n,coalesce(bool_or(emoji=$2),false) AS existing FROM message_reactions WHERE message_id = $1`, [messageId,emoji],db);
    if ((distinct?.n ?? 0) >= 20&&!distinct?.existing) throw Errors.badRequest('Слишком много разных реакций');
    await execute(`INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [messageId, userId, emoji],db);
  } else {
    await execute(`DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3`, [messageId, userId, emoji],db);
  }
  const rows = await query<{ user_ids: string[] }>(
    `SELECT array_agg(user_id ORDER BY created_at) AS user_ids FROM message_reactions WHERE message_id = $1 AND emoji = $2`,
    [messageId, emoji],
    db,
  );
    return rows[0]?.user_ids??[];
  });
  await emit(Ev.ReactionUpdate, { messageId, channelId: msg.channel_id, emoji, userIds: userIds.slice(0, 20), count: userIds.length,actorId:userId,actorHasReaction:userIds.includes(userId) }, targetOf(ca));
}

export async function setPinned(messageId: string, userId: string, pinned: boolean): Promise<MessageDTO> {
  const msg = await findMessage(messageId);
  if (!msg) throw Errors.notFound('Сообщение');
  const ca = await requireChannel(msg.channel_id, userId);
  if (ca.access && !has(ca.access.perms, Perm.PIN_MESSAGES) && !has(ca.access.perms, Perm.MANAGE_MESSAGES)) {
    throw Errors.forbidden('Нет права закреплять сообщения');
  }
  await tx(async db => {
    // All pin/unpin operations in a channel share a lock, including capacity checks.
    await execute(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`pins:${msg.channel_id}`], db);
    const current = await queryOne<{ pinned: boolean }>(`SELECT pinned FROM messages WHERE id = $1 FOR UPDATE`, [messageId], db);
    if (!current) throw Errors.notFound('Сообщение');
    if (pinned && !current.pinned) {
      const count = await queryOne<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE channel_id = $1 AND pinned`, [msg.channel_id], db);
      if ((count?.n ?? 0) >= 50) throw Errors.badRequest('Достигнут лимит закреплённых сообщений (50)');
    }
    await execute(`UPDATE messages SET pinned = $2 WHERE id = $1`, [messageId, pinned], db);
  });
  if (ca.channel.server_id) await audit(ca.channel.server_id, userId, AuditAction.MessagePin, { type: 'message', id: messageId }, { pinned });
  const [dto] = await hydrate([(await findMessage(messageId))!], userId);
  await emit(Ev.MessageUpdate, dto, targetOf(ca));
  return dto!;
}

export async function pins(channelId: string, userId: string): Promise<MessageDTO[]> {
  await requireChannel(channelId, userId);
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.channel_id = $1 AND m.pinned ORDER BY m.id DESC`,
    [channelId],
  );
  return hydrate(rows, userId);
}

export async function markRead(channelId: string, userId: string, messageId: string): Promise<void> {
  await requireChannel(channelId, userId);
  const state=await updateReadMarker(channelId,userId,messageId,false);
  await emit(Ev.ReadState, state, { users: [userId] });
}

/** "Mark unread": moves the read marker to just before the given message. */
export async function markUnread(channelId: string, userId: string, messageId: string): Promise<void> {
  await requireChannel(channelId, userId);
  const state=await updateReadMarker(channelId,userId,messageId,true);
  await emit(Ev.ReadState, state, { users: [userId] });
}

async function updateReadMarker(channelId:string,userId:string,messageId:string,unread:boolean){
  return tx(async db=>{
    await execute(`INSERT INTO read_states (user_id,channel_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,[userId,channelId],db);
    const row=await queryOne<{last_read_id:string|null}>(`SELECT last_read_id FROM read_states WHERE user_id=$1 AND channel_id=$2 FOR UPDATE`,[userId,channelId],db);
    // Count after obtaining the row lock so concurrent message inserts cannot lose their increments.
    const latest=await queryOne<{id:string}>(`SELECT coalesce(max(id),0)::text AS id FROM messages WHERE channel_id=$1`,[channelId],db);
    const cap=BigInt(latest!.id),requested=BigInt(messageId)-(unread?1n:0n),previous=BigInt(row!.last_read_id??'0');
    let marker=unread?requested:(requested>previous?requested:previous);
    if(marker<0n)marker=0n;if(marker>cap)marker=cap;
    const count=await queryOne<{n:number}>(`SELECT count(*)::int AS n FROM messages WHERE channel_id=$1 AND id>$3
      AND author_id IS DISTINCT FROM $2::uuid AND ($2::uuid=ANY(mention_ids) OR mentions_everyone)`,[channelId,userId,marker.toString()],db);
    await execute(`UPDATE read_states SET last_read_id=$3,mention_count=$4 WHERE user_id=$1 AND channel_id=$2`,[userId,channelId,marker.toString(),count!.n],db);
    return {channelId,lastReadId:marker.toString(),mentionCount:count!.n};
  });
}

export async function readStates(userId: string) {
  const rows = await query<{ channel_id: string; last_read_id: string; mention_count: number }>(
    `SELECT channel_id, last_read_id, mention_count FROM read_states WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => ({ channelId: r.channel_id, lastReadId: r.last_read_id, mentionCount: r.mention_count }));
}

// ─────────────── bookmarks ───────────────

export async function bookmark(messageId: string, userId: string, on: boolean): Promise<void> {
  const msg = await findMessage(messageId);
  if (!msg) throw Errors.notFound('Сообщение');
  await requireChannel(msg.channel_id, userId);
  if (on) await execute(`INSERT INTO bookmarks (user_id, message_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [userId, messageId]);
  else await execute(`DELETE FROM bookmarks WHERE user_id = $1 AND message_id = $2`, [userId, messageId]);
}

export async function bookmarks(userId: string): Promise<MessageDTO[]> {
  // Only messages the user can still see (left servers drop out).
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM bookmarks b JOIN messages m ON m.id = b.message_id JOIN channels c ON c.id = m.channel_id
      WHERE b.user_id = $1 AND (
        (c.server_id IS NOT NULL AND EXISTS (SELECT 1 FROM server_members sm WHERE sm.server_id = c.server_id AND sm.user_id = $1))
        OR (c.server_id IS NULL AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $1)))
      ORDER BY b.created_at DESC LIMIT 100`,
    [userId],
  );
  return hydrate(rows, userId);
}

export async function typing(channelId: string, userId: string): Promise<void> {
  const ca = await requireChannel(channelId, userId);
  if (ca.access && !has(ca.access.perms, Perm.SEND_MESSAGES)) return;
  // Throttle to one broadcast per user/channel every 3 seconds.
  if ((await redis.set(`typing:${channelId}:${userId}`, '1', 'EX', 3, 'NX')) !== 'OK') return;
  const user = await loadPublicUser(userId);
  await emit(Ev.TypingStart, { channelId, userId, username: user?.displayName || user?.username }, targetOf(ca), userId);
}

/** Reply chain of a message ("thread" view): the parent plus every direct reply, oldest first. */
export async function thread(messageId: string, userId: string): Promise<{ parent: MessageDTO; replies: MessageDTO[] }> {
  const parent = await findMessage(messageId);
  if (!parent) throw Errors.notFound('Сообщение');
  await requireChannel(parent.channel_id, userId);
  const rows = await query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.reply_to_id = $1 ORDER BY m.id ASC LIMIT 200`,
    [messageId],
  );
  const [p, ...replies] = await hydrate([parent, ...rows], userId);
  return { parent: p!, replies };
}
