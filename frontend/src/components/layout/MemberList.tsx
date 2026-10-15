import { useApp } from '../../state/app';
import { displayName, roleColor } from '../../state/actions';
import { openContextMenu, openProfile } from '../../state/ui';
import { Avatar } from '../ui/Avatar';
import { BadgeIcons } from '../profile/ProfileCard';
import { memberMenu } from '../profile/memberMenu';
import type { Member, Role } from '../../types';

export function MemberList({ serverId }: { serverId: string }) {
  const members = useApp((s) => Object.values(s.members[serverId] ?? {}));
  const roles = useApp((s) => s.roles[serverId] ?? []);
  const users = useApp((s) => s.users);
  const owner = useApp((s) => s.servers[serverId]?.ownerId);

  const hoisted = roles.filter((r) => r.hoist && !r.isDefault).sort((a, b) => b.position - a.position);
  const groups = new Map<string, { label: string; list: Member[] }>();
  for (const r of hoisted) groups.set(r.id, { label: r.name, list: [] });
  groups.set('online', { label: 'В сети', list: [] });
  groups.set('offline', { label: 'Не в сети', list: [] });

  for (const m of members) {
    const status = users[m.user.id]?.status ?? m.user.status;
    if (status === 'offline') {
      groups.get('offline')!.list.push(m);
      continue;
    }
    const top = hoisted.find((r: Role) => m.roleIds.includes(r.id));
    groups.get(top ? top.id : 'online')!.list.push(m);
  }
  for (const g of groups.values()) g.list.sort((a, b) => (users[a.user.id]?.username ?? a.user.username).localeCompare(users[b.user.id]?.username ?? b.user.username));

  return (
    <aside className="members scroll" aria-label="Участники">
      {[...groups.entries()].map(([key, g]) =>
        g.list.length === 0 ? null : (
          <section key={key}>
            <div className="members-group">
              {g.label} — {g.list.length}
            </div>
            {g.list.map((m) => (
              <MemberRow key={m.user.id} member={m} serverId={serverId} isOwner={owner === m.user.id} />
            ))}
          </section>
        ),
      )}
    </aside>
  );
}

function MemberRow({ member, serverId, isOwner }: { member: Member; serverId: string; isOwner: boolean }) {
  const user = useApp((s) => s.users[member.user.id] ?? member.user);
  const name = useApp((s) => displayName(s, user, serverId));
  const color = useApp((s) => roleColor(s, serverId, user.id));
  const speaking = useApp((s) => s.speaking[user.id] && s.voiceStates[user.id]?.serverId === serverId);
  return (
    <button
      className={`member${user.status === 'offline' ? ' offline' : ''}`}
      onClick={(e) => openProfile(user.id, serverId, e.currentTarget.getBoundingClientRect().left > 400 ? { clientX: e.currentTarget.getBoundingClientRect().left - 360, clientY: e.clientY } : e)}
      onContextMenu={(e) => openContextMenu(e, memberMenu(user.id, serverId))}
    >
      <Avatar user={user} size={34} status={user.status} speaking={!!speaking} ring="var(--bg-1)" />
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="member-name">
          <span className="ellipsis" style={color ? { color } : undefined}>
            {name}
          </span>
          {isOwner && <span title="Владелец сервера">👑</span>}
          {user.badges.length > 0 && <BadgeIcons badges={user.badges.filter((b) => b.global || b.serverId === serverId).slice(0, 3)} />}
        </span>
        {user.customStatus?.text && (
          <span className="member-sub ellipsis" style={{ display: 'block' }}>
            {user.customStatus.emoji} {user.customStatus.text}
          </span>
        )}
      </span>
    </button>
  );
}
