// Browser harness (bundled by test/webrtc.mjs): verifies the real-media parts of the voice stack
// against Chromium's actual WebRTC implementation, without needing an SFU:
//  1. microphone → AudioWorklet meter → VAD reacts to real signal
//  2. two RTCPeerConnections in loopback → getStats() → StatsSampler produces RTT / bitrate / codec
import { StatsSampler } from '../src/webrtc/stats';
import { createMeter, VoiceActivityDetector } from '../src/webrtc/audioMeter';

declare global {
  interface Window {
    runHarness(): Promise<Record<string, unknown>>;
  }
}

window.runHarness = async () => {
  const out: Record<string, unknown> = {};
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  await ctx.resume();
  const src = ctx.createMediaStreamSource(mic);
  const vad = new VoiceActivityDetector(-50, false);
  let maxDb = -100;
  let opened = false;
  const stop = await createMeter(ctx, src, ({ rmsDb }) => {
    maxDb = Math.max(maxDb, rmsDb);
    if (vad.update(rmsDb)) opened = true;
  });
  await new Promise((r) => setTimeout(r, 1500));
  stop();
  out.micMaxDb = Math.round(maxDb);
  out.vadOpened = opened;

  // Loopback call: a → b, audio from the fake microphone, gated through a GainNode like the engine does.
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate);
  const gate = ctx.createGain();
  const dest = ctx.createMediaStreamDestination();
  src.connect(gate).connect(dest);
  const track = dest.stream.getAudioTracks()[0]!;
  const sender = a.addTrack(track, dest.stream);
  const gotTrack = new Promise<RTCRtpReceiver>((r) => (b.ontrack = (e) => r(e.receiver)));
  await a.setLocalDescription(await a.createOffer());
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription(await b.createAnswer());
  await a.setRemoteDescription(b.localDescription!);
  const receiver = await gotTrack;
  const sampler = new StatsSampler();
  let last = null as ReturnType<StatsSampler['sample']> | null;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 700));
    last = sampler.sample([await sender.getStats()], [await receiver.getStats()]);
  }
  out.stats = last;
  a.close();
  b.close();
  mic.getTracks().forEach((t) => t.stop());
  await ctx.close();
  return out;
};
