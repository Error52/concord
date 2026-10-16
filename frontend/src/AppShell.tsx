import { useEffect } from 'react';
import { LuMenu } from 'react-icons/lu';
import { useApp, getState } from './state/app';
import { firstTextChannel } from './state/actions';
import { navigate, useRoute } from './state/router';
import { uiStore, useUi } from './state/ui';
import { useHotkeys } from './hooks/useHotkeys';
import { FriendsPage } from './pages/FriendsPage';
import { DiscoverPage } from './pages/DiscoverPage';
import { ServerRail } from './components/layout/ServerRail';
import { ChannelSidebar } from './components/layout/ChannelSidebar';
import { DmSidebar } from './components/layout/DmSidebar';
import { UserPanel, VoicePanel } from './components/layout/UserPanel';
import { MemberList } from './components/layout/MemberList';
import { ChatView } from './components/chat/ChatView';
import { Stage } from './components/voice/Stage';
import { MiniPlayer } from './components/voice/MiniPlayer';
import { IncomingCall } from './components/voice/IncomingCall';
import { ModalHost } from './components/modals/Modals';
import { ProfilePopover, FullProfileModal } from './components/profile/ProfilePopover';
import { SettingsPage } from './components/settings/SettingsPage';
import { ServerSettings } from './components/server/ServerSettings';
import {installMediaRecovery} from './utils/mediaRecovery';

function ConnectionBanner() {
  const gw = useApp((s) => s.gateway);
  const ready = useApp((s) => s.ready);
  if (gw === 'connected' || (!ready && gw === 'connecting')) return null;
  return <div className={`conn-banner${gw === 'offline' ? ' offline' : ''}`}>{gw === 'offline' ? 'Соединение потеряно' : 'Переподключение…'}</div>;
}

function Main() {
  useEffect(installMediaRecovery,[]);
  const route = useRoute();
  const ready = useApp((s) => s.ready);
  const membersOpen = useUi((s) => s.memberListOpen);
  const channel = useApp((s) => (route.name === 'channel' && route.channelId ? s.channels[route.channelId] : route.name === 'dm' ? s.channels[route.channelId] : undefined));
  const serverExists = useApp((s) => (route.name === 'channel' ? !!s.servers[route.serverId] : true));

  // Server without a channel in the URL → open its first text channel.
  useEffect(() => {
    if (route.name === 'channel' && !route.channelId && ready) {
      const first = firstTextChannel(getState(), route.serverId);
      if (first) navigate({ name: 'channel', serverId: route.serverId, channelId: first }, true);
    }
  }, [route, ready]);

  if (!ready) {
    return (
      <div className="main-col">
        <div className="main-head">
          <div className="skeleton" style={{ width: 160, height: 18 }} />
        </div>
        <div style={{ padding: 16 }} className="col">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 44, opacity: 1 - i * 0.12 }} />
          ))}
        </div>
      </div>
    );
  }
  if (route.name === 'friends') return <FriendsPage />;
  if (route.name === 'discover') return <DiscoverPage />;
  if (route.name === 'dm') return <ChatView key={route.channelId} channelId={route.channelId} serverId={null} jumpTo={route.messageId} />;
  if (route.name === 'channel') {
    if (!serverExists) {
      return (
        <div className="main-col">
          <div className="empty">
            Сервер не найден или вы не являетесь его участником.
            <button className="btn btn-primary" onClick={() => navigate({ name: 'friends' })}>
              На главную
            </button>
          </div>
        </div>
      );
    }
    if (!channel) {
      return (
        <div className="main-col">
          <header className="main-head">
            <button className="icon-btn mobile-only" onClick={() => uiStore.set({ mobilePanel: 'nav' })} aria-label="Меню">
              <LuMenu />
            </button>
          </header>
          <div className="empty">Выберите канал слева.</div>
        </div>
      );
    }
    if (channel.type === 'voice') {
      return <Stage key={channel.id} channelId={channel.id} serverId={route.serverId} mode="channel" />;
    }
    return (
      <>
        <ChatView key={channel.id} channelId={channel.id} serverId={route.serverId} jumpTo={route.messageId} />
        {membersOpen && <MemberList serverId={route.serverId} />}
      </>
    );
  }
  return null;
}

export default function Shell() {
  const route = useRoute();
  const mobileNav = useUi((s) => s.mobilePanel === 'nav');
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  useHotkeys();

  useEffect(() => {
    const compact = window.matchMedia('(max-width: 1100px)');
    const onBreakpoint = () => uiStore.set({ memberListOpen: !compact.matches });
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const s = uiStore.get();
      if (s.modal || s.settings || s.serverSettings || s.profile || s.fullProfile || s.contextMenu) return;
      if (s.mobilePanel === 'nav') uiStore.set({ mobilePanel: 'chat' });
      else if (compact.matches && s.memberListOpen) uiStore.set({ memberListOpen: false });
    };
    compact.addEventListener('change', onBreakpoint);
    window.addEventListener('keydown', onEscape);
    return () => {
      compact.removeEventListener('change', onBreakpoint);
      window.removeEventListener('keydown', onEscape);
    };
  }, []);

  // Close the mobile drawer after navigating.
  useEffect(() => {
    uiStore.set({ mobilePanel: 'chat' });
  }, [route]);

  const sidebar = route.name === 'channel' ? <ChannelSidebar serverId={route.serverId} /> : <DmSidebar />;
  return (
    <div className={`app${mobileNav ? ' nav-open' : ''}${sidebarHidden ? ' no-sidebar' : ''}`}>
      <ServerRail />
      <div className="sidebar" style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-1)' }}>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{sidebar}</div>
        <VoicePanel />
        <UserPanel />
      </div>
      <main className="main">
        <ConnectionBanner />
        <Main />
      </main>
      {mobileNav && <div className="nav-scrim" onClick={() => uiStore.set({ mobilePanel: 'chat' })} />}
      <MiniPlayer />
      <IncomingCall />
      <ProfilePopover />
      <FullProfileModal />
      <ModalHost />
      <SettingsPage />
      <ServerSettings />
    </div>
  );
}

