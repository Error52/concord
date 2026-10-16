import {
  ConnectionQuality,
  ConnectionState,
  BackupCodecPolicy,
  DisconnectReason,
  LocalTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type LocalTrack,
} from 'livekit-client';
import { api, errorMessage } from '../api/client';
import { createStore, useStoreSelector } from '../state/store';
import { settingsStore, type Settings, type StreamQuality } from '../state/settings';
import { toast } from '../state/ui';
import { gateway } from '../state/actions';
import { getState } from '../state/app';
import { createMeter, ensureMeterWorklet, VoiceActivityDetector } from './audioMeter';
import { mediaErrorMessage } from './devices';
import { StatsSampler, type ConnectionStats } from './stats';
import { joinSound, leaveSound, muteSound, unmuteSound } from '../utils/notify';
import { log } from '../utils/log';
import { IS_LINUX, IS_MAC } from '../utils/platform';
import { STREAM_QUALITIES, StreamLoadController, screenCodec, streamProfile, type StreamProfile } from './streamQuality';
export { STREAM_QUALITIES } from './streamQuality';
import { VOICE_AUDIO_PUBLISH, STREAM_AUDIO_PUBLISH, applyPlaybackBuffer, playbackBufferTarget } from './mediaPolicy';

/**
 * Voice/video engine on top of the LiveKit SFU.
 *
 * Microphone path (all real audio, nothing simulated):
 *   getUserMedia(constraints) → MediaStreamSource → input gain → gate gain → MediaStreamDestination → published track
 *                                                      └→ AudioWorklet level meter → VAD / speaking indicator
 * Voice Activity and Push-to-Talk both drive the gate gain, so the far end only receives audio while the
 * gate is open. User mute uses LiveKit's track mute (signalled to others); server mute is enforced by the SFU.
 */

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export interface ParticipantView {
  identity: string;
  name: string;
  avatarUrl: string | null;
  isLocal: boolean;
  speaking: boolean;
  micMuted: boolean;
  hasCamera: boolean;
  hasScreen: boolean;
  hasScreenAudio: boolean;
  watchingScreen: boolean;
  quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown';
}

export interface VoiceSnapshot {
  status: VoiceStatus;
  channelId: string | null;
  serverId: string | null;
  isDm: boolean;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  camera: boolean;
  screen: boolean;
  /** null = not sharing; true = system/tab audio is being sent; false = source/browser gave no audio */
  screenAudio: boolean | null;
  pttHeld: boolean;
  gateOpen: boolean;
  localSpeaking: boolean;
  participants: Record<string, ParticipantView>;
  stats: ConnectionStats | null;
  audioBlocked: boolean;
  joinedAt: number | null;
  /** Bumps on media changes; tiles re-attach only when their track changes. */
  version: number;
}

/**
 * Stream audio is film/music/game sound: stereo, no voice DTX/RED tricks, high bitrate. `stream` puts the
 * screen video and its audio into one MediaStream so the receiver keeps them lip-synced.
 */

/**
 * Screen-share presets express capture intent with "motion" or "detail". Auto preserves resolution
 * in Chromium; our CPU controller reduces capture workload separately from native congestion control.
 * Streams are published as a single high-quality layer (no simulcast): with simulcast, viewers with a small
 * tile or the mini-player were switched to the low layer (half resolution, ~¼ bitrate) — a blurry picture
 * that sharpened only after a delay when going fullscreen.
 */

const initial: VoiceSnapshot = {
  status: 'idle',
  channelId: null,
  serverId: null,
  isDm: false,
  selfMute: false,
  selfDeaf: false,
  serverMute: false,
  serverDeaf: false,
  camera: false,
  screen: false,
  screenAudio: null,
  pttHeld: false,
  gateOpen: false,
  localSpeaking: false,
  participants: {},
  stats: null,
  audioBlocked: false,
  joinedAt: null,
  version: 0,
};

export const voiceStore = createStore<VoiceSnapshot>(initial);
export function useVoice<T>(selector: (s: VoiceSnapshot) => T): T {
  return useStoreSelector(voiceStore, selector);
}

/** Level listeners get every meter reading (≈100/s) without going through React state. */
type LevelListener = (db: number, threshold: number) => void;

const QUALITY: Record<string, ParticipantView['quality']> = {
  [ConnectionQuality.Excellent]: 'excellent',
  [ConnectionQuality.Good]: 'good',
  [ConnectionQuality.Poor]: 'poor',
  [ConnectionQuality.Lost]: 'lost',
};

class VoiceEngine {
  private room: Room | null = null;
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private inputGain: GainNode | null = null;
  private gate: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private stopMeter: (() => void) | null = null;
  private micPub: LocalTrackPublication | null = null;
  private vad = new VoiceActivityDetector(-50, true);
  private levelListeners = new Set<LevelListener>();
  private statsTimer: number | null = null;
  private sampler = new StatsSampler();
  private pttReleaseTimer: number | null = null;
  private intentionalLeave = false;
  private rejoinAttempts = 0;
  private audioSink: HTMLDivElement | null = null;
  private lastSpeakingSent = false;
  private joinSeq = 0;
  private mutedByBlur = false;
  private muteBeforeDeafen = false;
  private micSeq = 0;
  private micStarting: Promise<void> | null = null;
  private screenSeq = 0;
  private screenStarting = false;
  private rejoinTimer: number | null = null;
  private cameraSeq = 0;
  private screenTracks: LocalTrack[] = [];
  private cameraTracks: LocalTrack[] = [];
  private cameraStarting = false;

  constructor() {
    settingsStore.subscribe(() => this.onSettingsChanged(settingsStore.get()));
    gateway.on('voice:move', (d: { channelId: string }) => void this.join(d.channelId));
    gateway.on('voice:disconnect', (d:{channelId:string}) => {
      if(d?.channelId!==voiceStore.get().channelId)return;
      toast('Вы были отключены от голосового канала', 'info');
      void this.disconnect(false);
    });
    gateway.on('voice:state', (vs: { userId: string; serverMute: boolean; serverDeaf: boolean }) => {
      if (vs.userId !== getState().me?.id || !this.room) return;
      const s = voiceStore.get();
      if (s.serverMute !== vs.serverMute || s.serverDeaf !== vs.serverDeaf) {
        voiceStore.set({ serverMute: vs.serverMute, serverDeaf: vs.serverDeaf });
        if (vs.serverMute) toast('Модератор отключил вам микрофон на сервере');
        this.applyGate();
        this.applyVolumes();
        if (!vs.serverMute && !vs.serverDeaf && !this.micPub) void this.startMicrophone();
      }
    });
    // After a gateway reconnect the server rebuilds presence from scratch: re-announce our voice state.
    gateway.on('ready', () => {
      if (this.room && voiceStore.get().channelId) this.announce();
    });
    window.addEventListener('blur', () => this.onWindowBlur());
    window.addEventListener('focus', () => this.onWindowFocus());
    window.addEventListener('beforeunload', () => {
      if (this.room) void this.room.disconnect();
    });
  }

