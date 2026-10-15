import type { ReactNode } from 'react';
import { createStore, useStoreSelector } from './store';

export type SettingsSection =
  | 'account'
  | 'profile'
  | 'privacy'
  | 'security'
  | 'notifications'
  | 'voice'
  | 'appearance'
  | 'accessibility'
  | 'language'
  | 'keybinds'
  | 'admin';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface ProfilePopover {
  userId: string;
  serverId: string | null;
  anchor: { x: number; y: number };
}

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  icon?: ReactNode;
  onSelect?: () => void;
  /** Custom element (e.g. a volume slider) rendered instead of a button. */
  render?: () => ReactNode;
  divider?: boolean;
}

export interface UiState {
  settings: SettingsSection | null;
  serverSettings: { serverId: string; tab: string } | null;
  profile: ProfilePopover | null;
  fullProfile: { userId: string; serverId: string | null } | null;
  contextMenu: { x: number; y: number; items: ContextMenuItem[] } | null;
  modal: { kind: 'createServer' } | { kind: 'createChannel'; serverId: string; type: 'text' | 'voice' } | { kind: 'invite'; serverId: string } | { kind: 'search'; serverId: string | null; channelId?: string } | { kind: 'inbox' } | { kind: 'bookmarks' } | null;
  toasts: Toast[];
  memberListOpen: boolean;
  sidebarHidden: boolean;
  mobilePanel: 'nav' | 'chat' | 'members';
  replyTo: Record<string, string | null>; // channelId → messageId
  editing: string | null;
  highlight: string | null; // message id to flash after a jump
  threadOf: { channelId: string; messageId: string } | null;
}

export const uiStore = createStore<UiState>({
  settings: null,
  serverSettings: null,
  profile: null,
  fullProfile: null,
  contextMenu: null,
  modal: null,
  toasts: [],
  memberListOpen: window.matchMedia('(min-width: 1101px)').matches,
  sidebarHidden: false,
  mobilePanel: 'chat',
  replyTo: {},
  editing: null,
  highlight: null,
  threadOf: null,
});

export function useUi<T>(selector: (s: UiState) => T): T {
  return useStoreSelector(uiStore, selector);
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = ++toastId;
  uiStore.set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, text }] }));
  setTimeout(() => uiStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 6000 : 3500);
}

export function openContextMenu(e: { clientX: number; clientY: number; preventDefault(): void }, items: ContextMenuItem[]): void {
  e.preventDefault();
  uiStore.set({ contextMenu: { x: e.clientX, y: e.clientY, items } });
}

export function openProfile(userId: string, serverId: string | null, e: { clientX: number; clientY: number } | { currentTarget: Element }): void {
  let anchor: { x: number; y: number };
  if ('currentTarget' in e && e.currentTarget instanceof Element) {
    const r = e.currentTarget.getBoundingClientRect();
    anchor = { x: r.right + 8, y: r.top };
  } else {
    const m = e as { clientX: number; clientY: number };
    anchor = { x: m.clientX + 8, y: m.clientY };
  }
  uiStore.set({ profile: { userId, serverId, anchor } });
}
