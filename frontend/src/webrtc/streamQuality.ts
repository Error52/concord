import type { StreamQuality } from '../state/settings';

export interface StreamProfile {
  label: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  hint: 'motion' | 'detail';
  degradation: RTCDegradationPreference;
}

export const STREAM_QUALITIES: Record<StreamQuality, StreamProfile> = {
  auto: { label: 'Авто · до 1440p / 60 fps — игры и видео', width: 2560, height: 1440, fps: 60, bitrate: 12_000_000, hint: 'motion', degradation: 'maintain-resolution' },
  '720p30': { label: '720p · 30 fps — слабый интернет', width: 1280, height: 720, fps: 30, bitrate: 2_500_000, hint: 'motion', degradation: 'maintain-resolution' },
  '1080p30': { label: '1080p · 30 fps — фильмы и видео', width: 1920, height: 1080, fps: 30, bitrate: 6_000_000, hint: 'motion', degradation: 'maintain-resolution' },
  '1080p60': { label: '1080p · 60 fps — игры, плавно (нужен хороший канал)', width: 1920, height: 1080, fps: 60, bitrate: 9_000_000, hint: 'motion', degradation: 'maintain-resolution' },
  text: { label: 'Текст и код — максимум чёткости, 15 fps', width: 2560, height: 1440, fps: 15, bitrate: 4_000_000, hint: 'detail', degradation: 'maintain-resolution' },
};

/** Selected quality is a ceiling. Reduce encoder work first, then pixels; never upscale a source. */
export function streamProfile(quality: StreamQuality, tier = 0, cores = 8): StreamProfile {
  const base = STREAM_QUALITIES[quality] ?? STREAM_QUALITIES.auto;
  const level = Math.max(0, Math.min(3, tier));
  const cpuWidth = quality === 'auto' && cores < 12 ? 1920 : base.width;
  const cpuFps = quality === 'auto' && cores <= 4 ? 30 : base.fps;
  const width = quality === 'text' ? base.width : Math.min(base.width, cpuWidth, level >= 3 ? 1280 : level >= 2 ? 1920 : base.width);
  const fps = Math.max(quality === 'text' ? 5 : 15, Math.round(cpuFps * [1, 0.8, 0.6, 0.5][level]!));
  return {
    ...base,
    width,
    height: Math.round(width * base.height / base.width),
    fps,
    bitrate: Math.max(1_200_000, Math.round(base.bitrate * (width / base.width) ** 2 * [1, 0.85, 0.7, 0.55][level]!)),
    degradation: base.degradation,
  };
}

interface EncodingStats {
  type: string;
  kind?: string;
  mediaType?: string;
  framesEncoded?: number;
  totalEncodeTime?: number;
  qualityLimitationReason?: string;
}

/** Hysteresis prevents rapid quality changes: three bad samples down, twenty good samples up. */
export class StreamLoadController {
  tier = 0;
  private bad = 0;
  private good = 0;
  private previous: { frames: number; seconds: number } | null = null;

  reset(): void {
    this.tier = this.bad = this.good = 0;
    this.previous = null;
  }

  sample(report: Iterable<EncodingStats>, fps: number): boolean {
    let stats: EncodingStats | undefined;
    for (const row of report) {
      if (row.type === 'outbound-rtp' && (row.kind ?? row.mediaType) === 'video') { stats = row; break; }
    }
    if (!stats) return false;
    const frames = stats.framesEncoded ?? 0;
    const seconds = stats.totalEncodeTime ?? 0;
    const prev = this.previous;
    this.previous = {frames, seconds};
    const frameDelta = prev ? frames - prev.frames : 0;
    const timeDelta = prev ? seconds - prev.seconds : 0;
    const busy = frameDelta > 0 && timeDelta >= 0 && timeDelta / frameDelta > 0.7 / fps;
    // Congestion control already adapts to bandwidth. Treating its startup estimate as CPU
    // pressure permanently reduced sharpness even on fast local connections.
    const limited = stats.qualityLimitationReason === 'cpu' || busy;
    // Missing stats cannot prove spare capacity; retain the browser's native adaptation.
    const healthy = stats.qualityLimitationReason === 'none' && !busy;
    this.bad = limited ? this.bad + 1 : 0;
    this.good = healthy ? this.good + 1 : 0;
    if (this.bad >= 3 && this.tier < 3) { this.tier++; this.bad = this.good = 0; return true; }
    if (this.good >= 20 && this.tier > 0) { this.tier--; this.bad = this.good = 0; return true; }
    return false;
  }
}

/** H.264 is widely hardware accelerated; use VP8 where the browser doesn't advertise it. */
export function screenCodec(capabilities: RTCRtpCapabilities | null): 'h264' | 'vp8' {
  return capabilities?.codecs.some((c) => c.mimeType.toLowerCase() === 'video/h264') ? 'h264' : 'vp8';
}
