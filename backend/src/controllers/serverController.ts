import { z } from 'zod';
import { Reply, validate, type Router } from '../http/router.js';
import * as servers from '../services/serverService.js';
import * as badges from '../services/badgeService.js';
import * as auditLog from '../services/auditService.js';
import * as voice from '../services/voiceService.js';
import { requirePerm } from '../services/permissionService.js';
import { Perm } from '../models/permissions.js';
import { readBody, MEDIA_MAX_BYTES } from '../services/mediaService.js';
import * as S from './schemas.js';

export function registerServers(r: Router): void {
  r.get('/servers', {}, async (ctx) => servers.listMine(ctx.user.id));
  r.post('/servers', { rateLimit: { name: 'server-create', max: 10, windowSec: 3600, by: 'user' } }, async (ctx) =>
    new Reply(201, await servers.create(ctx.user.id, validate(S.serverCreate, ctx.body))),
  );
  r.get('/servers/discover', {}, async (ctx) => servers.discover(ctx.query.get('q') ?? undefined));
  r.get('/servers/:id', {}, async (ctx) => servers.getFull(validate(S.uuid, ctx.params.id), ctx.user.id));
  r.patch('/servers/:id', {}, async (ctx) => servers.update(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.serverPatch, ctx.body)));
  r.delete('/servers/:id', {}, async (ctx) => {
    await servers.remove(validate(S.uuid, ctx.params.id), ctx.user.id);
    return new Reply(204, undefined);
  });
  r.put('/servers/:id/:field', { rawBody: true, rateLimit: { name: 'upload-media', max: 20, windowSec: 60, by: 'user' } }, async (ctx) => {
    const field = validate(z.enum(['icon', 'banner']), ctx.params.field);
    return servers.setImage(validate(S.uuid, ctx.params.id), ctx.user.id, field, await readBody(ctx.req, MEDIA_MAX_BYTES));
  });
  r.delete('/servers/:id/:field', {}, async (ctx) =>
    servers.setImage(validate(S.uuid, ctx.params.id), ctx.user.id, validate(z.enum(['icon', 'banner']), ctx.params.field), null),
  );
  r.post('/servers/:id/join', {}, async (ctx) => servers.joinPublic(validate(S.uuid, ctx.params.id), ctx.user.id));
  r.post('/servers/:id/leave', {}, async (ctx) => {
    await servers.leave(validate(S.uuid, ctx.params.id), ctx.user.id);
    return new Reply(204, undefined);
  });

  // channels
  r.post('/servers/:id/channels', {}, async (ctx) =>
    new Reply(201, await servers.createChannel(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.channelCreate, ctx.body))),
  );
  r.patch('/channels/:id', {}, async (ctx) => servers.updateChannel(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.channelPatch, ctx.body)));
  r.delete('/channels/:id', {}, async (ctx) => {
    await servers.deleteChannel(validate(S.uuid, ctx.params.id), ctx.user.id);
    return new Reply(204, undefined);
  });

  // roles
  r.post('/servers/:id/roles', {}, async (ctx) =>
    new Reply(201, await servers.createRole(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.roleCreate, ctx.body))),
  );
  r.patch('/servers/:id/roles/:roleId', {}, async (ctx) => {
    await servers.updateRole(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.roleId), validate(S.rolePatch, ctx.body));
    return new Reply(204, undefined);
  });
  r.delete('/servers/:id/roles/:roleId', {}, async (ctx) => {
    await servers.deleteRole(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.roleId));
    return new Reply(204, undefined);
  });

  // members & moderation
  const reason = z.object({ reason: z.string().max(512).optional() });
  r.put('/servers/:id/members/:userId/roles', {}, async (ctx) => {
    const body = validate(z.object({ roleIds: z.array(S.uuid).max(50) }), ctx.body);
    return servers.setMemberRoles(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.userId), body.roleIds);
  });
  r.patch('/servers/:id/members/:userId', {}, async (ctx) => {
    const body = validate(z.object({ nickname: z.string().max(32).nullable() }), ctx.body);
    return servers.setNickname(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.userId), body.nickname);
  });
  r.post('/servers/:id/members/:userId/kick', {}, async (ctx) => {
    await servers.kick(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.userId), validate(reason, ctx.body).reason);
    return new Reply(204, undefined);
  });
  r.post('/servers/:id/members/:userId/timeout', {}, async (ctx) => {
    const body = validate(z.object({ minutes: z.number().int().min(0).max(40320), reason: z.string().max(512).optional() }), ctx.body);
    return servers.timeout(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.userId), body.minutes, body.reason);
  });
  r.get('/servers/:id/bans', {}, async (ctx) => servers.listBans(validate(S.uuid, ctx.params.id), ctx.user.id));
  r.put('/servers/:id/bans/:userId', {}, async (ctx) => {
    await servers.ban(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.userId), validate(reason, ctx.body).reason);
    return new Reply(204, undefined);
  });
  r.delete('/servers/:id/bans/:userId', {}, async (ctx) => {
    await servers.unban(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.userId));
    return new Reply(204, undefined);
  });

  // voice moderation
  r.patch('/servers/:id/voice/:userId', {}, async (ctx) => {
    const body = validate(z.object({ serverMute: z.boolean().optional(), serverDeaf: z.boolean().optional(), channelId: S.uuid.optional() }), ctx.body);
    const serverId = validate(S.uuid, ctx.params.id);
    const target = validate(S.uuid, ctx.params.userId);
    if (body.channelId) {
      await voice.moveUser(ctx.user.id, serverId, target, body.channelId);
      return new Reply(204, undefined);
    }
    return voice.setServerMute(ctx.user.id, serverId, target, body);
  });
  r.delete('/servers/:id/voice/:userId', {}, async (ctx) => {
    await voice.disconnectUser(ctx.user.id, validate(S.uuid, ctx.params.id), validate(S.uuid, ctx.params.userId));
    return new Reply(204, undefined);
  });

  // invites
  r.post('/servers/:id/invites', { rateLimit: { name: 'invite', max: 30, windowSec: 3600, by: 'user' } }, async (ctx) =>
    new Reply(201, await servers.createInvite(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.inviteCreate, ctx.body))),
  );
  r.get('/servers/:id/invites', {}, async (ctx) => servers.listInvites(validate(S.uuid, ctx.params.id), ctx.user.id));
  r.get('/invites/:code', { auth: 'optional', rateLimit: { name: 'invite-view', max: 60, windowSec: 60 } }, async (ctx) =>
    servers.previewInvite(validate(z.string().regex(/^[A-Za-z0-9]{4,16}$/), ctx.params.code)),
  );
  r.post('/invites/:code', { rateLimit: { name: 'invite-use', max: 20, windowSec: 60, by: 'user' } }, async (ctx) =>
    servers.acceptInvite(validate(z.string().regex(/^[A-Za-z0-9]{4,16}$/), ctx.params.code), ctx.user.id),
  );
  r.delete('/invites/:code', {}, async (ctx) => {
    await servers.deleteInvite(validate(z.string().regex(/^[A-Za-z0-9]{4,16}$/), ctx.params.code), ctx.user.id);
    return new Reply(204, undefined);
  });

  // audit log
  r.get('/servers/:id/audit-log', {}, async (ctx) => {
    const serverId = validate(S.uuid, ctx.params.id);
    await requirePerm(serverId, ctx.user.id, Perm.VIEW_AUDIT_LOG, 'Нет доступа к журналу аудита');
    return auditLog.list(serverId, ctx.query.get('before') ?? undefined);
  });

  // badges
  r.get('/servers/:id/badges', {}, async (ctx) => badges.list(validate(S.uuid, ctx.params.id), ctx.user.id));
  r.post('/servers/:id/badges', {}, async (ctx) =>
    new Reply(201, await badges.create(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.badgeInput, ctx.body))),
  );
  r.patch('/servers/:id/badges/:badgeId', {}, async (ctx) =>
    badges.update(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.badgeId), validate(S.badgeInput.partial(), ctx.body)),
  );
  r.put('/servers/:id/badges/:badgeId/icon', { rawBody: true }, async (ctx) =>
    badges.setIcon(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.badgeId), await readBody(ctx.req, MEDIA_MAX_BYTES)),
  );
  r.delete('/servers/:id/badges/:badgeId', {}, async (ctx) => {
    await badges.remove(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.badgeId));
    return new Reply(204, undefined);
  });
  r.put('/servers/:id/badges/:badgeId/users/:userId', {}, async (ctx) => {
    await badges.grant(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.badgeId), validate(S.uuid, ctx.params.userId));
    return new Reply(204, undefined);
  });
  r.delete('/servers/:id/badges/:badgeId/users/:userId', {}, async (ctx) => {
    await badges.revoke(validate(S.uuid, ctx.params.id), ctx.user.id, validate(S.uuid, ctx.params.badgeId), validate(S.uuid, ctx.params.userId));
    return new Reply(204, undefined);
  });
}
