import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT (RFC 7519). Used for our access tokens, MFA tickets and LiveKit grants.
 * Only HS256 is accepted on verification, which rules out "alg: none" and key-confusion attacks.
 */

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

export type JwtPayload = Record<string, unknown> & { exp?: number; nbf?: number; iat?: number };

export function signJwt(payload: JwtPayload, secret: string, ttlSec?: number): string {
  const now = Math.floor(Date.now() / 1000);
  const body: JwtPayload = { iat: now, ...payload };
  if (ttlSec !== undefined) body.exp = now + ttlSec;
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const data = `${head}.${b64url(JSON.stringify(body))}`;
  const sig = createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifyJwt<T extends JwtPayload = JwtPayload>(token: string, secret: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  let header: { alg?: string };
  try {
    header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!header || typeof header !== 'object' || Array.isArray(header) || header.alg !== 'HS256') return null;
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.exp !== undefined && (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))) return null;
  if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf))) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && now >= payload.exp) return null;
  if (typeof payload.nbf === 'number' && now < payload.nbf) return null;
  return payload;
}
