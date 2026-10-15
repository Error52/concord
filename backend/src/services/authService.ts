import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { config, platformAdminEmails } from '../config.js';
import { execute, query, queryOne, tx, type Queryable } from '../db/pool.js';
import { Errors, AppError } from '../http/errors.js';
import { signJwt, verifyJwt } from '../auth/jwt.js';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/password.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import * as users from '../repositories/userRepo.js';
import { redis } from '../redis.js';
import { revokedSessionKey } from '../middleware/auth.js';
import { control } from '../websocket/bus.js';
import { queueMail } from './mailOutbox.js';
import { log } from '../logger.js';
import type { SelfUser, ProfileTheme } from '../models/dto.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Refresh reuse within this window is treated as a benign race between tabs, not theft. */
const ROTATION_GRACE_MS = 10_000;
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionTokens {
  accessToken: string;
  /** Cookie value: "<sessionId>.<secret>". */
  refreshToken: string;
  refreshMaxAgeSec: number;
}

export interface ClientInfo {
  ip: string;
  userAgent: string | undefined;
}

async function issueAccess(userId: string, sessionId: string, db?: Queryable): Promise<string> {
  const row = await queryOne<{verified:boolean}>(`SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE id=$1`, [userId], db);
  return signJwt({ sub: userId, sid: sessionId, typ: 'access', ev: row?.verified ?? false }, config.JWT_SECRET, config.ACCESS_TOKEN_TTL_SEC);
}

