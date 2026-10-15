import { useEffect, useState } from 'react';
import { DEFAULT_SETTINGS, formatKeybind, settingsStore, updateSettings, useSettings, type Keybind, type KeybindAction } from '../../state/settings';

const ACTIONS: [KeybindAction, string, string][] = [
  ['pushToTalk', 'Push-to-Talk (рация)', 'Удерживайте, чтобы говорить в режиме рации'],
  ['toggleMute', 'Микрофон вкл/выкл', ''],
  ['toggleDeafen', 'Звук вкл/выкл', ''],
  ['toggleCamera', 'Камера вкл/выкл', ''],
  ['toggleScreenShare', 'Демонстрация экрана', ''],
  ['toggleFullscreen', 'Полноэкранный режим', ''],
];

const MODIFIERS = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

/** Records a key (with modifiers) or an extra mouse button (back/forward/middle). */
function Recorder({ onDone }: { onDone: (k: Keybind | null) => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') return onDone(null);
      if (MODIFIERS.has(e.code)) return;
      onDone({ key: e.code, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    };
    const mouse = (e: MouseEvent) => {
      if (e.button < 1) return; // left click is reserved for the UI
      e.preventDefault();
      onDone({ key: `Mouse${e.button}`, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, meta: e.metaKey });
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('mousedown', mouse, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', mouse, true);
    };
  }, [onDone]);
  return null;
}

export function KeybindsSection() {
  const binds = useSettings((s) => s.keybinds);
  const [recording, setRecording] = useState<KeybindAction | null>(null);
  return (
    <>
      <h2>Горячие клавиши</h2>
      <p className="muted">Нажмите на сочетание и введите новое (клавиша с модификаторами или боковая кнопка мыши). Esc — отмена.</p>
      <div className="card">
        {ACTIONS.map(([k, label, hint]) => (
          <div key={k} className="keybind-row">
            <div className="grow">
              <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{label}</div>
              {hint && <div className="field-hint">{hint}</div>}
            </div>
            <button className={`kbd${recording === k ? ' recording' : ''}`} onClick={() => setRecording(k)}>
              {recording === k ? 'Нажмите клавишу…' : formatKeybind(binds[k])}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => updateSettings({ keybinds: { ...settingsStore.get().keybinds, [k]: null } })}>
              Очистить
            </button>
          </div>
        ))}
      </div>
      <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={() => updateSettings({ keybinds: DEFAULT_SETTINGS.keybinds })}>
        Сбросить по умолчанию
      </button>
      {recording && (
        <Recorder
          onDone={(kb) => {
            if (kb) updateSettings({ keybinds: { ...settingsStore.get().keybinds, [recording]: kb } });
            setRecording(null);
          }}
        />
      )}
    </>
  );
}
