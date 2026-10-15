import { LuCompass, LuMessageCircle, LuPlus, LuVolume2 } from 'react-icons/lu';
import { useApp } from '../../state/app';
import { dmUnreadTotal, firstTextChannel, serverUnread } from '../../state/actions';
import { navigate, useRoute } from '../../state/router';
import { uiStore, openContextMenu } from '../../state/ui';
import { useVoice } from '../../webrtc/voiceEngine';
import { Tooltip } from '../ui/Overlays';
import { initials } from '../../utils/format';
import { getState } from '../../state/app';
import { leaveServer } from '../../state/serverActions';

export function ServerRail() {
  const route = useRoute();
  const servers = useApp((s) => s.serverOrder.map((id) => s.servers[id]!).filter(Boolean));
  const unread = useApp((s) => Object.fromEntries(s.serverOrder.map((id) => [id, serverUnread(s, id)])));
  const dmUnread = useApp(dmUnreadTotal);
  const voiceServer = useVoice((v) => (v.status !== 'idle' ? v.serverId : null));
  const me = useApp((s) => s.me?.id);
  const home = route.name === 'friends' || route.name === 'dm';

  return (
    <nav className="rail scroll-hidden" aria-label="Серверы">
      <div className={`rail-item${home ? ' active' : ''}`}>
        <span className="rail-pip" />
        <Tooltip text="Личные сообщения" side="right">
          <button className="rail-btn" onClick={() => navigate({ name: 'friends' })} aria-label="Личные сообщения">
            <LuMessageCircle />
          </button>
        </Tooltip>
        {dmUnread > 0 && <span className="badge-count rail-badge">{dmUnread > 99 ? '99+' : dmUnread}</span>}
      </div>
      <div className="rail-sep" />
      {servers.map((srv) => {
        const u = unread[srv.id]!;
        const active = route.name === 'channel' && route.serverId === srv.id;
        return (
          <div key={srv.id} className={`rail-item${active ? ' active' : ''}${u.unread ? ' unread' : ''}`}>
            <span className="rail-pip" />
            <Tooltip text={srv.name} side="right">
              <button
                className="rail-btn"
                aria-label={srv.name}
                onClick={() => navigate({ name: 'channel', serverId: srv.id, channelId: firstTextChannel(getState(), srv.id) })}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: 'Пригласить людей', onSelect: () => uiStore.set({ modal: { kind: 'invite', serverId: srv.id } }) },
                    { label: 'Настройки сервера', onSelect: () => uiStore.set({ serverSettings: { serverId: srv.id, tab: 'overview' } }) },
                    { divider: true, label: '' },
                    ...(srv.ownerId !== me ? [{ label: 'Покинуть сервер', danger: true, onSelect: () => void leaveServer(srv.id) }] : []),
                  ])
                }
              >
                {srv.iconUrl ? <img src={srv.iconUrl} alt="" /> : initials(srv.name)}
              </button>
            </Tooltip>
            {u.mentions > 0 && <span className="badge-count rail-badge">{u.mentions}</span>}
            {voiceServer === srv.id && u.mentions === 0 && (
              <span className="rail-voice" aria-label="Вы в голосовом канале">
                <LuVolume2 />
              </span>
            )}
          </div>
        );
      })}
      <div className="rail-item">
        <Tooltip text="Создать или присоединиться" side="right">
          <button className="rail-btn add" onClick={() => uiStore.set({ modal: { kind: 'createServer' } })} aria-label="Добавить сервер">
            <LuPlus />
          </button>
        </Tooltip>
      </div>
      <div className={`rail-item${route.name === 'discover' ? ' active' : ''}`}>
        <span className="rail-pip" />
        <Tooltip text="Обзор публичных серверов" side="right">
          <button className="rail-btn add" onClick={() => navigate({ name: 'discover' })} aria-label="Обзор серверов">
            <LuCompass />
          </button>
        </Tooltip>
      </div>
    </nav>
  );
}
