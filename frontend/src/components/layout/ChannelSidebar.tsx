import { useState, type MouseEvent } from 'react';
import {
  LuChevronDown,
  LuHash,
  LuHeadphoneOff,
  LuMicOff,
  LuPlus,
  LuSettings,
  LuUserPlus,
  LuVideo,
  LuVolume2,
} from 'react-icons/lu';
import { useApp, getState } from '../../state/app';
import { channelsOf, displayName, hasUnread, mentionCount, markRead } from '../../state/actions';
import { navigate, useRoute } from '../../state/router';
import { uiStore, openContextMenu, openProfile, type ContextMenuItem } from '../../state/ui';
import { voice, useVoice } from '../../webrtc/voiceEngine';
import { deleteChannel, leaveServer } from '../../state/serverActions';
import { can, Perm } from '../../utils/permissions';
import { Avatar } from '../ui/Avatar';
import { voiceUserMenu } from '../voice/voiceMenus';
import type { Channel, VoiceState } from '../../types';

export function ChannelSidebar({ serverId }: { serverId: string }) {
  const route = useRoute();
  const server = useApp((s) => s.servers[serverId]);
  const channels = useApp((s) => channelsOf(s, serverId));
  const perms = useApp((s) => s.permissions[serverId]);
  const me = useApp((s) => s.me?.id);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (!server) return null;

  const activeId = route.name === 'channel' ? route.channelId : null;
  const groups = new Map<string, Channel[]>();
  for (const ch of channels) {
    const key = ch.category || (ch.type === 'voice' ? 'Голосовые каналы' : 'Текстовые каналы');
    const list = groups.get(key) ?? [];
    list.push(ch);
    groups.set(key, list);
  }
  // Text categories first, then voice ones.
  const ordered = [...groups.entries()].sort(([, a], [, b]) => (a[0]!.type === b[0]!.type ? 0 : a[0]!.type === 'text' ? -1 : 1));
  const manage = can(perms, Perm.MANAGE_CHANNELS);

  const serverMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: ContextMenuItem[] = [];
    if (can(perms, Perm.CREATE_INVITE)) items.push({ label: 'Пригласить людей', icon: <LuUserPlus />, onSelect: () => uiStore.set({ modal: { kind: 'invite', serverId } }) });
    items.push({ label: 'Настройки сервера', icon: <LuSettings />, onSelect: () => uiStore.set({ serverSettings: { serverId, tab: 'overview' } }) });
    if (manage) {
      items.push({ label: 'Создать текстовый канал', icon: <LuHash />, onSelect: () => uiStore.set({ modal: { kind: 'createChannel', serverId, type: 'text' } }) });
      items.push({ label: 'Создать голосовой канал', icon: <LuVolume2 />, onSelect: () => uiStore.set({ modal: { kind: 'createChannel', serverId, type: 'voice' } }) });
    }
    items.push({ label: 'Отметить как прочитанное', onSelect: () => channels.forEach((c) => c.type === 'text' && void markRead(c.id)) });
    if (server.ownerId !== me) items.push({ divider: true, label: '' }, { label: 'Покинуть сервер', danger: true, onSelect: () => void leaveServer(serverId) });
    openContextMenu({ clientX: r.left + 8, clientY: r.bottom + 4, preventDefault() {} }, items);
  };

  return (
    <aside className="sidebar-inner">
      {server.bannerUrl && <div className="sidebar-banner" style={{ backgroundImage: `url(${server.bannerUrl})` }} />}
      <button className="sidebar-head" onClick={serverMenu} aria-haspopup="menu">
        <span className="grow ellipsis">{server.name}</span>
        <LuChevronDown />
      </button>
      <div className="sidebar-list scroll">
        {ordered.map(([cat, list]) => (
          <section key={cat}>
            <div className="category">
              <button onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))} aria-expanded={!collapsed[cat]}>
                <LuChevronDown style={{ transform: collapsed[cat] ? 'rotate(-90deg)' : undefined, transition: 'transform 150ms' }} />
                <span className="ellipsis">{cat}</span>
              </button>
              {manage && (
                <button
                  className="icon-btn"
                  style={{ width: 20, height: 20, flex: 'none' }}
                  aria-label="Создать канал"
                  onClick={() => uiStore.set({ modal: { kind: 'createChannel', serverId, type: list[0]!.type === 'voice' ? 'voice' : 'text' } })}
                >
                  <LuPlus />
                </button>
              )}
            </div>
            {list.map((ch) =>
              collapsed[cat] && ch.id !== activeId && !(ch.type === 'text' && hasUnread(getState(), ch.id)) ? null : ch.type === 'voice' ? (
                <VoiceChannelRow key={ch.id} ch={ch} active={ch.id === activeId} manage={manage} serverId={serverId} />
              ) : (
                <TextChannelRow key={ch.id} ch={ch} active={ch.id === activeId} manage={manage} serverId={serverId} />
              ),
            )}
          </section>
        ))}
      </div>
    </aside>
  );
}

