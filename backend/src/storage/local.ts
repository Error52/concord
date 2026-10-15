import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ObjectStorage, StoredObject } from './types.js';

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
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
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
