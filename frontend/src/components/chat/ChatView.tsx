import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LuAtSign, LuHash, LuMenu, LuPhone, LuPin, LuSearch, LuUsers, LuVideo } from 'react-icons/lu';
import { api } from '../../api/client';
import { useApp, getState } from '../../state/app';
import { displayName, markRead } from '../../state/actions';
import { navigate } from '../../state/router';
import { uiStore, useUi } from '../../state/ui';
import { useSettings } from '../../state/settings';
import { gateway } from '../../state/actions';
import { voice, useVoice } from '../../webrtc/voiceEngine';
import { Avatar } from '../ui/Avatar';
import { Tooltip } from '../ui/Overlays';
import { MessageList } from './MessageList';
import { Composer, type ComposerHandle } from './Composer';
import { MessageBody } from './MessageItem';
import { ThreadPanel } from './ThreadPanel';
import { CallStage } from '../voice/CallStage';
import { formatTimestamp } from '../../utils/format';
import type { Message } from '../../types';

function TypingIndicator({ channelId }: { channelId: string }) {
  const names = useApp((s) => {
    const t = s.typing[channelId] ?? {};
    const now = Date.now();
    return Object.entries(t)
      .filter(([uid, v]) => uid !== s.me?.id && v.until > now)
      .map(([, v]) => v.name);
  });
  return (
    <div className="typing" aria-live="polite">
      {names.length > 0 && (
        <>
          <span className="typing-dots" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>{names.slice(0, 3).join(', ')}</strong> {names.length > 3 ? 'и другие печатают…' : names.length === 1 ? 'печатает…' : 'печатают…'}
          </span>
        </>
      )}
    </div>
  );
}

function PinsPopover({ channelId, anchor, onClose }: { channelId: string; anchor: DOMRect; onClose: () => void }) {
  const [pins, setPins] = useState<Message[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void api.get<Message[]>(`/channels/${channelId}/pins`).then(setPins, () => setPins([]));
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [channelId, onClose]);
  return createPortal(
    <div ref={ref} className="menu scroll" style={{ top: anchor.bottom + 8, right: 16, maxWidth: 420, width: 'min(420px, calc(100vw - 32px))', maxHeight: '70vh' }}>
      <div style={{ padding: '6px 8px 10px', fontWeight: 700, color: 'var(--text-0)' }}>Закреплённые сообщения</div>
      {pins === null && <div className="skeleton" style={{ height: 60, margin: 8 }} />}
      {pins?.length === 0 && <p className="muted" style={{ padding: '0 8px 8px' }}>В этом канале ещё нет закреплённых сообщений.</p>}
      {pins?.map((m) => (
        <button
          key={m.id}
          className="menu-item"
          style={{ display: 'block', color: 'var(--text-1)', background: 'var(--bg-3)', marginBottom: 6 }}
          onClick={() => {
            onClose();
            const r = getState().channels[m.channelId];
            if (r?.serverId) navigate({ name: 'channel', serverId: r.serverId, channelId: m.channelId, messageId: m.id });
          }}
        >
          <div className="row" style={{ marginBottom: 4 }}>
            <Avatar user={m.author} size={20} />
            <strong>{displayName(getState(), m.author, m.serverId)}</strong>
            <span className="msg-time">{formatTimestamp(m.createdAt)}</span>
          </div>
          <MessageBody m={m} />
        </button>
      ))}
    </div>,
    document.body,
  );
}

