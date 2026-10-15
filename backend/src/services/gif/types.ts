export interface Gif {
  id: string;
  title: string;
  /** Full animated media (mp4/gif/webp) for sending. */
  url: string;
  /** Small animated preview for the picker grid. */
  previewUrl: string;
  width: number;
  height: number;
}

export interface GifCategory {
  name: string;
  query: string;
  previewUrl: string | null;
}

export interface GifPage {
  items: Gif[];
  next: string | null;
}

/** Pluggable GIF backend. Add a provider by implementing this and registering it in gif/index.ts. */
export interface GifProvider {
  readonly name: string;
  /** Hostnames media URLs may come from; used to validate GIF embeds the client sends. */
  readonly mediaHosts: string[];
  search(q: string, pos: string | null, locale: string): Promise<GifPage>;
  trending(pos: string | null, locale: string): Promise<GifPage>;
  categories(locale: string): Promise<GifCategory[]>;
}
