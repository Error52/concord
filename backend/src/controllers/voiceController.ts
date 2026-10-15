import { RAW, Reply, sendJson, validate, type Router } from '../http/router.js';
import * as voice from '../services/voiceService.js';
import { verifyWebhook } from '../webrtc/livekit.js';
import { readBody } from '../services/mediaService.js';
import { Errors } from '../http/errors.js';
import { requireChannel } from '../services/permissionService.js';
import { log } from '../logger.js';
import * as S from './schemas.js';

export function registerVoice(r: Router): void {
  /** Issues a short-lived SFU token; permissions (CONNECT/SPEAK/VIDEO, server mute) are baked into the grant. */
  r.post('/voice/:channelId/token', { rateLimit: { name: 'voice-token', max: 30, windowSec: 60, by: 'user' } }, async (ctx) =>
    voice.join(ctx.user.id, validate(S.uuid, ctx.params.channelId)),
  );

  r.get('/voice/states/:channelId', {}, async (ctx) => {
    const channelId = validate(S.uuid, ctx.params.channelId);
    await requireChannel(channelId, ctx.user.id);
    return voice.statesForChannels([channelId]);
  });

  // LiveKit → backend. Authenticated by the signed JWT in the Authorization header.
  r.post('/webhooks/livekit', { auth: 'none', rawBody: true }, async (ctx) => {
    const body = await readBody(ctx.req, 256 * 1024);
    const event = verifyWebhook(body, ctx.req.headers.authorization);
    if (!event) throw Errors.unauthorized('Invalid webhook signature');
    log.debug('livekit webhook', { event: event.event, room: event.room?.name });
    await voice.handleWebhook(event);
    sendJson(ctx.res, 200, { ok: true });
    return RAW;
  });

  r.get('/health', { auth: 'none' }, async () => new Reply(200, { ok: true }));
}
