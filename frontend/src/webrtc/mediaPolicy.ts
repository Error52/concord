/** Voice gets priority over video when a connection is congested. Music stays raw stereo. */
export const VOICE_AUDIO_PUBLISH = {
  audioPreset: { maxBitrate: 96_000, priority: 'high' as const },
  dtx: true,
  red: true,
  forceStereo: false,
};

export const STREAM_AUDIO_PUBLISH = {
  audioPreset: { maxBitrate: 192_000, priority: 'high' as const },
  dtx: false,
  red: false,
  forceStereo: true,
  stream: 'screen',
};

/** A preference, not a forced buffer size. The browser still handles loss and AV sync. */
export function playbackBufferTarget(screen: boolean, jitterMs: number | null): number {
  const floor = screen ? 40 : 20;
  return Math.round(Math.min(160, Math.max(floor, Number.isFinite(jitterMs) ? (jitterMs ?? 0) * 2 + 20 : floor)));
}

/** Receiver reports are track scoped: one weak connection must not delay everyone else's audio. */
export function playbackBufferFromReport(screen: boolean, kind: string, report: RTCStatsReport | undefined): number {
  let jitterMs: number | null = null;
  report?.forEach((row: { type: string; kind?: string; mediaType?: string; jitter?: number }) => {
    if (row.type !== 'inbound-rtp' || (row.kind ?? row.mediaType) !== kind || typeof row.jitter !== 'number' || !Number.isFinite(row.jitter) || row.jitter < 0) return;
    jitterMs = Math.max(jitterMs ?? 0, row.jitter * 1000);
  });
  return playbackBufferTarget(screen, jitterMs);
}

export function applyPlaybackBuffer(receiver: RTCRtpReceiver | undefined, target: number): boolean {
  if (!receiver || !('jitterBufferTarget' in receiver)) return false;
  try {
    const supported = receiver as RTCRtpReceiver & { jitterBufferTarget: number | null };
    if (supported.jitterBufferTarget !== target) supported.jitterBufferTarget = target;
    return true;
  } catch { return false; }
}
