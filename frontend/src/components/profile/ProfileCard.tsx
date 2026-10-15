import type { CSSProperties, ReactNode } from 'react';
import type { Badge, User } from '../../types';
import { Avatar } from '../ui/Avatar';
import { Tooltip } from '../ui/Overlays';
import { PRESET_THEMES, readableTextOn } from '../../utils/color';

export function themeVars(user: Pick<User, 'theme' | 'accentColor'>): { style: CSSProperties; className: string } {
  const preset = PRESET_THEMES[user.theme.preset] ?? PRESET_THEMES.default!;
  const p1 = user.theme.primary ?? preset.primary;
  const p2 = user.theme.secondary ?? preset.secondary;
  const text = readableTextOn(p1, p2) ?? '#ffffff';
  const classes = ['pcard'];
  if (user.theme.background === 'solid') classes.push('solid');
  if (user.theme.glow) classes.push('glow');
  if (user.theme.cardStyle === 'glass') classes.push('glass');
  if (user.theme.cardStyle === 'outline') classes.push('outline');
  return {
    style: { ['--p1' as string]: p1, ['--p2' as string]: p2, ['--pa' as string]: user.accentColor, ['--ptext' as string]: text },
    className: classes.join(' '),
  };
}

export function BadgeIcons({ badges }: { badges: Badge[] }) {
  if (badges.length === 0) return null;
  return (
    <span className="pcard-badges">
      {badges.slice(0, 8).map((b) => (
        <Tooltip
          key={b.id}
          text={
            <span className="badge-tooltip">
              <strong>{b.name}</strong>
              {b.description && <span>{b.description}</span>}
              {b.global ? <span> · Значок Concord</span> : b.serverName && <span> · {b.serverName}</span>}
            </span>
          }
        >
          <span className="badge-icon" style={{ background: `color-mix(in srgb, ${b.color} 30%, transparent)` }} aria-label={b.name}>
            {b.iconUrl ? <img src={b.iconUrl} alt="" /> : (b.emoji ?? '★')}
          </span>
        </Tooltip>
      ))}
    </span>
  );
}

interface Props {
  user: User;
  /** Header buttons (top-right over the banner). */
  actions?: ReactNode;
  /** Content between bio and footer (roles, mutuals…). */
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  onAvatarClick?: () => void;
}

export function ProfileCard({ user, actions, children, footer, className, onAvatarClick }: Props) {
  const { style, className: themeClass } = themeVars(user);
  const bg = user.theme.background === 'image' && user.backgroundUrl ? { backgroundImage: `url(${user.backgroundUrl})` } : {};
  return (
    <div className={`${themeClass}${bg.backgroundImage ? ' image' : ''} ${className ?? ''}`} style={{ ...style, ...bg }}>
      <div
        className="pcard-banner"
        style={user.bannerUrl ? { backgroundImage: `url(${user.bannerUrl})` } : { background: `linear-gradient(135deg, ${user.bannerColor}, color-mix(in srgb, ${user.bannerColor} 50%, #000))` }}
      />
      {actions && <div className="pcard-actions">{actions}</div>}
      <div className="pcard-avatar">
        <Avatar user={user} size={84} status={user.status} onClick={onAvatarClick ? () => onAvatarClick() : undefined} />
      </div>
      {user.customStatus && (
        <div className="pcard-custom-status ellipsis" title={user.customStatus.text ?? ''}>
          {user.customStatus.emoji} {user.customStatus.text}
        </div>
      )}
      <div className="pcard-body">
        <div>
          <div className="pcard-name">{user.displayName || user.username}</div>
          <div className="pcard-handle">
            <span>{user.username}</span>
            <BadgeIcons badges={user.badges} />
          </div>
        </div>
        {user.bio && <div className="pcard-bio">{user.bio}</div>}
        {children}
        {footer}
      </div>
    </div>
  );
}
