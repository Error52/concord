import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ObjectStorage, StoredObject } from './types.js';

/**
 * S3-compatible client (AWS Signature V4, path-style). Works with MinIO, AWS S3, Cloudflare R2, etc.
 * Kept dependency-free on purpose: we only need PUT/GET/DELETE/HEAD and bucket creation.
 */
export interface S3Options {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();

/** RFC 3986 encoding as required by SigV4 (each path segment encoded, "/" preserved). */
function encodeKey(key: string): string {
  return key
    .split('/')
    .map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

export function signV4(params: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKey: string;
  secretKey: string;
  service?: string;
  date?: Date;
}): Record<string, string> {
  const service = params.service ?? 's3';
  const date = params.date ?? new Date();
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...params.headers,
    host: params.url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': params.payloadHash,
  };
  const sortedNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  const canonicalHeaders = sortedNames.map((h) => `${h}:${lower[h]}\n`).join('');
  const signedHeaders = sortedNames.join(';');
  const query = [...params.url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const canonicalRequest = [params.method, params.url.pathname, query, canonicalHeaders, signedHeaders, params.payloadHash].join('\n');
  const scope = `${day}/${params.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${params.secretKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, params.region), service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${params.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export class S3Storage implements ObjectStorage {
  constructor(private readonly o: S3Options) {}

  private url(key?: string): URL {
    const base = this.o.endpoint.replace(/\/$/, '');
    return new URL(key === undefined ? `${base}/${this.o.bucket}` : `${base}/${this.o.bucket}/${encodeKey(key)}`);
  }

  private async request(method: string, url: URL, body?: Buffer, extra: Record<string, string> = {}): Promise<Response> {
    const payloadHash = body ? sha256(body) : sha256('');
    const headers = signV4({
      method,
      url,
      headers: extra,
      payloadHash,
      region: this.o.region,
      accessKey: this.o.accessKey,
      secretKey: this.o.secretKey,
    });
    delete headers.host; // fetch sets Host itself
    return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined });
  }

  async ensureBucket(): Promise<void> {
    const head = await this.request('HEAD', this.url());
    if (head.ok) return;
    const res = await this.request('PUT', this.url());
    if (!res.ok && res.status !== 409) throw new Error(`S3 create bucket failed: ${res.status}`);
  }

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    const res = await this.request('PUT', this.url(key), data, { 'content-type': contentType });
    if (!res.ok) throw new Error(`S3 put failed: ${res.status}`);
  }

  async get(key: string, range?: string): Promise<StoredObject | null> {
    const res = await this.request('GET', this.url(key), undefined, range ? { range } : {});
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new Error(`S3 get failed: ${res.status}`);
    return {
      stream: Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>),
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      status: res.status,
      contentRange: res.headers.get('content-range') ?? undefined,
    };
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', this.url(key));
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete failed: ${res.status}`);
  }
}
