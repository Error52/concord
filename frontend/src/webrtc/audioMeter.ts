/**
 * Real-time audio level metering with an AudioWorklet (keeps running in background tabs,
 * unlike requestAnimationFrame/timers). Reports RMS and peak in dBFS ~every 10 ms.
 */

const WORKLET = `
class LevelMeter extends AudioWorkletProcessor {
  constructor() { super(); this.sum = 0; this.peak = 0; this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) { const v = ch[i]; this.sum += v * v; const a = v < 0 ? -v : v; if (a > this.peak) this.peak = a; }
      this.n += ch.length;
      if (this.n >= 480) {
        this.port.postMessage({ rms: Math.sqrt(this.sum / this.n), peak: this.peak });
        this.sum = 0; this.peak = 0; this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('concord-level-meter', LevelMeter);
`;

const loaded = new WeakSet<BaseAudioContext>();

export async function ensureMeterWorklet(ctx: AudioContext): Promise<void> {
  if (loaded.has(ctx)) return;
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try {
    await ctx.audioWorklet.addModule(url);
    loaded.add(ctx);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const toDb = (linear: number): number => (linear > 0 ? Math.max(-100, 20 * Math.log10(linear)) : -100);

/** 0..1 for UI meters, mapping -60 dBFS..0 dBFS linearly. */
export const dbToMeter = (db: number): number => Math.min(1, Math.max(0, (db + 60) / 60));

export interface MeterReading {
  rmsDb: number;
  peakDb: number;
}

export async function createMeter(ctx: AudioContext, source: AudioNode, onReading: (r: MeterReading) => void): Promise<() => void> {
  await ensureMeterWorklet(ctx);
  const node = new AudioWorkletNode(ctx, 'concord-level-meter', { numberOfInputs: 1, numberOfOutputs: 0 });
  node.port.onmessage = (e: MessageEvent<{ rms: number; peak: number }>) => onReading({ rmsDb: toDb(e.data.rms), peakDb: toDb(e.data.peak) });
  source.connect(node);
  return () => {
    node.port.onmessage = null;
    try {
      source.disconnect(node);
    } catch {
      /* already disconnected */
    }
  };
}

/**
 * Voice activity detector with hysteresis and hangover. In auto mode the threshold follows the
 * measured noise floor (+12 dB), so it adapts to fans/keyboards without manual tuning.
 */
export class VoiceActivityDetector {
  private open = false;
  private lastAbove = 0;
  noiseFloorDb = -70;

  constructor(
    public thresholdDb: number,
    public auto: boolean,
    private readonly hangoverMs = 300,
  ) {}

  get effectiveThreshold(): number {
    return this.auto ? Math.min(-20, Math.max(-65, this.noiseFloorDb + 12)) : this.thresholdDb;
  }

  update(levelDb: number, now = performance.now()): boolean {
    // Noise floor: falls quickly, rises slowly (only while not speaking).
    if (levelDb < this.noiseFloorDb) this.noiseFloorDb = this.noiseFloorDb * 0.9 + levelDb * 0.1;
    else if (!this.open) this.noiseFloorDb += 0.02;
    const thr = this.effectiveThreshold;
    if (levelDb >= thr) {
      this.lastAbove = now;
      this.open = true;
    } else if (this.open && now - this.lastAbove > this.hangoverMs && levelDb < thr - 3) {
      this.open = false;
    }
    return this.open;
  }

  get isOpen(): boolean {
    return this.open;
  }
}
