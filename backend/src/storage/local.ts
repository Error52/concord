import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import type { ObjectStorage, StoredObject } from './types.js';
import {parseByteRange} from './range.js';

/** Filesystem storage (default; a Docker volume in compose). Keys are validated to prevent path traversal. */
export class LocalStorage implements ObjectStorage {
  private readonly root: string;

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  private resolve(key: string): string {
    if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes('..')) throw new Error('invalid storage key');
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error('invalid storage key');
    return full;
  }

  async ensureBucket(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    await writeFile(`${file}.type`, contentType);
  }

  async get(key: string, range?: string): Promise<StoredObject | null> {
    const file = this.resolve(key);
    let size: number;
    try {
      size = (await stat(file)).size;
    } catch {
      return null;
    }
    const contentType = (await readFile(`${file}.type`, 'utf8').catch(() => '')) || 'application/octet-stream';
    const parsed = parseByteRange(range);
    if (parsed) {
      const total=BigInt(size),suffix='suffix' in parsed?parsed.suffix:null;
      const first='first' in parsed?parsed.first:total-(suffix!>total?total:suffix!);
      const requestedEnd='first' in parsed?(parsed.last??total-1n):total-1n;
      const last=requestedEnd<total?requestedEnd:total-1n;
      // A nonzero suffix is satisfiable even for an empty representation (RFC 9110
      // 14.1.2). Ignore that empty range rather than inventing a 206 with end=-1.
      if(!(size===0&&suffix!==null&&suffix>0n)&&
        (suffix===0n||first>last||first>=total))return {stream:Readable.from([]),size:0,contentType,status:416,contentRange:`bytes */${size}`};
      const start=Number(first),end=Number(last);
      if (start <= end && start < size) {
        return {
          stream: createReadStream(file, { start, end }),
          size: end - start + 1,
          contentType,
          status: 206,
          contentRange: `bytes ${start}-${end}/${size}`,
        };
      }
    }
    return { stream: createReadStream(file), size, contentType, status: 200 };
  }

  async delete(key: string): Promise<void> {
    const file = this.resolve(key);
    await rm(file, { force: true });
    await rm(`${file}.type`, { force: true });
  }
}
