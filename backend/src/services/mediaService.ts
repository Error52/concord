import type { IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Errors } from '../http/errors.js';
import { storage } from '../storage/index.js';
import {audioOnlyMp4,audioOnlyWebm} from '../utils/mediaTracks.js';

/** Reads a request body into memory, aborting as soon as it exceeds maxBytes. */
export async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > maxBytes) throw Errors.tooLarge(`Максимальный размер — ${Math.floor(maxBytes / 1024 / 1024)} МБ`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > maxBytes) {
      req.destroy();
      throw Errors.tooLarge(`Максимальный размер — ${Math.floor(maxBytes / 1024 / 1024)} МБ`);
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) throw Errors.badRequest('Пустой файл');
  return Buffer.concat(chunks);
}

export interface Sniffed {
  mime: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  extensions: string[];
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean => bytes.every((b, i) => buf[offset + i] === b);
const ascii = (buf: Buffer, start: number, end: number): string => buf.subarray(start, end).toString('latin1');

/**
 * Detects the real file type from magic bytes. The client-declared Content-Type is never trusted.
 * Returns null for unknown binary formats.
 */
export function sniff(buf: Buffer): Sniffed | null {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47])) return { mime: 'image/png', kind: 'image', extensions: ['png'] };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { mime: 'image/jpeg', kind: 'image', extensions: ['jpg', 'jpeg'] };
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return { mime: 'image/gif', kind: 'image', extensions: ['gif'] };
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image', extensions: ['webp'] };
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio', extensions: ['wav'] };
  if (ascii(buf, 4, 8) === 'ftyp') {
    const brand = ascii(buf, 8, 12);
    if (brand.startsWith('avif') || brand === 'avis') return { mime: 'image/avif', kind: 'image', extensions: ['avif'] };
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video', extensions: ['mov'] };
    if (brand.startsWith('M4A')||audioOnlyMp4(buf)) return { mime: 'audio/mp4', kind: 'audio', extensions: ['m4a','mp4'] };
    return { mime: 'video/mp4', kind: 'video', extensions: ['mp4', 'm4v'] };
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return audioOnlyWebm(buf)
    ? {mime:'audio/webm',kind:'audio',extensions:['webm','mka','mkv']}
    : { mime: 'video/webm', kind: 'video', extensions: ['webm', 'mkv'] };
  if (ascii(buf, 0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio', extensions: ['ogg', 'oga', 'opus'] };
  if (ascii(buf, 0, 3) === 'ID3' || startsWith(buf, [0xff, 0xfb]) || startsWith(buf, [0xff, 0xf3]) || startsWith(buf, [0xff, 0xf2]))
    return { mime: 'audio/mpeg', kind: 'audio', extensions: ['mp3'] };
  if (ascii(buf, 0, 4) === 'fLaC') return { mime: 'audio/flac', kind: 'audio', extensions: ['flac'] };
  if (ascii(buf, 0, 5) === '%PDF-') return { mime: 'application/pdf', kind: 'file', extensions: ['pdf'] };
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]))
    return { mime: 'application/zip', kind: 'file', extensions: ['zip', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'jar', 'apk'] };
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return { mime: 'application/x-7z-compressed', kind: 'file', extensions: ['7z'] };
  if (ascii(buf, 0, 4) === 'Rar!') return { mime: 'application/vnd.rar', kind: 'file', extensions: ['rar'] };
  if (isProbablyText(buf)) return { mime: 'text/plain', kind: 'file', extensions: TEXT_EXTENSIONS };
  return null;
}

const TEXT_EXTENSIONS = ['txt', 'md', 'log', 'csv', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'rb', 'php', 'yml', 'yaml', 'toml', 'ini', 'sql', 'sh', 'css', 'xml', 'kt', 'swift', 'lua'];

function isProbablyText(buf: Buffer): boolean {
  const sample = buf.subarray(0, 4096);
  if (sample.includes(0)) return false;
  try {
    // stream: true tolerates a multi-byte character cut at the sample boundary.
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buf.length });
    return true;
  } catch {
    return false;
  }
}

export function extensionOf(filename: string): string {
  const m = /\.([a-z0-9]{1,8})$/i.exec(filename);
  return m ? m[1]!.toLowerCase() : '';
}

/** Rejects files whose extension contradicts their content (e.g. an .exe renamed to .png). */
export function assertExtensionMatches(filename: string, sniffed: Sniffed): void {
  const ext = extensionOf(filename);
  if (!ext || !sniffed.extensions.includes(ext)) {
    throw Errors.unsupported(`Расширение файла не соответствует содержимому (${sniffed.mime})`);
  }
}

export function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  const clean = base.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '');
  const points=[...clean];
  if(points.length<=120)return clean||'file';
  // Keep the extension used by content validation and never leave half a surrogate.
  const suffix=/\.[a-z0-9]{1,8}$/i.exec(clean)?.[0]??'';
  return points.slice(0,120-[...suffix].length).join('')+suffix;
}

export type MediaKind = 'avatar' | 'banner' | 'icon' | 'background' | 'badge' | 'server-banner';

const MEDIA_SIZES: Record<MediaKind, { width: number; height: number; fit: 'cover' | 'inside' }> = {
  avatar: { width: 256, height: 256, fit: 'cover' },
  icon: { width: 256, height: 256, fit: 'cover' },
  badge: { width: 64, height: 64, fit: 'cover' },
  banner: { width: 960, height: 384, fit: 'cover' },
  'server-banner': { width: 960, height: 540, fit: 'cover' },
  background: { width: 1200, height: 1600, fit: 'inside' },
};

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Validates an uploaded image, re-encodes it (strips metadata and any embedded payloads),
 * resizes it for its purpose and stores it. Animated GIF/WebP stay animated.
 */
export async function storeProcessedImage(buf: Buffer, kind: MediaKind): Promise<string> {
  const sniffed = sniff(buf);
  if (!sniffed || !IMAGE_MIMES.has(sniffed.mime)) throw Errors.unsupported('Допустимы только изображения PNG, JPEG, GIF, WebP или AVIF');
  const size = MEDIA_SIZES[kind];
  let out: Buffer;
  try {
    const animated = sniffed.mime === 'image/gif' || sniffed.mime === 'image/webp';
    out = await sharp(buf, { animated, limitInputPixels: 50_000_000 })
      .rotate()
      .resize({ width: size.width, height: size.height, fit: size.fit, withoutEnlargement: size.fit === 'inside' })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
  } catch {
    throw Errors.unsupported('Не удалось обработать изображение');
  }
  const key = `media/${kind}/${randomUUID()}.webp`;
  await storage.put(key, out, 'image/webp');
  return key;
}

export async function deleteMedia(key: string | null | undefined): Promise<void> {
  if (key) await storage.delete(key).catch(() => undefined);
}
