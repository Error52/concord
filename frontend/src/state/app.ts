import { createStore, useStoreSelector } from './store';
import type {
  Channel,
  Dm,
  IncomingCall,
  Member,
  Message,
  Notification,
  ReadState,
  Relation,
  Role,
  SelfUser,
  Server,
  User,
  VoiceState,
} from '../types';
import type { GatewayStatus } from '../websocket/gateway';

export interface ChannelMessages {
  items: Message[];
  hasMoreBefore: boolean;
  /** false when the window was loaded "around" an old message and newer ones aren't loaded yet */
  atLatest: boolean;
  loading: boolean;
}

export interface AppState {
  auth: 'loading' | 'guest' | 'authed';
  me: SelfUser | null;
  users: Record<string, User>;
  servers: Record<string, Server>;
  serverOrder: string[];
  channels: Record<string, Channel>;
  roles: Record<string, Role[]>;
  members: Record<string, Record<string, Member>>;
  permissions: Record<string, bigint>;
  voiceStates: Record<string, VoiceState>;
  dms: Record<string, Dm>;
  relationships: Record<string, Relation>;
  readStates: Record<string, ReadState>;
  messages: Record<string, ChannelMessages>;
  typing: Record<string, Record<string, { name: string; until: number }>>;
  speaking: Record<string, boolean>;
  notifications: Notification[];
  unreadNotifications: number;
  incomingCalls: IncomingCall[];
  gateway: GatewayStatus;
  features: { gif: boolean };
  ready: boolean;
}

export const initialState: AppState = {
  auth: 'loading',
  me: null,
  users: {},
  servers: {},
  serverOrder: [],
  channels: {},
  roles: {},
  members: {},
  permissions: {},
  voiceStates: {},
  dms: {},
  relationships: {},
  readStates: {},
  messages: {},
  typing: {},
  speaking: {},
  notifications: [],
  unreadNotifications: 0,
  incomingCalls: [],
  gateway: 'offline',
  features: { gif: false },
  ready: false,
};

export const appStore = createStore<AppState>(initialState);

export function useApp<T>(selector: (s: AppState) => T): T {
  return useStoreSelector(appStore, selector);
}

export const getState = (): AppState => appStore.get();
export const setState = appStore.set;

/** Latest version of a user: the global cache wins over copies embedded in members/messages. */
export function resolveUser(s: AppState, u: User | null | undefined): User | null {
  if (!u) return null;
  return s.users[u.id] ?? u;
}
