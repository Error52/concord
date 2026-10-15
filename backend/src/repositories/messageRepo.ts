import { query, queryOne } from '../db/pool.js';
import { loadPublicUsers } from './userRepo.js';
import type { AttachmentDTO, EmbedDTO, MessageDTO, ReactionDTO } from '../models/dto.js';

export interface MessageRow {
  id: string;
  channel_id: string;
  server_id: string | null;
  author_id: string | null;
  content: string;
  kind: 'default' | 'system';
  reply_to_id: string | null;
  embeds: EmbedDTO[];
  mention_ids: string[];
  mentions_everyone: boolean;
  pinned: boolean;
  edited_at: Date | null;
  created_at: Date;
}

export const MESSAGE_COLUMNS = `m.id, m.channel_id, c.server_id, m.author_id, m.content, m.kind, m.reply_to_id, m.embeds,
  m.mention_ids, m.mentions_everyone, m.pinned, m.edited_at, m.created_at`;

export async function findMessage(id: string): Promise<MessageRow | null> {
  if (!/^\d{1,19}$/.test(id)) return null;
  return queryOne<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN channels c ON c.id = m.channel_id WHERE m.id = $1`, [id]);
}

interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  mime: string;
  size: string;
  kind: AttachmentDTO['kind'];
  width: number | null;
  height: number | null;
  preview_key: string | null;
}

export function toAttachment(a: Omit<AttachmentRow, 'message_id'>): AttachmentDTO {
  const name = encodeURIComponent(a.filename);
  return {
    id: a.id,
    filename: a.filename,
    mime: a.mime,
    size: Number(a.size),
    kind: a.kind,
    width: a.width,
    height: a.height,
    url: `/api/attachments/${a.id}/${name}`,
    previewUrl: a.preview_key ? `/api/attachments/${a.id}/preview` : null,
  };
}

/** Turns rows into wire DTOs with authors, replies, attachments and reactions in a constant number of queries. */
export async function hydrate(rows: MessageRow[], viewerId: string): Promise<MessageDTO[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const replyIds = rows.map((r) => r.reply_to_id).filter((x): x is string => !!x);

  const [attachments, reactions, replies] = await Promise.all([
    query<AttachmentRow>(
      `SELECT id, message_id, filename, mime, size, kind, width, height, preview_key FROM attachments WHERE message_id = ANY($1::bigint[]) ORDER BY created_at`,
      [ids],
    ),
    query<{ message_id: string; emoji: string; user_ids: string[]; first: Date }>(
      `SELECT message_id, emoji, array_agg(user_id ORDER BY created_at) AS user_ids, min(created_at) AS first
         FROM message_reactions WHERE message_id = ANY($1::bigint[]) GROUP BY message_id, emoji ORDER BY first`,
      [ids],
    ),
    replyIds.length
      ? query<{ id: string; author_id: string | null; content: string }>(`SELECT id, author_id, content FROM messages WHERE id = ANY($1::bigint[])`, [replyIds])
      : Promise.resolve([]),
  ]);

  const users = await loadPublicUsers([
    ...rows.map((r) => r.author_id),
    ...replies.map((r) => r.author_id),
  ].filter((x): x is string => !!x));

  const attByMsg = new Map<string, AttachmentDTO[]>();
  for (const a of attachments) {
    const list = attByMsg.get(a.message_id) ?? [];
    list.push(toAttachment(a));
    attByMsg.set(a.message_id, list);
  }
  const reactByMsg = new Map<string, ReactionDTO[]>();
  for (const r of reactions) {
    const list = reactByMsg.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: r.user_ids.length, me: r.user_ids.includes(viewerId), userIds: r.user_ids.slice(0, 20) });
    reactByMsg.set(r.message_id, list);
  }
  const replyById = new Map(replies.map((r) => [r.id, r]));

  return rows.map((r) => {
    const reply = r.reply_to_id ? replyById.get(r.reply_to_id) : undefined;
    return {
      id: r.id,
      channelId: r.channel_id,
      serverId: r.server_id,
      author: r.author_id ? (users.get(r.author_id) ?? null) : null,
      content: r.content,
      kind: r.kind,
      replyTo: reply
        ? { id: reply.id, author: reply.author_id ? (users.get(reply.author_id) ?? null) : null, content: reply.content.slice(0, 200) }
        : null,
      attachments: attByMsg.get(r.id) ?? [],
      embeds: r.embeds,
      reactions: reactByMsg.get(r.id) ?? [],
      mentionIds: r.mention_ids,
      mentionsEveryone: r.mentions_everyone,
      pinned: r.pinned,
      editedAt: r.edited_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
    };
  });
}
