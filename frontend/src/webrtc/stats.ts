/**
 * Connection statistics computed from RTCPeerConnection.getStats() reports (via LiveKit's
 * track.getRTCStatsReport()). Rates are computed from deltas between consecutive samples.
 */

export type Quality = 'excellent' | 'good' | 'average' | 'poor' | 'unknown';

export interface ConnectionStats {
  rttMs: number | null;
  jitterMs: number | null;
  audioBufferMs: number | null;
  videoBufferMs: number | null;
  packetLossPct: number | null;
  uploadKbps: number | null;
  downloadKbps: number | null;
  audioBitrateKbps: number | null;
  codec: string | null;
  transport: string | null; // e.g. "UDP · host", "TCP · relay (TURN)"
  iceState: string | null;
  dtlsState: string | null;
  quality: Quality;
  updatedAt: number;
}

interface Counters {
  bytesSent: number;
  bytesReceived: number;
  audioBytesSent: number;
  packetsReceived: number;
  packetsLost: number;
}

type StatsRecord = Record<string, unknown> & { type: string; id: string };

function entries(reports: (RTCStatsReport | undefined)[]): StatsRecord[] {
  const out: StatsRecord[] = [];
  const seen = new Set<string>();
  for (const r of reports) {
    r?.forEach((s: StatsRecord) => {
      const key = `${s.type}:${s.id}:${(s.ssrc as number | undefined) ?? ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(s);
      }
    });
  }
  return out;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function classify(rttMs: number | null, lossPct: number | null, jitterMs: number | null): Quality {
  if (rttMs === null && lossPct === null) return 'unknown';
  const rtt = rttMs ?? 0;
  const loss = lossPct ?? 0;
  const jitter = jitterMs ?? 0;
  if (rtt < 100 && loss < 1 && jitter < 20) return 'excellent';
  if (rtt < 200 && loss < 3 && jitter < 40) return 'good';
  if (rtt < 400 && loss < 8 && jitter < 80) return 'average';
  return 'poor';
}

export class StatsSampler {
  private previousAt: number | null = null;
  private trackPrev = new Map<string, Counters>();
  private bufferPrev = new Map<string, { delay: number; count: number }>();

  /**
   * @param publisher reports from local (sent) tracks — upload, RTT, remote-reported loss
   * @param subscriber reports from remote (received) tracks — download, jitter, received loss
   */
  sample(publisher: (RTCStatsReport | undefined)[], subscriber: (RTCStatsReport | undefined)[]): ConnectionStats {
    const pub = entries(publisher);
    const sub = entries(subscriber);
    // Publisher/subscriber peer connections may reuse IDs such as T01 and codec IDs.
    const pubById = new Map(pub.map((s) => [s.id, s]));
    const subById = new Map(sub.map((s) => [s.id, s]));
    const now = performance.now();
    const nextTracks = new Map<string, Counters>();
    const delta = (s: StatsRecord, direction: 'publisher' | 'subscriber'): Counters => {
      const key=`${direction}:${s.id}:${s.ssrc??''}:${s.kind??s.mediaType??''}`;
      const counters: Counters = {
        bytesSent:num(s.bytesSent)??0, bytesReceived:num(s.bytesReceived)??0,
        audioBytesSent:(s.kind??s.mediaType)==='audio'?(num(s.bytesSent)??0):0,
        packetsReceived:num(s.packetsReceived)??0, packetsLost:num(s.packetsLost)??0,
      };
      const previous=this.trackPrev.get(key);nextTracks.set(key,counters);
      // A new/restarted RTP stream establishes its own baseline, rather than adding lifetime counters.
      if(!previous||counters.bytesSent<previous.bytesSent||counters.bytesReceived<previous.bytesReceived){
        return {bytesSent:0,bytesReceived:0,audioBytesSent:0,packetsReceived:0,packetsLost:0};
      }
      return {
        bytesSent:counters.bytesSent-previous.bytesSent,bytesReceived:counters.bytesReceived-previous.bytesReceived,
        audioBytesSent:counters.audioBytesSent-previous.audioBytesSent,
        packetsReceived:Math.max(0,counters.packetsReceived-previous.packetsReceived),
        packetsLost:Math.max(0,counters.packetsLost-previous.packetsLost),
      };
    };

    let rtt: number | null = null;
    let iceState: string | null = null;
    let dtlsState: string | null = null;
    let transport: string | null = null;
    // Selected candidate pair, preferring the publisher transport.
    for (const list of [pub, sub]) {
      if (rtt !== null) break;
      const byId=list===pub?pubById:subById;
      const tr = list.find((s) => s.type === 'transport');
      const pairId = tr?.selectedCandidatePairId as string | undefined;
      const pair = (pairId ? byId.get(pairId) : undefined) ?? list.find((s) => s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded');
      if (tr) {
        iceState = (tr.iceState as string) ?? iceState;
        dtlsState = (tr.dtlsState as string) ?? dtlsState;
      }
      if (pair) {
        const r = num(pair.currentRoundTripTime);
        if (r !== null) rtt = r * 1000;
        if (!iceState && pair.state === 'succeeded') iceState = 'connected';
        const local = byId.get(pair.localCandidateId as string);
        if (local) {
          const proto = String(local.relayProtocol ?? local.protocol ?? '').toUpperCase();
          const type = String(local.candidateType ?? '');
          transport = `${proto || 'UDP'} · ${type === 'relay' ? 'relay (TURN)' : type === 'srflx' ? 'STUN' : type}`;
        }
      }
    }
    for (const s of pub) {
      if (s.type === 'remote-inbound-rtp' && rtt === null) {
        const r = num(s.roundTripTime);
        if (r !== null) rtt = r * 1000;
      }
    }

    let bytesSent = 0;
    let audioBytesSent = 0;
    let bytesReceived = 0;
    let packetsReceived = 0;
    let packetsLost = 0;
    let jitterSum = 0;
    let jitterN = 0;
    let remoteLossFraction: number | null = null;
    let codec: string | null = null;
    const buffers = { audio: { delay: 0, count: 0 }, video: { delay: 0, count: 0 } };
    const nextBuffers = new Map<string, { delay: number; count: number }>();

    for (const s of pub) {
      if (s.type === 'outbound-rtp') {
        const change=delta(s,'publisher');
        bytesSent += change.bytesSent;
        if ((s.kind??s.mediaType) === 'audio') {
          audioBytesSent += change.audioBytesSent;
          const c = pubById.get(s.codecId as string);
          if (c) codec = String(c.mimeType ?? '').split('/')[1] ?? codec;
        }
      }
      if (s.type === 'remote-inbound-rtp') {
        const f = num(s.fractionLost);
        if (f !== null) remoteLossFraction = Math.max(remoteLossFraction ?? 0, f);
        const j = num(s.jitter);
        if (j !== null && sub.length === 0) {
          jitterSum += j * 1000;
          jitterN++;
        }
      }
    }
    for (const s of sub) {
      if (s.type !== 'inbound-rtp') continue;
      const kind = s.kind ?? s.mediaType;
      const delay = num(s.jitterBufferDelay), count = num(s.jitterBufferEmittedCount);
      if ((kind === 'audio' || kind === 'video') && delay !== null && count !== null) {
        const key=`${s.id}:${s.ssrc??''}`;
        const prev = this.bufferPrev.get(key);
        const dd = prev && delay >= prev.delay && count >= prev.count ? delay - prev.delay : delay;
        const dc = prev && delay >= prev.delay && count >= prev.count ? count - prev.count : count;
        nextBuffers.set(key, { delay, count });
        if (dc > 0 && dd >= 0) { buffers[kind].delay += dd; buffers[kind].count += dc; }
      }
      const change=delta(s,'subscriber');
      bytesReceived += change.bytesReceived;
      packetsReceived += change.packetsReceived;
      packetsLost += change.packetsLost;
      const j = num(s.jitter);
      if (j !== null && kind === 'audio') {
        jitterSum += j * 1000;
        jitterN++;
      }
      if (!codec && kind === 'audio') {
        const c = subById.get(s.codecId as string);
        if (c) codec = String(c.mimeType ?? '').split('/')[1] ?? null;
      }
    }

    let uploadKbps: number | null = null;
    let downloadKbps: number | null = null;
    let audioKbps: number | null = null;
    let lossPct: number | null = remoteLossFraction !== null ? remoteLossFraction * 100 : null;
    if (this.previousAt!==null && now > this.previousAt) {
      const dt = (now - this.previousAt) / 1000;
      uploadKbps = bytesSent * 8 / 1000 / dt;
      downloadKbps = bytesReceived * 8 / 1000 / dt;
      audioKbps = audioBytesSent * 8 / 1000 / dt;
      const recv = packetsReceived;
      const lost = packetsLost;
      if (recv + lost > 0) lossPct = Math.max(lossPct ?? 0, (lost / (recv + lost)) * 100);
    }
    this.previousAt=now;
    this.trackPrev=nextTracks;
    this.bufferPrev = nextBuffers;
    const jitter = jitterN ? jitterSum / jitterN : null;
    return {
      rttMs: rtt,
      jitterMs: jitter,
      audioBufferMs: buffers.audio.count > 0 ? buffers.audio.delay * 1000 / buffers.audio.count : null,
      videoBufferMs: buffers.video.count > 0 ? buffers.video.delay * 1000 / buffers.video.count : null,
      packetLossPct: lossPct,
      uploadKbps,
      downloadKbps,
      audioBitrateKbps: audioKbps,
      codec: codec ? codec.charAt(0).toUpperCase() + codec.slice(1) : null,
      transport,
      iceState,
      dtlsState,
      quality: classify(rtt, lossPct, jitter),
      updatedAt: Date.now(),
    };
  }

  reset(): void {
    this.previousAt = null;
    this.trackPrev.clear();
    this.bufferPrev.clear();
  }
}

export const qualityLabel: Record<Quality, string> = {
  excellent: 'Отличное',
  good: 'Хорошее',
  average: 'Среднее',
  poor: 'Плохое',
  unknown: 'Измерение…',
};

export function formatBitrate(kbps: number | null): string {
  if (kbps === null) return '—';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Мбит/с` : `${Math.round(kbps)} кбит/с`;
}
