/** Server permission bit flags (stored as bigint in roles.permissions). */
export const Perm = {
  ADMINISTRATOR: 1n << 0n,
  MANAGE_SERVER: 1n << 1n,
  MANAGE_CHANNELS: 1n << 2n,
  MANAGE_MESSAGES: 1n << 3n,
  KICK_MEMBERS: 1n << 4n,
  BAN_MEMBERS: 1n << 5n,
  MANAGE_ROLES: 1n << 6n,
  MANAGE_VOICE: 1n << 7n, // server mute/deafen, move, disconnect
  MANAGE_BADGES: 1n << 8n,
  MODERATE_MEMBERS: 1n << 9n, // timeout
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
export const ALL_PERMISSIONS = Object.values(Perm).reduce((a, b) => a | b, 0n);

export const DEFAULT_MEMBER_PERMS =
  Perm.SEND_MESSAGES | Perm.ATTACH_FILES | Perm.ADD_REACTIONS | Perm.CONNECT | Perm.SPEAK | Perm.VIDEO | Perm.CREATE_INVITE;

export const MODERATOR_PERMS =
  DEFAULT_MEMBER_PERMS |
  Perm.MANAGE_MESSAGES |
  Perm.KICK_MEMBERS |
  Perm.MODERATE_MEMBERS |
  Perm.MANAGE_VOICE |
  Perm.VIEW_AUDIT_LOG |
  Perm.PIN_MESSAGES |
  Perm.MENTION_EVERYONE;

export const ADMIN_PERMS = ALL_PERMISSIONS & ~Perm.ADMINISTRATOR;

export function has(perms: bigint, flag: bigint): boolean {
  return (perms & Perm.ADMINISTRATOR) !== 0n || (perms & flag) === flag;
}

export function permNames(perms: bigint): PermName[] {
  return (Object.keys(Perm) as PermName[]).filter((k) => (perms & Perm[k]) !== 0n);
}

export function fromNames(names: string[]): bigint {
  let v = 0n;
  for (const n of names) if (n in Perm) v |= Perm[n as PermName];
  return v;
}
