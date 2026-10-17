import type { IncomingMessage, Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import { redisSub } from '../redis.js';
import { log } from '../logger.js';
import { corsOrigins, config } from '../config.js';
import { verifyAccessToken } from '../middleware/auth.js';
import { BUS_CHANNEL, emit, type BusMessage, type Dispatch } from './bus.js';
import { Ev, Op } from './events.js';
import * as presence from '../services/presenceService.js';
import * as users from '../repositories/userRepo.js';
import * as servers from '../services/serverService.js';
import * as dms from '../services/dmService.js';
import * as friends from '../services/friendService.js';
import * as messages from '../services/messageService.js';
import * as voice from '../services/voiceService.js';
import * as calls from '../services/callService.js';
import * as notifications from '../services/notificationService.js';
import { setStatus } from '../services/userService.js';
import { gifStatus } from '../services/gif/index.js';
import { query } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { rateLimit } from '../middleware/rateLimit.js';
import type { ChosenStatus } from '../models/dto.js';

/** Close codes understood by the client. */
export const Close = {
  AuthFailed: 4001,
  AuthTimeout: 4002,
  SessionRevoked: 4003,
  RateLimited: 4008,
  ServerShutdown: 4009,
} as const;

const HEARTBEAT_INTERVAL_MS = 25_000;
const AUTH_TIMEOUT_MS = 10_000;

interface Conn {
  id: string;
  ws: WebSocket;
  userId: string | null;
  sessionId: string | null;
  servers: Set<string>;
  alive: boolean;
  seq: number;
  ready: boolean;
  pending: Dispatch[];
}

const clientOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal(Op.Auth), d: z.object({ token: z.string().min(10).max(4096) }) }),
  z.object({ op: z.literal(Op.Heartbeat), d: z.object({ afk: z.boolean().optional() }).optional() }),
  z.object({ op: z.literal(Op.Typing), d: z.object({ channelId: z.string().uuid() }) }),
  z.object({
    op: z.literal(Op.VoiceState),
    d: z.object({
      channelId: z.string().uuid().nullable(),
      expectedChannelId:z.string().uuid().optional(),
      participantSid:z.string().min(1).max(128).optional(),
      selfMute: z.boolean().optional(),
      selfDeaf: z.boolean().optional(),
      camera: z.boolean().optional(),
      screen: z.boolean().optional(),
    }),
  }),
  z.object({ op: z.literal(Op.VoiceSpeaking), d: z.object({ speaking: z.boolean() }) }),
  z.object({ op: z.literal(Op.CallRing), d: z.object({ channelId: z.string().uuid(), video: z.boolean() }) }),
  z.object({ op: z.literal(Op.CallAccept), d: z.object({ channelId: z.string().uuid(),ringId:z.string().uuid().optional() }) }),
  z.object({ op: z.literal(Op.CallDecline), d: z.object({ channelId: z.string().uuid(),ringId:z.string().uuid().optional() }) }),
  z.object({ op: z.literal(Op.CallEnd), d: z.object({ channelId: z.string().uuid(), durationSec: z.number().finite().min(0).max(604800).nullable().optional() }) }),
  z.object({ op: z.literal(Op.SetStatus), d: z.object({ status: z.enum(['online', 'idle', 'dnd', 'invisible']) }) }),
]);

type ClientOp = z.infer<typeof clientOp>;

export class Gateway {
  private wss: WebSocketServer;
  private conns = new Map<string, Conn>();
  private byUser = new Map<string, Set<Conn>>();
  private byServer = new Map<string, Set<Conn>>();
  private bySession = new Map<string, Set<Conn>>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatWork: Promise<void> | null = null;
  private closingConnections = new Set<Promise<void>>();

