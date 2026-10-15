import { createStore, useStoreSelector } from './store';
import { IS_MAC } from '../utils/platform';

/**
 * Client-side preferences, persisted in localStorage per browser. Includes audio devices,
 * input mode (voice activity / push-to-talk), keybinds and per-user volumes — these must never
 * affect other users, so they are deliberately not stored on the server.
 */

export type InputMode = 'vad' | 'ptt';
export type Theme = 'dark' | 'light' | 'oled';
export type Density = 'comfortable' | 'compact';

export interface Keybind {
  key: string; // KeyboardEvent.code, or "Mouse3"/"Mouse4" for side buttons
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

export type KeybindAction = 'pushToTalk' | 'toggleMute' | 'toggleDeafen' | 'toggleCamera' | 'toggleScreenShare' | 'toggleFullscreen';

export type StreamQuality = 'auto' | '720p30' | '1080p30' | '1080p60' | 'text';

export interface Settings {
  theme: Theme;
  accent: string;
  density: Density;
  fontScale: number;
  reducedMotion: boolean;
  chatBackground: 'none' | 'dots' | 'gradient';
  language: 'ru' | 'en';

  inputDeviceId: string;
  outputDeviceId: string;
  videoDeviceId: string;
  inputVolume: number; // 0..2 (gain applied before sending)
  outputVolume: number; // 0..2
  inputMode: InputMode;
  /** Voice activity threshold in dBFS (-100..0). */
  vadThresholdDb: number;
  vadAuto: boolean;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  autoGainControl: boolean;
  pttReleaseDelayMs: number;
  muteOnBlur: boolean;
  /** 'auto' = audio captured by the browser with the screen; otherwise an input device used as stream audio. */
  streamAudioDeviceId: string;
  /** Automatically watch/hear other people's screen shares (like a shared demo). */
  autoWatchStreams: boolean;
  /** Quality of your own screen share (see STREAM_QUALITIES in voiceEngine). */
  streamQuality: StreamQuality;

  keybinds: Record<KeybindAction, Keybind | null>;
  userVolumes: Record<string, number>; // userId → 0..2
  userMuted: Record<string, boolean>;

  desktopNotifications: boolean;
  notificationSounds: boolean;
}

const kb = (key: string, mods: Partial<Keybind> = {}): Keybind => ({ key, ctrl: false, shift: false, alt: false, meta: false, ...mods });

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  accent: '#7c6cff',
  density: 'comfortable',
  fontScale: 1,
  reducedMotion: false,
  chatBackground: 'none',
  language: 'ru',
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  videoDeviceId: 'default',
  inputVolume: 1,
  outputVolume: 1,
  inputMode: 'vad',
  vadThresholdDb: -50,
  vadAuto: true,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  pttReleaseDelayMs: 150,
  muteOnBlur: false,
  streamAudioDeviceId: 'auto',
  autoWatchStreams: true,
  streamQuality: 'auto',
  keybinds: {
    pushToTalk: kb('KeyV'),
    toggleMute: kb('KeyM', { ctrl: true, shift: true }),
    toggleDeafen: kb('KeyD', { ctrl: true, shift: true }),
    toggleCamera: kb('KeyC', { ctrl: true, shift: true }),
    toggleScreenShare: kb('KeyS', { ctrl: true, shift: true }),
    toggleFullscreen: kb('KeyF', { ctrl: true, shift: true }),
  },
  userVolumes: {},
  userMuted: {},
  desktopNotifications: false,
  notificationSounds: true,
};

const KEY = 'concord.settings.v1';

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...parsed, keybinds: { ...DEFAULT_SETTINGS.keybinds, ...parsed.keybinds } };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export const settingsStore = createStore<Settings>(load());

settingsStore.subscribe(() => {
  try {
    localStorage.setItem(KEY, JSON.stringify(settingsStore.get()));
  } catch {
    /* storage full or disabled — settings stay in memory */
  }
});

export function updateSettings(patch: Partial<Settings>): void {
  settingsStore.set(patch);
}

export function useSettings<T>(selector: (s: Settings) => T): T {
  return useStoreSelector(settingsStore, selector);
}

export function formatKeybind(k: Keybind | null): string {
  if (!k) return 'Не назначено';
  const parts: string[] = [];
  // macOS shows the native modifier symbols; Ctrl stays Ctrl (⌃) so defaults don't clash with ⌘ browser shortcuts.
  if (k.ctrl) parts.push(IS_MAC ? '⌃' : 'Ctrl');
  if (k.alt) parts.push(IS_MAC ? '⌥' : 'Alt');
  if (k.shift) parts.push(IS_MAC ? '⇧' : 'Shift');
  if (k.meta) parts.push(IS_MAC ? '⌘' : 'Win');
  parts.push(keyLabel(k.key));
  return parts.join(IS_MAC ? ' ' : ' + ');
}

export function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Mouse')) return `Мышь ${Number(code.slice(5)) + 1}`;
  const map: Record<string, string> = { Space: 'Пробел', Backquote: '`', CapsLock: 'Caps Lock', Backslash: '\\' };
  return map[code] ?? code.replace(/^(Arrow|Numpad)/, '$1 ');
}