  // ─────────────── public API ───────────────

  onLevel(fn: LevelListener): () => void {
    this.levelListeners.add(fn);
    return () => this.levelListeners.delete(fn);
  }

  get currentRoom(): Room | null {
    return this.room;
  }

  async join(channelId: string): Promise<void> {
    const seq = ++this.joinSeq;
    if (this.room) await this.disconnect(false, true);
    if (seq !== this.joinSeq) return;
    const ch = getState().channels[channelId];
    const prev = voiceStore.get();
    voiceStore.set({ ...initial, selfMute: prev.selfMute, selfDeaf: prev.selfDeaf, status: 'connecting', channelId, serverId: ch?.serverId ?? null, isDm: ch?.type === 'dm', version: prev.version + 1 });
    this.intentionalLeave = false;
    try {
      const grant = await api.post<{ token: string; url: string; serverMute: boolean; serverDeaf: boolean }>(`/voice/${channelId}/token`);
      if (seq !== this.joinSeq) return;
      await this.ensureAudioContext();
      if (seq !== this.joinSeq) return;
      const settings = settingsStore.get();
      const room = new Room({
        // Video keeps playing in background tabs, otherwise picture-in-picture freezes when you switch tabs.
        adaptiveStream: { pauseVideoInBackground: false },
        dynacast: true,
        // Remote audio is played through <audio> elements, NOT Web Audio: Chromium applies echo
        // cancellation only to audio played by media elements, so with Web Audio anyone on speakers
        // would send voices and the film back into the call.
        webAudioMix: false,
        disconnectOnPageLeave: true,
        audioOutput: settings.outputDeviceId !== 'default' ? { deviceId: settings.outputDeviceId } : undefined,
        videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
        publishDefaults: {
          ...VOICE_AUDIO_PUBLISH,
          simulcast: true,
          videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
          screenShareEncoding: { maxBitrate: STREAM_QUALITIES['1080p30'].bitrate, maxFramerate: 30 },
        },
      });
      this.room = room;
      this.wireRoom(room);
      await room.connect(resolveUrl(grant.url), grant.token, { autoSubscribe: false });
      if (seq !== this.joinSeq) {
        await room.disconnect();
        return;
      }
      voiceStore.set({ status: 'connected', joinedAt: Date.now(), serverMute: grant.serverMute, serverDeaf: grant.serverDeaf });
      log.info('voice connected', { room: room.name });
      for (const p of room.remoteParticipants.values()) this.onParticipant(p);
      await this.startMicrophone();
      if (seq !== this.joinSeq || this.room !== room) return;
      this.announce();
      this.startStats();
      this.refreshParticipants();
      joinSound();
      this.rejoinAttempts = 0;
    } catch (err) {
      if (seq !== this.joinSeq) return;
      log.warn('voice join failed', { err: String(err) });
      await this.teardown();
      voiceStore.set({ ...initial, selfMute: voiceStore.get().selfMute, selfDeaf: voiceStore.get().selfDeaf });
      toast(errorMessage(err, 'Не удалось подключиться к голосовому каналу'), 'error');
    }
  }

  async disconnect(playSound = true, switching = false): Promise<void> {
    const s = voiceStore.get();
    this.intentionalLeave = true;
    const seq = switching ? this.joinSeq : ++this.joinSeq;
    if (s.isDm && s.channelId && s.joinedAt) {
      gateway.send('call:end', { channelId: s.channelId, durationSec: (Date.now() - s.joinedAt) / 1000 });
    }
    if (s.channelId) gateway.send('voice:state', { channelId: null });
    await this.teardown();
    if (seq !== this.joinSeq) return;
    if (!switching) voiceStore.set({ ...initial, selfMute: s.selfMute, selfDeaf: s.selfDeaf, version: s.version + 1 });
    if (playSound && s.status !== 'idle') leaveSound();
  }

  /** Works before joining too: the choice is applied when a call starts. */
  toggleMute(): void {
    const s = voiceStore.get();
    // Unmuting while deafened also undeafens (same as Discord).
    if (s.selfMute && s.selfDeaf) {
      voiceStore.set({ selfDeaf: false });
      this.applyVolumes();
    }
    voiceStore.set({ selfMute: !s.selfMute });
    (s.selfMute ? unmuteSound : muteSound)();
    this.applyGate();
    const latest = voiceStore.get();
    if (!latest.selfMute && !latest.serverMute && !latest.serverDeaf && this.room && !this.micPub) void this.startMicrophone();
    this.announce();
  }

  toggleDeafen(): void {
    const s = voiceStore.get();
    const deaf = !s.selfDeaf;
    if (deaf) this.muteBeforeDeafen = s.selfMute;
    voiceStore.set({ selfDeaf: deaf, selfMute: deaf || this.muteBeforeDeafen });
    (deaf ? muteSound : unmuteSound)();
    this.applyGate();
    this.applyVolumes();
    this.announce();
  }

  /** Push-to-talk key state. */
  setPtt(held: boolean): void {
    if (settingsStore.get().inputMode !== 'ptt') return;
    if (this.pttReleaseTimer) {
      clearTimeout(this.pttReleaseTimer);
      this.pttReleaseTimer = null;
    }
    if (held) {
      voiceStore.set({ pttHeld: true });
      this.applyGate();
    } else {
      // Short release delay so the last syllable isn't clipped.
      this.pttReleaseTimer = window.setTimeout(() => {
        voiceStore.set({ pttHeld: false });
        this.applyGate();
      }, settingsStore.get().pttReleaseDelayMs);
    }
  }