export function ChatView({ channelId, serverId, jumpTo }: { channelId: string; serverId: string | null; jumpTo?: string }) {
  const channel = useApp((s) => s.channels[channelId]);
  const dm = useApp((s) => s.dms[channelId]);
  const other = useApp((s) => (dm?.recipients[0] ? (s.users[dm.recipients[0].id] ?? dm.recipients[0]) : null));
  const otherName = useApp((s) => displayName(s, other));
  const membersOpen = useUi((s) => s.memberListOpen);
  const thread = useUi((s) => (s.threadOf?.channelId === channelId ? s.threadOf.messageId : null));
  const chatBg = useSettings((s) => s.chatBackground);
  const inCallHere = useVoice((v) => v.channelId === channelId && v.status !== 'idle');
  const callActive = useApp((s) => Object.values(s.voiceStates).some((v) => v.channelId === channelId));
  const [drag, setDrag] = useState(0);
  const [pins, setPins] = useState<DOMRect | null>(null);
  const composer = useRef<ComposerHandle>(null);
  const closeThread=useCallback(()=>uiStore.set({threadOf:null}),[]);

  useEffect(() => {
    if (!jumpTo&&document.hasFocus()) void markRead(channelId);
  }, [channelId,jumpTo]);

  if (!channel) {
    return (
      <div className="main-col">
        <div className="empty">
          <p>Канал не найден или у вас нет к нему доступа.</p>
        </div>
      </div>
    );
  }
  const isDm = channel.type === 'dm';
  const title = isDm ? otherName : channel.name;

  const startCall = async (video: boolean) => {
    if(!await voice.join(channelId))return;
    gateway.send('call:ring', { channelId, video });
    if (video) await voice.setCamera(true);
  };

  const intro = (
    <div className="messages-intro">
      {isDm ? (
        <>
          <Avatar user={other} size={80} />
          <h2 style={{ marginTop: 12 }}>{otherName}</h2>
          <p className="muted">Это начало вашей личной переписки с {otherName}.</p>
        </>
      ) : (
        <>
          <div className="messages-intro-icon">
            <LuHash />
          </div>
          <h2>Добро пожаловать в #{channel.name}!</h2>
          <p className="muted">Это начало канала #{channel.name}. {channel.topic}</p>
        </>
      )}
    </div>
  );

  return (
    <div className="main-col">
      <header className="main-head">
        <button className="icon-btn mobile-only" onClick={() => uiStore.set({ mobilePanel: 'nav' })} aria-label="Меню">
          <LuMenu />
        </button>
        <div className="main-head-title grow">
          {isDm ? <LuAtSign /> : <LuHash />}
          <span className="ellipsis">{title}</span>
          {!isDm && channel.topic && <span className="main-head-topic ellipsis">{channel.topic}</span>}
        </div>
        {isDm && !inCallHere && (
          <>
            <Tooltip text="Голосовой звонок" side="bottom">
              <button className="icon-btn" onClick={() => void startCall(false)} aria-label="Голосовой звонок">
                <LuPhone />
              </button>
            </Tooltip>
            <Tooltip text="Видеозвонок" side="bottom">
              <button className="icon-btn" onClick={() => void startCall(true)} aria-label="Видеозвонок">
                <LuVideo />
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip text="Закреплённые" side="bottom">
          <button className="icon-btn" onClick={(e) => setPins(e.currentTarget.getBoundingClientRect())} aria-label="Закреплённые сообщения">
            <LuPin />
          </button>
        </Tooltip>
        {!isDm && (
          <Tooltip text={membersOpen ? 'Скрыть участников' : 'Показать участников'} side="bottom">
            <button className={`icon-btn${membersOpen ? ' active' : ''}`} onClick={() => uiStore.set({ memberListOpen: !membersOpen })} aria-label="Участники">
              <LuUsers />
            </button>
          </Tooltip>
        )}
        <Tooltip text="Поиск" side="bottom">
          <button className="icon-btn" onClick={() => uiStore.set({ modal: { kind: 'search', serverId, channelId } })} aria-label="Поиск по сообщениям">
            <LuSearch />
          </button>
        </Tooltip>
      </header>
      {isDm && (inCallHere || callActive) && <CallStage channelId={channelId} />}
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          className={`chat${chatBg !== 'none' ? ` bg-${chatBg}` : ''}`}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes('Files')) setDrag((d) => d + 1);
          }}
          onDragLeave={() => setDrag((d) => Math.max(0, d - 1))}
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(0);
            const files = Array.from(e.dataTransfer.files);
            if (files.length) composer.current?.addFiles(files);
          }}
        >
          <MessageList channelId={channelId} serverId={serverId} jumpTo={jumpTo} intro={intro} />
          <TypingIndicator channelId={channelId} />
          <Composer ref={composer} channelId={channelId} serverId={serverId} placeholder={isDm ? `Сообщение для @${otherName}` : `Написать в #${channel.name}`} />
          {drag > 0 && (
            <div className="drop-overlay">
              <div>
                Перетащите файлы для загрузки
                <div className="muted" style={{ fontSize: '0.875rem', fontWeight: 500, marginTop: 6 }}>
                  в {isDm ? `@${otherName}` : `#${channel.name}`} · до 25 МБ
                </div>
              </div>
            </div>
          )}
        </div>
        {thread && (
          <ThreadPanel key={thread} channelId={channelId} serverId={serverId} messageId={thread} onClose={closeThread} />
        )}
      </div>
      {pins && <PinsPopover channelId={channelId} anchor={pins} onClose={() => setPins(null)} />}
    </div>
  );
}

