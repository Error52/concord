import { useEffect, useState } from 'react';
import { LuHash, LuSearch, LuVolume2 } from 'react-icons/lu';
import { api, errorMessage } from '../../api/client';
import { getState, useApp } from '../../state/app';
import { channelsOf, displayName } from '../../state/actions';
import { navigate } from '../../state/router';
import { openDm } from '../../state/serverActions';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { MessageBody } from '../chat/MessageItem';
import { formatTimestamp, initials } from '../../utils/format';
import type { SearchResult, Server, User } from '../../types';

interface Quick {
  users: User[];
  servers: Server[];
  channels: { id: string; name: string; type: string; serverId: string; serverName: string }[];
}

type Has = 'link' | 'image' | 'file' | 'gif';
const HAS: [Has, string][] = [
  ['link', 'Ссылки'],
  ['image', 'Изображения'],
  ['file', 'Файлы'],
  ['gif', 'GIF'],
];
const PAGE = 25;

/** Global search: people/servers/channels instantly, messages via the backend full-text index with filters. */
export function SearchModal({ serverId, channelId, onClose }: { serverId: string | null; channelId?: string; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<'all' | 'server' | 'channel'>(channelId ? 'channel' : serverId ? 'server' : 'all');
  const [authorId, setAuthorId] = useState('');
  const [inChannel, setInChannel] = useState(channelId ?? '');
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [has, setHas] = useState<Has[]>([]);
  const [offset, setOffset] = useState(0);
  const [quick, setQuick] = useState<Quick | null>(null);
  const [results, setResults] = useState<{ total: number; results: SearchResult[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const members = useApp((s) => (serverId ? Object.values(s.members[serverId] ?? {}).map((m) => s.users[m.user.id] ?? m.user) : []));
  const channels = useApp((s) => (serverId ? channelsOf(s, serverId).filter((c) => c.type === 'text') : []));
  const serverName = useApp((s) => (serverId ? s.servers[serverId]?.name : null));

  useEffect(() => setOffset(0), [q, scope, authorId, inChannel, before, after, has]);

  useEffect(() => {
    let current=true;
    setQuick(null);setResults(null);setError(null);setLoading(false);
    const t = setTimeout(async () => {
      if (q.trim() && scope === 'all') api.get<Quick>(`/search?q=${encodeURIComponent(q.trim())}`).then(d=>{if(current)setQuick(d);}, () => {if(current)setQuick(null);});
      else setQuick(null);
      if (!q.trim() && !authorId && !has.length && !before && !after) {
        setResults(null);
        return;
      }
      const params = new URLSearchParams();
      if (q.trim()) params.set('q', q.trim());
      if (scope === 'server' && serverId) params.set('serverId', serverId);
      if (scope !== 'all' && inChannel) params.set('channelId', inChannel);
      if (scope === 'channel' && channelId) params.set('channelId', channelId);
      if (authorId) params.set('authorId', authorId);
      if (before) params.set('before', before);
      if (after) params.set('after', after);
      has.forEach((h) => params.append('has', h));
      params.set('offset', String(offset));
      params.set('limit', String(PAGE));
      setLoading(true);
      try {
        const data=await api.get<{total:number;results:SearchResult[]}>(`/search/messages?${params}`);
        if(!current)return;
        setResults(data);
        setError(null);
      } catch (err) {
        if(current)setError(errorMessage(err));
      } finally {
        if(current)setLoading(false);
      }
    }, 300);
    return () => {current=false;clearTimeout(t);};
  }, [q, scope, authorId, inChannel, before, after, has, offset, serverId, channelId]);

  const jump = (m: SearchResult) => {
    onClose();
    if (m.serverId) navigate({ name: 'channel', serverId: m.serverId, channelId: m.channelId, messageId: m.id });
    else navigate({ name: 'dm', channelId: m.channelId, messageId: m.id });
  };

  return (
    <Modal title="Поиск" onClose={onClose} width={720}>
      <div className="row composer" style={{ padding: '4px 10px' }}>
        <LuSearch />
        <input className="input" style={{ border: 0, background: 'transparent' }} placeholder="Сообщения, люди, серверы, каналы…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div className="segmented">
          <button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
            Везде
          </button>
          {serverId && (
            <button aria-pressed={scope === 'server'} onClick={() => setScope('server')}>
              {serverName}
            </button>
          )}
          {channelId && (
            <button aria-pressed={scope === 'channel'} onClick={() => setScope('channel')}>
              Этот канал
            </button>
          )}
        </div>
        {serverId && scope === 'server' && (
          <select className="select" style={{ width: 'auto' }} value={inChannel} onChange={(e) => setInChannel(e.target.value)} aria-label="В канале">
            <option value="">В: любой канал</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                #{c.name}
              </option>
            ))}
          </select>
        )}
        {serverId && scope !== 'all' && (
          <select className="select" style={{ width: 'auto' }} value={authorId} onChange={(e) => setAuthorId(e.target.value)} aria-label="От пользователя">
            <option value="">От: кто угодно</option>
            {members.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName || u.username}
              </option>
            ))}
          </select>
        )}
        <label className="row" style={{ fontSize: '0.8125rem' }}>
          После <input className="input" type="date" style={{ width: 'auto', padding: '6px 8px' }} value={after} onChange={(e) => setAfter(e.target.value)} />
        </label>
        <label className="row" style={{ fontSize: '0.8125rem' }}>
          До <input className="input" type="date" style={{ width: 'auto', padding: '6px 8px' }} value={before} onChange={(e) => setBefore(e.target.value)} />
        </label>
        <div className="row" style={{ gap: 4 }}>
          {HAS.map(([k, l]) => (
            <button key={k} className="pill" style={has.includes(k) ? { background: 'var(--accent)', color: '#fff' } : undefined} onClick={() => setHas((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k]))}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {quick && (quick.users.length > 0 || quick.servers.length > 0 || quick.channels.length > 0) && (
        <div className="col" style={{ gap: 4 }}>
          {quick.users.length > 0 && <div className="field-label">Люди</div>}
          {quick.users.map((u) => (
            <button key={u.id} className="chan" onClick={() => (onClose(), void openDm(u.id))}>
              <Avatar user={u} size={24} /> {u.displayName || u.username} <span className="muted">{u.username}</span>
            </button>
          ))}
          {quick.servers.length > 0 && <div className="field-label">Серверы</div>}
          {quick.servers.map((s) => (
            <button key={s.id} className="chan" onClick={() => (onClose(), navigate(getState().servers[s.id] ? { name: 'channel', serverId: s.id, channelId: null } : { name: 'discover' }))}>
              <span className="pcard-server-icon" style={{ background: 'var(--accent)' }}>{initials(s.name)}</span> {s.name}
            </button>
          ))}
          {quick.channels.length > 0 && <div className="field-label">Каналы</div>}
          {quick.channels.map((c) => (
            <button key={c.id} className="chan" onClick={() => (onClose(), navigate({ name: 'channel', serverId: c.serverId, channelId: c.id }))}>
              {c.type === 'voice' ? <LuVolume2 /> : <LuHash />} {c.name} <span className="muted">· {c.serverName}</span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="field-error">{error}</p>}
      {results && (
        <div className="col" style={{ gap: 6 }}>
          <div className="field-label">
            Сообщения — {results.total >= 1000 ? '1000+' : results.total} {loading && '…'}
          </div>
          {results.results.length === 0 && <p className="muted">Ничего не найдено.</p>}
          {results.results.map((m) => (
            <button key={m.id} className="pcard-section" style={{ textAlign: 'left', background: 'var(--bg-3)', border: '1px solid var(--border)' }} onClick={() => jump(m)}>
              <div className="row" style={{ fontSize: '0.8125rem', marginBottom: 4 }}>
                <Avatar user={m.author} size={20} />
                <strong style={{ color: 'var(--text-0)' }}>{displayName(getState(), m.author, m.serverId)}</strong>
                <span className="muted">{m.serverId ? `#${m.channelName}` : 'Личные сообщения'}</span>
                <span className="msg-time">{formatTimestamp(m.createdAt)}</span>
              </div>
              <MessageBody m={m} />
              {m.attachments.length > 0 && <div className="muted" style={{ fontSize: '0.75rem' }}>📎 {m.attachments.map((a) => a.filename).join(', ')}</div>}
            </button>
          ))}
          {results.total > PAGE && (
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-secondary btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                ← Назад
              </button>
              <span className="muted" style={{ fontSize: '0.8125rem' }}>
                {offset / PAGE + 1} / {Math.ceil(Math.min(results.total, 1000) / PAGE)}
              </span>
              <button className="btn btn-secondary btn-sm" disabled={offset + PAGE >= Math.min(results.total, 1000)} onClick={() => setOffset(offset + PAGE)}>
                Далее →
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
