import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { createApp, type App } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { redis, closeRedis } from '../src/redis.js';
import { storage } from '../src/storage/index.js';
import { assertTestDatabases } from './environment.js';

/**
 * Integration test harness: boots the real HTTP server + gateway against the configured
 * PostgreSQL and Redis (use a dedicated test database!).
 */
export interface Harness {
  app: App;
  base: string;
  close(): Promise<void>;
}

export async function startServer(): Promise<Harness> {
  assertTestDatabases(process.env);
  await migrate();
  await storage.ensureBucket();
  await pool.query(`TRUNCATE users, servers, channels, sessions, notifications, audit_log RESTART IDENTITY CASCADE`);
  await redis.call('flushdb');
  const app = createApp();
  await app.gateway.start();
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const { port } = app.server.address() as AddressInfo;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await app.gateway.stop();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      await pool.end();
      await closeRedis();
    },
  };
}

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export class Client {
  token: string | null = null;
  cookies = new Map<string, string>();
  user: any = null;
  /** Each client looks like a distinct IP (tests run with TRUST_PROXY=1) so per-IP limits don't interfere. */
  readonly ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

  constructor(private readonly base: string) {}

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private storeCookies(headers: Headers): void {
    for (const c of headers.getSetCookie()) {
      const [pair] = c.split(';');
      const idx = pair!.indexOf('=');
      const name = pair!.slice(0, idx);
      const value = pair!.slice(idx + 1);
      if (/Max-Age=0/.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async req<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { 'X-Requested-With': 'concord', 'X-Forwarded-For': this.ip, ...extra };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.cookies.size) headers.Cookie = this.cookieHeader();
    let payload: BodyInit | undefined;
    if (body instanceof Buffer) {
      payload = new Uint8Array(body);
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(this.base + path, { method, headers, body: payload });
    this.storeCookies(res.headers);
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* binary or text */
    }
    return { status: res.status, body: parsed as T, headers: res.headers };
  }

  get = <T = any>(p: string) => this.req<T>('GET', p);
  post = <T = any>(p: string, b?: unknown) => this.req<T>('POST', p, b ?? {});
  patch = <T = any>(p: string, b?: unknown) => this.req<T>('PATCH', p, b ?? {});
  put = <T = any>(p: string, b?: unknown) => this.req<T>('PUT', p, b);
  del = <T = any>(p: string) => this.req<T>('DELETE', p);

  async register(username: string, password = 'password123'): Promise<this> {
    const res = await this.post('/api/auth/register', { username, email: `${username}@example.com`, password });
    if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    this.token = res.body.accessToken;
    this.user = res.body.user;
    // General feature fixtures are verified explicitly in the isolated test database.
    // Verification-specific tests use raw /register and exercise the real confirmation endpoint.
    await pool.query(`UPDATE users SET email_verified_at=now() WHERE id=$1`, [this.user.id]);
    const refresh = await this.post('/api/auth/refresh');
    if (refresh.status !== 200) throw new Error('Verified fixture refresh failed');
    this.token = refresh.body.accessToken;
    return this;
  }
}

export interface GatewayClient {
  ws: WebSocket;
  events: { t: string; d: any }[];
  ready: any;
  waitFor(t: string, pred?: (d: any) => boolean, timeoutMs?: number): Promise<any>;
  send(op: string, d: unknown): void;
  close(): void;
}

export async function connectGateway(base: string, token: string, immediateHeartbeat = false): Promise<GatewayClient> {
  const ws = new WebSocket(base.replace('http', 'ws') + '/gateway');
  const events: { t: string; d: any }[] = [];
  const listeners = new Set<() => void>();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    events.push({ t: msg.t, d: msg.d });
    listeners.forEach((l) => l());
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const client: GatewayClient = {
    ws,
    events,
    ready: null,
    send(op, d) {
      ws.send(JSON.stringify({ op, d }));
    },
    close() {
      ws.close();
    },
    waitFor(t, pred = () => true, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const check = (): boolean => {
          const idx = events.findIndex((e) => e.t === t && pred(e.d));
          if (idx >= 0) {
            const [e] = events.splice(idx, 1);
            listeners.delete(check);
            clearTimeout(timer);
            resolve(e!.d);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timeout waiting for ${t}; got ${events.map((e) => e.t).join(',')}`));
        }, timeoutMs);
        if (!check()) listeners.add(check);
      });
    },
  };
  client.send('auth', { token });
  if (immediateHeartbeat) client.send('heartbeat', { afk: false });
  client.ready = await client.waitFor('ready');
  return client;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
