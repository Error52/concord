/** Wire shapes returned by the API and gateway. */

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';
export type ChosenStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export interface ProfileTheme {
  preset: string;
  primary?: string;
  secondary?: string;
  /** "solid" | "gradient" | "image" */
  background?: 'solid' | 'gradient' | 'image';
  glow?: boolean;
  cardStyle?: 'default' | 'glass' | 'outline';
}

export interface BadgeDTO {
  id: string;
  /** null for platform-wide badges (created in the admin panel). */
  serverId: string | null;
  serverName?: string;
  global: boolean;
  name: string;
  description: string;
  emoji: string | null;
  iconUrl: string | null;
  color: string;
  position: number;
}

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  backgroundUrl: string | null;
  bannerColor: string;
  accentColor: string;
  bio: string;
  theme: ProfileTheme;
  status: PresenceStatus;
  customStatus: { text: string | null; emoji: string | null } | null;
  badges: BadgeDTO[];
  createdAt: string;
}

export interface SelfUser extends PublicUser {
  email: string;
  emailVerified: boolean;
  accountReady:boolean;
  hasRecoveryWord:boolean;
  recoveryWordAllowed:boolean;
  verificationMode:'email'|'secret-word';
  emailVerificationRequired: boolean;
  demoMailbox: boolean;
  chosenStatus: ChosenStatus;
  totpEnabled: boolean;
  isPlatformAdmin: boolean;
}

export interface RoleDTO {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  permissions: string; // bigint as decimal string
  position: number;
  isDefault: boolean;
  hoist: boolean;
}

export interface ChannelDTO {
  id: string;
  serverId: string | null;
  type: 'text' | 'voice' | 'dm';
  name: string;
  topic: string;
  category: string;
  position: number;
  slowmodeSeconds: number;
  lastMessageId: string | null;
}

export interface MemberDTO {
  serverId: string;
  user: PublicUser;
  nickname: string | null;
  roleIds: string[];
  joinedAt: string;
  timeoutUntil: string | null;
}

export interface ServerDTO {
  id: string;
  name: string;
  description: string;
  iconUrl: string | null;
  bannerUrl: string | null;
  ownerId: string;
  isPublic: boolean;
  createdAt: string;
  memberCount?: number;
}

export interface AttachmentDTO {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'video' | 'audio' | 'file';
  width: number | null;
  height: number | null;
  url: string;
  previewUrl: string | null;
}

export interface EmbedDTO {
  type: 'gif';
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  title?: string;
  provider: string;
}

export interface ReactionDTO {
  emoji: string;
  count: number;
  me: boolean;
  userIds: string[];
}

export interface MessageDTO {
  id: string;
  channelId: string;
  serverId: string | null;
  author: PublicUser | null;
  content: string;
  kind: 'default' | 'system';
  replyTo: { id: string; author: PublicUser | null; content: string } | null;
  attachments: AttachmentDTO[];
  embeds: EmbedDTO[];
  reactions: ReactionDTO[];
  mentionIds: string[];
  mentionsEveryone: boolean;
  pinned: boolean;
  editedAt: string | null;
  createdAt: string;
}

export interface VoiceStateDTO {
  userId: string;
  channelId: string;
  serverId: string | null;
  selfMute: boolean;
  selfDeaf: boolean;
  serverMute: boolean;
  serverDeaf: boolean;
  camera: boolean;
  screen: boolean;
  joinedAt: string;
}
