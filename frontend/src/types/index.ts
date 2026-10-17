/** Wire types — mirror backend/src/models/dto.ts. */

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';
export type ChosenStatus = 'online' | 'idle' | 'dnd' | 'invisible';

export interface ProfileTheme {
  preset: string;
  primary?: string;
  secondary?: string;
  background?: 'solid' | 'gradient' | 'image';
  glow?: boolean;
  cardStyle?: 'default' | 'glass' | 'outline';
}

export interface Badge {
  id: string;
  /** null for special (platform-wide) badges from the admin panel. */
  serverId: string | null;
  serverName?: string;
  global?: boolean;
  name: string;
  description: string;
  emoji: string | null;
  iconUrl: string | null;
  color: string;
  position: number;
}

export interface User {
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
  badges: Badge[];
  createdAt: string;
}

export interface SelfUser extends User {
  email: string;
  emailVerified: boolean;
  emailVerificationRequired: boolean;
  accountReady: boolean;
  hasRecoveryWord: boolean;
  recoveryWordAllowed: boolean;
  verificationMode: 'email' | 'secret-word';
  demoMailbox: boolean;
  chosenStatus: ChosenStatus;
  totpEnabled: boolean;
  isPlatformAdmin: boolean;
}

export interface AuthOptions {
  verificationMode: 'email' | 'secret-word';
  recoveryWordMinLength: number;
  recoveryWordMaxLength: number;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string | null;
  permissions: string;
  position: number;
  isDefault: boolean;
  hoist: boolean;
}

export interface Channel {
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

export interface Member {
  serverId: string;
  user: User;
  nickname: string | null;
  roleIds: string[];
  joinedAt: string;
  timeoutUntil: string | null;
}

export interface Server {
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

export interface VoiceState {
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

export interface FullServer {
  server: Server;
  channels: Channel[];
  roles: Role[];
  members: Member[];
  voiceStates: VoiceState[];
  permissions: string;
}

export interface Attachment {
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

export interface GifEmbed {
  type: 'gif';
  url: string;
  previewUrl: string;
  width: number;
  height: number;
  title?: string;
  provider: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
  userIds: string[];
}

export interface Message {
  id: string;
  channelId: string;
  serverId: string | null;
  author: User | null;
  content: string;
  kind: 'default' | 'system';
  replyTo: { id: string; author: User | null; content: string } | null;
  attachments: Attachment[];
  embeds: GifEmbed[];
  reactions: Reaction[];
  mentionIds: string[];
  mentionsEveryone: boolean;
  pinned: boolean;
  editedAt: string | null;
  createdAt: string;
  nonce?: string;
  /** client-only: optimistic message that hasn't been acknowledged yet */
  pending?: boolean;
  failed?: boolean;
}

export interface Dm {
  id: string;
  type: 'dm';
  recipients: User[];
  lastMessageId: string | null;
}

export type RelationType = 'friend' | 'incoming' | 'outgoing' | 'blocked';
export interface Relation {
  id: string;
  type: RelationType;
  user: User;
  since: string;
}

export interface ReadState {
  channelId: string;
  lastReadId: string;
  mentionCount: number;
  revision?: string;
}

export interface Notification {
  revision?: string;
  unread?: number;
  id: string;
  type: 'mention' | 'everyone' | 'dm' | 'friend_request' | 'friend_accept' | 'call' | 'server';
  data: Record<string, any>;
  read: boolean;
  createdAt: string;
}

export interface Invite {
  code: string;
  serverId: string;
  creatorId: string | null;
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  createdAt: string;
}

export interface ProfileView {
  user: User;
  mutualServers: Server[];
  mutualFriends: User[];
  relationship: 'self' | 'friend' | 'incoming' | 'outgoing' | 'blocked' | 'none';
}

export interface Gif {
  id: string;
  title: string;
  url: string;
  previewUrl: string;
  width: number;
  height: number;
}

export interface IncomingCall {
  id?: string;
  timeoutSec?: number;
  channelId: string;
  caller: User;
  video: boolean;
}

export interface ReadyPayload {
  user: SelfUser;
  servers: FullServer[];
  dms: Dm[];
  relationships: Relation[];
  readStates: ReadState[];
  notifications: { items: Notification[]; unread: number;revision?:string };
  dmVoiceStates: VoiceState[];
  voiceState: VoiceState | null;
  incomingCalls: IncomingCall[];
  features: { gif: { enabled: boolean; provider: string | null } };
}

export interface SearchResult extends Message {
  channelName: string;
}
