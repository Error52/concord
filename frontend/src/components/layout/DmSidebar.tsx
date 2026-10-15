import { LuUsers, LuX, LuSearch, LuBell, LuBookmark } from 'react-icons/lu';
import { useApp } from '../../state/app';
import { displayName, hasUnread, mentionCount } from '../../state/actions';
import { navigate, useRoute } from '../../state/router';
import { uiStore, openContextMenu } from '../../state/ui';
import { closeDm } from '../../state/serverActions';
import { cmpId } from '../../utils/ids';
import { Avatar } from '../ui/Avatar';
import type { Dm } from '../../types';

export function DmSidebar() {
  const route = useRoute();
  const dms = useApp((s) =>
    Object.values(s.dms).sort((a, b) => {
      if (!a.lastMessageId) return 1;
      if (!b.lastMessageId) return -1;
      return -cmpId(a.lastMessageId, b.lastMessageId);
    }),
  );
  const incoming = useApp((s) => Object.values(s.relationships).filter((r) => r.type === 'incoming').length);
  const unreadNotifications = useApp((s) => s.unreadNotifications);
  return (
    <aside className="sidebar-inner">
      <div className="sidebar-head">
        <button className="input row" style={{ height: 32, padding: '0 10px', fontSize: '0.8125rem', color: 'var(--text-2)' }} onClick={() => uiStore.set({ modal: { kind: 'search', serverId: null } })}>
          <LuSearch /> Найти или начать беседу
        </button>
      </div>
      <div className="sidebar-list scroll">
        <button className={`chan${route.name === 'friends' ? ' active' : ''}`} onClick={() => navigate({ name: 'friends' })}>
          <LuUsers />
          <span className="grow">Друзья</span>
          {incoming > 0 && <span className="badge-count">{incoming}</span>}
        </button>
        <button className="chan" onClick={() => uiStore.set({ modal: { kind: 'inbox' } })}>
          <LuBell />
          <span className="grow">Уведомления</span>
          {unreadNotifications > 0 && <span className="badge-count">{unreadNotifications > 99 ? '99+' : unreadNotifications}</span>}
        </button>
        <button className="chan" onClick={() => uiStore.set({ modal: { kind: 'bookmarks' } })}>
          <LuBookmark />
          <span className="grow">Закладки</span>
        </button>
        <div className="category">Личные сообщения</div>
        {dms.length === 0 && <p className="muted" style={{ fontSize: '0.8125rem', padding: '4px 8px' }}>Здесь появятся ваши диалоги.</p>}
        {dms.map((dm) => (
          <DmRow key={dm.id} dm={dm} active={route.name === 'dm' && route.channelId === dm.id} />
        ))}
      </div>
    </aside>
  );
}

function DmRow({ dm, active }: { dm: Dm; active: boolean }) {
  const other = useApp((s) => (dm.recipients[0] ? (s.users[dm.recipients[0].id] ?? dm.recipients[0]) : null));
  const name = useApp((s) => displayName(s, other));
  const unread = useApp((s) => hasUnread(s, dm.id));
  const mentions = useApp((s) => mentionCount(s, dm.id));
  const inCall = useApp((s) => Object.values(s.voiceStates).some((v) => v.channelId === dm.id));
  return (
    <button
      className={`chan${active ? ' active' : ''}${unread && !active ? ' unread' : ''}`}
      style={{ height: 44 }}
      onClick={() => navigate({ name: 'dm', channelId: dm.id })}
      onContextMenu={(e) => openContextMenu(e, [{ label: 'Закрыть диалог', onSelect: () => void closeDm(dm.id) }])}
    >
      <Avatar user={other} size={32} status={other?.status} ring="var(--bg-1)" />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="ellipsis" style={{ display: 'block' }}>{name}</span>
        {inCall ? (
          <span style={{ fontSize: '0.75rem', color: 'var(--green)' }}>Идёт звонок</span>
        ) : (
          other?.customStatus?.text && <span className="ellipsis muted" style={{ display: 'block', fontSize: '0.75rem' }}>{other.customStatus.emoji} {other.customStatus.text}</span>
        )}
      </span>
      {(mentions > 0 || unread) && !active && <span className="badge-count">{Math.max(1, mentions)}</span>}
      <span className="chan-actions">
        <span
          role="button"
          tabIndex={-1}
          className="icon-btn"
          aria-label="Закрыть"
          onClick={(e) => {
            e.stopPropagation();
            void closeDm(dm.id);
          }}
        >
          <LuX />
        </span>
      </span>
    </button>
  );
}
