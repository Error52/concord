import { config } from '../../config.js';
import { redis } from '../../redis.js';
import { Errors } from '../../http/errors.js';
import { log } from '../../logger.js';
import { GiphyProvider } from './giphy.js';
import { TenorProvider } from './tenor.js';
import { LocalGifProvider } from './local.js';
export {localGifBytes} from './local.js';
import type { GifCategory, GifPage, GifProvider } from './types.js';
import type { EmbedDTO } from '../../models/dto.js';

function createProvider(): GifProvider | null {
  if (config.GIF_PROVIDER === 'none') return null;
  if(config.GIF_PROVIDER==='local'||!config.GIF_API_KEY)return new LocalGifProvider(config.APP_URL);
  return config.GIF_PROVIDER === 'tenor' ? new TenorProvider(config.GIF_API_KEY) : new GiphyProvider(config.GIF_API_KEY);
}

const provider = createProvider();

function requireProvider(): GifProvider {
  if (!provider) throw Errors.unavailable('GIF_DISABLED', 'GIF недоступны: на сервере не задан GIF_API_KEY');
  return provider;
}

async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  if(provider?.name==='local')return fn();
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit) as T;
  let value: T;
  try {
    value = await fn();
  } catch (err) {
    log.warn('gif provider failed', { err, provider: provider?.name });
    throw Errors.unavailable('GIF_UNAVAILABLE', 'Сервис GIF временно недоступен');
  }
  await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  return value;
}

export function gifStatus(): { enabled: boolean; provider: string | null } {
  return { enabled: !!provider, provider: provider?.name ?? null };
}

export async function search(q: string, pos: string | null, locale: string): Promise<GifPage> {
  const p = requireProvider();
  const norm = q.trim().toLowerCase().slice(0, 100);
  return cached(`gif:${p.name}:s:${locale}:${norm}:${pos ?? ''}`, 600, () => p.search(norm, pos, locale));
}

export async function trending(pos: string | null, locale: string): Promise<GifPage> {
  const p = requireProvider();
  return cached(`gif:${p.name}:t:${locale}:${pos ?? ''}`, 300, () => p.trending(pos, locale));
}

export async function categories(locale: string): Promise<GifCategory[]> {
  const p = requireProvider();
  return cached(`gif:${p.name}:c:${locale}`, 3600, () => p.categories(locale));
}

/** Accepts a GIF embed from the client only if its media comes from the active provider's CDN. */
export function validateEmbed(input: { url: string; previewUrl: string; width: number; height: number; title?: string }): EmbedDTO {
  const p = requireProvider();
  const local=new LocalGifProvider(config.APP_URL).byUrl(input.url);
  if(local&&input.previewUrl===local.previewUrl)return {type:'gif',url:local.url,previewUrl:local.previewUrl,width:local.width,height:local.height,title:local.title,provider:'local'};
  for (const u of [input.url, input.previewUrl]) {
    let host: string;
    try {
      const parsed = new URL(u);
      if (parsed.protocol !== 'https:') throw new Error('protocol');
      host = parsed.hostname;
    } catch {
      throw Errors.badRequest('Некорректный GIF');
    }
    if (!p.mediaHosts.some((h) => host === h || host.endsWith(`.${h}`))) throw Errors.badRequest('GIF должен быть из подключённого провайдера');
  }
  return { type: 'gif', url: input.url, previewUrl: input.previewUrl, width: input.width, height: input.height, title: input.title?.slice(0, 140), provider: p.name };
}
