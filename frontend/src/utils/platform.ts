/** Platform detection for keyboard labels and OS-specific permission hints. */
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
const platform = typeof navigator !== 'undefined' ? ((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '') : '';

export const IS_MAC = /Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/.test(ua);
export const IS_LINUX = !IS_MAC && /Linux/i.test(platform || ua) && !/Android/i.test(ua);
export const IS_WAYLAND = IS_LINUX && typeof navigator !== 'undefined' && /Wayland/i.test(ua);

/** Where the OS hides camera/microphone/screen permissions, if the browser was denied by the OS. */
export function osPermissionHint(kind: 'mic' | 'camera' | 'screen'): string {
  if (IS_MAC) {
    const item = kind === 'mic' ? 'Микрофон' : kind === 'camera' ? 'Камера' : 'Запись экрана и системного звука';
    return ` macOS: Системные настройки → Конфиденциальность и безопасность → ${item} — включите доступ для браузера и перезапустите его.`;
  }
  if (IS_LINUX) {
    if (kind === 'screen') return ' Linux: на Wayland нужен xdg-desktop-portal и PipeWire (в GNOME/KDE они уже есть).';
    return ' Linux: проверьте, что устройство не занято другим приложением и видно в PipeWire/PulseAudio.';
  }
  return '';
}
