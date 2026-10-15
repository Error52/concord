import { osPermissionHint } from '../utils/platform';

/** Media device helpers built on navigator.mediaDevices (real device lists, no placeholders). */

export interface DeviceLists {
  audioinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
  videoinput: MediaDeviceInfo[];
}

export const mediaSupported = (): boolean => !!navigator.mediaDevices?.getUserMedia;
export const outputSelectionSupported = (): boolean => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
export const screenShareSupported = (): boolean => !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;
export const pipSupported = (): boolean => typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;

export async function listDevices(): Promise<DeviceLists> {
  const out: DeviceLists = { audioinput: [], audiooutput: [], videoinput: [] };
  if (!navigator.mediaDevices?.enumerateDevices) return out;
  const all = await navigator.mediaDevices.enumerateDevices();
  for (const d of all) if (d.kind in out) out[d.kind as keyof DeviceLists].push(d);
  return out;
}

/** Labels are hidden until the user grants permission once; this asks for it. */
export async function ensureLabels(kind: 'audio' | 'video'): Promise<void> {
  const lists = await listDevices();
  const relevant = kind === 'audio' ? lists.audioinput : lists.videoinput;
  if (relevant.length > 0 && relevant.every((d) => d.label)) return;
  const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: true } : { video: true });
  stream.getTracks().forEach((t) => t.stop());
}

export function onDeviceChange(fn: () => void): () => void {
  navigator.mediaDevices?.addEventListener('devicechange', fn);
  return () => navigator.mediaDevices?.removeEventListener('devicechange', fn);
}

/** Maps getUserMedia errors to user-facing messages. */
export function mediaErrorMessage(err: unknown, kind: 'mic' | 'camera' | 'screen'): string {
  const name = (err as { name?: string })?.name;
  const what = kind === 'mic' ? 'микрофон' : kind === 'camera' ? 'камеру' : 'демонстрацию экрана';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      if (kind === 'screen') return `Демонстрация экрана отменена или запрещена.${osPermissionHint('screen')}`;
      return `Нет разрешения на использование ${kind === 'mic' ? 'микрофона' : 'камеры'}.${osPermissionHint(kind)}`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return kind === 'mic' ? 'Микрофон недоступен' : kind === 'camera' ? 'Камера не найдена' : 'Источник не найден';
    case 'NotReadableError':
    case 'AbortError':
      return `Не удалось получить ${what}: устройство занято или доступ запрещён системой.${osPermissionHint(kind)}`;
    default:
      if (!window.isSecureContext) return 'Медиа доступны только по HTTPS или на localhost';
      return `Не удалось включить ${what}`;
  }
}