  constructor(server: Server) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/gateway' && url.pathname !== '/api/gateway') return socket.destroy();
      if (!this.originAllowed(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // Non-browser clients (tests, bots) send no Origin; browsers always do.
    return !origin || corsOrigins.has(origin) || origin === config.APP_URL;
  }

  async start(): Promise<void> {
    await redisSub.subscribe(BUS_CHANNEL);
    redisSub.on('message', (_channel: string, raw: string) => {
      try {
        this.onBus(JSON.parse(raw) as BusMessage);
      } catch (err) {
        log.error('bad bus message', { err });
      }
    });
    this.heartbeatTimer = setInterval(() => {
      if (!this.heartbeatWork) this.heartbeatWork = this.sweep()
        .catch(err => log.warn('gateway heartbeat failed', {err}))
        .finally(() => {this.heartbeatWork = null;});
    }, HEARTBEAT_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const c of this.conns.values()) c.ws.close(Close.ServerShutdown, 'restart');
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    await this.heartbeatWork;
    // Socket closure precedes asynchronous presence cleanup and queued auth work.
    while (this.closingConnections.size) await Promise.all(this.closingConnections);
  }

  // ─────────────── bus fan-out ───────────────

  private onBus(msg: BusMessage): void {
    switch (msg.kind) {
      case 'event':
        this.dispatch(msg);
        break;
      case 'subscribe':
        for (const c of this.byUser.get(msg.userId) ?? []) this.subscribe(c, msg.serverId);
        break;
      case 'unsubscribe':
        for (const c of this.byUser.get(msg.userId) ?? []) this.unsubscribe(c, msg.serverId);
        break;
      case 'revoke':
        for (const sid of msg.sessionIds) {
          for (const c of this.bySession.get(sid) ?? []) {
            this.send(c, Ev.SessionRevoked, {});
            c.ws.close(Close.SessionRevoked, 'session revoked');
          }
        }
        break;
    }
  }

  private dispatch(msg: Dispatch): void {
    const targets = new Set<Conn>();
    for (const u of msg.target.users ?? []) for (const c of this.byUser.get(u) ?? []) targets.add(c);
    if (msg.target.server) for (const c of this.byServer.get(msg.target.server) ?? []) targets.add(c);
    if (targets.size === 0) return;
    const frame = (seq: number): string => JSON.stringify({ t: msg.t, d: msg.d, s: seq });
    for (const c of targets) {
      if (msg.exceptUser && c.userId === msg.exceptUser) continue;
      if(!c.ready){
        if(c.pending.length>=512){c.ws.close(Close.ServerShutdown,'snapshot queue overflow');continue;}
        c.pending.push(msg);continue;
      }
      if (c.ws.readyState === WebSocket.OPEN) c.ws.send(frame(++c.seq));
    }
  }

  private send(c: Conn, t: string, d: unknown): void {
    if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify({ t, d, s: ++c.seq }));
  }

  private subscribe(c: Conn, serverId: string): void {
    c.servers.add(serverId);
    let set = this.byServer.get(serverId);
    if (!set) this.byServer.set(serverId, (set = new Set()));
    set.add(c);
  }

  private unsubscribe(c: Conn, serverId: string): void {
    c.servers.delete(serverId);
    const set = this.byServer.get(serverId);
    set?.delete(c);
    if (set?.size === 0) this.byServer.delete(serverId);
  }

  // ─────────────── connection lifecycle ───────────────

  private onConnection(ws: WebSocket): void {
    const conn: Conn = { id: randomUUID(), ws, userId: null, sessionId: null, servers: new Set(), alive: true, seq: 0,ready:false,pending:[] };
    this.conns.set(conn.id, conn);
    const authTimer = setTimeout(() => {
      if (!conn.ready) ws.close(Close.AuthTimeout, 'auth timeout');
    }, AUTH_TIMEOUT_MS);

    ws.on('pong', () => {
      conn.alive = true;
    });
    // Authentication and subsequent messages must finish in wire order. Browsers
    // send their first heartbeat as soon as they receive hello, while auth awaits DB I/O.
    let pendingMessages = Promise.resolve();
    ws.on('message', (raw: RawData) => {
      pendingMessages = pendingMessages
        .then(() => ws.readyState === WebSocket.OPEN ? this.onMessage(conn, raw) : undefined)
        .catch((err: unknown) => log.error('gateway message queue failed', { err }));
    });
    ws.on('close', () => {
      clearTimeout(authTimer);
      const closing = pendingMessages.then(() => this.onClose(conn));
      this.closingConnections.add(closing);
      void closing.finally(() => this.closingConnections.delete(closing));
    });
    ws.on('error', (err: Error) => log.debug('ws error', { err }));
    this.send(conn, 'hello', { heartbeatInterval: HEARTBEAT_INTERVAL_MS });
  }

