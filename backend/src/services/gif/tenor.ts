import type { Gif, GifCategory, GifPage, GifProvider } from './types.js';

interface TenorFormat {
  url: string;
  dims: [number, number];
}
interface TenorItem {
  id: string;
  content_description: string;
  media_formats: Record<string, TenorFormat | undefined>;
}

export class TenorProvider implements GifProvider {
  readonly name = 'tenor';
  readonly mediaHosts = ['tenor.com'];

  constructor(private readonly apiKey: string) {}

  private async call<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`https://tenor.googleapis.com/v2/${path}`);
    url.searchParams.set('key', this.apiKey);
    url.searchParams.set('client_key', 'concord');
    url.searchParams.set('media_filter', 'gif,tinygif');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) throw new Error(`tenor ${res.status}`);
    return (await res.json()) as T;
  }

  private map(item: TenorItem): Gif | null {
    const full = item.media_formats.gif;
    const preview = item.media_formats.tinygif ?? full;
    if (!full || !preview) return null;
    return { id: item.id, title: item.content_description, url: full.url, previewUrl: preview.url, width: full.dims[0], height: full.dims[1] };
  }

  async search(q: string, pos: string | null, locale: string): Promise<GifPage> {
    const res = await this.call<{ results: TenorItem[]; next: string }>('search', {
      q,
      limit: '24',
      locale,
      contentfilter: 'medium',
      ...(pos ? { pos } : {}),
    });
    return { items: res.results.map((r) => this.map(r)).filter((g): g is Gif => !!g), next: res.next || null };
  }

  async trending(pos: string | null, locale: string): Promise<GifPage> {
    const res = await this.call<{ results: TenorItem[]; next: string }>('featured', {
      limit: '24',
      locale,
      contentfilter: 'medium',
      ...(pos ? { pos } : {}),
    });
    return { items: res.results.map((r) => this.map(r)).filter((g): g is Gif => !!g), next: res.next || null };
  }

  async categories(locale: string): Promise<GifCategory[]> {
    const res = await this.call<{ tags: { searchterm: string; image: string }[] }>('categories', { locale, type: 'featured' });
    return res.tags.map((t) => ({ name: t.searchterm, query: t.searchterm, previewUrl: t.image }));
  }
}
