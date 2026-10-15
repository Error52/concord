import { useEffect } from 'react';
import { settingsStore, type Keybind, type KeybindAction } from '../state/settings';
import { voice, voiceStore } from '../webrtc/voiceEngine';
import { toggleFullscreen } from '../components/voice/VideoTile';

function matches(k: Keybind | null, code: string, e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }, strictMods: boolean): boolean {
  if (!k || k.key !== code) return false;
  if (!strictMods) return (!k.ctrl || e.ctrlKey) && (!k.shift || e.shiftKey) && (!k.alt || e.altKey) && (!k.meta || e.metaKey);
  return k.ctrl === e.ctrlKey && k.shift === e.shiftKey && k.alt === e.altKey && k.meta === e.metaKey;
}

const isTyping = (t: EventTarget | null): boolean => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
};

/**
 * Global keybinds. Push-to-talk works on keydown/keyup (and mouse side buttons), ignores key repeat,
 * and is released when the window loses focus (handled in the voice engine) since keyup events
 * that happen in other windows are never delivered to a web page.
 */
export function useHotkeys(): void {
  useEffect(() => {
    let pttDown = false;
    const action = (a: KeybindAction): void => {
      if (voiceStore.get().status === 'idle' && a !== 'toggleFullscreen' && a !== 'toggleMute' && a !== 'toggleDeafen') return;
      switch (a) {
        case 'toggleMute':
          voice.toggleMute();
          break;
        case 'toggleDeafen':
          voice.toggleDeafen();
          break;
        case 'toggleCamera':
          void voice.setCamera(!voiceStore.get().camera);
          break;
        case 'toggleScreenShare':
          void (voiceStore.get().screen ? voice.stopScreenShare() : voice.startScreenShare());
          break;
        case 'toggleFullscreen':
          void toggleFullscreen(document.querySelector('.stage'));
          break;
        default:
          break;
      }
    };

    const onDown = (code: string, e: KeyboardEvent | MouseEvent, repeat: boolean): boolean => {
      const s = settingsStore.get();
      // PTT: modifiers may be held in addition (gamers often hold Shift while running).
      if (s.inputMode === 'ptt' && matches(s.keybinds.pushToTalk, code, e, false)) {
        if (!repeat && !pttDown) {
          pttDown = true;
          voice.setPtt(true);
        }
        return true;
      }
      if (repeat) return false;
      for (const a of ['toggleMute', 'toggleDeafen', 'toggleCamera', 'toggleScreenShare', 'toggleFullscreen'] as KeybindAction[]) {
        if (matches(s.keybinds[a], code, e, true)) {
          action(a);
          return true;
        }
      }
      return false;
    };

    const onUp = (code: string): void => {
      const s = settingsStore.get();
      if (pttDown && s.keybinds.pushToTalk?.key === code) {
        pttDown = false;
        voice.setPtt(false);
      }
    };

    const keydown = (e: KeyboardEvent) => {
      const kb = settingsStore.get().keybinds.pushToTalk;
      // Plain-letter PTT shouldn't fire while typing a message; modifier combos still work.
      const plain = !(e.ctrlKey || e.altKey || e.metaKey);
      if (isTyping(e.target) && plain && !(kb && kb.key === e.code && (kb.ctrl || kb.alt || kb.meta))) return;
      if (onDown(e.code, e, e.repeat)) e.preventDefault();
    };
    const keyup = (e: KeyboardEvent) => onUp(e.code);
    const mousedown = (e: MouseEvent) => {
      if (e.button >= 1 && onDown(`Mouse${e.button}`, e, false)) e.preventDefault();
    };
    const mouseup = (e: MouseEvent) => e.button >= 1 && onUp(`Mouse${e.button}`);
    const release = () => {
      if (pttDown) {
        pttDown = false;
        voice.setPtt(false);
      }
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('mousedown', mousedown);
    window.addEventListener('mouseup', mouseup);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('mousedown', mousedown);
      window.removeEventListener('mouseup', mouseup);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
    };
  }, []);
}