async function createSession(userId: string, client: ClientInfo, familyId: string = randomUUID(), db?: Queryable, expectedPasswordHash?:string): Promise<SessionTokens> {
  if (!db) return tx((transaction) => createSession(userId, client, familyId, transaction, expectedPasswordHash));
  await lockUserSessions(userId, db);
  if(expectedPasswordHash){
    const current=await queryOne<{password_hash:string}>(`SELECT password_hash FROM users WHERE id=$1`,[userId],db);
    if(current?.password_hash!==expectedPasswordHash)throw new AppError(401,'INVALID_CREDENTIALS','Неверный email или пароль');
  }
  const secret = randomBytes(32).toString('base64url');
  const maxAge = config.REFRESH_TOKEN_TTL_DAYS * 86_400;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (user_id, family_id, refresh_token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING id`,
    [userId, familyId, sha256(secret), client.userAgent?.slice(0, 255) ?? null, client.ip, maxAge],
    db,
  );
  const sessionId = row!.id;
  return { accessToken: await issueAccess(userId, sessionId, db), refreshToken: `${sessionId}.${secret}`, refreshMaxAgeSec: maxAge };
}

async function lockUserSessions(userId:string,db:Queryable):Promise<void> {
  await queryOne(`SELECT pg_advisory_xact_lock(hashtextextended($1,72601))`,[userId],db);
}

async function revokeSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await execute(`UPDATE sessions SET revoked_at = now() WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`, [ids]);
  const ttl = config.ACCESS_TOKEN_TTL_SEC + 60;
  const pipe = redis.pipeline();
  for (const id of ids) pipe.set(revokedSessionKey(id), '1', 'EX', ttl);
  await pipe.exec();
  await control({ kind: 'revoke', sessionIds: ids });
}

export interface RegisterInput {
  username: string;
  email: string;
  password: string;
  displayName?: string;
  bannerColor?: string;
  accentColor?: string;
  theme?: ProfileTheme;
}

export async function register(input: RegisterInput, client: ClientInfo, verifiedSeed = false): Promise<{ user: SelfUser; tokens: SessionTokens }> {
  if (await users.findByEmail(input.email)) throw Errors.conflict('EMAIL_TAKEN', 'Этот email уже зарегистрирован');
  if (await users.findByUsername(input.username)) throw Errors.conflict('USERNAME_TAKEN', 'Это имя пользователя уже занято');
  const passwordHash = await hashPassword(input.password);

  const { userId, tokens } = await tx(async (db) => {
    // Serialize the first-admin decision across concurrent registrations.
    await queryOne(`SELECT pg_advisory_xact_lock(727275)`, [], db);
    const u = await queryOne<{ id: string }>(
      // The very first account on a fresh install becomes the platform admin (plus anyone in PLATFORM_ADMIN_EMAILS).
      `INSERT INTO users (email, username, display_name, password_hash, is_platform_admin, email_verified_at)
       VALUES ($1, $2, $3, $4, $5 OR NOT EXISTS (SELECT 1 FROM users), CASE WHEN $6 THEN now() END) RETURNING id`,
      [input.email.trim().toLowerCase(), input.username.trim(), input.displayName?.trim() || null, passwordHash, platformAdminEmails.includes(input.email.trim().toLowerCase()), verifiedSeed],
      db,
    );
    await execute(
      `INSERT INTO profiles (user_id, banner_color, accent_color, theme) VALUES ($1, coalesce($2, '#5b5bd6'), coalesce($3, '#7c6cff'), coalesce($4::jsonb, '{"preset":"default"}'::jsonb))`,
      [u!.id, input.bannerColor ?? null, input.accentColor ?? null, input.theme ? JSON.stringify(input.theme) : null],
      db,
    );
    if (!verifiedSeed) await queueEmailVerification(u!.id, input.email.trim().toLowerCase(), db);
    return { userId: u!.id, tokens: await createSession(u!.id, client, undefined, db) };
  });
  const row = await users.findById(userId);
  return { user: await users.toSelf(row!), tokens };
}

export type LoginResult = { kind: 'ok'; user: SelfUser; tokens: SessionTokens } | { kind: 'mfa'; ticket: string };

export async function login(email: string, password: string, client: ClientInfo): Promise<LoginResult> {
  const row = await users.findByEmail(email);
  // Always run the KDF so response time does not leak account existence.
  const ok = await verifyPassword(password, row?.password_hash ?? (await getDummyHash()));
  if (!row || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Неверный email или пароль');
  if (row.totp_enabled) {
    return { kind: 'mfa', ticket: signJwt({ sub: row.id, typ: 'mfa', pv:sha256(row.password_hash) }, config.JWT_SECRET, 300) };
  }
  return { kind: 'ok', user: await users.toSelf(row), tokens: await createSession(row.id, client, undefined, undefined, row.password_hash) };
}

export async function completeMfa(ticket: string, code: string, client: ClientInfo): Promise<{ user: SelfUser; tokens: SessionTokens }> {
  const claims = verifyJwt<{ sub: string; typ: string; pv?:string }>(ticket, config.JWT_SECRET);
  if (!claims || claims.typ !== 'mfa') throw new AppError(401, 'MFA_EXPIRED', 'Сессия входа истекла, войдите заново');
  const row = await users.findById(claims.sub);
  if(row && claims.pv!==sha256(row.password_hash))throw new AppError(401,'MFA_EXPIRED','Сессия входа истекла, войдите заново');
  if (!row?.totp_enabled || !row.totp_secret || !verifyTotp(row.totp_secret, code)) {
    throw new AppError(401, 'INVALID_CODE', 'Неверный код подтверждения');
  }
  // Prevent replay of the same code within its validity window.
  const replayKey = `totp-used:${row.id}:${code}`;
  if ((await redis.set(replayKey, '1', 'EX', 90, 'NX')) !== 'OK') throw new AppError(401, 'INVALID_CODE', 'Код уже использован');
  return { user: await users.toSelf(row), tokens: await createSession(row.id, client, undefined, undefined, row.password_hash) };
}

interface SessionRow {
  id: string;
  user_id: string;
  family_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_at: Date | null;
  replaced_by: string | null;
}

/**
 * Refresh-token rotation with reuse detection: each refresh token is single-use.
 * Presenting an already-rotated token (outside a short grace window) revokes the whole family,
 * because it means the token was copied.
 */
export async function refresh(cookieValue: string | undefined, client: ClientInfo): Promise<SessionTokens> {
  const invalid = new AppError(401, 'SESSION_EXPIRED', 'Сессия истекла, войдите снова');
  if (!cookieValue) throw invalid;
  const [sessionId, secret, extra] = cookieValue.split('.');
  if (!sessionId || !secret || extra !== undefined || !UUID_PATTERN.test(sessionId)) throw invalid;

  const result = await tx(async (db): Promise<SessionTokens | {reusedFamily:string}> => {
    const owner=await queryOne<{user_id:string}>(`SELECT user_id FROM sessions WHERE id=$1`,[sessionId],db);
    if(!owner)throw invalid;
    await lockUserSessions(owner.user_id,db);
    const s = await queryOne<SessionRow>(`SELECT * FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId], db);
    if (!s) throw invalid;
    const a = Buffer.from(sha256(secret));
    const b = Buffer.from(s.refresh_token_hash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid;
    if (s.rotated_at) {
      if (Date.now() - s.rotated_at.getTime() > ROTATION_GRACE_MS) {
        log.warn('refresh token reuse detected; revoking family', { userId: s.user_id });
        return {reusedFamily:s.family_id};
      }
      const cached = await redis.get(`refresh-rotation:${s.id}`);
      const replacement = s.replaced_by ? await queryOne<{revoked_at:Date|null;expires_at:Date}>(`SELECT revoked_at, expires_at FROM sessions WHERE id=$1`, [s.replaced_by], db) : null;
      if (cached && replacement && !replacement.revoked_at && replacement.expires_at.getTime() > Date.now()) return JSON.parse(cached) as SessionTokens;
      // Another tab may already have rotated the replacement. Do not erase its new shared cookie.
      throw new AppError(409, 'REFRESH_RETRY', 'Сессия обновляется в другой вкладке, повторите запрос');
    }
    if (s.revoked_at || s.expires_at.getTime() < Date.now()) throw invalid;
    const next = await createSession(s.user_id, client, s.family_id, db);
    const nextId = next.refreshToken.split('.')[0];
    await execute(`UPDATE sessions SET rotated_at = now(), revoked_at = now(), replaced_by = $2 WHERE id = $1`, [s.id, nextId], db);
    await redis.set(`refresh-rotation:${s.id}`, JSON.stringify(next), 'PX', ROTATION_GRACE_MS);
    return next;
  });
  if ('reusedFamily' in result) {
    const family = await query<{id:string}>(`SELECT id FROM sessions WHERE family_id=$1`, [result.reusedFamily]);
    await revokeSessions(family.map((f)=>f.id));
    throw invalid;
  }
  return result;
}

