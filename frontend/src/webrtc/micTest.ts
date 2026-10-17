import type { Settings } from '../state/settings';
import { createMeter, VoiceActivityDetector } from './audioMeter';

export interface MicTest { stop(): void }

/** Owns every capture resource, including partially failed microphone tests. */
export async function startMicrophoneTest(getSettings: () => Settings, opts: { loopback: boolean; onLevel: (db: number, thr: number) => void; signal?: AbortSignal }): Promise<MicTest> {
  if (opts.signal?.aborted) throw new DOMException('Microphone test cancelled', 'AbortError');
  const s = getSettings();
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  let stream: MediaStream | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let gain: GainNode | null = null;
  let output: MediaStreamAudioDestinationNode | null = null;
  let stopMeter: (() => void) | null = null;
  let audio: HTMLAudioElement | null = null;
  let stopped = false;
  const stop = () => {
    opts.signal?.removeEventListener('abort', stop);
    stopMeter?.(); stopMeter = null;
    source?.disconnect(); source = null;
    gain?.disconnect(); gain = null;
    if (audio) { audio.pause(); audio.srcObject = null; audio = null; }
    stream?.getTracks().forEach(t => t.stop()); stream = null;
    output?.stream.getTracks().forEach(t => t.stop()); output = null;
    if (!stopped) { stopped = true; void ctx.close().catch(() => undefined); }
  };
  const checkActive = () => { if (stopped || opts.signal?.aborted) { stop(); throw new DOMException('Microphone test cancelled', 'AbortError'); } };
  opts.signal?.addEventListener('abort', stop, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: s.inputDeviceId !== 'default' ? { exact: s.inputDeviceId } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
    } });
    checkActive();
    if (ctx.state === 'suspended') await ctx.resume();
    checkActive();
    source = ctx.createMediaStreamSource(stream);
    gain = ctx.createGain();
    gain.gain.value = s.inputVolume;
    source.connect(gain);
    const vad = new VoiceActivityDetector(s.vadThresholdDb, s.vadAuto);
    stopMeter = await createMeter(ctx, gain, ({ rmsDb }) => {
      if (stopped) return;
      const st = getSettings();
      vad.thresholdDb = st.vadThresholdDb;
      vad.auto = st.vadAuto;
      vad.update(rmsDb);
      opts.onLevel(rmsDb, vad.effectiveThreshold);
    });
    checkActive();
    if (opts.loopback) {
      output = ctx.createMediaStreamDestination();
      gain.connect(output);
      audio = new Audio();
      audio.srcObject = output.stream;
      if (s.outputDeviceId !== 'default' && 'setSinkId' in audio) {
        await (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(s.outputDeviceId).catch(() => undefined);
        checkActive();
      }
      await audio.play().catch(() => undefined);
      checkActive();
    }
    return { stop };
  } catch (error) {
    stop();
    throw error;
  }
}
