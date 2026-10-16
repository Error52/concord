import { memo, useState, type ReactNode } from 'react';
import {
  LuArrowRight,
  LuBookmark,
  LuCopy,
  LuDownload,
  LuFile,
  LuMailOpen,
  LuPencil,
  LuPhone,
  LuPhoneMissed,
  LuPin,
  LuReply,
  LuSmilePlus,
  LuTrash2,
  LuEllipsis,
  LuMessagesSquare,
} from 'react-icons/lu';
import { useApp, getState } from '../../state/app';
import { deleteMessage, displayName, discardFailed, editMessage, markUnread, roleColor, sendMessage, toggleReaction } from '../../state/actions';
import { api, errorMessage } from '../../api/client';
import { uiStore, openContextMenu, openProfile, toast, useUi, type ContextMenuItem } from '../../state/ui';
import { renderMarkdown, isEmojiOnly, plainMentions } from '../../utils/markdown';
import { formatBytes, formatDuration, formatFull, formatTime, formatTimestamp } from '../../utils/format';
import { QUICK_REACTIONS } from '../../utils/emoji';
import { can, Perm } from '../../utils/permissions';
import { Avatar } from '../ui/Avatar';
import { Tooltip } from '../ui/Overlays';
import { ReactionPicker } from './Pickers';
import type { Attachment, Message } from '../../types';

function Mention({ userId, serverId }: { userId: string; serverId: string | null }) {
  const name = useApp((s) => {
    const u = s.users[userId] ?? (serverId ? s.members[serverId]?.[userId]?.user : undefined);
    return u ? displayName(s, u, serverId) : 'неизвестный';
  });
  return (
    <span className="mention" role="button" tabIndex={0} onClick={(e) => openProfile(userId, serverId, e)}>
      @{name}
    </span>
  );
}

export function MessageBody({ m }: { m: Message }) {
  if (!m.content) return null;
  const jumbo = isEmojiOnly(m.content);
  return (
    <div className={`msg-content${jumbo ? ' jumbo' : ''}`}>
      {jumbo
        ? m.content
        : renderMarkdown(m.content, {
            highlightEveryone: m.mentionsEveryone,
            renderMention: (id) => <Mention userId={id} serverId={m.serverId} />,
          })}
      {m.editedAt && (
        <Tooltip text={formatFull(m.editedAt)}>
          <span className="msg-edited">(изменено)</span>
        </Tooltip>
      )}
    </div>
  );
}

function AttachmentView({ a, onOpenImage }: { a: Attachment; onOpenImage: (a: Attachment) => void }) {
  if (a.kind === 'image') {
    const w = a.width ?? 400;
    const h = a.height ?? 300;
    const scale = Math.min(1, 420 / w, 340 / h);
    return (
      <img
        className="att-image"
        src={a.previewUrl ?? a.url}
        alt={a.filename}
        width={Math.round(w * scale)}
        height={Math.round(h * scale)}
        loading="lazy"
        onClick={() => onOpenImage(a)}
      />
    );
  }
  if (a.kind === 'video') return <video className="att-video" src={a.url} controls preload="metadata" />;
  return (
    <div className={a.kind === 'audio' ? 'att-file att-audio' : 'att-file'} style={a.kind === 'audio' ? { flexDirection: 'column', alignItems: 'stretch' } : undefined}>
      <div className="row">
        <LuFile />
        <div className="grow">
          <a href={a.url} target="_blank" rel="noopener noreferrer" className="ellipsis" style={{ display: 'block' }}>
            {a.filename}
          </a>
          <span className="muted" style={{ fontSize: '0.75rem' }}>{formatBytes(a.size)}</span>
        </div>
        <a className="icon-btn" href={`${a.url}?download=1`} download={a.filename} aria-label="Скачать">
          <LuDownload />
        </a>
      </div>
      {a.kind === 'audio' && <audio src={a.url} controls preload="metadata" />}
    </div>
  );
}

function SystemMessage({ m }: { m: Message }) {
  const name = useApp((s) => displayName(s, m.author, m.serverId));
  let icon: ReactNode = <LuArrowRight />;
  let text: ReactNode = `${name} присоединяется к серверу`;
  if (m.content === 'call:missed') {
    icon = <LuPhoneMissed style={{ color: 'var(--red)' }} />;
    text = `Пропущенный звонок от ${name}`;
  } else if (m.content.startsWith('call:ended:')) {
    icon = <LuPhone />;
    text = `${name} начал(а) звонок, который длился ${formatDuration(Number(m.content.split(':')[2]))}`;
  }
  return (
    <div className="msg-system" data-message-id={m.id}>
      {icon}
      <span>{text}</span>
      <span className="msg-time">{formatTimestamp(m.createdAt)}</span>
    </div>
  );
}

