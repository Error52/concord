import { getAccessToken, refreshSession } from '../api/client';

/**
 * Gateway connection with automatic reconnect (exponential backoff + jitter), heartbeats,
 * idle detection and token refresh on auth failure. Every reconnect re-sends `auth`, and the
 * server answers with a fresh `ready` snapshot, so client state is rebuilt without gaps.
 */

export type GatewayStatus = 'connecting' | 'connected' | 'reconnecting' | 'offline';

type Handler = (data: any) => void;

const CLOSE_AUTH_FAILED = 4001;
const CLOSE_SESSION_REVOKED = 4003;
const IDLE_AFTER_MS = 5 * 60_000;

export class Gateway {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private statusListeners = new Set<(s: GatewayStatus) => void>();
  private heartbeatTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private attempts = 0;
  private stopped = true;
  private lastActivity = Date.now();
  private afk = false;
  status: GatewayStatus = 'offline';
  latencyMs: number | null = null;
  private lastBeatAt = 0;
  private pendingBeatAt: number | null = null;
  private heartbeatInterval = 20_000;
  private generation = 0;

  constructor(private readonly onSessionRevoked: () => void) {
    const activity = (): void => {
      this.lastActivity = Date.now();
      if (this.afk) this.heartbeat();
    };
    for (const ev of ['pointerdown', 'keydown', 'mousemove', 'focus']) window.addEventListener(ev, activity, { passive: true });
    window.addEventListener('online', () => this.reconnectNow());
    window.addEventListener('offline', () => {
      if (this.stopped) return;
      ++this.generation;
      this.clearTimers();
      const ws = this.ws;
      this.ws = null;
      ws?.close(1000);
      this.setStatus('reconnecting');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && this.status !== 'connected') this.reconnectNow();
    });
  }

  on(event: string, fn: Handler): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  onStatus(fn: (s: GatewayStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  private setStatus(s: GatewayStatus): void {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    ++this.generation;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000);
    this.setStatus('offline');
  }

  send(op: string, d: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  private reconnectNow(): void {
    if (this.stopped || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.attempts = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped || this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    const generation = ++this.generation;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/gateway`);
    this.ws = ws;
    const current = () => !this.stopped && this.generation === generation && this.ws === ws;
    ws.onopen = () => {
      if (!current()) return;
      const token = getAccessToken();
      if (!token) {
        ws.close(CLOSE_AUTH_FAILED);
        return;
      }
      ws.send(JSON.stringify({ op: 'auth', d: { token } }));
    };
    ws.onmessage = (ev) => {
      if (!current()) return;
      let msg: {t:string;d:any};
      try { msg=JSON.parse(ev.data as string); } catch { return; }
      if(!msg || typeof msg.t!=='string')return;
      if (msg.t === 'hello') {
        this.startHeartbeat(msg.d?.heartbeatInterval);
        return;
      }
      if (msg.t === 'heartbeat:ack') {
        if(this.pendingBeatAt!==null)this.latencyMs = Math.max(0,Date.now() - this.lastBeatAt);
        this.pendingBeatAt=null;
        return;
      }
      if (msg.t === 'ready') {
        this.attempts = 0;
        this.setStatus('connected');
      }
      this.handlers.get(msg.t)?.forEach((h) => h(msg.d));
      this.handlers.get('*')?.forEach((h) => h(msg));
    };
    ws.onclose = async (ev) => {
      if (!current()) return;
      this.clearHeartbeat();
      if (ev.code === CLOSE_SESSION_REVOKED) {
        this.stop();
        this.onSessionRevoked();
        return;
      }
      if (ev.code === CLOSE_AUTH_FAILED) {
        let ok=true;
        try { ok=await refreshSession(); } catch { /* Retry transient auth/network failures without logging out. */ }
        if(!current())return;
        if (!ok && navigator.onLine) {
          this.stop();
          this.onSessionRevoked();
          return;
        }
      }
      if(current())this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if(this.stopped)return;
    if(this.reconnectTimer!==null)clearTimeout(this.reconnectTimer);
    this.setStatus('reconnecting');
    if(!navigator.onLine)return;
    const generation=this.generation;
    const delay = Math.min(30_000, 500 * 2 ** this.attempts) * (0.7 + Math.random() * 0.6);
    this.attempts++;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer=null;
      if(generation===this.generation)this.connect();
    }, delay);
  }

  private startHeartbeat(interval: number): void {
    this.clearHeartbeat();
    this.heartbeatInterval=typeof interval==='number'&&Number.isFinite(interval)?Math.max(1000,Math.min(interval,20_000)):20_000;
    this.heartbeat();
    this.heartbeatTimer = window.setInterval(() => this.heartbeat(), this.heartbeatInterval);
  }

  private clearHeartbeat():void {
    if(this.heartbeatTimer!==null)clearInterval(this.heartbeatTimer);
    this.heartbeatTimer=null;
    this.pendingBeatAt=null;
    this.latencyMs=null;
  }

  private clearTimers():void {
    if(this.reconnectTimer!==null)clearTimeout(this.reconnectTimer);
    this.reconnectTimer=null;
    this.clearHeartbeat();
  }

  private heartbeat(): void {
    if(this.stopped || this.ws?.readyState!==WebSocket.OPEN)return;
    if(this.pendingBeatAt!==null){
      if(Date.now()-this.pendingBeatAt>=Math.max(10_000,this.heartbeatInterval*2))this.ws.close(4000,'Heartbeat timeout');
      return;
    }
    const afk = Date.now() - this.lastActivity > IDLE_AFTER_MS;
    const changed = afk !== this.afk;
    this.afk = afk;
    this.lastBeatAt = Date.now();
    if(this.send('heartbeat', changed || !afk ? { afk } : {}))this.pendingBeatAt=this.lastBeatAt;
  }
}
