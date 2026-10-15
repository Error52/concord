import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';
import { AppError, Errors } from './errors.js';
import { log, type Logger } from '../logger.js';
import { config, corsOrigins } from '../config.js';
import { rateLimit, type RateLimitRule } from '../middleware/rateLimit.js';

export interface AuthUser {
  id: string;
  sessionId: string;
  emailVerified?: boolean;
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  ip: string;
  user: AuthUser | null;
  log: Logger;
}

export interface AuthedCtx extends Ctx {
  user: AuthUser;
}

/** Returned by handlers that wrote the response themselves (file streams, redirects). */
export const RAW = Symbol('raw-response');

export class Reply {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly headers: Record<string, string | string[]> = {},
  ) {}
}

type AuthMode = 'required' | 'optional' | 'none';

interface RouteOptions {
  auth?: AuthMode;
  rateLimit?: RateLimitRule;
  /** Do not parse the body; handler consumes the request stream (uploads, webhooks). */
  rawBody?: boolean;
  /** Cookie-authenticated endpoint: require the anti-CSRF header + allowed Origin. */
  csrf?: boolean;
  allowUnverified?: boolean;
}

type AnyHandler = (ctx: AuthedCtx) => unknown;

interface Route {
  method: string;
  segments: string[];
  options: RouteOptions;
  handler: AnyHandler;
}

export type Authenticator = (req: IncomingMessage) => Promise<AuthUser | null>;

const JSON_LIMIT = 1024 * 1024;

export function validate<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const res = schema.safeParse(input);
  if (!res.success) throw Errors.validation(res.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return res.data;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > JSON_LIMIT) throw Errors.tooLarge('Тело запроса слишком большое');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  if (!type.includes('application/json')) throw Errors.unsupported('Ожидается application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Errors.badRequest('Некорректный JSON');
  }
}

export function clientIp(req: IncomingMessage): string {
  if (config.TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (origin && corsOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, X-File-Name, X-Channel-Id');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function checkCsrf(req: IncomingMessage): void {
  // Custom header cannot be set cross-site without a CORS preflight, which our allowlist rejects.
  if (req.headers['x-requested-with'] !== 'concord') throw Errors.forbidden('CSRF-проверка не пройдена');
  const origin = req.headers.origin;
  if (origin && !corsOrigins.has(origin) && origin !== config.APP_URL) throw Errors.forbidden('CSRF-проверка не пройдена');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  if (res.headersSent) return;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (body === undefined) {
    res.writeHead(status === 200 ? 204 : status).end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

export class Router {
  private routes: Route[] = [];

  constructor(private readonly authenticate: Authenticator) {}

  private add(method: string, path: string, options: RouteOptions, handler: AnyHandler): void {
    this.routes.push({ method, segments: path.split('/').filter(Boolean), options, handler });
  }

  get(path: string, options: RouteOptions, handler: AnyHandler): void {
    this.add('GET', path, options, handler);
  }
  post(path: string, options: RouteOptions, handler: AnyHandler): void {
    this.add('POST', path, options, handler);
  }
  put(path: string, options: RouteOptions, handler: AnyHandler): void {
    this.add('PUT', path, options, handler);
  }
  patch(path: string, options: RouteOptions, handler: AnyHandler): void {
    this.add('PATCH', path, options, handler);
  }
  delete(path: string, options: RouteOptions, handler: AnyHandler): void {
    this.add('DELETE', path, options, handler);
  }

  private match(method: string, pathname: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(':')) {
          try {
            params[seg.slice(1)] = decodeURIComponent(part);
          } catch {
            ok = false;
            break;
          }
        } else if (seg !== part) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      pathMatched = true;
      if (route.method === method) return { route, params };
    }
    return pathMatched ? 'method' : null;
  }

  async handle(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams): Promise<void> {
    const requestId = randomUUID();
    const rlog = log.child({ requestId });
    const started = Date.now();
    securityHeaders(res);
    applyCors(req, res);
    res.setHeader('X-Request-Id', requestId);
    const method = req.method ?? 'GET';

    try {
      if (method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      const matched = this.match(method, pathname);
      if (matched === null) throw Errors.notFound('Маршрут');
      if (matched === 'method') throw new AppError(405, 'METHOD_NOT_ALLOWED', 'Метод не поддерживается');
      const { route, params } = matched;
      const opts = route.options;
      const ip = clientIp(req);

      if (opts.csrf) checkCsrf(req);

      const mode = opts.auth ?? 'required';
      const user = mode === 'none' ? null : await this.authenticate(req);
      if (mode === 'required' && !user) throw Errors.unauthorized();
      if (user && config.REQUIRE_EMAIL_VERIFICATION && user.emailVerified === false && !opts.allowUnverified && route.segments[0] !== 'auth') {
        throw new AppError(403, 'EMAIL_UNVERIFIED', 'Подтвердите почту, чтобы завершить регистрацию');
      }

      if (opts.rateLimit) await rateLimit(opts.rateLimit, opts.rateLimit.by === 'user' && user ? user.id : ip);

      const body = opts.rawBody || method === 'GET' || method === 'DELETE' ? undefined : await readJson(req);
      const ctx: Ctx = { req, res, params, query: search, body, ip, user, log: rlog };
      const result = await route.handler(ctx as AuthedCtx);

      if (result === RAW) return;
      if (result instanceof Reply) sendJson(res, result.status, result.body, result.headers);
      else sendJson(res, 200, result);
    } catch (err) {
      this.fail(res, err, rlog);
    } finally {
      rlog.debug('http', { method, path: pathname, status: res.statusCode, ms: Date.now() - started });
    }
  }

  private fail(res: ServerResponse, err: unknown, rlog: Logger): void {
    if (err instanceof AppError) {
      if (err.status === 429) res.setHeader('Retry-After', String((err.details as { retryAfter: number }).retryAfter));
      sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof ZodError) {
      sendJson(res, 400, { error: { code: 'VALIDATION', message: 'Проверьте введённые данные' } });
      return;
    }
    // Unique violations race past pre-checks occasionally; surface them as conflicts.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505') {
      const constraint = (err as {constraint?:string}).constraint;
      if (constraint === 'users_email_uq' || constraint === 'users_username_uq') {
        const email = constraint === 'users_email_uq';
        sendJson(res, 409, {error:{code:email?'EMAIL_TAKEN':'USERNAME_TAKEN',message:email?'Этот email уже зарегистрирован':'Это имя пользователя уже занято'}});
        return;
      }
      sendJson(res, 409, { error: { code: 'CONFLICT', message: 'Такая запись уже существует' } });
      return;
    }
    rlog.error('unhandled error', { err });
    sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Внутренняя ошибка сервера' } });
  }
}