  private async onMessage(conn: Conn, raw: RawData): Promise<void> {
    let parsed: ClientOp;
    try {
      parsed = clientOp.parse(JSON.parse(raw.toString()));
    } catch {
      this.send(conn, 'error', { code: 'BAD_OP', message: 'Некорректное сообщение' });
      return;
    }
    try {
      if (parsed.op === Op.Auth) return await this.onAuth(conn, parsed.d.token);
      if (!conn.userId) {
        conn.ws.close(Close.AuthFailed, 'not authenticated');
        return;
      }
      await rateLimit({ name: 'ws', max: 120, windowSec: 10 }, conn.userId);
      await this.handleOp(conn, conn.userId, parsed);
    } catch (err) {
      if(parsed.op===Op.Auth){
        log.warn('gateway snapshot failed; reconnect required',{err});
        conn.pending=[];conn.ws.close(Close.ServerShutdown,'snapshot failed');return;
      }
      if (err instanceof AppError) {
        if (err.status === 429 && parsed.op !== Op.Heartbeat) this.send(conn, 'error', { code: err.code, message: err.message, op: parsed.op });
        else if (err.status !== 429) this.send(conn, 'error', { code: err.code, message: err.message, op: parsed.op });
        return;
      }
      log.error('gateway op failed', { err, op: parsed.op });
      this.send(conn, 'error', { code: 'INTERNAL', message: 'Внутренняя ошибка', op: parsed.op });
    }
  }

  private async handleOp(conn: Conn, userId: string, op: ClientOp): Promise<void> {
    switch (op.op) {
      case Op.Heartbeat: {
        conn.alive = true;
        await presence.touchConnection(userId, conn.id);
        if (op.d?.afk !== undefined) {
          await presence.setAfk(userId, op.d.afk);
          await this.publishPresence(userId);
        }
        this.send(conn, 'heartbeat:ack', { t: Date.now() });
        break;
      }
      case Op.Typing:
        await messages.typing(op.d.channelId, userId);
        break;
      case Op.VoiceState: {
        const { channelId,expectedChannelId,participantSid, ...rest } = op.d;
        if (channelId === null) {
          await voice.leaveClient(userId,expectedChannelId,participantSid);
        } else {
          const current = await voice.myState(userId);
          if (current?.channelId !== channelId) await voice.join(userId, channelId); // permission check
          if(!await voice.markJoined(userId,channelId,{participantSid},true))return;
          await voice.updateSelfState(userId, rest,channelId,participantSid);
        }
        break;
      }
      case Op.VoiceSpeaking:
        await voice.relaySpeaking(userId, op.d.speaking);
        break;
      case Op.CallRing:
        await calls.ring(op.d.channelId, userId, op.d.video);
        break;
      case Op.CallAccept:
        await calls.accept(op.d.channelId, userId,op.d.ringId);
        break;
      case Op.CallDecline:
        await calls.decline(op.d.channelId, userId,op.d.ringId);
        break;
      case Op.CallEnd:
        await calls.end(op.d.channelId, userId, op.d.durationSec ?? null);
        break;
      case Op.SetStatus:
        await setStatus(userId, op.d.status);
        break;
    }
  }