interface Props {
  m: Message;
  head: boolean;
  canManage: boolean;
  canPin: boolean;
  onOpenImage: (a: Attachment) => void;
  highlight: boolean;
}

export const MessageItem = memo(function MessageItem({ m, head, canManage, canPin, onOpenImage, highlight }: Props) {
  const me = useApp((s) => s.me?.id);
  const author = useApp((s) => (m.author ? (s.users[m.author.id] ?? m.author) : null));
  const name = useApp((s) => displayName(s, author, m.serverId));
  const color = useApp((s) => (author ? roleColor(s, m.serverId, author.id) : null));
  const editing = useUi((s) => s.editing === m.id);
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState(m.content);

  if (m.kind === 'system') return <SystemMessage m={m} />;
  const mine = author?.id === me;
  const mentioned = !!me && !mine && (m.mentionIds.includes(me) || m.mentionsEveryone);

  const reply = () => uiStore.set((s) => ({ replyTo: { ...s.replyTo, [m.channelId]: m.id } }));
  const startEdit = () => {
    setDraft(m.content);
    uiStore.set({ editing: m.id });
  };
  const remove = () => {
    if (confirm('Удалить это сообщение?')) void deleteMessage(m);
  };
  const pin = () =>
    void (m.pinned ? api.del(`/messages/${m.id}/pin`) : api.put(`/messages/${m.id}/pin`)).catch((err) => toast(errorMessage(err, 'Не удалось закрепить'), 'error'));
  const bookmark = () =>
    void api.put(`/messages/${m.id}/bookmark`).then(
      () => toast('Сохранено в закладки', 'success'),
      (err) => toast(errorMessage(err), 'error'),
    );
  const link = `${location.origin}/channels/${m.serverId ?? '@me'}/${m.channelId}/${m.id}`;

  const menu = (): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      { label: 'Ответить', icon: <LuReply />, onSelect: reply },
      { label: 'Открыть ветку', icon: <LuMessagesSquare />, onSelect: () => uiStore.set({ threadOf: { channelId: m.channelId, messageId: m.id } }) },
      { label: 'Добавить реакцию', icon: <LuSmilePlus />, onSelect: () => setPicker({ x: innerWidth / 2 - 180, y: innerHeight / 2 - 210 }) },
    ];
    if (mine) items.push({ label: 'Редактировать', icon: <LuPencil />, onSelect: startEdit });
    if (canPin) items.push({ label: m.pinned ? 'Открепить' : 'Закрепить', icon: <LuPin />, onSelect: pin });
    items.push({ label: 'В закладки', icon: <LuBookmark />, onSelect: bookmark });
    items.push({ label: 'Копировать текст', icon: <LuCopy />, onSelect: () => void navigator.clipboard?.writeText(m.content) });
    items.push({ label: 'Копировать ссылку', icon: <LuCopy />, onSelect: () => void navigator.clipboard?.writeText(link) });
    items.push({ label: 'Отметить как непрочитанное', icon: <LuMailOpen />, onSelect: () => void markUnread(m) });
    if (mine || canManage) items.push({ divider: true, label: '' }, { label: 'Удалить', icon: <LuTrash2 />, danger: true, onSelect: remove });
    return items;
  };

  if (m.failed) {
    return (
      <div className="msg failed">
        <div className="msg-gutter" />
        <div>
          <MessageBody m={m} />
          <div className="row" style={{ fontSize: '0.75rem' }}>
            Не удалось отправить сообщение.
            <button className="link-btn" onClick={() => (discardFailed(m.channelId, m.id), void sendMessage(m.channelId, { content: m.content,replyToId:m.replyTo?.id,nonce:m.nonce }))}>
              Повторить
            </button>
            <button className="link-btn" onClick={() => discardFailed(m.channelId, m.id)}>
              Удалить
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`msg${head || m.replyTo ? ' head' : ''}${mentioned ? ' mentioned' : ''}${m.pending ? ' pending' : ''}${highlight ? ' highlight' : ''}`}
      data-message-id={m.id}
      onContextMenu={(e) => !editing && openContextMenu(e, menu())}
    >
      {m.replyTo && (
        <div
          className="msg-reply"
          onClick={() => {
            const el = document.querySelector(`[data-message-id="${m.replyTo!.id}"]`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              uiStore.set({ highlight: m.replyTo!.id });
            }
          }}
        >
          <Avatar user={m.replyTo.author} size={16} />
          <b>@{displayName(getState(), m.replyTo.author, m.serverId)}</b>
          <span className="ellipsis">{m.replyTo.content ? plainMentions(m.replyTo.content, (id) => displayName(getState(), getState().users[id] ?? null, m.serverId)) : 'Вложение'}</span>
        </div>
      )}
      <div className="msg-gutter">
        {head || m.replyTo ? (
          <Avatar user={author} size={40} onClick={(e) => author && openProfile(author.id, m.serverId, e)} />
        ) : (
          <Tooltip text={formatFull(m.createdAt)}>
            <span className="msg-hover-time">{formatTime(m.createdAt)}</span>
          </Tooltip>
        )}
      </div>
      <div style={{ minWidth: 0 }}>
        {(head || m.replyTo) && (
          <div className="msg-head">
            <span className="msg-author" style={color ? { color } : undefined} onClick={(e) => author && openProfile(author.id, m.serverId, e)}>
              {name}
            </span>
            <Tooltip text={formatFull(m.createdAt)}>
              <span className="msg-time">{formatTimestamp(m.createdAt)}</span>
            </Tooltip>
            {m.pinned && <LuPin style={{ width: 12, height: 12, color: 'var(--text-3)' }} aria-label="Закреплено" />}
          </div>
        )}
        {editing ? (
          <div className="composer" style={{ marginTop: 4 }}>
            <div className="composer-row">
              <textarea
                autoFocus
                value={draft}
                rows={Math.min(10, draft.split('\n').length)}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') uiStore.set({ editing: null });
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (draft.trim() && draft !== m.content) void editMessage(m, draft);
                    uiStore.set({ editing: null });
                  }
                }}
              />
            </div>
            <div className="composer-bar" style={{ borderRadius: '0 0 12px 12px', borderBottom: 0 }}>
              Escape — отмена · Enter — сохранить
            </div>
          </div>
        ) : (
          <MessageBody m={m} />
        )}
        {m.embeds.map((g, i) => (
          <img key={i} className="gif-embed" src={g.url} alt={g.title ?? 'GIF'} width={g.width} height={g.height} loading="lazy" style={{ height: 'auto' }} />
        ))}
        {m.attachments.length > 0 && (
          <div className="attachments">
            {m.attachments.map((a) => (
              <AttachmentView key={a.id} a={a} onOpenImage={onOpenImage} />
            ))}
          </div>
        )}
        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <Tooltip key={r.emoji} text={`${r.emoji} — ${r.userIds.map((id) => displayName(getState(), getState().users[id] ?? null)).join(', ')}${r.count > r.userIds.length ? ` и ещё ${r.count - r.userIds.length}` : ''}`}>
                <button className={`reaction${r.me ? ' me' : ''}`} onClick={() => void toggleReaction(m, r.emoji)}>
                  <span>{r.emoji}</span>
                  <span className="reaction-count">{r.count}</span>
                </button>
              </Tooltip>
            ))}
            <button className="reaction" onClick={(e) => setPicker({ x: e.clientX, y: e.clientY - 420 })} aria-label="Добавить реакцию">
              <LuSmilePlus style={{ width: 16, height: 16 }} />
            </button>
          </div>
        )}
      </div>
      {!m.pending && !editing && (
        <div className={`msg-tools${picker ? ' open' : ''}`}>
          {QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} className="icon-btn" onClick={() => void toggleReaction(m, e)} aria-label={`Реакция ${e}`}>
              {e}
            </button>
          ))}
          <button className="icon-btn" onClick={(e) => setPicker({ x: e.clientX - 360, y: e.clientY })} aria-label="Добавить реакцию">
            <LuSmilePlus />
          </button>
          <button className="icon-btn" onClick={reply} aria-label="Ответить">
            <LuReply />
          </button>
          {mine && (
            <button className="icon-btn" onClick={startEdit} aria-label="Редактировать">
              <LuPencil />
            </button>
          )}
          <button className="icon-btn" onClick={(e) => openContextMenu(e, menu())} aria-label="Ещё">
            <LuEllipsis />
          </button>
        </div>
      )}
      {picker && <ReactionPicker x={picker.x} y={picker.y} onPick={(e) => void toggleReaction(m, e)} onClose={() => setPicker(null)} />}
    </div>
  );
});

export function canManageIn(serverId: string | null): { manage: boolean; pin: boolean } {
  if (!serverId) return { manage: false, pin: true };
  const p = getState().permissions[serverId];
  return { manage: can(p, Perm.MANAGE_MESSAGES), pin: can(p, Perm.PIN_MESSAGES) || can(p, Perm.MANAGE_MESSAGES) };
}
