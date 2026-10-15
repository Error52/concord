import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { LuEllipsis, LuMessageCircle, LuPencil, LuUserCheck, LuUserPlus, LuBan, LuClock } from 'react-icons/lu';
import { api, errorMessage } from '../../api/client';
import { useApp } from '../../state/app';
import { navigate } from '../../state/router';
import { openContextMenu, uiStore, useUi, toast } from '../../state/ui';
import { acceptFriend, blockUser, openDm, sendFriendRequest, unblockUser } from '../../state/serverActions';
import { formatDate, initials } from '../../utils/format';
import { ProfileCard } from './ProfileCard';
import { memberMenu } from './memberMenu';
import { useClampedPosition } from '../ui/Overlays';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { Tooltip } from '../ui/Overlays';
import type { Dm, ProfileView, Server } from '../../types';

function useProfile(userId: string | undefined): ProfileView | null {
  const [data, setData] = useState<ProfileView | null>(null);
  const live = useApp((s) => (userId ? s.users[userId] : undefined));
  const rel = useApp((s) => (userId ? s.relationships[userId]?.type : undefined));
  useEffect(() => {
    if (!userId) return;
    setData(null);
    api.get<ProfileView>(`/users/${userId}`).then(setData, (err) => {
      toast(errorMessage(err, 'Не удалось загрузить профиль'), 'error');
      uiStore.set({ profile: null, fullProfile: null });
    });
  }, [userId, rel]);
  if (!data) return null;
  return live ? { ...data, user: { ...data.user, ...live, badges: live.badges ?? data.user.badges } } : data;
}

function ServerIcon({ s }: { s: Server }) {
  return s.iconUrl ? <img className="pcard-server-icon" src={s.iconUrl} alt="" /> : <span className="pcard-server-icon" style={{ background: 'var(--accent)' }}>{initials(s.name)}</span>;
}

function RelationButton({ view }: { view: ProfileView }) {
  const id = view.user.id;
  switch (view.relationship) {
    case 'self':
      return (
        <Tooltip text="Редактировать профиль">
          <button onClick={() => uiStore.set({ profile: null, fullProfile: null, settings: 'profile' })} aria-label="Редактировать профиль">
            <LuPencil />
          </button>
        </Tooltip>
      );
    case 'friend':
      return (
        <Tooltip text="Вы друзья">
          <button aria-label="Друзья">
            <LuUserCheck />
          </button>
        </Tooltip>
      );
    case 'incoming':
      return (
        <Tooltip text="Принять запрос в друзья">
          <button onClick={() => void acceptFriend(id)} aria-label="Принять запрос">
            <LuUserCheck />
          </button>
        </Tooltip>
      );
    case 'outgoing':
      return (
        <Tooltip text="Запрос отправлен">
          <button aria-label="Запрос отправлен" disabled>
            <LuClock />
          </button>
        </Tooltip>
      );
    case 'blocked':
      return (
        <Tooltip text="Разблокировать">
          <button onClick={() => void unblockUser(id)} aria-label="Разблокировать">
            <LuBan />
          </button>
        </Tooltip>
      );
    default:
      return (
        <Tooltip text="Добавить в друзья">
          <button onClick={() => void sendFriendRequest({ userId: id })} aria-label="Добавить в друзья">
            <LuUserPlus />
          </button>
        </Tooltip>
      );
  }
}

