import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { config } from '../config.js';
import { execute, query, queryOne, tx } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import { Perm } from '../models/permissions.js';
import { storage } from '../storage/index.js';
import { assertPerm, canManage, requireChannel } from './permissionService.js';
import { assertExtensionMatches, readBody, sanitizeFilename, sniff } from './mediaService.js';
import { findMessage, hydrate, toAttachment, MESSAGE_COLUMNS, type MessageRow } from '../repositories/messageRepo.js';
import { emit } from '../websocket/bus.js';
import { Ev } from '../websocket/events.js';
import { targetOf } from './messageService.js';
import { log } from '../logger.js';
import type { AttachmentDTO } from '../models/dto.js';

const MAX_BYTES = (): number => config.MAX_UPLOAD_MB * 1024 * 1024;

/** Content types that are safe to render inline in the browser. Everything else is forced to download. */
const INLINE_SAFE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mp4',
  'application/pdf',
]);

export async function upload(req: IncomingMessage, channelId: string, userId: string): Promise<AttachmentDTO> {
  const ca = await requireChannel(channelId, userId);
  if (ca.channel.type === 'voice') throw Errors.badRequest('В голосовой канал нельзя загружать файлы');
  assertPerm(ca, Perm.ATTACH_FILES, 'Нет права прикреплять файлы');

  const rawName = req.headers['x-file-name'];
  if (typeof rawName !== 'string' || !rawName) throw Errors.badRequest('Не указано имя файла');
  let filename: string;
  try {
    filename = sanitizeFilename(decodeURIComponent(rawName));
  } catch {
    throw Errors.badRequest('Некорректное имя файла');
  }

  const data = await readBody(req, MAX_BYTES());
  const sniffed = sniff(data);
  if (!sniffed) throw Errors.unsupported('Этот тип файла не поддерживается');
  assertExtensionMatches(filename, sniffed);

  // Office documents are ZIP containers; give them their proper MIME so they download with the right type.
  const mime = sniffed.mime === 'application/zip' ? officeMime(filename) : sniffed.mime;
  const id = randomUUID();
  const key = `attachments/${channelId}/${id}`;
  let width: number | null = null;
  let height: number | null = null;
  let previewKey: string | null = null;

  if (sniffed.kind === 'image') {
    try {
      const meta = await sharp(data, { limitInputPixels: 100_000_000 }).metadata();
      width = meta.width ?? null;
      height = meta.pageHeight ?? meta.height ?? null;
      // Static preview for large images keeps chat scrolling light; GIFs stay animated in the original.
      if (sniffed.mime !== 'image/gif' && (width ?? 0) * (height ?? 0) > 1280 * 1280) {
        const preview = await sharp(data).rotate().resize({ width: 1280, height: 1280, fit: 'inside' }).webp({ quality: 82 }).toBuffer();
        previewKey = `${key}.preview.webp`;
        await storage.put(previewKey, preview, 'image/webp');
      }
    } catch {
      throw Errors.unsupported('Изображение повреждено или не поддерживается');
    }
  }

  await storage.put(key, data, mime);
  const row = await queryOne<{ id: string; filename: string; mime: string; size: string; kind: AttachmentDTO['kind']; width: number | null; height: number | null; preview_key: string | null }>(
    `INSERT INTO attachments (id, uploader_id, channel_id, storage_key, preview_key, filename, mime, size, kind, width, height)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, filename, mime, size, kind, width, height, preview_key`,
    [id, userId, channelId, key, previewKey, filename, mime, data.length, sniffed.kind, width, height],
  );
  return toAttachment(row!);
}

function officeMime(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    odt: 'application/vnd.oasis.opendocument.text',
    ods: 'application/vnd.oasis.opendocument.spreadsheet',
    odp: 'application/vnd.oasis.opendocument.presentation',
  };
  return (ext && map[ext]) || 'application/zip';
}

interface AttRow {
  id: string;
  message_id: string | null;
  uploader_id: string;
  channel_id: string;
  storage_key: string;
  preview_key: string | null;
  filename: string;
  mime: string;
}

/**
 * Streams an attachment after checking that the viewer can see its channel. IDs alone grant nothing:
 * a user outside the server/DM gets 404 even with a valid attachment id.
 */
