import type { IncomingMessage } from 'node:http';
import { verifyJwt } from '../auth/jwt.js';
import { config } from '../config.js';
import { redis } from '../redis.js';
import type { AuthUser } from '../http/router.js';

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
  exp: number;
  [k: string]: unknown;
}

export const revokedSessionKey = (sid: string): string => `revoked-sid:${sid}`;

/** Verifies an access token and rejects sessions revoked before the token expired. */
export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  const claims = verifyJwt<AccessClaims>(token, config.JWT_SECRET);
  if (!claims || claims.typ !== 'access' || typeof claims.sub !== 'string' || typeof claims.sid !== 'string') return null;
  if (await redis.exists(revokedSessionKey(claims.sid))) return null;
  return { id: claims.sub, sessionId: claims.sid, emailVerified: claims.ev !== false };
}

export async function authenticateRequest(req: IncomingMessage): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyAccessToken(header.slice(7).trim());
}
