import { cleanupOrphans } from './services/attachmentService.js';
import { execute, query } from './db/pool.js';
import { redis } from './redis.js';
import { listParticipants,listRooms, type LkParticipant } from './webrtc/livekit.js';
import { leaveClient,acceptParticipant } from './services/voiceService.js';
import { log } from './logger.js';
import { deliverPendingMail } from './services/mailOutbox.js';

/**
 * Periodic maintenance. Each job takes a short Redis lock so only one backend replica runs it.
 */
export async function withLock(name: string, ttlSec: number, fn: () => Promise<void>): Promise<void> {
  try {
    if ((await redis.set(`lock:job:${name}`, '1', 'EX', ttlSec, 'NX')) !== 'OK') return;
    await fn();
  } catch (err) {
    log.warn('job failed', { job: name, err });
  }
}

async function scanKeys(pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    out.push(...batch);
    cursor = next;
  } while (cursor !== '0');
  return out;
}

/** Reconciles Redis voice occupancy with what the SFU actually has (covers missed webhooks). */
export async function reconcileVoice(): Promise<void> {
  const keys = await scanKeys('voice:room:*');
  const rooms=await listRooms();
  for (const key of new Set([...keys,...rooms.filter(r=>/^ch_[0-9a-f-]{36}$/.test(r)).map(r=>`voice:room:${r.slice(3)}`)])) {
    const channelId = key.slice('voice:room:'.length);
    let participants:LkParticipant[];
    try {
      participants=await listParticipants(`ch_${channelId}`);
    } catch {
      return; // SFU unreachable: do not wipe state on a transient failure
    }
    const identities=new Set(participants.map(p=>p.identity));
    const tracked = await redis.smembers(key);
    for (const userId of tracked) if (!identities.has(userId)) await leaveClient(userId, channelId);
    for (const participant of participants) await acceptParticipant(participant.identity, channelId,{participantSid:participant.sid,metadata:participant.metadata});
  }
}

export function startJobs(): () => void {
  let sending = false;
  const mailTick = async () => {
    if (sending) return;
    sending = true;
    try { await deliverPendingMail(); } catch(err) { log.warn('mail worker failed', {err}); }
    finally { sending = false; }
  };
  const timers = [
    setInterval(() => void mailTick(), 1000),
    setInterval(() => void withLock('orphans', 300, cleanupOrphans), 10 * 60_000),
    setInterval(() => void withLock('voice-reconcile', 25, reconcileVoice), 30_000),
    setInterval(
      () =>
        void withLock('expire', 300, async () => {
          await execute(`DELETE FROM sessions WHERE expires_at < now() - interval '7 days'`);
          await execute(`DELETE FROM password_resets WHERE expires_at < now() - interval '1 day'`);
          await execute(`DELETE FROM email_verifications WHERE expires_at < now() - interval '1 day'`);
          await execute(`DELETE FROM outbound_emails WHERE created_at < now() - interval '7 days'`);
          await execute(`DELETE FROM invites WHERE expires_at < now() - interval '7 days'`);
          const old = await query(`DELETE FROM notifications WHERE created_at < now() - interval '60 days' RETURNING id`);
          if (old.length) log.info('old notifications removed', { count: old.length });
        }),
      60 * 60_000,
    ),
  ];
  return () => timers.forEach(clearInterval);
}
