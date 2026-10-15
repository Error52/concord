import { z } from 'zod';
import { Reply, validate, type Router } from '../http/router.js';
import * as admin from '../services/adminService.js';
import { readBody, MEDIA_MAX_BYTES } from '../services/mediaService.js';
import * as S from './schemas.js';

/** Platform admin panel. Every handler checks users.is_platform_admin on the backend. */
export function registerAdmin(r: Router): void {
  r.get('/admin/stats', {}, async (ctx) => admin.stats(ctx.user.id));

  r.get('/admin/badges', {}, async (ctx) => admin.listBadges(ctx.user.id));
  r.post('/admin/badges', {}, async (ctx) => new Reply(201, await admin.createBadge(ctx.user.id, validate(S.badgeInput, ctx.body))));
  r.patch('/admin/badges/:badgeId', {}, async (ctx) =>
    admin.updateBadge(ctx.user.id, validate(S.uuid, ctx.params.badgeId), validate(S.badgeInput.partial(), ctx.body)),
  );
  r.put('/admin/badges/:badgeId/icon', { rawBody: true, rateLimit: { name: 'upload-media', max: 20, windowSec: 60, by: 'user' } }, async (ctx) =>
    admin.setBadgeIcon(ctx.user.id, validate(S.uuid, ctx.params.badgeId), await readBody(ctx.req, MEDIA_MAX_BYTES)),
  );
  r.delete('/admin/badges/:badgeId/icon', {}, async (ctx) => admin.setBadgeIcon(ctx.user.id, validate(S.uuid, ctx.params.badgeId), null));
  r.delete('/admin/badges/:badgeId', {}, async (ctx) => {
    await admin.deleteBadge(ctx.user.id, validate(S.uuid, ctx.params.badgeId));
    return new Reply(204, undefined);
  });
  r.get('/admin/badges/:badgeId/users', {}, async (ctx) => admin.badgeHolders(ctx.user.id, validate(S.uuid, ctx.params.badgeId)));
  r.put('/admin/badges/:badgeId/users/:userId', {}, async (ctx) => {
    await admin.grantBadge(ctx.user.id, validate(S.uuid, ctx.params.badgeId), validate(S.uuid, ctx.params.userId));
    return new Reply(204, undefined);
  });
  r.delete('/admin/badges/:badgeId/users/:userId', {}, async (ctx) => {
    await admin.revokeBadge(ctx.user.id, validate(S.uuid, ctx.params.badgeId), validate(S.uuid, ctx.params.userId));
    return new Reply(204, undefined);
  });

  r.get('/admin/users', { rateLimit: { name: 'admin-search', max: 120, windowSec: 60, by: 'user' } }, async (ctx) =>
    admin.searchUsers(ctx.user.id, (ctx.query.get('q') ?? '').slice(0, 100)),
  );
  r.put('/admin/users/:userId/admin', {}, async (ctx) => {
    const body = validate(z.object({ value: z.boolean() }), ctx.body);
    await admin.setPlatformAdmin(ctx.user.id, validate(S.uuid, ctx.params.userId), body.value);
    return new Reply(204, undefined);
  });

  r.get('/admin/audit-log', {}, async (ctx) => admin.auditLog(ctx.user.id));
}
