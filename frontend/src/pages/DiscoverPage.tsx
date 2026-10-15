import { useEffect, useState } from 'react';
import { LuCompass, LuMenu, LuUsers } from 'react-icons/lu';
import { api, errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { navigate } from '../state/router';
import { uiStore, toast } from '../state/ui';
import { joinPublic } from '../state/serverActions';
import { firstTextChannel } from '../state/actions';
import { getState } from '../state/app';
import { initials, plural } from '../utils/format';
import type { Server } from '../types';

export function DiscoverPage() {
  const [q, setQ] = useState('');
  const [servers, setServers] = useState<Server[] | null>(null);
  const mine = useApp((s) => s.servers);
  useEffect(() => {
    const t = setTimeout(() => {
      api.get<Server[]>(`/servers/discover${q ? `?q=${encodeURIComponent(q)}` : ''}`).then(setServers, (err) => toast(errorMessage(err), 'error'));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <div className="main-col">
      <header className="main-head">
        <button className="icon-btn mobile-only" onClick={() => uiStore.set({ mobilePanel: 'nav' })} aria-label="Меню">
          <LuMenu />
        </button>
        <div className="main-head-title">
          <LuCompass /> Обзор серверов
        </div>
      </header>
      <div className="scroll" style={{ flex: 1, padding: 24 }}>
        <div style={{ maxWidth: 980, margin: '0 auto' }}>
          <div className="pcard" style={{ width: '100%', padding: '32px 28px', marginBottom: 20, ['--p1' as string]: '#2a1650', ['--p2' as string]: '#0f2347' }}>
            <h1 style={{ color: '#fff', fontSize: '1.75rem' }}>Найдите своё сообщество</h1>
            <p style={{ opacity: 0.8 }}>Публичные серверы, открытые для всех.</p>
            <input className="input" style={{ maxWidth: 420, marginTop: 8 }} placeholder="Поиск серверов" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 14 }}>
            {servers === null && Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" style={{ height: 200, borderRadius: 14 }} />)}
            {servers?.length === 0 && <p className="muted">Ничего не найдено.</p>}
            {servers?.map((s) => (
              <article key={s.id} style={{ background: 'var(--bg-3)', borderRadius: 14, overflow: 'hidden', border: '1px solid var(--border)' }}>
                <div style={{ height: 90, background: s.bannerUrl ? `url(${s.bannerUrl}) center/cover` : 'linear-gradient(135deg, var(--accent), #14b8a6)' }} />
                <div style={{ padding: 14, marginTop: -36 }}>
                  <div className="rail-btn" style={{ borderRadius: 14, width: 56, height: 56, border: '4px solid var(--bg-3)' }}>
                    {s.iconUrl ? <img src={s.iconUrl} alt="" /> : initials(s.name)}
                  </div>
                  <h3 style={{ marginTop: 8 }}>{s.name}</h3>
                  <p className="muted" style={{ fontSize: '0.875rem', minHeight: 36 }}>{s.description || 'Без описания'}</p>
                  <div className="row">
                    <span className="muted row" style={{ fontSize: '0.8125rem', gap: 4 }}>
                      <LuUsers style={{ width: 14 }} /> {s.memberCount} {plural(s.memberCount ?? 0, 'участник', 'участника', 'участников')}
                    </span>
                    <span className="grow" />
                    {mine[s.id] ? (
                      <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'channel', serverId: s.id, channelId: firstTextChannel(getState(), s.id) })}>
                        Открыть
                      </button>
                    ) : (
                      <button className="btn btn-primary btn-sm" onClick={() => void joinPublic(s.id)}>
                        Присоединиться
                      </button>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
