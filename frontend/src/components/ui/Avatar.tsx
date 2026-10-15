import { memo, type MouseEvent } from 'react';
import type { PresenceStatus, User } from '../../types';
import { hashColor, initials } from '../../utils/format';

interface Props {
  user: Pick<User, 'id' | 'username' | 'displayName' | 'avatarUrl'> | null;
  size?: number;
  status?: PresenceStatus | null;
  speaking?: boolean;
  ring?: string;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  onContextMenu?: (e: MouseEvent<HTMLElement>) => void;
}

export const Avatar = memo(function Avatar({ user, size = 40, status, speaking, ring, onClick, onContextMenu }: Props) {
  const name = user?.displayName || user?.username || '?';
  const dot = Math.max(10, Math.round(size * 0.32));
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`avatar${speaking ? ' speaking' : ''}`}
      style={{ width: size, height: size, ['--status-ring' as string]: ring }}
      onClick={onClick}
      onContextMenu={onContextMenu}
      aria-label={onClick ? `Профиль ${name}` : undefined}
      type={onClick ? 'button' : undefined}
    >
      {user?.avatarUrl ? (
        <img className="avatar-img" src={user.avatarUrl} alt="" loading="lazy" draggable={false} />
      ) : (
        <div className="avatar-img" style={{ background: hashColor(user?.id ?? name), fontSize: size * 0.38 }} aria-hidden>
          {initials(name)}
        </div>
      )}
      {status && <span className={`status-dot ${status}`} style={{ width: dot, height: dot }} title={STATUS_LABEL[status]} />}
    </Tag>
  );
});

export const STATUS_LABEL: Record<PresenceStatus, string> = {
  online: 'В сети',
  idle: 'Неактивен',
  dnd: 'Не беспокоить',
  offline: 'Не в сети',
};