function channelMenu(ch: Channel, manage: boolean, serverId: string): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (ch.type === 'text') items.push({ label: 'Отметить как прочитанное', onSelect: () => void markRead(ch.id) });
  items.push({ label: 'Копировать ссылку', onSelect: () => void navigator.clipboard?.writeText(`${location.origin}/channels/${serverId}/${ch.id}`) });
  if (manage) {
    items.push({ divider: true, label: '' });
    items.push({ label: 'Настроить канал', onSelect: () => uiStore.set({ serverSettings: { serverId, tab: `channel:${ch.id}` } }) });
    items.push({ label: 'Удалить канал', danger: true, onSelect: () => void deleteChannel(ch) });
  }
  return items;
}

function TextChannelRow({ ch, active, manage, serverId }: { ch: Channel; active: boolean; manage: boolean; serverId: string }) {
  const unread = useApp((s) => hasUnread(s, ch.id));
  const mentions = useApp((s) => mentionCount(s, ch.id));
  return (
    <button
      className={`chan${active ? ' active' : ''}${unread && !active ? ' unread' : ''}`}
      onClick={() => {
        navigate({ name: 'channel', serverId, channelId: ch.id });
        uiStore.set({ mobilePanel: 'chat' });
      }}
      onContextMenu={(e) => openContextMenu(e, channelMenu(ch, manage, serverId))}
    >
      <LuHash />
      <span className="ellipsis grow">{ch.name}</span>
      {mentions > 0 && !active && <span className="badge-count">{mentions}</span>}
      {manage && (
        <span className="chan-actions">
          <span
            role="button"
            tabIndex={-1}
            className="icon-btn"
            aria-label="Настройки канала"
            onClick={(e) => {
              e.stopPropagation();
              uiStore.set({ serverSettings: { serverId, tab: `channel:${ch.id}` } });
            }}
          >
            <LuSettings />
          </span>
        </span>
      )}
    </button>
  );
}

function VoiceChannelRow({ ch, active, manage, serverId }: { ch: Channel; active: boolean; manage: boolean; serverId: string }) {
  const states = useApp((s) => Object.values(s.voiceStates).filter((v) => v.channelId === ch.id));
  const connectedHere = useVoice((v) => v.channelId === ch.id && v.status !== 'idle');
  return (
    <>
      <button
        className={`chan${active ? ' active' : ''}`}
        onClick={() => {
          if (!connectedHere) void voice.join(ch.id);
          navigate({ name: 'channel', serverId, channelId: ch.id });
        }}
        onContextMenu={(e) => openContextMenu(e, channelMenu(ch, manage, serverId))}
      >
        <LuVolume2 />
        <span className="ellipsis grow">{ch.name}</span>
        {states.length > 0 && <span className="muted" style={{ fontSize: '0.75rem' }}>{states.length}</span>}
      </button>
      {states.length > 0 && (
        <div className="voice-users">
          {states.map((vs) => (
            <VoiceUserRow key={vs.userId} vs={vs} serverId={serverId} />
          ))}
        </div>
      )}
    </>
  );
}

function VoiceUserRow({ vs, serverId }: { vs: VoiceState; serverId: string }) {
  const user = useApp((s) => s.users[vs.userId] ?? s.members[serverId]?.[vs.userId]?.user);
  const name = useApp((s) => displayName(s, user, serverId));
  // Inside the same room the SFU's measured speaking state wins; otherwise the gateway relay.
  const sfuSpeaking = useVoice((v) => v.participants[vs.userId]?.speaking);
  const relaySpeaking = useApp((s) => s.speaking[vs.userId]);
  const speaking = sfuSpeaking ?? relaySpeaking ?? false;
  return (
    <button
      className={`voice-user${speaking ? ' speaking' : ''}`}
      onClick={(e) => openProfile(vs.userId, serverId, e)}
      onContextMenu={(e) => openContextMenu(e, voiceUserMenu(vs.userId, serverId))}
    >
      <Avatar user={user ?? null} size={22} speaking={speaking} />
      <span className="ellipsis">{name}</span>
      <span className="voice-user-icons">
        {vs.screen && <span className="live-badge">LIVE</span>}
        {vs.camera && <LuVideo />}
        {(vs.selfMute || vs.serverMute) && <LuMicOff className={vs.serverMute ? 'server' : ''} />}
        {(vs.selfDeaf || vs.serverDeaf) && <LuHeadphoneOff className={vs.serverDeaf ? 'server' : ''} />}
      </span>
    </button>
  );
}