  async setCamera(on: boolean): Promise<void> {
    if (!this.room) return;
    if (on && this.cameraStarting) return;
    const room = this.room;
    const seq = ++this.cameraSeq;
    if (!on) {
      this.cameraStarting=false;
      const tracks = new Set(this.cameraTracks);
      const track = room.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
      if (track) tracks.add(track);
      this.cameraTracks = [];
      tracks.forEach((t) => t.stop());
      voiceStore.set({ camera: false });
      this.announce();
      await Promise.allSettled([...tracks].map((t) => room.localParticipant.unpublishTrack(t)));
      this.bump();
      return;
    }
    this.cameraStarting = true;
    let tracks: LocalTrack[] = [];
    try {
      const deviceId = settingsStore.get().videoDeviceId;
      tracks = await room.localParticipant.createTracks({ video: deviceId === 'default' ? true : { deviceId } });
      if (this.room !== room || seq !== this.cameraSeq) { tracks.forEach((t) => t.stop()); return; }
      tracks.forEach((t) => { t.source = Track.Source.Camera; });
      this.cameraTracks = tracks;
      await Promise.all(tracks.map((t) => room.localParticipant.publishTrack(t, { source: Track.Source.Camera })));
      if (this.room !== room || seq !== this.cameraSeq) {
        tracks.forEach((t) => t.stop());
        await Promise.allSettled(tracks.map((t) => room.localParticipant.unpublishTrack(t)));
        return;
      }
      voiceStore.set({ camera: on });
      this.bump();
      this.announce();
    } catch (err) {
      tracks.forEach((t) => t.stop());
      await Promise.allSettled(tracks.map((t) => room.localParticipant.unpublishTrack(t)));
      if (this.room !== room || seq !== this.cameraSeq) return;
      toast(mediaErrorMessage(err, 'camera'), 'error');
      voiceStore.set({ camera: false });
    } finally {
      if(this.room===room && seq===this.cameraSeq)this.cameraStarting = false;
    }
  }

  /** Cycles through cameras, or flips front/back on phones with a single reported device. */
  async switchCamera(): Promise<void> {
    if (!this.room || !voiceStore.get().camera) return;
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    const current = pub?.track?.mediaStreamTrack.getSettings();
    try {
      if (cams.length > 1) {
        const idx = cams.findIndex((c) => c.deviceId === current?.deviceId);
        const next = cams[(idx + 1) % cams.length]!;
        await this.room.switchActiveDevice('videoinput', next.deviceId);
        settingsStore.set({ videoDeviceId: next.deviceId });
      } else if (pub?.track && 'restartTrack' in pub.track) {
        const facingMode = current?.facingMode === 'environment' ? 'user' : 'environment';
        await (pub.track as unknown as { restartTrack(o: MediaTrackConstraints): Promise<void> }).restartTrack({ facingMode });
      } else {
        toast('Другая камера не найдена');
      }
      this.bump();
    } catch (err) {
      toast(mediaErrorMessage(err, 'camera'), 'error');
    }
  }

  async startScreenShare(): Promise<void> {
    if (!this.room || this.screenStarting || voiceStore.get().screen) return;
    if (!navigator.mediaDevices || !('getDisplayMedia' in navigator.mediaDevices)) {
      toast('Ваш браузер не поддерживает демонстрацию экрана', 'error');
      return;
    }
    const audioDevice = settingsStore.get().streamAudioDeviceId;
    // A separate audio source (BlackHole on macOS, "Monitor of …" on Linux, a capture card…) replaces the
    // browser's own capture, so everyone hears the whole system sound even where browsers can't capture it.
    const useDevice = audioDevice !== 'auto';
    const quality = settingsStore.get().streamQuality;
    this.streamLoad.reset();
    const q = streamProfile(quality, 0, navigator.hardwareConcurrency || 4);
    const room = this.room;
    const seq = ++this.screenSeq;
    this.screenStarting = true;
    let tracks: LocalTrack[] = [];
    try {
      tracks = await room.localParticipant.createScreenTracks(
        {
          audio: useDevice ? false : { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
          systemAudio: 'include',
          surfaceSwitching: 'include',
          selfBrowserSurface: 'exclude',
          suppressLocalAudioPlayback: false,
          resolution: { width: q.width, height: q.height, frameRate: q.fps },
          contentHint: q.hint,
        },
      );
      if (this.room !== room || seq !== this.screenSeq) { tracks.forEach((t) => t.stop()); return; }
      this.screenTracks = tracks;
      await Promise.all(tracks.map((track) => room.localParticipant.publishTrack(track, {
          ...STREAM_AUDIO_PUBLISH,
          simulcast: false,
          videoCodec: screenCodec(RTCRtpSender.getCapabilities?.('video') ?? null),
          backupCodec: {codec:'vp8',encoding:{maxBitrate:q.bitrate,maxFramerate:q.fps}},
          backupCodecPolicy: BackupCodecPolicy.PREFER_REGRESSION,
          screenShareEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
          videoEncoding: { maxBitrate: q.bitrate, maxFramerate: q.fps },
          degradationPreference: q.degradation,
        })));
      if (this.room !== room || seq !== this.screenSeq) {
        tracks.forEach((t) => t.stop());
        await Promise.allSettled(tracks.map((t) => room.localParticipant.unpublishTrack(t)));
        return;
      }
      this.screenQuality = quality;
      // Enforce the encoded ceiling even if a capture source ignores ideal dimensions.
      await this.applyScreenProfile(q, quality);
      if (this.room !== room || seq !== this.screenSeq) return;
      let hasAudio = !!this.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)?.track;
      if (useDevice) hasAudio = await this.publishStreamAudioDevice(audioDevice);
      if (this.room !== room || seq !== this.screenSeq) return;
      voiceStore.set({ screen: true, screenAudio: hasAudio });
      if (hasAudio && !voiceStore.get().selfMute) {
        toast('Совет: во время показа фильма говорите в наушниках — иначе микрофон подхватит звук фильма из колонок, и у всех он будет звучать дважды.', 'info');
      }
      if (!hasAudio && !useDevice) {
        // Chrome/Edge capture system audio only for a whole screen on Windows/ChromeOS; on macOS and Linux only a tab has audio.
        const hint =
          IS_MAC || IS_LINUX
            ? ' На macOS и Linux браузер отдаёт звук только при показе вкладки. Чтобы все слышали весь звук компьютера, выберите источник звука демонстрации в Настройки → Голос и видео.'
            : ' Включите галочку «Поделиться системным звуком» / «звуком вкладки» в окне выбора.';
        toast(`Звук недоступен для этого источника или браузера (System audio is not available for this source/browser).${hint}`, 'info');
      }
      this.bump();
      this.announce();
    } catch (err) {
      tracks.forEach((t) => t.stop());
      await Promise.allSettled(tracks.map((t) => room.localParticipant.unpublishTrack(t)));
      if (this.room !== room || seq !== this.screenSeq) return;
      const { name, message } = err as { name?: string; message?: string };
      // "Permission denied by system" = the OS blocked screen recording (macOS privacy settings), not a user cancel.
      const deniedBySystem = name === 'NotAllowedError' && /system/i.test(message ?? '');
      if (deniedBySystem || (name !== 'NotAllowedError' && name !== 'AbortError')) toast(mediaErrorMessage(err, 'screen'), 'error');
      voiceStore.set({ screen: false, screenAudio: null });
    } finally {
      if(this.room===room && seq===this.screenSeq)this.screenStarting = false;
    }
  }

