import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { Reply, validate, type Ctx, type Router } from '../http/router.js';
import { parseCookies, serializeCookie } from '../http/cookies.js';
import { config } from '../config.js';
import { signJwt } from '../auth/jwt.js';
import * as auth from '../services/authService.js';
import * as S from './schemas.js';
import { queryOne } from '../db/pool.js';
import { Errors } from '../http/errors.js';
import {openMail} from '../services/mailCrypto.js';

export const REFRESH_COOKIE = 'cc_refresh';
export const MEDIA_COOKIE = 'cc_media';

/** Refresh token (httpOnly, path-scoped to the auth endpoints) + media cookie for authenticated file downloads. */
function sessionCookies(userId: string, tokens: auth.SessionTokens): string[] {
  const secure = config.COOKIE_SECURE;
  const media = signJwt({ sub: userId, sid: tokens.refreshToken.split('.')[0], typ: 'media' }, config.JWT_SECRET, tokens.refreshMaxAgeSec);
  return [
    serializeCookie(REFRESH_COOKIE, tokens.refreshToken, { path: '/api/auth', maxAgeSec: tokens.refreshMaxAgeSec, secure }),
    serializeCookie(MEDIA_COOKIE, media, { path: '/api/attachments', maxAgeSec: tokens.refreshMaxAgeSec, secure }),
  ];
}

function clearCookies(): string[] {
  return [
    serializeCookie(REFRESH_COOKIE, '', { path: '/api/auth', maxAgeSec: 0, secure: config.COOKIE_SECURE }),
    serializeCookie(MEDIA_COOKIE, '', { path: '/api/attachments', maxAgeSec: 0, secure: config.COOKIE_SECURE }),
  ];
}

const client = (ctx: Ctx): auth.ClientInfo => ({ ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });

function userIdFromAccess(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string };
  return payload.sub;
}

