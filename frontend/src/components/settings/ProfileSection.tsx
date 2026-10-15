import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { setState, useApp } from '../../state/app';
import { toast } from '../../state/ui';
import { ProfileCard } from '../profile/ProfileCard';
import { Switch } from '../ui/Overlays';
import { PRESET_THEMES, readableTextOn } from '../../utils/color';
import type { ProfileTheme, SelfUser } from '../../types';

const ACCENTS = ['#7c6cff', '#5865f2', '#3b82f6', '#14b8a6', '#22c55e', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7'];

async function uploadImage(field: 'avatar' | 'banner' | 'background', file: File | null): Promise<void> {
  try {
    const me = file ? await api.putFile<SelfUser>(`/users/me/${field}`, file) : await api.del<SelfUser>(`/users/me/${field}`);
    setState({ me });
    toast(file ? 'Изображение обновлено' : 'Изображение удалено', 'success');
  } catch (err) {
    toast(errorMessage(err, 'Не удалось загрузить изображение'), 'error');
  }
}

function ImagePicker({ label, field, hint }: { label: string; field: 'avatar' | 'banner' | 'background'; hint: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row">
        <label className="btn btn-secondary btn-sm">
          Загрузить
          <input
            type="file"
            hidden
            accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 8 * 1024 * 1024) return toast('Файл больше 8 МБ', 'error');
              void uploadImage(field, f);
            }}
          />
        </label>
        <button className="btn btn-ghost btn-sm" onClick={() => void uploadImage(field, null)}>
          Удалить
        </button>
      </div>
      <span className="field-hint">{hint}</span>
    </div>
  );
}

