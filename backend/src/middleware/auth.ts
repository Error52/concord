import type { IncomingMessage } from 'node:http';
import { verifyJwt } from '../auth/jwt.js';
import { config } from '../config.js';
import { redis } from '../redis.js';
import { queryOne } from '../db/pool.js';
import type { AuthUser } from '../http/router.js';
import {accountReady} from '../auth/accountReadiness.js';

export interface AccessClaims {
  sub: string;
  sid: string;
  typ: 'access';
  exp: number;
  [k: string]: unknown;
}

export const revokedSessionKey = (sid: string): string => `revoked-sid:${sid}`;
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Verifies an access token and rejects sessions revoked before the token expired. */
export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  const claims = verifyJwt<AccessClaims>(token, config.JWT_SECRET);
  if (!claims || claims.typ !== 'access' || typeof claims.sub !== 'string' || typeof claims.sid !== 'string'
    || !UUID_PATTERN.test(claims.sub) || !UUID_PATTERN.test(claims.sid)) return null;
  if (await redis.exists(revokedSessionKey(claims.sid))) return null;
  // Redis is a fast rejection path, not the durable source of session validity.
  // An earlier access token remains valid after rotation while its family is active.
  const active=await queryOne<{email_verified_at:Date|null;local_verified_at:Date|null;is_platform_admin:boolean}>(`SELECT u.email_verified_at,u.local_verified_at,u.is_platform_admin FROM sessions original JOIN users u ON u.id=original.user_id WHERE original.id=$1 AND original.user_id=$2
    AND EXISTS (SELECT 1 FROM sessions active WHERE active.family_id=original.family_id
      AND active.revoked_at IS NULL AND active.expires_at>now())`,[claims.sid,claims.sub]);
  if(!active)return null;
  return { id: claims.sub, sessionId: claims.sid, emailVerified: claims.ev !== false&&accountReady(active) };
}

export async function authenticateRequest(req: IncomingMessage): Promise<AuthUser | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyAccessToken(header.slice(7).trim());
}
