import { useEffect, useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { getState, useApp } from '../../state/app';
import { clearNotifications,displayName,markNotificationsRead,notificationTitle } from '../../state/actions';
import { navigate } from '../../state/router';
import { toast } from '../../state/ui';
import { formatTimestamp } from '../../utils/format';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { MessageBody } from '../chat/MessageItem';
import { plainMentions } from '../../utils/markdown';
import type { Message, Notification, User } from '../../types';

function openNotification(n: Notification, close: () => void): void {
  const d = n.data;
  close();
  if (typeof d.channelId === 'string') {
    if (d.serverId) navigate({ name: 'channel', serverId: d.serverId as string, channelId: d.channelId, messageId: d.messageId as string | undefined });
    else navigate({ name: 'dm', channelId: d.channelId, messageId: d.messageId as string | undefined });
  } else if (n.type === 'friend_request' || n.type === 'friend_accept') navigate({ name: 'friends' });
}

/** Notification inbox: mentions, DMs, friend requests, calls. */
export function InboxModal({ onClose }: { onClose: () => void }) {
  const items = useApp((s) => s.notifications);
  useEffect(() => {
    // Opening the inbox marks everything as read.
    void markNotificationsRead().catch(err=>toast(errorMessage(err,'Не удалось отметить уведомления'),'error'));
  }, []);
  return (
    <Modal
      title="Уведомления"
      onClose={onClose}
      width={560}
      footer={
        <button
          className="btn btn-ghost"
          onClick={() =>
            void clearNotifications().catch(err=>toast(errorMessage(err),'error'))
          }
        >
          Очистить всё
        </button>
      }
    >
      {items.length === 0 && <div className="empty">Новых уведомлений нет.</div>}
      {items.map((n) => {
        const who = (n.data.author ?? n.data.from ?? n.data.user ?? n.data.caller) as User | undefined;
        return (
          <button key={n.id} className="pcard-section row" style={{ textAlign: 'left', background: n.read ? 'var(--bg-3)' : 'var(--accent-soft)', alignItems: 'flex-start' }} onClick={() => openNotification(n, onClose)}>
            <Avatar user={who ?? null} size={32} />
            <span className="grow" style={{ minWidth: 0 }}>
              <strong style={{ color: 'var(--text-0)' }}>{notificationTitle(n)}</strong>
              {typeof n.data.content === 'string' && n.data.content && (
                <span className="ellipsis muted" style={{ display: 'block' }}>
                  {plainMentions(n.data.content, (id) => displayName(getState(), getState().users[id] ?? null))}
                </span>
              )}
              <span className="msg-time">{formatTimestamp(n.createdAt)}</span>
            </span>
          </button>
        );
      })}
    </Modal>
  );
}

export function BookmarksModal({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<Message[] | null>(null);
  useEffect(() => {
    api.get<Message[]>('/bookmarks').then(setItems, (err) => toast(errorMessage(err), 'error'));
  }, []);
  return (
    <Modal title="Закладки" subtitle="Сохранённые сообщения видны только вам." onClose={onClose} width={600}>
      {items === null && <div className="skeleton" style={{ height: 80 }} />}
      {items?.length === 0 && <div className="empty">Добавляйте сообщения в закладки через меню сообщения («…» → «В закладки»).</div>}
      {items?.map((m) => (
        <div key={m.id} className="pcard-section" style={{ background: 'var(--bg-3)' }}>
          <div className="row" style={{ marginBottom: 4 }}>
            <Avatar user={m.author} size={20} />
            <strong style={{ color: 'var(--text-0)' }}>{m.author?.displayName || m.author?.username}</strong>
            <span className="msg-time">{formatTimestamp(m.createdAt)}</span>
            <span className="grow" />
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                onClose();
                if (m.serverId) navigate({ name: 'channel', serverId: m.serverId, channelId: m.channelId, messageId: m.id });
                else navigate({ name: 'dm', channelId: m.channelId, messageId: m.id });
              }}
            >
              Перейти
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void api.del(`/messages/${m.id}/bookmark`).then(() => setItems((l) => l?.filter((x) => x.id !== m.id) ?? null))}
            >
              Убрать
            </button>
          </div>
          <MessageBody m={m} />
          {m.attachments.length > 0 && <div className="muted" style={{ fontSize: '0.75rem' }}>📎 {m.attachments.map((a) => a.filename).join(', ')}</div>}
        </div>
      ))}
    </Modal>
  );
}