export async function serve(req: IncomingMessage, res: ServerResponse, attachmentId: string, userId: string, preview: boolean): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(attachmentId)) throw Errors.notFound('Файл');
  const att = await queryOne<AttRow>(`SELECT * FROM attachments WHERE id = $1`, [attachmentId]);
  if (!att) throw Errors.notFound('Файл');
  if (att.message_id === null && att.uploader_id !== userId) throw Errors.notFound('Файл');
  await requireChannel(att.channel_id, userId).catch(() => {
    throw Errors.notFound('Файл');
  });
  const key = preview && att.preview_key ? att.preview_key : att.storage_key;
  const range = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const obj = await storage.get(key, range);
  if (!obj) throw Errors.notFound('Файл');
  const mime = preview && att.preview_key ? 'image/webp' : att.mime;
  const forceDownload = req.url?.includes('download=1') || !INLINE_SAFE.has(mime);
  const disposition = `${forceDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(att.filename)}`;
  res.writeHead(obj.status, {
    'Content-Type': INLINE_SAFE.has(mime) ? mime : 'application/octet-stream',
    'Content-Length': obj.size,
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    ...(obj.contentRange ? { 'Content-Range': obj.contentRange } : {}),
  });
  await pipeline(obj.stream, res).catch(() => undefined);
}

/** Public media (avatars, icons, banners): random keys, re-encoded by us, safe to cache. */
export async function serveMedia(res: ServerResponse, key: string): Promise<void> {
  if (!/^media\/[a-z-]+\/[0-9a-f-]{36}\.webp$/.test(key)) throw Errors.notFound('Файл');
  const obj = await storage.get(key);
  if (!obj) throw Errors.notFound('Файл');
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Content-Length': obj.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  await pipeline(obj.stream, res).catch(() => undefined);
}

export async function remove(attachmentId: string, userId: string): Promise<void> {
  let observed=false;
  for(;;){
    const att = await queryOne<AttRow>(`SELECT * FROM attachments WHERE id = $1`, [attachmentId]);
    if (!att) {if(observed)return;throw Errors.notFound('Файл');}
    const ca = await requireChannel(att.channel_id, userId);
    if (att.uploader_id !== userId && !canManage(ca, Perm.MANAGE_MESSAGES)) throw Errors.forbidden('Нет права удалять этот файл');
    observed=true;
    const result=await tx(async(db)=>{
      // Message deletion locks the parent before cascading to attachments. Keep
      // that order, and serialize the decision to remove an emptied message.
      const msg=att.message_id?await queryOne<MessageRow>(`SELECT ${MESSAGE_COLUMNS} FROM messages m
        JOIN channels c ON c.id=m.channel_id WHERE m.id=$1 FOR UPDATE OF m`,[att.message_id],db):null;
      if(att.message_id && !msg)return {retry:false,removed:att,message:null,deleted:false};
      const removed=await queryOne<AttRow>(`DELETE FROM attachments WHERE id=$1
        AND message_id IS NOT DISTINCT FROM $2::bigint RETURNING *`,[att.id,att.message_id],db);
      // A pending upload may have been linked while we waited. Release its row
      // before retrying with the new parent, rather than locking parent after child.
      if(!removed)return {retry:true,removed:null,message:null,deleted:false};
      if(!msg)return {retry:false,removed,message:null,deleted:false};
      const left=await queryOne<{n:number}>(`SELECT count(*)::int AS n FROM attachments WHERE message_id=$1`,[msg.id],db);
      const deleted=!msg.content && !msg.embeds?.length && left!.n===0;
      if(deleted)await execute(`DELETE FROM messages WHERE id=$1`,[msg.id],db);
      return {retry:false,removed,message:msg,deleted};
    });
    if(result.retry)continue;
    await storage.delete(result.removed!.storage_key).catch(()=>undefined);
    if(result.removed!.preview_key)await storage.delete(result.removed!.preview_key).catch(()=>undefined);
    const msg=result.message;
    if(msg){
      if(result.deleted){
        await emit(Ev.MessageDelete,{id:msg.id,channelId:msg.channel_id,serverId:msg.server_id},targetOf(ca));
      }else{
        const current=await findMessage(msg.id);
        if(current){const [dto]=await hydrate([current],userId);await emit(Ev.MessageUpdate,dto,targetOf(ca));}
      }
    }
    return;
  }
}

/** Deletes uploads that were never attached to a message (abandoned composer). */
export async function cleanupOrphans(): Promise<void> {
  const rows = await query<{ id: string; storage_key: string; preview_key: string | null }>(
    `DELETE FROM attachments WHERE message_id IS NULL AND created_at < now() - interval '2 hours' RETURNING id, storage_key, preview_key`,
  );
  for (const r of rows) {
    await storage.delete(r.storage_key).catch(() => undefined);
    if (r.preview_key) await storage.delete(r.preview_key).catch(() => undefined);
  }
  if (rows.length) log.info('orphan attachments removed', { count: rows.length });
}
