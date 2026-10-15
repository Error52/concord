import { z } from 'zod';
import { validate, type Router } from '../http/router.js';
import * as userService from '../services/userService.js';
import * as notifications from '../services/notificationService.js';
import * as search from '../services/searchService.js';
import * as messages from '../services/messageService.js';
import { readBody, MEDIA_MAX_BYTES } from '../services/mediaService.js';
import * as S from './schemas.js';

const imageField = z.enum(['avatar', 'banner', 'background']);

export function registerUsers(r: Router): void {
  r.get('/users/me', { allowUnverified: true }, async (ctx) => userService.me(ctx.user.id));

  r.patch('/users/me', { rateLimit: { name: 'profile', max: 30, windowSec: 60, by: 'user' } }, async (ctx) =>
    userService.updateProfile(ctx.user.id, validate(S.profilePatch, ctx.body)),
  );

  r.put('/users/me/:field', { allowUnverified: true, rawBody: true, rateLimit: { name: 'upload-media', max: 20, windowSec: 60, by: 'user' } }, async (ctx) => {
    const field = validate(imageField, ctx.params.field);
    return userService.setImage(ctx.user.id, field, await readBody(ctx.req, MEDIA_MAX_BYTES));
  });

  r.delete('/users/me/:field', {}, async (ctx) => userService.setImage(ctx.user.id, validate(imageField, ctx.params.field), null));

  r.patch('/users/me/status', {}, async (ctx) => {
    const body = validate(z.object({ status: z.enum(['online', 'idle', 'dnd', 'invisible']) }), ctx.body);
    return userService.setStatus(ctx.user.id, body.status);
  });

  r.get('/users/:id', {}, async (ctx) => userService.profileFor(validate(S.uuid, ctx.params.id), ctx.user.id));

  r.get('/notifications', {}, async (ctx) => notifications.list(ctx.user.id));
  r.post('/notifications/read', {}, async (ctx) => {
    const body = validate(z.object({ ids: z.union([z.array(S.uuid).max(200), z.literal('all')]) }), ctx.body);
    return notifications.markRead(ctx.user.id, body.ids);
  });
  r.delete('/notifications', {}, async (ctx) => {
    return notifications.clear(ctx.user.id);
  });

  r.get('/bookmarks', {}, async (ctx) => messages.bookmarks(ctx.user.id));

  r.get('/search', { rateLimit: { name: 'search', max: 60, windowSec: 60, by: 'user' } }, async (ctx) =>
    search.quickSearch(ctx.user.id, (ctx.query.get('q') ?? '').slice(0, 100)),
  );

  r.get('/search/messages', { rateLimit: { name: 'search', max: 60, windowSec: 60, by: 'user' } }, async (ctx) => {
    const q = ctx.query;
    const parsed = validate(
      z.object({
        q: z.string().max(200).optional(),
        serverId: S.uuid.optional(),
        channelId: S.uuid.optional(),
        authorId: S.uuid.optional(),
        before: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
        after: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
        has: z.array(z.enum(['link', 'image', 'file', 'gif'])).optional(),
        offset: z.coerce.number().int().min(0).max(5000).optional(),
        limit: z.coerce.number().int().min(1).max(50).optional(),
      }),
      {
        q: q.get('q') || undefined,
        serverId: q.get('serverId') || undefined,
        channelId: q.get('channelId') || undefined,
        authorId: q.get('authorId') || undefined,
        before: q.get('before') || undefined,
        after: q.get('after') || undefined,
        has: q.getAll('has').length ? q.getAll('has') : undefined,
        offset: q.get('offset') || undefined,
        limit: q.get('limit') || undefined,
      },
    );
    return search.searchMessages(ctx.user.id, parsed);
  });
}
