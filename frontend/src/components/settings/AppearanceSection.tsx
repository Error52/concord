import { updateSettings, useSettings, type Theme } from '../../state/settings';
import { requestNotificationPermission } from '../../utils/notify';
import { toast } from '../../state/ui';
import { Switch } from '../ui/Overlays';

const ACCENTS = ['#7c6cff', '#5865f2', '#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#f59e0b', '#f97316', '#ef4444', '#ec4899'];

export function AppearanceSection() {
  const s = useSettings((x) => ({ theme: x.theme, accent: x.accent, density: x.density, fontScale: x.fontScale, chatBackground: x.chatBackground }));
  return (
    <>
      <h2>Внешний вид</h2>
      <h3>Тема</h3>
      <div className="row" style={{ gap: 12 }}>
        {(
          [
            ['dark', 'Тёмная', '#16171f'],
            ['light', 'Светлая', '#ffffff'],
            ['oled', 'OLED', '#000000'],
          ] as [Theme, string, string][]
        ).map(([k, l, c]) => (
          <button key={k} className="col" style={{ alignItems: 'center', gap: 6 }} onClick={() => updateSettings({ theme: k })} aria-pressed={s.theme === k}>
            <span style={{ width: 64, height: 64, borderRadius: '50%', background: c, border: `3px solid ${s.theme === k ? 'var(--accent)' : 'var(--border-strong)'}` }} />
            <span style={{ fontSize: '0.8125rem' }}>{l}</span>
          </button>
        ))}
      </div>
      <h3>Акцентный цвет</h3>
      <div className="row">
        <div className="swatches">
          {ACCENTS.map((c) => (
            <button key={c} className="swatch" style={{ background: c }} aria-pressed={s.accent === c} aria-label={c} onClick={() => updateSettings({ accent: c })} />
          ))}
        </div>
        <span className="color-input">
          <input type="color" value={s.accent} onChange={(e) => updateSettings({ accent: e.target.value })} aria-label="Свой цвет" />
        </span>
      </div>
      <h3>Отображение сообщений</h3>
      <div className="segmented">
        <button aria-pressed={s.density === 'comfortable'} onClick={() => updateSettings({ density: 'comfortable' })}>
          Комфортное
        </button>
        <button aria-pressed={s.density === 'compact'} onClick={() => updateSettings({ density: 'compact' })}>
          Компактное
        </button>
      </div>
      <h3>Размер шрифта — {Math.round(s.fontScale * 100)}%</h3>
      <input className="range" type="range" min={0.85} max={1.3} step={0.05} value={s.fontScale} onChange={(e) => updateSettings({ fontScale: Number(e.target.value) })} />
      <h3>Фон чата</h3>
      <div className="segmented">
        {(
          [
            ['none', 'Без фона'],
            ['dots', 'Точки'],
            ['gradient', 'Градиент'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} aria-pressed={s.chatBackground === k} onClick={() => updateSettings({ chatBackground: k })}>
            {l}
          </button>
        ))}
      </div>
    </>
  );
}

export function AccessibilitySection() {
  const s = useSettings((x) => ({ reducedMotion: x.reducedMotion, fontScale: x.fontScale }));
  return (
    <>
      <h2>Доступность</h2>
      <div className="card">
        <div className="toggle-row">
          <div className="grow">
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Уменьшить движение</div>
            <div className="field-hint">Отключает анимации и переходы. Также учитывается системная настройка.</div>
          </div>
          <Switch checked={s.reducedMotion} onChange={(v) => updateSettings({ reducedMotion: v })} label="Уменьшить движение" />
        </div>
        <label className="field" style={{ paddingTop: 12 }}>
          <span className="field-label">Масштаб текста — {Math.round(s.fontScale * 100)}%</span>
          <input className="range" type="range" min={0.85} max={1.3} step={0.05} value={s.fontScale} onChange={(e) => updateSettings({ fontScale: Number(e.target.value) })} />
        </label>
      </div>
    </>
  );
}

export function LanguageSection() {
  const lang = useSettings((x) => x.language);
  return (
    <>
      <h2>Язык</h2>
      <label className="field" style={{ maxWidth: 320 }}>
        <span className="field-label">Язык интерфейса</span>
        <select className="select" value={lang} onChange={(e) => updateSettings({ language: e.target.value as 'ru' | 'en' })}>
          <option value="ru">Русский</option>
          <option value="en">English (formats only)</option>
        </select>
      </label>
      <p className="field-hint">Интерфейс сейчас переведён на русский. Выбор English пока влияет только на язык поиска GIF.</p>
    </>
  );
}

export function NotificationsSection() {
  const s = useSettings((x) => ({ desktop: x.desktopNotifications, sounds: x.notificationSounds }));
  return (
    <>
      <h2>Уведомления</h2>
      <div className="card">
        <div className="toggle-row">
          <div className="grow">
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Уведомления на рабочем столе</div>
            <div className="field-hint">Личные сообщения, упоминания, запросы в друзья, звонки — когда окно не в фокусе.</div>
          </div>
          <Switch
            checked={s.desktop}
            onChange={async (v) => {
              if (v && !(await requestNotificationPermission())) return toast('Браузер запретил уведомления', 'error');
              updateSettings({ desktopNotifications: v });
            }}
            label="Уведомления на рабочем столе"
          />
        </div>
        <div className="toggle-row">
          <div className="grow">
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Звуки уведомлений</div>
          </div>
          <Switch checked={s.sounds} onChange={(v) => updateSettings({ notificationSounds: v })} label="Звуки" />
        </div>
      </div>
      <p className="field-hint">В статусе «Не беспокоить» уведомления и входящие звонки не показываются.</p>
    </>
  );
}
