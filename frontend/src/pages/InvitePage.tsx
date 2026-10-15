import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { navigate } from '../state/router';
import { joinByInvite } from '../state/serverActions';
import { initials, plural } from '../utils/format';
import type { Server, User } from '../types';

interface Preview {
  code: string;
  server: Server;
  inviter: User | null;
  expiresAt: string | null;
}

/** /invite/:code — works for guests (shows login) and members. */
export function InvitePage({ code }: { code: string }) {
  const auth = useApp((s) => s.auth);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current=true;setPreview(null);setError(null);setBusy(false);
    api.get<Preview>(`/invites/${encodeURIComponent(code)}`).then(d=>{if(current)setPreview(d);}, (err) => {if(current)setError(errorMessage(err, 'Приглашение недействительно'));});
    return ()=>{current=false;};
  }, [code]);
  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        {error ? (
          <>
            <h1>Приглашение недействительно</h1>
            <p className="auth-sub">{error}</p>
            <button className="btn btn-primary btn-block" onClick={() => navigate({ name: 'friends' })}>
              На главную
            </button>
          </>
        ) : !preview ? (
          <div className="skeleton" style={{ height: 200 }} />
        ) : (
          <>
            <div className="rail-btn" style={{ width: 80, height: 80, borderRadius: 24, margin: '0 auto 14px', fontSize: '1.5rem' }}>
              {preview.server.iconUrl ? <img src={preview.server.iconUrl} alt="" /> : initials(preview.server.name)}
            </div>
            <p className="muted">{preview.inviter ? `${preview.inviter.displayName || preview.inviter.username} приглашает вас на сервер` : 'Вас пригласили на сервер'}</p>
            <h1>{preview.server.name}</h1>
            <p className="auth-sub">
              {preview.server.memberCount} {plural(preview.server.memberCount ?? 0, 'участник', 'участника', 'участников')}
            </p>
            {auth === 'authed' ? (
              <button
                className="btn btn-primary btn-block"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  if (!(await joinByInvite(code))) setBusy(false);
                }}
              >
                Принять приглашение
              </button>
            ) : (
              <button
                className="btn btn-primary btn-block"
                onClick={() => {
                  sessionStorage.setItem('concord.pendingInvite', code);
                  navigate({ name: 'login' });
                }}
              >
                Войти, чтобы принять
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