  private streamAudioStream: MediaStream | null = null;

  /** Publishes an audio input device as the stream's audio track (raw, stereo, music bitrate). */
  private async publishStreamAudioDevice(deviceId: string): Promise<boolean> {
    if (!this.room) return false;
    const room = this.room;
    const seq = this.screenSeq;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2, sampleRate: 48000 },
      });
      if (this.room !== room || seq !== this.screenSeq) { stream.getTracks().forEach((t) => t.stop()); return false; }
      const track = stream.getAudioTracks()[0];
      if (!track) { stream.getTracks().forEach((t) => t.stop()); return false; }
      this.streamAudioStream = stream;
      await room.localParticipant.publishTrack(track, { ...STREAM_AUDIO_PUBLISH, source: Track.Source.ScreenShareAudio, name: 'stream-audio' });
      if (this.room !== room || seq !== this.screenSeq) { await room.localParticipant.unpublishTrack(track).catch(() => undefined); stream.getTracks().forEach((t) => t.stop()); return false; }
      return true;
    } catch (err) {
      stream?.getTracks().forEach((t) => t.stop());
      if (this.streamAudioStream === stream) this.streamAudioStream = null;
      if (this.room !== room || seq !== this.screenSeq) return false;
      toast(`Не удалось взять звук для демонстрации с выбранного устройства. ${mediaErrorMessage(err, 'mic')}`, 'error');
      return false;
    }
  }

  private async stopStreamAudioDevice(): Promise<void> {
    const room = this.room;
    const stream = this.streamAudioStream;
    this.streamAudioStream = null;
    stream?.getTracks().forEach((t) => t.stop());
    const track = stream?.getAudioTracks()[0];
    if (room && track) await room.localParticipant.unpublishTrack(track).catch(() => undefined);
  }

  private screenQuality: StreamQuality | null = null;
  private streamLoad = new StreamLoadController();
  private screenUpdates: Promise<void> = Promise.resolve();

  /**
   * Switches the quality of a running screen share without re-opening the picker: new capture
   * constraints + content hint on the track, new bitrate/framerate on the RTP sender.
   */
  private async applyStreamQuality(quality: StreamQuality): Promise<void> {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare);
    const mst = pub?.track?.mediaStreamTrack;
    if (!pub?.track || !mst) return;
    const q = streamProfile(quality, 0, navigator.hardwareConcurrency || 4);
    try {
      if (!await this.applyScreenProfile(q, quality)) return;
      this.screenQuality = quality;
      this.streamLoad.reset();
      toast(`Качество демонстрации: ${q.label}`, 'success');
    } catch (err) {
      log.warn('stream quality change failed', { err: String(err) });
      toast('Не удалось сменить качество на ходу — перезапустите демонстрацию', 'error');
    }
  }

  private async applyScreenProfile(q: StreamProfile, quality: StreamQuality): Promise<boolean> {
    const track = this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
    if (!track) return false;
    let applied = false;
    const update = this.screenUpdates.catch(() => undefined).then(async () => {
      const current = () => this.room?.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track === track && track.mediaStreamTrack.readyState !== 'ended' && settingsStore.get().streamQuality === quality;
      if (!current()) return;
      track.mediaStreamTrack.contentHint = q.hint;
      await track.mediaStreamTrack.applyConstraints({ width: { max: q.width }, height: { max: q.height }, frameRate: { max: q.fps } });
      if (!current()) return;
      const sender = (track as unknown as { sender?: RTCRtpSender }).sender;
      if (!sender) return;
      const params = sender.getParameters();
      const capture = track.mediaStreamTrack.getSettings();
      const scale = Math.max(1, (capture.width ?? q.width) / q.width, (capture.height ?? q.height) / q.height);
      for (const enc of params.encodings ?? []) { enc.maxBitrate = q.bitrate; enc.maxFramerate = q.fps; enc.scaleResolutionDownBy = scale; }
      params.degradationPreference = q.degradation;
      await sender.setParameters(params);
      applied = current();
    });
    this.screenUpdates = update;
    await update;
    return applied;
  }

  async stopScreenShare(): Promise<void> {
    const seq = ++this.screenSeq;
    this.screenStarting=false;
    const room = this.room;
    const tracks = this.screenTracks;
    this.screenTracks = [];
    tracks.forEach((t) => t.stop());
    if (!room) return;
    this.screenQuality = null;
    this.streamLoad.reset();
    await this.stopStreamAudioDevice();
    await room.localParticipant.setScreenShareEnabled(false).catch(() => undefined);
    if (this.room !== room || this.screenSeq !== seq) return;
    voiceStore.set({ screen: false, screenAudio: null });
    this.bump();
    this.announce();
  }

  /** Re-opens the browser picker to choose another screen/window/tab. */
  async changeScreenSource(): Promise<void> {
    await this.stopScreenShare();
    await this.startScreenShare();
  }

  /** Subscribes/unsubscribes to someone's stream (video + its audio). */
  watchStream(identity: string, on: boolean): void {
    const p = this.room?.remoteParticipants.get(identity);
    if (!p) return;
    if (on) this.unwatched.delete(identity);
    else this.unwatched.add(identity);
    for (const pub of p.trackPublications.values()) {
      if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) pub.setSubscribed(on);
    }
    this.refreshParticipants();
  }

  getVideoTrack(identity: string, source: 'camera' | 'screen'): Track | null {
    if (!this.room) return null;
    const src = source === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare;
    const p = identity === this.room.localParticipant.identity ? this.room.localParticipant : this.room.remoteParticipants.get(identity);
    const track = p?.getTrackPublication(src)?.track;
    return track ?? null;
  }

  /** Applies per-user volume (0..2, client-side only). */
  setUserVolume(userId: string, volume: number): void {
    const s = settingsStore.get();
    settingsStore.set({ userVolumes: { ...s.userVolumes, [userId]: volume } });
  }

  setUserMuted(userId: string, muted: boolean): void {
    const s = settingsStore.get();
    settingsStore.set({ userMuted: { ...s.userMuted, [userId]: muted } });
  }

  async startAudioPlayback(): Promise<void> {
    await this.room?.startAudio();
    await this.ctx?.resume();
    voiceStore.set({ audioBlocked: false });
  }

  // ─────────────── microphone pipeline ───────────────

  private async ensureAudioContext(): Promise<AudioContext> {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx;
  }

  private micConstraints(s: Settings): MediaTrackConstraints {
    return {
      deviceId: s.inputDeviceId !== 'default' ? { exact: s.inputDeviceId } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
      channelCount: 1,
      sampleRate: 48000,
    };
  }

  private async acquireMic(): Promise<boolean> {
    const seq = ++this.micSeq;
    const room = this.room;
    if (!room) return false;
    const s = settingsStore.get();
    const ctx = await this.ensureAudioContext();
    const current = () => seq === this.micSeq && this.room === room;
    if (!current()) return false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints(s) });
    } catch (err) {
      if(!current())return false;
      if (['OverconstrainedError','NotFoundError'].includes((err as {name?:string}).name??'') && s.inputDeviceId !== 'default') {
        // Saved device was unplugged: fall back to the system default.
        this.prevSettings = { ...this.prevSettings, inputDeviceId: 'default' };
        settingsStore.set({ inputDeviceId: 'default' });
        stream = await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints(settingsStore.get()) });
      } else throw err;
    }
    try { await ensureMeterWorklet(ctx); } catch (err) { stream.getTracks().forEach((t) => t.stop()); throw err; }
    if (!current()) { stream.getTracks().forEach((t) => t.stop()); return false; }
    this.stopMeter?.();
    this.micSource?.disconnect();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = stream;
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.room !== room || this.micStream !== stream) return;
      toast('Микрофон отключён', 'error');
      void this.acquireMic().catch(() => undefined);
    });
    this.micSource = ctx.createMediaStreamSource(stream);
    if (!this.inputGain || !this.gate || !this.dest || this.dest.stream.getAudioTracks()[0]?.readyState === 'ended') {
      this.inputGain?.disconnect();
      this.gate?.disconnect();
      this.inputGain = ctx.createGain();
      this.gate = ctx.createGain();
      this.dest = ctx.createMediaStreamDestination();
      this.dest.channelCount = 1;
      this.inputGain.connect(this.gate);
      this.gate.connect(this.dest);
    }
    this.inputGain.gain.value = s.inputVolume;
    this.micSource.connect(this.inputGain);
    const stop = await createMeter(ctx, this.inputGain, ({ rmsDb }) => this.onLevelReading(rmsDb));
    if (!current()) { stop(); stream.getTracks().forEach((t) => t.stop()); return false; }
    this.stopMeter = stop;
    this.applyGate();
    return true;
  }

  private async startMicrophone(): Promise<void> {
    if (!this.room || this.micPub) return;
    if (!this.mayPublish(Track.Source.Microphone)) return;
    if (this.micStarting) return this.micStarting;
    const pending = this.publishMicrophone();
    this.micStarting = pending;
    try { await pending; } finally { if (this.micStarting === pending) this.micStarting = null; }
  }

  private async publishMicrophone(): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      if (!await this.acquireMic() || this.room !== room) return;
    } catch (err) {
      if (this.room !== room) return;
      toast(mediaErrorMessage(err, 'mic'), 'error');
      voiceStore.set({ selfMute: true });
      return;
    }
    const track = this.dest!.stream.getAudioTracks()[0]!;
    this.applyGate();
    if (voiceStore.get().serverMute || voiceStore.get().serverDeaf || !this.mayPublish(Track.Source.Microphone)) { this.releaseMicrophone(); return; }
    try {
      const publication = await room.localParticipant.publishTrack(track, { ...VOICE_AUDIO_PUBLISH, source: Track.Source.Microphone, name: 'microphone' });
      if (this.room !== room) { await room.localParticipant.unpublishTrack(publication.track!).catch(() => undefined); return; }
      this.micPub = publication;
      if (voiceStore.get().selfMute) await this.micPub.mute();
    } catch (err) {
      if (this.room !== room) return;
      log.warn('mic publish failed', { err: String(err) });
      toast('Не удалось передать звук микрофона', 'error');
    }
  }

  private mayPublish(source:Track.Source):boolean {
    const p=this.room?.localParticipant.permissions;
    return !!p?.canPublish && (!p.canPublishSources.length || p.canPublishSources.includes(Track.sourceToProto(source)));
  }

  private releaseMicrophone():void {
    ++this.micSeq;
    this.stopMeter?.();this.stopMeter=null;
    this.micStream?.getTracks().forEach(t=>t.stop());this.micStream=null;
    this.micSource?.disconnect();this.micSource=null;
    this.inputGain?.disconnect();this.gate?.disconnect();this.inputGain=null;this.gate=null;
    this.dest?.stream.getTracks().forEach(t=>t.stop());this.dest=null;
    const ctx=this.ctx;this.ctx=null;if(ctx)void ctx.close().catch(()=>undefined);
    voiceStore.set({gateOpen:false,localSpeaking:false});
    if(this.lastSpeakingSent){this.lastSpeakingSent=false;gateway.send('voice:speaking',{speaking:false});}
  }

  private onLevelReading(db: number): void {
    const s = settingsStore.get();
    this.vad.thresholdDb = s.vadThresholdDb;
    this.vad.auto = s.vadAuto;
    const vadOpen = this.vad.update(db);
    for (const l of this.levelListeners) l(db, this.vad.effectiveThreshold);
    const v = voiceStore.get();
    const gateOpen = this.computeGate();
    if (gateOpen !== v.gateOpen && s.inputMode === 'vad') this.applyGate();
    // Speaking = gate open AND real signal above the threshold.
    const speaking = gateOpen && (s.inputMode === 'vad' ? vadOpen : db > this.vad.effectiveThreshold);
    if (speaking !== v.localSpeaking) {
      voiceStore.set({ localSpeaking: speaking });
      this.refreshParticipants();
      if (speaking !== this.lastSpeakingSent) {
        this.lastSpeakingSent = speaking;
        gateway.send('voice:speaking', { speaking });
      }
    }
  }

  private computeGate(): boolean {
    const v = voiceStore.get();
    const s = settingsStore.get();
    if (v.selfMute || v.selfDeaf || v.serverMute || v.serverDeaf || this.mutedByBlur) return false;
    return s.inputMode === 'ptt' ? v.pttHeld : this.vad.isOpen;
  }

  private applyGate(): void {
    const open = this.computeGate();
    if (this.gate && this.ctx) {
      // 10 ms ramps avoid clicks when the gate toggles.
      this.gate.gain.setTargetAtTime(open ? 1 : 0, this.ctx.currentTime, 0.01);
    }
    const v = voiceStore.get();
    if (v.gateOpen !== open) voiceStore.set({ gateOpen: open });
    const shouldMute = v.selfMute || v.selfDeaf;
    if (this.micPub && this.micPub.isMuted !== shouldMute) void (shouldMute ? this.micPub.mute() : this.micPub.unmute());
  }

  private onWindowBlur(): void {
    // A key-up that happens while another window has focus is never delivered to us.
    if (voiceStore.get().pttHeld) this.setPtt(false);
    if (settingsStore.get().muteOnBlur && this.room) {
      this.mutedByBlur = true;
      this.applyGate();
    }
  }

  private onWindowFocus(): void {
    if (this.mutedByBlur) {
      this.mutedByBlur = false;
      this.applyGate();
    }
  }

  private prevSettings = settingsStore.get();
  private onSettingsChanged(s: Settings): void {
    const p = this.prevSettings;
    this.prevSettings = s;
    if (this.inputGain) this.inputGain.gain.value = s.inputVolume;
    if (!this.room) return;
    if (p.inputDeviceId !== s.inputDeviceId || p.noiseSuppression !== s.noiseSuppression || p.echoCancellation !== s.echoCancellation || p.autoGainControl !== s.autoGainControl) {
      // The published track comes from the WebAudio graph, so swapping the source needs no renegotiation.
      void this.acquireMic().catch((err) => toast(mediaErrorMessage(err, 'mic'), 'error'));
    }
    if (p.outputDeviceId !== s.outputDeviceId) void this.applyOutputDevice(s.outputDeviceId);
    if (p.videoDeviceId !== s.videoDeviceId && voiceStore.get().camera && s.videoDeviceId !== 'default') {
      void this.room.switchActiveDevice('videoinput', s.videoDeviceId).catch((err) => toast(mediaErrorMessage(err, 'camera'), 'error'));
    }
    if (p.inputMode !== s.inputMode) {
      voiceStore.set({ pttHeld: false });
      this.applyGate();
    }
    if (p.userVolumes !== s.userVolumes || p.userMuted !== s.userMuted || p.outputVolume !== s.outputVolume) this.applyVolumes();
    if (p.streamQuality !== s.streamQuality && voiceStore.get().screen) void this.applyStreamQuality(s.streamQuality);
  }

  private async applyOutputDevice(deviceId: string): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.switchActiveDevice('audiooutput', deviceId);
    } catch {
      toast('Браузер не поддерживает выбор устройства вывода', 'error');
    }
  }

  private applyVolumes(): void {
    if (!this.room) return;
    const s = settingsStore.get();
    const deaf = voiceStore.get().selfDeaf || voiceStore.get().serverDeaf;
    for (const p of this.room.remoteParticipants.values()) {
      const muted = s.userMuted[p.identity];
      // Media elements play at most 100% (see webAudioMix above).
      const base = Math.min(1, (s.userVolumes[p.identity] ?? 1) * s.outputVolume);
      const v = deaf || muted ? 0 : base;
      p.setVolume(v, Track.Source.Microphone);
      p.setVolume(deaf ? 0 : Math.min(1, (s.userVolumes[`stream:${p.identity}`] ?? 1) * s.outputVolume), Track.Source.ScreenShareAudio);
    }
  }

  // ─────────────── room events ───────────────

  private wireRoom(room: Room): void {
    room
      .on(RoomEvent.ParticipantConnected, (p) => {
        this.onParticipant(p);
        joinSound();
        this.refreshParticipants();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        leaveSound();
        this.refreshParticipants();
        this.bump();
      })
      .on(RoomEvent.TrackPublished, (pub, p) => {
        this.autoSubscribe(pub, p);
        this.refreshParticipants();
      })
      .on(RoomEvent.TrackUnpublished, () => {
        this.refreshParticipants();
        this.bump();
      })
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => this.onTrackSubscribed(track, p))
      .on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach().forEach((el) => { if (this.audioSink?.contains(el)) el.remove(); });
        this.refreshParticipants();
        this.bump();
      })
      .on(RoomEvent.TrackMuted, () => this.refreshParticipants())
      .on(RoomEvent.TrackUnmuted, () => this.refreshParticipants())
      .on(RoomEvent.ActiveSpeakersChanged, () => this.refreshParticipants())
      .on(RoomEvent.ConnectionQualityChanged, () => this.refreshParticipants())
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        const replacement=room.localParticipant.getTrackPublication(pub.source);
        if(replacement&&replacement!==pub&&replacement.track)return;
        // LiveKit republishes existing captures after a full reconnect. Do not stop them mid-resume.
        if(room.state===ConnectionState.Reconnecting)return;
        if (pub.source === Track.Source.Microphone) this.micPub = null;
        if(pub.source===Track.Source.Microphone && !this.mayPublish(Track.Source.Microphone))this.releaseMicrophone();
        // Covers the browser's own "Stop sharing" button.
        if (pub.source === Track.Source.ScreenShare) {
          const tracks = this.screenTracks;
          this.screenTracks = [];
          tracks.forEach((t) => t.stop());
          for (const track of tracks) if (track.source === Track.Source.ScreenShareAudio) void room.localParticipant.unpublishTrack(track).catch(() => undefined);
          this.screenQuality = null;
          this.streamLoad.reset();
          void this.stopStreamAudioDevice();
          voiceStore.set({ screen: false, screenAudio: null });
          this.announce();
        }
        if (pub.source === Track.Source.Camera) {
          if (!room.localParticipant.getTrackPublication(Track.Source.Camera)?.track) voiceStore.set({ camera: false });
          this.announce();
        }
        this.bump();
      })
      .on(RoomEvent.LocalTrackPublished, () => this.bump())
      .on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
        const v = voiceStore.get();
        if(participant===room.localParticipant&&!this.mayPublish(Track.Source.Microphone)){
          const pub=this.micPub;this.micPub=null;this.releaseMicrophone();
          if(pub?.track)void room.localParticipant.unpublishTrack(pub.track).catch(()=>undefined);
          return;
        }
        if (participant === room.localParticipant && !v.serverMute && !v.serverDeaf && !this.micPub) void this.startMicrophone();
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, () => voiceStore.set({ audioBlocked: !room.canPlaybackAudio }))
      .on(RoomEvent.MediaDevicesError, (err) => toast(mediaErrorMessage(err, 'mic'), 'error'))
      .on(RoomEvent.SignalReconnecting, () => log.info('webrtc signaling: reconnecting'))
      .on(RoomEvent.Reconnecting, () => {
        log.info('webrtc connection: reconnecting (ICE restart)');
        voiceStore.set({ status: 'reconnecting' });
      })
      .on(RoomEvent.Reconnected, () => {
        log.info('webrtc connection: reconnected');
        voiceStore.set({ status: 'connected' });
        this.micPub=room.localParticipant.getTrackPublication(Track.Source.Microphone)??null;
        if(!this.micPub)void this.startMicrophone();
        voiceStore.set({camera:!!room.localParticipant.getTrackPublication(Track.Source.Camera)?.track,
          screen:!!room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track});
        this.sampler.reset();
        this.announce();
      })
      .on(RoomEvent.ConnectionStateChanged, (state) => log.info('webrtc connection state', { state }))
      .on(RoomEvent.Disconnected, (reason) => void this.onDisconnected(reason));
  }

  private onParticipant(p: RemoteParticipant): void {
    for (const pub of p.trackPublications.values()) this.autoSubscribe(pub, p);
  }

  /**
   * Mic and camera are always subscribed. Streams (screen video + its audio) too when "auto-watch" is on
   * (default, so everyone hears the demo); otherwise only after "Смотреть трансляцию".
   */
  private autoSubscribe(pub: RemoteTrackPublication, p: RemoteParticipant): void {
    if (pub.source === Track.Source.Microphone || pub.source === Track.Source.Camera) pub.setSubscribed(true);
    else if ((pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) && settingsStore.get().autoWatchStreams && !this.unwatched.has(p.identity)) {
      pub.setSubscribed(true);
    }
  }

  /** Streams the user explicitly stopped watching (not re-subscribed automatically). */
  private unwatched = new Set<string>();

  private onTrackSubscribed(track: RemoteTrack, p: RemoteParticipant): void {
    applyPlaybackBuffer(track.receiver, playbackBufferTarget(track.source === Track.Source.ScreenShare || track.source === Track.Source.ScreenShareAudio, voiceStore.get().stats?.jitterMs ?? null));
    if (track.kind === Track.Kind.Audio) {
      this.audioSink ??= Object.assign(document.createElement('div'), { hidden: true });
      if (!this.audioSink.isConnected) document.body.appendChild(this.audioSink);
      const el = track.attach();
      this.audioSink.appendChild(el);
      this.applyVolumes();
      voiceStore.set({ audioBlocked: !this.room?.canPlaybackAudio });
    }
    void p;
    this.refreshParticipants();
    this.bump();
  }

  private async onDisconnected(reason?: DisconnectReason): Promise<void> {
    log.info('webrtc disconnected', { reason });
    if (this.intentionalLeave || !this.room) return;
    const channelId = voiceStore.get().channelId;
    const fatal = reason === DisconnectReason.PARTICIPANT_REMOVED || reason === DisconnectReason.ROOM_DELETED || reason === DisconnectReason.DUPLICATE_IDENTITY;
    if (fatal || !channelId) {
      if (reason === DisconnectReason.DUPLICATE_IDENTITY) toast('Вы подключились к голосу с другого устройства');
      await this.disconnect(false);
      return;
    }
    // Network recovery beyond LiveKit's own resume: rejoin with a fresh token, with backoff.
    voiceStore.set({ status: 'reconnecting' });
    const seq = this.joinSeq;
    if (voiceStore.get().screen) toast('Соединение восстанавливается. После подключения запустите демонстрацию снова.', 'info');
    await this.teardown();
    if (seq !== this.joinSeq || voiceStore.get().status !== 'reconnecting') return;
    const delay = Math.min(15_000, 1000 * 2 ** this.rejoinAttempts++);
    log.info('voice: rejoining', { delay });
    this.rejoinTimer = window.setTimeout(() => {
      this.rejoinTimer = null;
      if (voiceStore.get().channelId === channelId && voiceStore.get().status === 'reconnecting') {
        void this.join(channelId);
      }
    }, delay);
  }

  private async teardown(): Promise<void> {
    ++this.micSeq;
    ++this.screenSeq;
    ++this.cameraSeq;
    this.cameraStarting=false;
    this.screenStarting=false;
    this.micStarting = null;
    if (this.rejoinTimer !== null) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    if (this.pttReleaseTimer !== null) clearTimeout(this.pttReleaseTimer);
    this.pttReleaseTimer = null;
    this.mutedByBlur = false;
    this.vad = new VoiceActivityDetector(settingsStore.get().vadThresholdDb, settingsStore.get().vadAuto);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    // Detach ownership before awaiting anything: a stale teardown must never close a newer call.
    const room = this.room;
    const ctx = this.ctx;
    const streamAudio = this.streamAudioStream;
    const captured = [...this.screenTracks, ...this.cameraTracks];
    this.screenTracks = [];
    this.cameraTracks = [];
    this.room = null;
    this.ctx = null;
    this.streamAudioStream = null;
    room?.removeAllListeners();
    captured.forEach((t) => t.stop());
    streamAudio?.getTracks().forEach((t) => t.stop());
    this.screenQuality = null;
    this.streamLoad.reset();
    this.unwatched.clear();
    this.stopMeter?.();
    this.stopMeter = null;
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.micStream = null;
    this.micSource?.disconnect();
    this.micSource = null;
    this.micPub = null;
    this.inputGain?.disconnect();
    this.gate?.disconnect();
    this.inputGain = null;
    this.gate = null;
    this.dest = null;
    this.audioSink?.replaceChildren();
    this.sampler.reset();
    if (this.lastSpeakingSent) {
      this.lastSpeakingSent = false;
      gateway.send('voice:speaking', { speaking: false });
    }
    voiceStore.set({ participants: {}, stats: null, screen: false, screenAudio: null, camera: false, pttHeld: false, gateOpen: false, localSpeaking: false });
    await Promise.allSettled([room?.disconnect(), ctx?.close()]);
  }

  /** Tells the gateway our channel + self state so others see mute/camera/stream icons. */
  private announce(): void {
    const v = voiceStore.get();
    if (!v.channelId) return;
    gateway.send('voice:state', { channelId: v.channelId, selfMute: v.selfMute, selfDeaf: v.selfDeaf, camera: v.camera, screen: v.screen });
  }

  private bump(): void {
    voiceStore.set((s) => ({ version: s.version + 1 }));
  }

  private refreshParticipants(): void {
    const room = this.room;
    if (!room) return;
    const views: Record<string, ParticipantView> = {};
    const add = (p: Participant, isLocal: boolean) => {
      let meta: { avatarUrl?: string | null } = {};
      try {
        meta = p.metadata ? JSON.parse(p.metadata) : {};
      } catch {
        /* ignore */
      }
      const mic = p.getTrackPublication(Track.Source.Microphone);
      const screen = p.getTrackPublication(Track.Source.ScreenShare);
      views[p.identity] = {
        identity: p.identity,
        name: p.name || p.identity,
        avatarUrl: meta.avatarUrl ?? null,
        isLocal,
        speaking: isLocal ? voiceStore.get().localSpeaking : p.isSpeaking,
        micMuted: isLocal ? voiceStore.get().selfMute : !mic || mic.isMuted,
        hasCamera: !!p.getTrackPublication(Track.Source.Camera) && !p.getTrackPublication(Track.Source.Camera)!.isMuted,
        hasScreen: !!screen,
        hasScreenAudio: !!p.getTrackPublication(Track.Source.ScreenShareAudio),
        watchingScreen: isLocal ? !!screen : !!(screen as RemoteTrackPublication | undefined)?.isSubscribed,
        quality: QUALITY[p.connectionQuality] ?? 'unknown',
      };
    };
    add(room.localParticipant, true);
    for (const p of room.remoteParticipants.values()) add(p, false);
    voiceStore.set({ participants: views });
  }

  private startStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    let sampling = false;
    const tick = async () => {
      const room = this.room;
      if (!room || sampling) return;
      sampling = true;
      const local = [...room.localParticipant.trackPublications.values()].map((p) => p.track).filter((t): t is NonNullable<typeof t> => !!t);
      const remote = [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()].map((pub) => pub.track)).filter((t): t is NonNullable<typeof t> => !!t);
      try {
        const [pub, sub] = await Promise.all([Promise.all(local.map((t) => t.getRTCStatsReport())), Promise.all(remote.map((t) => t.getRTCStatsReport()))]);
        if (this.room !== room) return;
        const stats = this.sampler.sample(pub, sub);
        const prev = voiceStore.get().stats;
        if (prev?.iceState !== stats.iceState) log.info('webrtc ice state', { ice: stats.iceState, dtls: stats.dtlsState, transport: stats.transport });
        voiceStore.set({ stats });
        for (const track of remote) applyPlaybackBuffer(track.receiver, playbackBufferTarget(track.source === Track.Source.ScreenShare || track.source === Track.Source.ScreenShareAudio, stats.jitterMs));
        const screenTrack = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)?.track;
        const screenIndex = screenTrack ? local.indexOf(screenTrack) : -1;
        const screenReport = screenIndex >= 0 ? pub[screenIndex] : undefined;
        if (screenReport && this.screenQuality && this.screenQuality === settingsStore.get().streamQuality) {
          const q = streamProfile(this.screenQuality, this.streamLoad.tier, navigator.hardwareConcurrency || 4);
          if (this.streamLoad.sample(screenReport.values(), q.fps)) {
            await this.applyScreenProfile(streamProfile(this.screenQuality, this.streamLoad.tier, navigator.hardwareConcurrency || 4), this.screenQuality);
          }
        }
      } catch (err) {
        log.debug('stats failed', { err: String(err) });
      } finally {
        sampling = false;
      }
    };
    void tick();
    this.statsTimer = window.setInterval(() => void tick(), 1500);
  }
}

