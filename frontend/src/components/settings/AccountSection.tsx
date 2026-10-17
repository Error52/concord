import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { setState, useApp } from '../../state/app';
import type { SelfUser } from '../../types';
import { uiStore, toast } from '../../state/ui';
import { unblockUser } from '../../state/serverActions';
import { logout } from '../../state/actions';
import { Avatar } from '../ui/Avatar';
import { ProfileCard } from '../profile/ProfileCard';

export function AccountSection() {
  const me = useApp((s) => s.me);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  if (!me) return null;
  return (
    <>
      <h2>Моя учётная запись</h2>
      <ProfileCard user={me} className="" footer={<button className="btn btn-primary" onClick={() => uiStore.set({ settings: 'profile' })}>Редактировать профиль</button>} />
      <h3>Данные</h3>
      <div className="card col">
        <div className="row">
          <div className="grow">
            <div className="field-label">Имя пользователя</div>
            {me.username}
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => uiStore.set({ settings: 'profile' })}>
            Изменить
          </button>
        </div>
        <div>
          <div className="field-label">Email</div>
          {me.email}
          <span className="pill" style={{marginLeft:8}}>{me.emailVerified?'Почта подтверждена':'Почта не подтверждена'}</span>
        </div>
      </div>
      <h3>Пароль</h3>
      <form
        className="card col"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api.post('/auth/password/change', { currentPassword: cur, newPassword: next });
            toast('Пароль изменён. Остальные сеансы завершены.', 'success');
            setCur('');
            setNext('');
          } catch (err) {
            toast(errorMessage(err), 'error');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label className="field">
          <span className="field-label">Текущий пароль</span>
          <input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
        </label>
        <label className="field">
          <span className="field-label">Новый пароль</span>
          <input className="input" type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={busy}>
          Сменить пароль
        </button>
      </form>
      <h3>Сеанс</h3>
      <button className="btn btn-danger" onClick={() => void logout()}>
        Выйти из аккаунта
      </button>
    </>
  );
}

interface SessionRow {
  id: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  current: boolean;
}

export function SecuritySection() {
  const me = useApp((s) => s.me);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [disablePw, setDisablePw] = useState('');
  const [busy,setBusy]=useState(false);
  const performing=useRef(false);
  const perform=async(action:()=>Promise<void>)=>{
    if(performing.current)return;
    performing.current=true;setBusy(true);
    try{await action();}
    catch(err){toast(errorMessage(err,'Не удалось изменить настройки безопасности'),'error');}
    finally{performing.current=false;setBusy(false);}
  };
  const load = () => void api.get<SessionRow[]>('/auth/sessions').then(setSessions, () => undefined);
  useEffect(load, []);
  if (!me) return null;
  const refreshMe = async () => setState({ me: await api.get<SelfUser>('/users/me') });
  return (
    <>
      <h2>Безопасность</h2>
      <h3>Двухфакторная аутентификация (TOTP)</h3>
      <div className="card col">
        {me.totpEnabled ? (
          <>
            <p style={{ margin: 0 }}>✅ 2FA включена. При входе потребуется код из приложения-аутентификатора.</p>
            <div className="settings-grid">
              <input className="input" type="password" placeholder="Пароль" value={disablePw} onChange={(e) => setDisablePw(e.target.value)} />
              <input className="input" inputMode="numeric" maxLength={6} placeholder="Код 2FA" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </div>
            <button
              className="btn btn-danger"
              style={{ alignSelf: 'flex-start' }}
              disabled={busy}
              onClick={() => void perform(async () => {
                  await api.post('/auth/2fa/disable', { password: disablePw, code });
                  toast('2FA отключена', 'success');
                  setCode('');
                  setDisablePw('');
                  await refreshMe();
              })}
            >
              Отключить 2FA
            </button>
          </>
        ) : setup ? (
          <>
            <p style={{ margin: 0 }}>Добавьте ключ в приложение-аутентификатор (Google Authenticator, Aegis, 1Password) и введите код.</p>
            <div className="field">
              <span className="field-label">Секретный ключ</span>
              <code className="md-inline-code" style={{ fontSize: '1rem', padding: 8, userSelect: 'all', wordBreak: 'break-all' }}>
                {setup.secret.match(/.{1,4}/g)?.join(' ')}
              </code>
              <a className="link-btn" href={setup.otpauthUrl}>
                Открыть в приложении (otpauth://)
              </a>
            </div>
            <div className="row">
              <input className="input" style={{ maxWidth: 160 }} inputMode="numeric" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              <button
                className="btn btn-primary"
                disabled={busy||code.length !== 6}
                onClick={() => void perform(async () => {
                    await api.post('/auth/2fa/enable', { code });
                    toast('2FA включена', 'success');
                    setSetup(null);
                    setCode('');
                    await refreshMe();
                })}
              >
                Подтвердить
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }} className="muted">Защитите аккаунт одноразовыми кодами — даже утечка пароля не даст войти.</p>
            <button className="btn btn-primary" disabled={busy} style={{ alignSelf: 'flex-start' }} onClick={() => void perform(async()=>{setSetup(await api.post('/auth/2fa/setup'));})}>
              Включить 2FA
            </button>
          </>
        )}
      </div>
      <h3>Активные сеансы</h3>
      <div className="card">
        {sessions.map((s) => (
          <div key={s.id} className="session-row">
            <div className="grow">
              <div style={{ fontWeight: 600, color: 'var(--text-0)' }} className="ellipsis">
                {describeAgent(s.userAgent)} {s.current && <span className="pill" style={{ marginLeft: 6 }}>Этот сеанс</span>}
              </div>
              <div className="muted" style={{ fontSize: '0.8125rem' }}>
                {s.ip ?? '—'} · вход {new Date(s.createdAt).toLocaleString('ru-RU')}
              </div>
            </div>
            {!s.current && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={async () => {
                  await api.del(`/auth/sessions/${s.id}`).catch((err) => toast(errorMessage(err), 'error'));
                  load();
                }}
              >
                Завершить
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return 'Неизвестное устройство';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Браузер';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` · ${os}` : ''}`;
}

export function PrivacySection() {
  const blocked = useApp((s) => Object.values(s.relationships).filter((r) => r.type === 'blocked'));
  return (
    <>
      <h2>Конфиденциальность</h2>
      <p className="muted">
        Заблокированные пользователи не могут писать вам в личные сообщения, звонить и отправлять запросы в друзья. Сообщения в
        DM и файлы доступны только участникам диалога.
      </p>
      <h3>Заблокированные — {blocked.length}</h3>
      <div className="card">
        {blocked.length === 0 && <span className="muted">Список пуст.</span>}
        {blocked.map((r) => (
          <div key={r.id} className="session-row">
            <Avatar user={r.user} size={32} />
            <span className="grow">{r.user.displayName || r.user.username}</span>
            <button className="btn btn-secondary btn-sm" onClick={() => void unblockUser(r.id)}>
              Разблокировать
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
