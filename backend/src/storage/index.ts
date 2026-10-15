import { config } from '../config.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';
import type { ObjectStorage } from './types.js';

function create(): ObjectStorage {
  if (config.STORAGE_DRIVER === 'local') return new LocalStorage(config.STORAGE_LOCAL_DIR);
  if (!config.S3_ENDPOINT || !config.S3_ACCESS_KEY || !config.S3_SECRET_KEY) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY');
  }
  return new S3Storage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKey: config.S3_ACCESS_KEY,
    secretKey: config.S3_SECRET_KEY,
  });
}

export const storage: ObjectStorage = create();

/** Public, cacheable media (avatars, banners, icons). Keys are random, so URLs are unguessable. */
export const mediaUrl = (key: string | null | undefined): string | null => (key ? `/api/${key}` : null);
