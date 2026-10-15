import type { Readable } from 'node:stream';

export interface StoredObject {
  stream: Readable;
  size: number;
  contentType: string;
  /** 200 for full content, 206 for a satisfied Range request. */
  status: number;
  contentRange?: string;
}

export interface ObjectStorage {
  ensureBucket(): Promise<void>;
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** range: raw HTTP Range header value ("bytes=0-1023"), used for video seeking. */
  get(key: string, range?: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
}
