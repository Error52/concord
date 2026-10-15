import type { Gif, GifCategory, GifPage, GifProvider } from './types.js';

interface GiphyImage {
  url?: string;
  width?: string;
  height?: string;
}
interface GiphyItem {
  id: string;
  title: string;
  images: Record<string, GiphyImage | undefined>;
}

const PAGE = 24;

export class GiphyProvider implements GifProvider {
  readonly name = 'giphy';
  readonly mediaHosts = ['giphy.com'];

  constructor(private readonly apiKey: string) {}

  private async call<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://api.giphy.com/v1/${path}`);
    url.searchParams.set('api_key', this.apiKey);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`giphy ${res.status}`);
    return (await res.json()) as T;
  }

  private map(item: GiphyItem): Gif | null {
    const full = item.images.original ?? item.images.downsized;
    const preview = item.images.fixed_width_downsampled ?? item.images.fixed_width ?? full;
    if (!full?.url || !preview?.url) return null;
    return {
      id: item.id,
      title: item.title,
      url: full.url,
      previewUrl: preview.url,
      width: Number(full.width ?? 0),
      height: Number(full.height ?? 0),
    };
  }

  private page(data: GiphyItem[], offset: number, total: number): GifPage {
    const next = offset + PAGE < Math.min(total, 4999) ? String(offset + PAGE) : null;
    return { items: data.map((d) => this.map(d)).filter((g): g is Gif => !!g), next };
  }

  async search(q: string, pos: string | null, locale: string): Promise<GifPage> {
    const offset = Number(pos ?? 0);
    const res = await this.call<{ data: GiphyItem[]; pagination: { total_count: number } }>('gifs/search', {
      q,
      limit: String(PAGE),
      offset: String(offset),
      rating: 'pg-13',
      lang: locale.slice(0, 2),
    });
    return this.page(res.data, offset, res.pagination.total_count);
  }

  async trending(pos: string | null): Promise<GifPage> {
    const offset = Number(pos ?? 0);
    const res = await this.call<{ data: GiphyItem[]; pagination: { total_count: number } }>('gifs/trending', {
      limit: String(PAGE),
      offset: String(offset),
      rating: 'pg-13',
    });
    return this.page(res.data, offset, res.pagination.total_count);
  }

  async categories(): Promise<GifCategory[]> {
    const res = await this.call<{ data: { name: string; name_encoded: string; gif?: GiphyItem }[] }>('gifs/categories', {});
    return res.data.slice(0, 24).map((c) => ({
      name: c.name,
      query: c.name,
      previewUrl: c.gif ? (this.map(c.gif)?.previewUrl ?? null) : null,
    }));
  }
}