/** The backend may return a path ("/livekit"); turn it into a ws(s) URL on the current host. */
function resolveUrl(url: string): string {
  if (/^wss?:\/\//.test(url)) return url;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}${url.startsWith('/') ? url : `/${url}`}`;
}

export const voice = new VoiceEngine();

// Microphone test (settings page): same pipeline as a call, but played back locally and never sent.
export interface MicTest {
  stop(): void;
}

export async function startMicTest(opts: { loopback: boolean; onLevel: (db: number, thr: number) => void }): Promise<MicTest> {
  const s = settingsStore.get();
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: s.inputDeviceId !== 'default' ? { exact: s.inputDeviceId } : undefined,
      echoCancellation: s.echoCancellation,
      noiseSuppression: s.noiseSuppression,
      autoGainControl: s.autoGainControl,
    },
  });
  const src = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = s.inputVolume;
  src.connect(gain);
  const vad = new VoiceActivityDetector(s.vadThresholdDb, s.vadAuto);
  const stopMeter = await createMeter(ctx, gain, ({ rmsDb }) => {
    const st = settingsStore.get();
    vad.thresholdDb = st.vadThresholdDb;
    vad.auto = st.vadAuto;
    vad.update(rmsDb);
    opts.onLevel(rmsDb, vad.effectiveThreshold);
  });
  let audioEl: HTMLAudioElement | null = null;
  if (opts.loopback) {
    // Played through an <audio> element so the selected output device (setSinkId) is honoured.
    const out = ctx.createMediaStreamDestination();
    gain.connect(out);
    audioEl = new Audio();
    audioEl.srcObject = out.stream;
    if (s.outputDeviceId !== 'default' && 'setSinkId' in audioEl) {
      await (audioEl as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(s.outputDeviceId).catch(() => undefined);
    }
    await audioEl.play().catch(() => undefined);
  }
  return {
    stop() {
      stopMeter();
      audioEl?.pause();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
