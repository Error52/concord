/** Mirrors backend/src/models/permissions.ts — used only to hide UI; the backend enforces everything. */
export const Perm = {
  ADMINISTRATOR: 1n << 0n,
  MANAGE_SERVER: 1n << 1n,
  MANAGE_CHANNELS: 1n << 2n,
  MANAGE_MESSAGES: 1n << 3n,
  KICK_MEMBERS: 1n << 4n,
  BAN_MEMBERS: 1n << 5n,
  MANAGE_ROLES: 1n << 6n,
  MANAGE_VOICE: 1n << 7n,
  MANAGE_BADGES: 1n << 8n,
  MODERATE_MEMBERS: 1n << 9n,
  CREATE_INVITE: 1n << 10n,
  VIEW_AUDIT_LOG: 1n << 11n,
  MENTION_EVERYONE: 1n << 12n,
  SEND_MESSAGES: 1n << 13n,
  ATTACH_FILES: 1n << 14n,
  ADD_REACTIONS: 1n << 15n,
  CONNECT: 1n << 16n,
  SPEAK: 1n << 17n,
  VIDEO: 1n << 18n,
  PIN_MESSAGES: 1n << 19n,
} as const;

export type PermName = keyof typeof Perm;

export const PERM_LABELS: Record<PermName, { label: string; hint: string }> = {
  ADMINISTRATOR: { label: 'Администратор', hint: 'Все права. Выдавайте осторожно.' },
  MANAGE_SERVER: { label: 'Управлять сервером', hint: 'Название, иконка, баннер, приглашения' },
  MANAGE_CHANNELS: { label: 'Управлять каналами', hint: 'Создание, изменение и удаление каналов' },
  MANAGE_MESSAGES: { label: 'Управлять сообщениями', hint: 'Удаление чужих сообщений' },
  KICK_MEMBERS: { label: 'Выгонять участников', hint: '' },
  BAN_MEMBERS: { label: 'Банить участников', hint: '' },
  MANAGE_ROLES: { label: 'Управлять ролями', hint: 'Только роли ниже своей' },
  MANAGE_VOICE: { label: 'Управлять голосом', hint: 'Серверный мут, перемещение, отключение' },
  MANAGE_BADGES: { label: 'Управлять значками', hint: 'Создание и выдача значков' },
  MODERATE_MEMBERS: { label: 'Тайм-аут', hint: 'Временно ограничивать участников' },
  CREATE_INVITE: { label: 'Создавать приглашения', hint: '' },
  VIEW_AUDIT_LOG: { label: 'Журнал аудита', hint: '' },
  MENTION_EVERYONE: { label: 'Упоминать @everyone', hint: '' },
  SEND_MESSAGES: { label: 'Отправлять сообщения', hint: '' },
  ATTACH_FILES: { label: 'Прикреплять файлы', hint: '' },
  ADD_REACTIONS: { label: 'Добавлять реакции', hint: '' },
  CONNECT: { label: 'Подключаться к голосу', hint: '' },
  SPEAK: { label: 'Говорить', hint: '' },
  VIDEO: { label: 'Видео и демонстрация', hint: '' },
  PIN_MESSAGES: { label: 'Закреплять сообщения', hint: '' },
};

export function can(perms: bigint | undefined, flag: bigint): boolean {
  if (perms === undefined) return false;
  return (perms & Perm.ADMINISTRATOR) !== 0n || (perms & flag) === flag;
}