function QuickMessage({ userId, name }: { userId: string; name: string }) {
  const [text, setText] = useState('');
  return (
    <form
      className="pcard-message"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        try {
          const dm = await api.post<Dm>('/dm', { recipientId: userId });
          await api.post(`/channels/${dm.id}/messages`, { content: text.trim() });
          uiStore.set({ profile: null, fullProfile: null });
          navigate({ name: 'dm', channelId: dm.id });
        } catch (err) {
          toast(errorMessage(err, 'Не удалось отправить сообщение'), 'error');
        }
      }}
    >
      <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Сообщение для @${name}`} maxLength={4000} />
    </form>
  );
}

function ProfileDetails({ view, serverId, full }: { view: ProfileView; serverId: string | null; full?: boolean }) {
  const member = useApp((s) => (serverId ? s.members[serverId]?.[view.user.id] : undefined));
  const roles = useApp((s) => (serverId ? (s.roles[serverId] ?? []) : []));
  const memberRoles = member ? roles.filter((r) => member.roleIds.includes(r.id)).sort((a, b) => b.position - a.position) : [];
  const [tab, setTab] = useState<'about' | 'servers' | 'friends'>('about');
  const sections: ReactNode = (
    <>
      <div className="pcard-section">
        <h4>В Concord с</h4>
        {formatDate(view.user.createdAt)}
        {member && (
          <>
            {' · на сервере с '}
            {formatDate(member.joinedAt)}
          </>
        )}
      </div>
      {memberRoles.length > 0 && (
        <div className="pcard-section">
          <h4>Роли</h4>
          <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
            {memberRoles.map((r) => (
              <span key={r.id} className="pill">
                <span className="pill-dot" style={{ background: r.color ?? 'var(--text-3)' }} />
                {r.name}
              </span>
            ))}
          </div>
        </div>
      )}
      {view.user.badges.length > 0 && full && (
        <div className="pcard-section">
          <h4>Значки</h4>
          <div className="col" style={{ gap: 6 }}>
            {view.user.badges.map((b) => (
              <div key={b.id} className="row">
                <span className="badge-icon" style={{ background: `color-mix(in srgb, ${b.color} 30%, transparent)` }}>
                  {b.iconUrl ? <img src={b.iconUrl} alt="" /> : b.emoji}
                </span>
                <span className="grow">
                  <strong>{b.name}</strong>
                  <span style={{ opacity: 0.75 }}> — {b.description || (b.global ? 'Значок Concord' : b.serverName)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
  if (!full) {
    return (
      <>
        {sections}
        {view.mutualServers.length > 0 && (
          <div className="pcard-mutual">
            <span className="pcard-mutual-icons">
              {view.mutualServers.slice(0, 3).map((s) => (
                <ServerIcon key={s.id} s={s} />
              ))}
            </span>
            {view.mutualServers.length} {view.mutualServers.length === 1 ? 'общий сервер' : 'общих сервера'}
            {view.mutualFriends.length > 0 && ` · ${view.mutualFriends.length} общих друзей`}
          </div>
        )}
      </>
    );
  }
  return (
    <>
      <div className="profile-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'about'} onClick={() => setTab('about')}>
          Обо мне
        </button>
        <button role="tab" aria-selected={tab === 'servers'} onClick={() => setTab('servers')}>
          Общие серверы — {view.mutualServers.length}
        </button>
        <button role="tab" aria-selected={tab === 'friends'} onClick={() => setTab('friends')}>
          Общие друзья — {view.mutualFriends.length}
        </button>
      </div>
      {tab === 'about' && sections}
      {tab === 'servers' && (
        <div className="col">
          {view.mutualServers.length === 0 && <span style={{ opacity: 0.7 }}>Нет общих серверов</span>}
          {view.mutualServers.map((s) => (
            <button key={s.id} className="row pcard-section" style={{ textAlign: 'left' }} onClick={() => (uiStore.set({ fullProfile: null }), navigate({ name: 'channel', serverId: s.id, channelId: null }))}>
              <ServerIcon s={s} /> {s.name}
            </button>
          ))}
        </div>
      )}
      {tab === 'friends' && (
        <div className="col">
          {view.mutualFriends.length === 0 && <span style={{ opacity: 0.7 }}>Нет общих друзей</span>}
          {view.mutualFriends.map((u) => (
            <button key={u.id} className="row pcard-section" style={{ textAlign: 'left' }} onClick={() => uiStore.set({ fullProfile: { userId: u.id, serverId: null } })}>
              <Avatar user={u} size={24} /> {u.displayName || u.username}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function ProfilePopover() {
  const pop = useUi((s) => s.profile);
  const view = useProfile(pop?.userId);
  const { ref, pos } = useClampedPosition(pop?.anchor.x ?? 0, pop?.anchor.y ?? 0, [view?.user.id, !!view]);
  useEffect(() => {
    if (!pop) return;
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!ref.current?.contains(t) && !t.closest('.menu') && !t.closest('.tooltip')) uiStore.set({ profile: null });
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && uiStore.set({ profile: null });
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [pop, ref]);
  if (!pop) return null;
  return createPortal(
    <div className="profile-popover" ref={ref} style={pos}>
      {view ? (
        <ProfileCard
          user={view.user}
          onAvatarClick={() => uiStore.set({ profile: null, fullProfile: { userId: view.user.id, serverId: pop.serverId } })}
          actions={
            <>
              <RelationButton view={view} />
              <button onClick={(e) => openContextMenu(e, memberMenu(view.user.id, pop.serverId))} aria-label="Ещё">
                <LuEllipsis />
              </button>
            </>
          }
          footer={
            view.relationship === 'self' ? (
              <button className="btn btn-secondary" onClick={() => uiStore.set({ profile: null, settings: 'profile' })}>
                <LuPencil /> Редактировать профиль
              </button>
            ) : view.relationship !== 'blocked' ? (
              <QuickMessage userId={view.user.id} name={view.user.username} />
            ) : null
          }
        >
          <ProfileDetails view={view} serverId={pop.serverId} />
        </ProfileCard>
      ) : (
        <div className="pcard" style={{ height: 320 }}>
          <div className="skeleton" style={{ height: 120, borderRadius: 0 }} />
        </div>
      )}
    </div>,
    document.body,
  );
}

export function FullProfileModal() {
  const fp = useUi((s) => s.fullProfile);
  const view = useProfile(fp?.userId);
  if (!fp) return null;
  const close = () => uiStore.set({ fullProfile: null });
  return (
    <Modal onClose={close} width={600} className="profile-full">
      {view ? (
        <ProfileCard
          user={view.user}
          actions={
            <>
              <RelationButton view={view} />
              {view.relationship !== 'self' && view.relationship !== 'blocked' && (
                <Tooltip text="Написать сообщение">
                  <button onClick={() => (close(), void openDm(view.user.id))} aria-label="Написать">
                    <LuMessageCircle />
                  </button>
                </Tooltip>
              )}
              {view.relationship !== 'self' && view.relationship !== 'blocked' && (
                <Tooltip text="Заблокировать">
                  <button onClick={() => void blockUser(view.user.id)} aria-label="Заблокировать">
                    <LuBan />
                  </button>
                </Tooltip>
              )}
              <button onClick={(e) => openContextMenu(e, memberMenu(view.user.id, fp.serverId))} aria-label="Ещё">
                <LuEllipsis />
              </button>
            </>
          }
          footer={view.relationship !== 'self' && view.relationship !== 'blocked' ? <QuickMessage userId={view.user.id} name={view.user.username} /> : null}
        >
          <ProfileDetails view={view} serverId={fp.serverId} full />
        </ProfileCard>
      ) : (
        <div className="skeleton" style={{ height: 420 }} />
      )}
    </Modal>
  );
}