export async function logout(sessionId: string): Promise<void> {
  const ids=await tx(async(db)=>{
    const session=await queryOne<{user_id:string;family_id:string}>(`SELECT user_id,family_id FROM sessions WHERE id=$1`,[sessionId],db);
    if(!session)return [];
    await lockUserSessions(session.user_id,db);
    const family=await query<{id:string}>(`UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE family_id=$1 RETURNING id`,[session.family_id],db);
    return family.map(s=>s.id);
  });
  await revokeSessions(ids);
}

export async function logoutByCookie(cookieValue: string | undefined): Promise<void> {
  const [sessionId,secret,extra]=cookieValue?.split('.')??[];
  if(!sessionId || !secret || extra!==undefined || !UUID_PATTERN.test(sessionId))return;
  const row=await queryOne<{refresh_token_hash:string}>(`SELECT refresh_token_hash FROM sessions WHERE id=$1`,[sessionId]);
  if(row){const a=Buffer.from(sha256(secret)),b=Buffer.from(row.refresh_token_hash);if(a.length===b.length&&timingSafeEqual(a,b))await logout(sessionId);}
}

export async function listSessions(userId: string, currentSessionId: string) {
  const rows = await query<{ id: string; user_agent: string | null; ip: string | null; created_at: Date; last_used_at: Date }>(
    `SELECT id, user_agent, ip, created_at, last_used_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at.toISOString(),
    current: r.id === currentSessionId,
  }));
}

export async function revokeSession(userId: string, sessionId: string): Promise<void> {
  const owned = await queryOne(`SELECT 1 FROM sessions WHERE id = $1 AND user_id = $2`, [sessionId, userId]);
  if (!owned) throw Errors.notFound('Сессия');
  await logout(sessionId);
}

export async function changePassword(userId: string, sessionId: string, current: string, next: string): Promise<void> {
  const row = await users.findById(userId);
  if (!row || !(await verifyPassword(current, row.password_hash))) throw new AppError(400, 'INVALID_PASSWORD', 'Текущий пароль неверен');
  const passwordHash=await hashPassword(next);
  const ids=await tx(async(db)=>{
    await lockUserSessions(userId,db);
    const latest=await users.findById(userId,db);
    if(!latest || latest.password_hash!==row.password_hash)throw new AppError(409,'PASSWORD_CHANGED','Пароль уже изменён. Войдите заново.');
    const currentSession=await queryOne<{family_id:string}>(`SELECT family_id FROM sessions WHERE id=$1 AND user_id=$2`,[sessionId,userId],db);
    if(!currentSession)throw new AppError(401,'SESSION_EXPIRED','Сессия истекла');
    await execute(`UPDATE users SET password_hash=$2,updated_at=now() WHERE id=$1`,[userId,passwordHash],db);
    await execute(`UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`,[userId],db);
    const others=await query<{id:string}>(`UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1 AND family_id<>$2 RETURNING id`,[userId,currentSession.family_id],db);
    return others.map(s=>s.id);
  });
  await revokeSessions(ids);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const row = await users.findByEmail(email);
  if (!row) return; // do not reveal whether the account exists
  const token = randomBytes(32).toString('base64url');
  const link = `${config.APP_URL}/reset-password?token=${token}`;
  await tx(async (db) => {
    await queryOne(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [row.id], db);
    await execute(`UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [row.id], db);
    const reset=await queryOne<{expires_at:Date}>(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2,now()+interval '1 hour') RETURNING expires_at`, [row.id,sha256(token)], db);
    await queueMail(row.id, {
      to: row.email,
      subject: 'Concord — восстановление пароля',
      text: `Чтобы задать новый пароль, откройте ссылку (действует 1 час):\n${link}\n\nЕсли вы не запрашивали сброс, просто проигнорируйте это письмо.`,
      html: `<p>Чтобы задать новый пароль, нажмите на ссылку (действует 1 час):</p><p><a href="${link}">Сбросить пароль</a></p><p>Если вы не запрашивали сброс, проигнорируйте это письмо.</p>`,
    }, db,{purpose:'password-reset',tokenHash:sha256(token),expiresAt:reset!.expires_at});
  });
}

export async function confirmPasswordReset(token: string, password: string): Promise<void> {
  const passwordHash = await hashPassword(password);
  const userId = await tx(async (db) => {
    const owner=await queryOne<{user_id:string}>(`SELECT user_id FROM password_resets WHERE token_hash=$1`,[sha256(token)],db);
    if(!owner)throw new AppError(400,'RESET_INVALID','Ссылка недействительна или устарела');
    await lockUserSessions(owner.user_id,db);
    const row = await queryOne<{user_id:string}>(`UPDATE password_resets SET used_at=now()
      WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id`, [sha256(token)], db);
    if (!row) throw new AppError(400, 'RESET_INVALID', 'Ссылка недействительна или устарела');
    await execute(`UPDATE users SET password_hash=$2, email_verified_at=coalesce(email_verified_at,now()), updated_at=now() WHERE id=$1`, [row.user_id,passwordHash], db);
    await execute(`UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [row.user_id], db);
    // Revoke in the same transaction so a concurrent refresh cannot survive the reset.
    const sessions = await query<{id:string}>(`UPDATE sessions SET revoked_at=coalesce(revoked_at,now()) WHERE user_id=$1 RETURNING id`, [row.user_id], db);
    return {id:row.user_id,sessions:sessions.map(s=>s.id)};
  });
  await revokeSessions(userId.sessions);
}