  private async onAuth(conn: Conn, token: string): Promise<void> {
    if (conn.userId) return;
    const user = await verifyAccessToken(token);
    if (!user) {
      conn.ws.close(Close.AuthFailed, 'invalid token');
      return;
    }
    const row = await users.findById(user.id);
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    if (!row) {
      conn.ws.close(Close.AuthFailed, 'invalid token');
      return;
    }
    if (config.REQUIRE_EMAIL_VERIFICATION && !row.email_verified_at) {
      conn.ws.close(Close.AuthFailed, 'email verification required');
      return;
    }
    conn.userId = user.id;
    conn.sessionId = user.sessionId;
    this.index(this.byUser, user.id, conn);
    this.index(this.bySession, user.sessionId, conn);

    const serverIds = (await query<{ server_id: string }>(`SELECT server_id FROM server_members WHERE user_id = $1`, [user.id])).map((r) => r.server_id);
    for (const s of serverIds) this.subscribe(conn, s);

    await presence.touchConnection(user.id, conn.id);
    await presence.setAfk(user.id, false);
    await this.publishPresence(user.id, row.status);

    const ready = await this.buildReady(user.id, serverIds);
    this.send(conn, Ev.Ready, ready);
    conn.ready=true;
    for(const event of conn.pending){
      if(event.target.users?.includes(user.id)||(event.target.server&&conn.servers.has(event.target.server)))this.send(conn,event.t,event.d);
    }
    conn.pending=[];
  }

  private async buildReady(userId: string, serverIds: string[]) {
    const [me, serverList, dmList, relations, readStates, notif, voiceState] = await Promise.all([
      users.findById(userId).then((r) => users.toSelf(r!)),
      Promise.all(serverIds.map((id) => servers.getFull(id, userId).catch(() => null))),
      dms.list(userId),
      friends.list(userId),
      messages.readStates(userId),
      notifications.list(userId, 30),
      voice.myState(userId),
    ]);
    const dmVoice = await dms.voiceStates(userId);
    const rings = await calls.pendingRings(userId, dmList.map((d) => d.id));
    return {
      user: me,
      servers: serverList.filter((s) => s !== null),
      dms: dmList,
      relationships: relations,
      readStates,
      notifications: notif,
      dmVoiceStates: dmVoice,
      voiceState,
      incomingCalls: rings,
      features: { gif: gifStatus() },
    };
  }

  private index(map: Map<string, Set<Conn>>, key: string, conn: Conn): void {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(conn);
  }

  private unindex(map: Map<string, Set<Conn>>, key: string, conn: Conn): void {
    const set = map.get(key);
    set?.delete(conn);
    if (set?.size === 0) map.delete(key);
  }

  private async onClose(conn: Conn): Promise<void> {
    this.conns.delete(conn.id);
    for (const s of conn.servers) this.unsubscribe(conn, s);
    if (!conn.userId) return;
    this.unindex(this.byUser, conn.userId, conn);
    if (conn.sessionId) this.unindex(this.bySession, conn.sessionId, conn);
    try {
      await presence.dropConnection(conn.userId, conn.id);
      await this.publishPresence(conn.userId);
    } catch (err) {
      log.warn('presence update on close failed', { err });
    }
  }

  /** Recomputes and broadcasts a user's presence if it changed. */
  async publishPresence(userId: string, chosen?: ChosenStatus): Promise<void> {
    const status = chosen ?? (await users.findById(userId))?.status ?? 'online';
    const changed = await presence.recompute(userId, status);
    if (!changed) return;
    const audience = await users.audienceOf(userId);
    const ev = changed === 'offline' ? Ev.UserOffline : Ev.UserOnline;
    await emit(ev, { userId, status: changed }, { users: [...audience, userId] });
    await emit(Ev.PresenceUpdate, { userId, status: changed }, { users: [...audience, userId] });
  }

  /** Pings sockets, terminates dead ones, and expires presence of connections lost by crashed nodes. */
  private async sweep(): Promise<void> {
    for (const c of this.conns.values()) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
      if (c.userId) await presence.touchConnection(c.userId, c.id).catch(() => undefined);
    }
    try {
      const online = await presence.onlineUserIds();
      for (const userId of online) await this.publishPresence(userId);
    } catch (err) {
      log.warn('presence sweep failed', { err });
    }
  }

  get connectionCount(): number {
    return this.conns.size;
  }
}
