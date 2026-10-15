import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { LuX } from 'react-icons/lu';
import { uiStore, useUi, type SettingsSection } from '../../state/ui';
import { logout } from '../../state/actions';
import { AccountSection, PrivacySection, SecuritySection } from './AccountSection';
import { ProfileSection } from './ProfileSection';
import { VoiceSection } from './VoiceSection';
import { AccessibilitySection, AppearanceSection, LanguageSection, NotificationsSection } from './AppearanceSection';
import { KeybindsSection } from './KeybindsSection';
import { AdminSection } from './AdminSection';
import { useApp } from '../../state/app';

const NAV: { group: string; items: [SettingsSection, string][] }[] = [
  {
    group: 'Пользователь',
    items: [
      ['account', 'Моя учётная запись'],
      ['profile', 'Профиль'],
      ['privacy', 'Конфиденциальность'],
      ['security', 'Безопасность'],
    ],
  },
  {
    group: 'Приложение',
    items: [
      ['notifications', 'Уведомления'],
      ['voice', 'Голос и видео'],
      ['appearance', 'Внешний вид'],
      ['accessibility', 'Доступность'],
      ['language', 'Язык'],
      ['keybinds', 'Горячие клавиши'],
    ],
  },
];

export function SettingsPage() {
  const section = useUi((s) => s.settings);
  const isAdmin = useApp((s) => !!s.me?.isPlatformAdmin);
  const nav = isAdmin ? [...NAV, { group: 'Платформа', items: [['admin', 'Админ-панель']] as [SettingsSection, string][] }] : NAV;
  useEffect(() => {
    if (!section) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.overlay')) uiStore.set({ settings: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [section]);
  if (!section) return null;
  const go = (s: SettingsSection) => uiStore.set({ settings: s });
  return createPortal(
    <div className="settings" role="dialog" aria-label="Настройки">
      <aside className="settings-nav scroll">
        <nav>
          {nav.map((g) => (
            <div key={g.group} style={{ display: 'contents' }}>
              <h4>{g.group}</h4>
              {g.items.map(([k, l]) => (
                <button key={k} aria-current={section === k ? 'page' : undefined} onClick={() => go(k)}>
                  {l}
                </button>
              ))}
            </div>
          ))}
          <div className="menu-divider" />
          <button style={{ color: 'var(--red)' }} onClick={() => void logout()}>
            Выйти
          </button>
        </nav>
      </aside>
      <main className="settings-content scroll">
        {section === 'account' && <AccountSection />}
        {section === 'profile' && <ProfileSection />}
        {section === 'privacy' && <PrivacySection />}
        {section === 'security' && <SecuritySection />}
        {section === 'notifications' && <NotificationsSection />}
        {section === 'voice' && <VoiceSection />}
        {section === 'appearance' && <AppearanceSection />}
        {section === 'accessibility' && <AccessibilitySection />}
        {section === 'language' && <LanguageSection />}
        {section === 'keybinds' && <KeybindsSection />}
        {section === 'admin' && <AdminSection />}
      </main>
      <div className="settings-close">
        <button onClick={() => uiStore.set({ settings: null })} aria-label="Закрыть настройки">
          <LuX />
        </button>
        <span>ESC</span>
      </div>
    </div>,
    document.body,
  );
}