export function ProfileSection() {
  const me = useApp((s) => s.me);
  const [draft, setDraft] = useState(() => snapshot(me));
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(snapshot(me)), [me?.id]);
  if (!me || !draft) return null;

  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot(me));
  const theme = draft.theme;
  const preset = PRESET_THEMES[theme.preset] ?? PRESET_THEMES.default!;
  const p1 = theme.primary ?? preset.primary;
  const p2 = theme.secondary ?? preset.secondary;
  // Same rule as the backend: some single text colour must reach WCAG AA (4.5:1) on both stops.
  const readable = readableTextOn(p1, p2) !== null;
  const setTheme = (patch: Partial<ProfileTheme>) => setDraft({ ...draft, theme: { ...theme, ...patch } });

  const save = async () => {
    if (!readable) return toast('Цвета темы делают текст нечитаемым', 'error');
    setBusy(true);
    try {
      const updated = await api.patch<SelfUser>('/users/me', {
        username: draft.username !== me.username ? draft.username : undefined,
        displayName: draft.displayName || null,
        bio: draft.bio,
        accentColor: draft.accentColor,
        bannerColor: draft.bannerColor,
        theme: draft.theme,
        customStatus: draft.statusText || draft.statusEmoji ? { text: draft.statusText || null, emoji: draft.statusEmoji || null } : null,
      });
      setState({ me: updated });
      toast('Профиль сохранён', 'success');
    } catch (err) {
      toast(errorMessage(err, 'Не удалось сохранить профиль'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const preview: SelfUser = {
    ...me,
    username: draft.username,
    displayName: draft.displayName || null,
    bio: draft.bio,
    accentColor: draft.accentColor,
    bannerColor: draft.bannerColor,
    theme: draft.theme,
    customStatus: draft.statusText || draft.statusEmoji ? { text: draft.statusText || null, emoji: draft.statusEmoji || null } : null,
  };

  return (
    <>
      <h2>Профиль</h2>
      <div className="profile-editor">
        <div className="col" style={{ gap: 18 }}>
          <div className="settings-grid">
            <label className="field">
              <span className="field-label">Отображаемое имя</span>
              <input className="input" maxLength={32} value={draft.displayName} onChange={(e) => setDraft({ ...draft, displayName: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Имя пользователя</span>
              <input className="input" maxLength={32} pattern="[a-zA-Z0-9_.]+" value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
            </label>
          </div>
          <label className="field">
            <span className="field-label">Обо мне</span>
            <textarea className="textarea" maxLength={400} value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} />
            <span className="field-hint">{draft.bio.length}/400</span>
          </label>
          <label className="field">
            <span className="field-label">Свой статус</span>
            <div className="row">
              <input className="input" style={{ width: 64, flex: 'none' }} maxLength={4} placeholder="🎮" value={draft.statusEmoji} onChange={(e) => setDraft({ ...draft, statusEmoji: e.target.value })} aria-label="Эмодзи статуса" />
              <input className="input" maxLength={128} placeholder="Играю в Minecraft" value={draft.statusText} onChange={(e) => setDraft({ ...draft, statusText: e.target.value })} aria-label="Текст статуса" />
            </div>
          </label>
          <div className="settings-grid">
            <ImagePicker label="Аватар" field="avatar" hint="PNG, JPEG, GIF, WebP · до 8 МБ · обрезается до 256×256" />
            <ImagePicker label="Баннер" field="banner" hint="Рекомендуется 960×384" />
          </div>
          <div className="field">
            <span className="field-label">Акцентный цвет</span>
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <div className="swatches">
                {ACCENTS.map((c) => (
                  <button key={c} className="swatch" style={{ background: c }} aria-pressed={draft.accentColor === c} onClick={() => setDraft({ ...draft, accentColor: c, bannerColor: c })} aria-label={c} />
                ))}
              </div>
              <span className="color-input">
                <input type="color" value={draft.accentColor} onChange={(e) => setDraft({ ...draft, accentColor: e.target.value })} aria-label="Свой акцентный цвет" />
              </span>
            </div>
          </div>
          <div className="field">
            <span className="field-label">Цвет баннера (если нет изображения)</span>
            <span className="color-input">
              <input type="color" value={draft.bannerColor} onChange={(e) => setDraft({ ...draft, bannerColor: e.target.value })} aria-label="Цвет баннера" />
              <code className="md-inline-code">{draft.bannerColor}</code>
            </span>
          </div>

          <h3 style={{ margin: '8px 0 0' }}>Тема профиля</h3>
          <div className="theme-chips">
            {Object.entries(PRESET_THEMES).map(([k, t]) => (
              <button key={k} className="theme-chip" aria-pressed={theme.preset === k} style={{ background: `linear-gradient(135deg, ${t.primary}, ${t.secondary})` }} onClick={() => setTheme({ preset: k, primary: t.primary, secondary: t.secondary })}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="settings-grid">
            <label className="field">
              <span className="field-label">Основной цвет</span>
              <span className="color-input">
                <input type="color" value={p1} onChange={(e) => setTheme({ preset: 'custom', primary: e.target.value, secondary: p2 })} />
                <code className="md-inline-code">{p1}</code>
              </span>
            </label>
            <label className="field">
              <span className="field-label">Дополнительный цвет</span>
              <span className="color-input">
                <input type="color" value={p2} onChange={(e) => setTheme({ preset: 'custom', primary: p1, secondary: e.target.value })} />
                <code className="md-inline-code">{p2}</code>
              </span>
            </label>
          </div>
          {!readable && <div className="field-error">Текст на таких цветах будет нечитаемым (контраст ниже 4.5:1). Выберите более тёмные или более светлые оттенки.</div>}
          <div className="field">
            <span className="field-label">Фон карточки</span>
            <div className="segmented">
              {(['gradient', 'solid', 'image'] as const).map((b) => (
                <button key={b} aria-pressed={(theme.background ?? 'gradient') === b} onClick={() => setTheme({ background: b })}>
                  {b === 'gradient' ? 'Градиент' : b === 'solid' ? 'Сплошной' : 'Изображение'}
                </button>
              ))}
            </div>
            {theme.background === 'image' && <ImagePicker label="Фоновое изображение" field="background" hint="Сжимается до 1200×1600, хранится в объектном хранилище" />}
          </div>
          <div className="field">
            <span className="field-label">Стиль карточки</span>
            <div className="segmented">
              {(['default', 'glass', 'outline'] as const).map((c) => (
                <button key={c} aria-pressed={(theme.cardStyle ?? 'default') === c} onClick={() => setTheme({ cardStyle: c })}>
                  {c === 'default' ? 'Обычный' : c === 'glass' ? 'Стекло' : 'Контур'}
                </button>
              ))}
            </div>
          </div>
          <div className="toggle-row">
            <span className="grow">Свечение профиля</span>
            <Switch checked={!!theme.glow} onChange={(glow) => setTheme({ glow })} label="Свечение" />
          </div>
        </div>
        <div>
          <span className="field-label" style={{ display: 'block', marginBottom: 8 }}>
            Предпросмотр
          </span>
          <div style={{ position: 'sticky', top: 0 }}>
            <ProfileCard user={preview} />
          </div>
        </div>
      </div>
      {dirty && (
        <div className="save-bar">
          <span className="grow">Есть несохранённые изменения</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setDraft(snapshot(me))}>
            Сбросить
          </button>
          <button className="btn btn-success btn-sm" disabled={busy || !readable} onClick={() => void save()}>
            Сохранить
          </button>
        </div>
      )}
    </>
  );
}

function snapshot(me: SelfUser | null) {
  if (!me) return null;
  return {
    username: me.username,
    displayName: me.displayName ?? '',
    bio: me.bio,
    accentColor: me.accentColor,
    bannerColor: me.bannerColor,
    theme: me.theme,
    statusText: me.customStatus?.text ?? '',
    statusEmoji: me.customStatus?.emoji ?? '',
  };
}