export function registerAuth(r: Router): void {
  const strict = { name: 'auth', max: 10, windowSec: 60 };
  r.get('/auth/options',{auth:'none'},()=>({verificationMode:config.ACCOUNT_VERIFICATION_MODE,recoveryWordMinLength:12,recoveryWordMaxLength:256}));
  r.post('/auth/recovery-word/reset',{auth:'none',csrf:true,rateLimit:{name:'recovery-word-ip',max:5,windowSec:900}},async ctx=>{
    const body=validate(z.object({identifier:z.string().trim().min(2).max(254),recoveryWord:S.recoveryWord,newPassword:S.password,newRecoveryWord:S.recoveryWord,totpCode:z.string().regex(/^\d{6}$/).optional()}),ctx.body);
    await auth.resetByRecoveryWord(body);return new Reply(200,{ok:true},{'Set-Cookie':clearCookies()});
  });
  r.post('/auth/recovery-word',{rateLimit:{name:'recovery-word-setup',max:5,windowSec:900,by:'user'}},async ctx=>{
    const body=validate(z.object({currentPassword:z.string().min(1).max(128),recoveryWord:S.recoveryWord,oldRecoveryWord:S.recoveryWord.optional(),totpCode:z.string().regex(/^\d{6}$/).optional()}),ctx.body);
    await auth.setRecoveryWord(ctx.user.id,ctx.user.sessionId,body);return {ok:true};
  });

  r.post('/auth/register', { auth: 'none', csrf: true, rateLimit: { name: 'register', max: 5, windowSec: 3600 } }, async (ctx) => {
    const body = validate(S.register, ctx.body);
    const { user, tokens } = await auth.register(body, client(ctx));
    return new Reply(201, { user, accessToken: tokens.accessToken }, { 'Set-Cookie': sessionCookies(user.id, tokens) });
  });

  r.post('/auth/login', { auth: 'none', csrf: true, rateLimit: strict }, async (ctx) => {
    const body = validate(S.login, ctx.body);
    const res = await auth.login(body.identifier??body.email!, body.password, client(ctx));
    if (res.kind === 'mfa') return { mfaRequired: true, ticket: res.ticket };
    return new Reply(200, { user: res.user, accessToken: res.tokens.accessToken }, { 'Set-Cookie': sessionCookies(res.user.id, res.tokens) });
  });

  r.post('/auth/mfa', { auth: 'none', csrf: true, rateLimit: strict }, async (ctx) => {
    const body = validate(S.mfa, ctx.body);
    const { user, tokens } = await auth.completeMfa(body.ticket, body.code, client(ctx));
    return new Reply(200, { user, accessToken: tokens.accessToken }, { 'Set-Cookie': sessionCookies(user.id, tokens) });
  });

  r.post('/auth/refresh', { auth: 'none', csrf: true, rateLimit: { name: 'refresh', max: 60, windowSec: 60 } }, async (ctx) => {
    try {
      const tokens = await auth.refresh(parseCookies(ctx.req)[REFRESH_COOKIE], client(ctx));
      return new Reply(200, { accessToken: tokens.accessToken }, { 'Set-Cookie': sessionCookies(userIdFromAccess(tokens.accessToken), tokens) });
    } catch (err) {
      if ((err as {status?:number}).status === 401) clearOn(ctx.res);
      throw err;
    }
  });

  r.post('/auth/logout', { auth: 'optional', csrf: true }, async (ctx) => {
    if (ctx.user) await auth.logout(ctx.user.sessionId);
    else await auth.logoutByCookie(parseCookies(ctx.req)[REFRESH_COOKIE]);
    return new Reply(204, undefined, { 'Set-Cookie': clearCookies() });
  });

  r.post('/auth/email/resend', { rateLimit: {name:'verify-resend',max:5,windowSec:3600,by:'user'} }, async(ctx)=>{
    await auth.resendEmailVerification(ctx.user.id);
    return {ok:true};
  });
  r.get('/auth/email/demo', {rateLimit:{name:'demo-mail',max:30,windowSec:60,by:'user'}}, async(ctx)=>{
    if(!config.DEMO_MAILBOX||config.ACCOUNT_VERIFICATION_MODE!=='email')throw Errors.notFound('Демопочта');
    // No address/ID parameter, no reset links, no HTML. Only this authenticated user's live verification link.
    const row=await queryOne<{text_body:string;html_body:string}>(`SELECT e.text_body,e.html_body FROM outbound_emails e
      JOIN users u ON u.id=e.user_id
      WHERE e.user_id=$1 AND u.email_verified_at IS NULL AND e.created_at>now()-interval '24 hours'
        AND e.subject='Concord — подтвердите почту'
      ORDER BY e.created_at DESC LIMIT 1`,[ctx.user.id]);
    const candidate=row?openMail(row).text.match(/https?:\/\/[^\s]+\/verify-email\?token=([^\s]+)/)?.[1]:undefined;
    const valid=candidate?await queryOne<{id:string}>(`SELECT id FROM email_verifications WHERE user_id=$1
      AND token_hash=encode(sha256($2::bytea),'hex') AND used_at IS NULL AND expires_at>now()`,[ctx.user.id,Buffer.from(candidate)]):null;
    return {verificationPath:valid?`/verify-email?token=${encodeURIComponent(candidate!)}`:null};
  });
  r.post('/auth/email/confirm', {auth:'none',csrf:true,rateLimit:{name:'verify-confirm',max:20,windowSec:60}}, async(ctx)=>{
    const body=validate(z.object({token:z.string().min(20).max(200)}),ctx.body);
    return auth.confirmEmail(body.token);
  });

  r.post('/auth/password/forgot', { auth: 'none', rateLimit: { name: 'forgot', max: 5, windowSec: 3600 } }, async (ctx) => {
    const body = validate(z.object({ email: S.email }), ctx.body);
    await auth.requestPasswordReset(body.email);
    return { ok: true };
  });

  r.post('/auth/password/reset', { auth: 'none', rateLimit: strict }, async (ctx) => {
    const body = validate(z.object({ token: z.string().min(20).max(200), password: S.password }), ctx.body);
    await auth.confirmPasswordReset(body.token, body.password);
    return { ok: true };
  });

  r.post('/auth/password/change', { rateLimit: { ...strict, by: 'user' } }, async (ctx) => {
    const body = validate(z.object({ currentPassword: z.string().min(1), newPassword: S.password }), ctx.body);
    await auth.changePassword(ctx.user.id, ctx.user.sessionId, body.currentPassword, body.newPassword);
    return { ok: true };
  });

  r.get('/auth/sessions', {}, async (ctx) => auth.listSessions(ctx.user.id, ctx.user.sessionId));
  r.delete('/auth/sessions/:id', {}, async (ctx) => {
    await auth.revokeSession(ctx.user.id, validate(S.uuid, ctx.params.id));
    return new Reply(204, undefined);
  });

  r.post('/auth/2fa/setup', {}, async (ctx) => auth.beginTotpSetup(ctx.user.id));
  r.post('/auth/2fa/enable', { rateLimit: { ...strict, by: 'user' } }, async (ctx) => {
    const body = validate(z.object({ code: z.string().regex(/^\d{6}$/) }), ctx.body);
    await auth.enableTotp(ctx.user.id, body.code);
    return { ok: true };
  });
  r.post('/auth/2fa/disable', { rateLimit: { ...strict, by: 'user' } }, async (ctx) => {
    const body = validate(z.object({ password: z.string().min(1), code: z.string().regex(/^\d{6}$/) }), ctx.body);
    await auth.disableTotp(ctx.user.id, body.password, body.code);
    return { ok: true };
  });
}

function clearOn(res: ServerResponse): void {
  res.setHeader('Set-Cookie', clearCookies());
}