async function queueEmailVerification(userId:string,email:string,db:Queryable):Promise<void> {
  const token=randomBytes(32).toString('base64url');
  const link=`${config.APP_URL}/verify-email?token=${token}`;
  await execute(`UPDATE email_verifications SET used_at=now() WHERE user_id=$1 AND used_at IS NULL`, [userId], db);
  const verification=await queryOne<{expires_at:Date}>(`INSERT INTO email_verifications (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '24 hours') RETURNING expires_at`, [userId,sha256(token)], db);
  await queueMail(userId,{to:email,subject:'Concord — подтвердите почту',text:`Подтвердите адрес электронной почты, чтобы завершить регистрацию:\n${link}\n\nСсылка действует 24 часа. Если вы не создавали аккаунт, проигнорируйте письмо.`,html:`<p>Подтвердите адрес электронной почты, чтобы завершить регистрацию:</p><p><a href="${link}">Подтвердить почту</a></p><p>Ссылка действует 24 часа. Если вы не создавали аккаунт, проигнорируйте письмо.</p>`},db,{purpose:'verification',tokenHash:sha256(token),expiresAt:verification!.expires_at});
}

export async function resendEmailVerification(userId:string):Promise<void> {
  await tx(async(db)=>{
    const row=await queryOne<{email:string;email_verified_at:Date|null}>(`SELECT email,email_verified_at FROM users WHERE id=$1 FOR UPDATE`,[userId],db);
    if(!row)throw Errors.notFound('Пользователь');
    if(row.email_verified_at)return;
    const last=await queryOne<{created_at:Date}>(`SELECT created_at FROM email_verifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,[userId],db);
    const wait=last?Math.ceil((60_000-Date.now()+last.created_at.getTime())/1000):0;
    if(wait>0)throw new AppError(429,'RATE_LIMITED',`Повторить отправку можно через ${wait} сек.`,{retryAfter:wait});
    await queueEmailVerification(userId,row.email,db);
  });
}

export async function confirmEmail(token:string):Promise<{userId:string}> {
  return tx(async(db)=>{
    const row=await queryOne<{user_id:string}>(`UPDATE email_verifications SET used_at=now()
      WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id`,[sha256(token)],db);
    if(!row){
      const confirmed=await queryOne<{user_id:string}>(`SELECT v.user_id FROM email_verifications v JOIN users u ON u.id=v.user_id
        WHERE v.token_hash=$1 AND v.used_at IS NOT NULL AND v.expires_at>now() AND u.email_verified_at IS NOT NULL`,[sha256(token)],db);
      if(confirmed)return {userId:confirmed.user_id};
      throw new AppError(400,'VERIFY_INVALID','Ссылка недействительна или устарела. Запросите новое письмо.');
    }
    await execute(`UPDATE users SET email_verified_at=coalesce(email_verified_at,now()),updated_at=now() WHERE id=$1`,[row.user_id],db);
    return {userId:row.user_id};
  });
}

// ─────────────── TOTP 2FA ───────────────

export async function beginTotpSetup(userId: string): Promise<{ secret: string; otpauthUrl: string }> {
  const row = await users.findById(userId);
  if (!row) throw Errors.notFound('Пользователь');
  if (row.totp_enabled) throw Errors.conflict('TOTP_ENABLED', 'Двухфакторная аутентификация уже включена');
  const secret = generateTotpSecret();
  await redis.set(`totp-setup:${userId}`, secret, 'EX', 600);
  return { secret, otpauthUrl: otpauthUrl(secret, row.email) };
}

export async function enableTotp(userId: string, code: string): Promise<void> {
  const secret = await redis.get(`totp-setup:${userId}`);
  if (!secret) throw new AppError(400, 'TOTP_SETUP_EXPIRED', 'Начните настройку заново');
  if (!verifyTotp(secret, code)) throw new AppError(400, 'INVALID_CODE', 'Неверный код подтверждения');
  await execute(`UPDATE users SET totp_secret = $2, totp_enabled = true, updated_at = now() WHERE id = $1`, [userId, secret]);
  await redis.del(`totp-setup:${userId}`);
}

export async function disableTotp(userId: string, password: string, code: string): Promise<void> {
  const row = await users.findById(userId);
  if (!row?.totp_enabled || !row.totp_secret) throw new AppError(400, 'TOTP_DISABLED', '2FA не включена');
  if (!(await verifyPassword(password, row.password_hash))) throw new AppError(400, 'INVALID_PASSWORD', 'Неверный пароль');
  if (!verifyTotp(row.totp_secret, code)) throw new AppError(400, 'INVALID_CODE', 'Неверный код подтверждения');
  await execute(`UPDATE users SET totp_secret = NULL, totp_enabled = false, updated_at = now() WHERE id = $1`, [userId]);
}

export async function touchSession(sessionId: string): Promise<void> {
  await execute(`UPDATE sessions SET last_used_at = now() WHERE id = $1`, [sessionId]);
}
