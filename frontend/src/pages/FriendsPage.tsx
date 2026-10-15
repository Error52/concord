import { useState } from 'react';
import { LuCheck, LuMenu, LuMessageCircle, LuUsers, LuX, LuEllipsis } from 'react-icons/lu';
import { useApp } from '../state/app';
import { uiStore, openContextMenu, openProfile } from '../state/ui';
import { acceptFriend, blockUser, openDm, removeFriend, sendFriendRequest, unblockUser } from '../state/serverActions';
import { Avatar, STATUS_LABEL } from '../components/ui/Avatar';
import { Tooltip } from '../components/ui/Overlays';
import type { Relation } from '../types';

type Tab = 'online' | 'all' | 'pending' | 'blocked' | 'add';

export function FriendsPage() {
  const [tab, setTab] = useState<Tab>('online');
  const relations = useApp((s) => Object.values(s.relationships).map((r) => ({ ...r, user: s.users[r.id] ?? r.user })));
  const pending = relations.filter((r) => r.type === 'incoming' || r.type === 'outgoing');
  const list =
    tab === 'online'
      ? relations.filter((r) => r.type === 'friend' && r.user.status !== 'offline')
      : tab === 'all'
        ? relations.filter((r) => r.type === 'friend')
        : tab === 'pending'
          ? pending
          : relations.filter((r) => r.type === 'blocked');

  return (
    <div className="main-col">
      <header className="main-head">
        <button className="icon-btn mobile-only" onClick={() => uiStore.set({ mobilePanel: 'nav' })} aria-label="Меню">
          <LuMenu />
        </button>
        <div className="main-head-title">
          <LuUsers /> Друзья
        </div>
        <div className="segmented" style={{ marginLeft: 12, background: 'transparent', overflowX: 'auto' }} role="tablist">
          {(
            [
              ['online', 'В сети'],
              ['all', 'Все'],
              ['pending', `Ожидание${pending.length ? ` (${pending.length})` : ''}`],
              ['blocked', 'Заблокированные'],
            ] as [Tab, string][]
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-pressed={tab === k} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
          <button className="btn btn-success btn-sm" style={{ marginLeft: 6 }} aria-pressed={tab === 'add'} onClick={() => setTab('add')}>
            Добавить в друзья
          </button>
        </div>
      </header>
      <div className="scroll" style={{ flex: 1, padding: '16px 20px' }}>
        {tab === 'add' ? (
          <AddFriend />
        ) : list.length === 0 ? (
          <div className="empty">
            <div className="empty-art">
              <LuUsers />
            </div>
            {tab === 'online' ? 'Никого из друзей нет в сети.' : tab === 'pending' ? 'Нет запросов в друзья.' : tab === 'blocked' ? 'Вы никого не блокировали.' : 'Пока нет друзей — добавьте кого-нибудь!'}
          </div>
        ) : (
          <>
            <div className="field-label" style={{ marginBottom: 8 }}>
              {tab === 'online' ? 'В сети' : tab === 'all' ? 'Все друзья' : tab === 'pending' ? 'Ожидание' : 'Заблокированные'} — {list.length}
            </div>
            {list.map((r) => (
              <FriendRow key={r.id} r={r} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function FriendRow({ r }: { r: Relation }) {
  const u = r.user;
  const sub = r.type === 'incoming' ? 'Входящий запрос' : r.type === 'outgoing' ? 'Исходящий запрос' : r.type === 'blocked' ? 'Заблокирован' : u.customStatus?.text ? `${u.customStatus.emoji ?? ''} ${u.customStatus.text}` : STATUS_LABEL[u.status];
  return (
    <div className="member" style={{ borderTop: '1px solid var(--border)', borderRadius: 0, padding: '10px 8px' }}>
      <Avatar user={u} size={36} status={r.type === 'friend' ? u.status : null} onClick={(e) => openProfile(u.id, null, e)} ring="var(--bg-2)" />
      <div className="grow">
        <div className="member-name">
          {u.displayName || u.username} <span className="muted" style={{ fontWeight: 400, fontSize: '0.8125rem' }}>{u.username}</span>
        </div>
        <div className="member-sub">{sub}</div>
      </div>
      {r.type === 'friend' && (
        <Tooltip text="Написать">
          <button className="icon-btn" onClick={() => void openDm(u.id)} aria-label="Написать">
            <LuMessageCircle />
          </button>
        </Tooltip>
      )}
      {r.type === 'incoming' && (
        <Tooltip text="Принять">
          <button className="icon-btn" style={{ color: 'var(--green)' }} onClick={() => void acceptFriend(u.id)} aria-label="Принять">
            <LuCheck />
          </button>
        </Tooltip>
      )}
      {(r.type === 'incoming' || r.type === 'outgoing') && (
        <Tooltip text={r.type === 'incoming' ? 'Отклонить' : 'Отменить'}>
          <button className="icon-btn danger" onClick={() => void removeFriend(u.id)} aria-label="Отклонить">
            <LuX />
          </button>
        </Tooltip>
      )}
      {r.type === 'blocked' && (
        <button className="btn btn-secondary btn-sm" onClick={() => void unblockUser(u.id)}>
          Разблокировать
        </button>
      )}
      {r.type === 'friend' && (
        <button
          className="icon-btn"
          aria-label="Ещё"
          onClick={(e) =>
            openContextMenu(e, [
              { label: 'Профиль', onSelect: () => uiStore.set({ fullProfile: { userId: u.id, serverId: null } }) },
              { label: 'Удалить из друзей', danger: true, onSelect: () => confirm('Удалить из друзей?') && void removeFriend(u.id) },
              { label: 'Заблокировать', danger: true, onSelect: () => void blockUser(u.id) },
            ])
          }
        >
          <LuEllipsis />
        </button>
      )}
    </div>
  );
}

function AddFriend() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        if (await sendFriendRequest({ username: name.trim() })) setName('');
        setBusy(false);
      }}
      style={{ maxWidth: 640 }}
    >
      <h2 style={{ fontSize: '1.125rem' }}>Добавить в друзья</h2>
      <p className="muted">Введите имя пользователя (username) — например, alice.</p>
      <div className="row composer" style={{ padding: 6 }}>
        <input className="input grow" style={{ border: 0, background: 'transparent' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя пользователя" autoFocus />
        <button className="btn btn-primary btn-sm" disabled={!name.trim() || busy}>
          Отправить запрос
        </button>
      </div>
    </form>
  );
}
