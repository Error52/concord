import { z } from 'zod';
import { RAW, Reply, validate, type Router } from '../http/router.js';
import * as messages from '../services/messageService.js';
import * as attachments from '../services/attachmentService.js';
import * as dms from '../services/dmService.js';
import * as friends from '../services/friendService.js';
import * as gifs from '../services/gif/index.js';
import { parseCookies } from '../http/cookies.js';
import { verifyJwt } from '../auth/jwt.js';
import { config } from '../config.js';
import { Errors } from '../http/errors.js';
import { MEDIA_COOKIE } from './authController.js';
import * as S from './schemas.js';
import { queryOne } from '../db/pool.js';

export function registerMessages(r: Router): void {
  const sendLimit = { name: 'send', max: 10, windowSec: 5, by: 'user' as const };

  r.get('/channels/:id/messages', {}, async (ctx) =>
    messages.list(validate(S.uuid, ctx.params.id), ctx.user.id, {
      before: ctx.query.get('before') ? validate(S.snowflake, ctx.query.get('before')) : undefined,
      after: ctx.query.get('after') ? validate(S.snowflake, ctx.query.get('after')) : undefined,
      around: ctx.query.get('around') ? validate(S.snowflake, ctx.query.get('around')) : undefined,
      limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
    }),
  );

  r.post('/channels/:id/messages', { rateLimit: sendLimit }, async (ctx) => {
    const body = validate(S.messageCreate, ctx.body);
    const gif = body.gif ? gifs.validateEmbed(body.gif) : null;
    return new Reply(201, await messages.create(validate(S.uuid, ctx.params.id), ctx.user.id, { ...body, gif }));
  });

  r.get('/channels/:id/pins', {}, async (ctx) => messages.pins(validate(S.uuid, ctx.params.id), ctx.user.id));

  r.post('/channels/:id/read', {}, async (ctx) => {
    const body = validate(z.object({ messageId: S.snowflake }), ctx.body);
    await messages.markRead(validate(S.uuid, ctx.params.id), ctx.user.id, body.messageId);
    return new Reply(204, undefined);
  });
  r.post('/channels/:id/unread', {}, async (ctx) => {
    const body = validate(z.object({ messageId: S.snowflake }), ctx.body);
    await messages.markUnread(validate(S.uuid, ctx.params.id), ctx.user.id, body.messageId);
    return new Reply(204, undefined);
  });
  r.post('/channels/:id/typing', { rateLimit: { name: 'typing', max: 30, windowSec: 10, by: 'user' } }, async (ctx) => {
    await messages.typing(validate(S.uuid, ctx.params.id), ctx.user.id);
    return new Reply(204, undefined);
  });

  r.patch('/messages/:id', { rateLimit: sendLimit }, async (ctx) =>
    messages.edit(validate(S.snowflake, ctx.params.id), ctx.user.id, validate(S.messageEdit, ctx.body).content),
  );
  r.get('/messages/:id/thread', {}, async (ctx) => messages.thread(validate(S.snowflake, ctx.params.id), ctx.user.id));
  r.delete('/messages/:id', {}, async (ctx) => {
    await messages.remove(validate(S.snowflake, ctx.params.id), ctx.user.id);
    return new Reply(204, undefined);
  });
  r.put('/messages/:id/reactions/:emoji', { rateLimit: { name: 'react', max: 20, windowSec: 5, by: 'user' } }, async (ctx) => {
    await messages.react(validate(S.snowflake, ctx.params.id), ctx.user.id, ctx.params.emoji ?? '', true);
    return new Reply(204, undefined);
  });
  r.delete('/messages/:id/reactions/:emoji', {}, async (ctx) => {
    await messages.react(validate(S.snowflake, ctx.params.id), ctx.user.id, ctx.params.emoji ?? '', false);
    return new Reply(204, undefined);
  });
  r.put('/messages/:id/pin', {}, async (ctx) => messages.setPinned(validate(S.snowflake, ctx.params.id), ctx.user.id, true));
  r.delete('/messages/:id/pin', {}, async (ctx) => messages.setPinned(validate(S.snowflake, ctx.params.id), ctx.user.id, false));
  r.put('/messages/:id/bookmark', {}, async (ctx) => {
    await messages.bookmark(validate(S.snowflake, ctx.params.id), ctx.user.id, true);
    return new Reply(204, undefined);
  });
  r.delete('/messages/:id/bookmark', {}, async (ctx) => {
    await messages.bookmark(validate(S.snowflake, ctx.params.id), ctx.user.id, false);
    return new Reply(204, undefined);
  });

  // ── attachments ──
  r.post('/channels/:id/attachments', { rawBody: true, rateLimit: { name: 'upload', max: 30, windowSec: 60, by: 'user' } }, async (ctx) =>
    new Reply(201, await attachments.upload(ctx.req, validate(S.uuid, ctx.params.id), ctx.user.id)),
  );
  r.delete('/attachments/:id', {}, async (ctx) => {
    await attachments.remove(validate(S.uuid, ctx.params.id), ctx.user.id);
    return new Reply(204, undefined);
  });
  // Served with the media cookie: <img>/<video> cannot send Authorization headers.
  r.get('/attachments/:id/:name', { auth: 'none' }, async (ctx) => {
    const token = parseCookies(ctx.req)[MEDIA_COOKIE];
    const claims = token ? verifyJwt<{ sub: string; sid: string; typ: string }>(token, config.JWT_SECRET) : null;
    if (!claims || claims.typ !== 'media' || typeof claims.sub!=='string' || typeof claims.sid!=='string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sid)) throw Errors.unauthorized();
    if(!S.uuid.safeParse(claims.sub).success)throw Errors.unauthorized();
    // Media cookies live longer than access-token revocation cache entries. Check the durable session family.
    // Rotation keeps downloads working; logout, password reset and explicit revocation invalidate them.
    const active=await queryOne<{id:string}>(`SELECT s.id FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.user_id=$1 AND s.family_id=(SELECT family_id FROM sessions WHERE id=$2 AND user_id=$1)
        AND s.revoked_at IS NULL AND s.expires_at>now() AND ($3::boolean=false OR u.email_verified_at IS NOT NULL
          OR ($4::boolean AND (u.local_verified_at IS NOT NULL OR u.is_platform_admin))) LIMIT 1`,
      [claims.sub,claims.sid,config.REQUIRE_EMAIL_VERIFICATION,config.ACCOUNT_VERIFICATION_MODE==='secret-word']);
    if(!active)throw Errors.unauthorized();
    await attachments.serve(ctx.req, ctx.res, ctx.params.id ?? '', claims.sub, ctx.params.name === 'preview');
    return RAW;
  });
  r.get('/media/:kind/:file', { auth: 'none' }, async (ctx) => {
    await attachments.serveMedia(ctx.res, `media/${ctx.params.kind}/${ctx.params.file}`);
    return RAW;
  });

  // ── DMs ──
  r.get('/dm', {}, async (ctx) => dms.list(ctx.user.id));
  r.post('/dm', {}, async (ctx) => dms.open(ctx.user.id, validate(z.object({ recipientId: S.uuid }), ctx.body).recipientId));
  r.get('/dm/:id', {}, async (ctx) => dms.get(validate(S.uuid, ctx.params.id), ctx.user.id));
  r.delete('/dm/:id', {}, async (ctx) => {
    await dms.hide(validate(S.uuid, ctx.params.id), ctx.user.id);
    return new Reply(204, undefined);
  });
  r.get('/dm/:id/messages', {}, async (ctx) =>
    messages.list(validate(S.uuid, ctx.params.id), ctx.user.id, {
      before: ctx.query.get('before') ? validate(S.snowflake, ctx.query.get('before')) : undefined,
      limit: ctx.query.get('limit') ? Number(ctx.query.get('limit')) : undefined,
    }),
  );
  r.post('/dm/:id/messages', { rateLimit: sendLimit }, async (ctx) => {
    const body = validate(S.messageCreate, ctx.body);
    const gif = body.gif ? gifs.validateEmbed(body.gif) : null;
    return new Reply(201, await messages.create(validate(S.uuid, ctx.params.id), ctx.user.id, { ...body, gif }));
  });

  // ── friends ──
  r.get('/friends', {}, async (ctx) => friends.list(ctx.user.id));
  r.post('/friends/request', { rateLimit: { name: 'friend-req', max: 20, windowSec: 600, by: 'user' } }, async (ctx) => {
    const body = validate(z.object({ username: S.username.optional(), userId: S.uuid.optional() }).refine((b) => b.username || b.userId, 'Укажите пользователя'), ctx.body);
    return friends.request(ctx.user.id, body);
  });
  r.post('/friends/:id/accept', {}, async (ctx) => friends.accept(ctx.user.id, validate(S.uuid, ctx.params.id)));
  r.delete('/friends/:id', {}, async (ctx) => friends.remove(ctx.user.id, validate(S.uuid, ctx.params.id)));
  r.put('/blocks/:id', {}, async (ctx) => friends.block(ctx.user.id, validate(S.uuid, ctx.params.id)));
  r.delete('/blocks/:id', {}, async (ctx) => friends.unblock(ctx.user.id, validate(S.uuid, ctx.params.id)));

  // ── GIFs (API key stays on the backend) ──
  r.get('/gifs/local/:filename',{auth:'none'},async ctx=>{
    const bytes=gifs.localGifBytes(ctx.params.filename??'');
    if(!bytes)throw Errors.notFound('GIF');
    ctx.res.writeHead(200,{'Content-Type':'image/gif','Content-Length':bytes.length,'Cache-Control':'public, max-age=31536000, immutable'});
    ctx.res.end(bytes);return RAW;
  });
  const gifLimit = { name: 'gif', max: 60, windowSec: 60, by: 'user' as const };
  const locale = (q: URLSearchParams): string => (/^[a-z]{2}(_[A-Z]{2})?$/.test(q.get('locale') ?? '') ? q.get('locale')! : 'ru_RU');
  r.get('/gifs/trending', { rateLimit: gifLimit }, async (ctx) => gifs.trending(ctx.query.get('pos'), locale(ctx.query)));
  r.get('/gifs/search', { rateLimit: gifLimit }, async (ctx) => {
    const q = validate(z.string().trim().min(1).max(100), ctx.query.get('q') ?? '');
    return gifs.search(q, ctx.query.get('pos'), locale(ctx.query));
  });
  r.get('/gifs/categories', { rateLimit: gifLimit }, async (ctx) => gifs.categories(locale(ctx.query)));
}
