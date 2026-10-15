import { createStore, useStoreSelector } from './store';

/** Minimal History-API router. Routes:
 *   /login /register /forgot /reset-password?token=…  /invite/:code
 *   /channels/@me            friends
 *   /channels/@me/:dmId      direct message
 *   /channels/:serverId/:channelId
 *   /discover
 */
export type Route =
  | { name: 'login' }
  | { name: 'register' }
  | { name: 'forgot' }
  | { name: 'reset'; token: string }
  | { name: 'verify'; token: string }
  | { name: 'invite'; code: string }
  | { name: 'friends' }
  | { name: 'dm'; channelId: string; messageId?: string }
  | { name: 'channel'; serverId: string; channelId: string | null; messageId?: string }
  | { name: 'discover' };

export function parse(pathname: string, search: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  const q = new URLSearchParams(search);
  switch (parts[0]) {
    case 'login':
      return { name: 'login' };
    case 'register':
      return { name: 'register' };
    case 'forgot':
      return { name: 'forgot' };
    case 'reset-password':
      return { name: 'reset', token: q.get('token') ?? '' };
    case 'verify-email':
      return { name: 'verify', token: q.get('token') ?? '' };
    case 'invite':
      return parts[1] ? { name: 'invite', code: parts[1] } : { name: 'friends' };
    case 'discover':
      return { name: 'discover' };
    case 'channels':
      if (parts[1] === '@me') return parts[2] ? { name: 'dm', channelId: parts[2], messageId: parts[3] } : { name: 'friends' };
      if (parts[1]) return { name: 'channel', serverId: parts[1], channelId: parts[2] ?? null, messageId: parts[3] };
      return { name: 'friends' };
    default:
      return { name: 'friends' };
  }
}

export function toPath(r: Route): string {
  switch (r.name) {
    case 'login':
      return '/login';
    case 'register':
      return '/register';
    case 'forgot':
      return '/forgot';
    case 'reset':
      return `/reset-password?token=${encodeURIComponent(r.token)}`;
    case 'verify':
      return r.token ? `/verify-email?token=${encodeURIComponent(r.token)}` : '/verify-email';
    case 'invite':
      return `/invite/${r.code}`;
    case 'discover':
      return '/discover';
    case 'friends':
      return '/channels/@me';
    case 'dm':
      return `/channels/@me/${r.channelId}${r.messageId ? `/${r.messageId}` : ''}`;
    case 'channel':
      return `/channels/${r.serverId}${r.channelId ? `/${r.channelId}` : ''}${r.messageId ? `/${r.messageId}` : ''}`;
  }
}

export const routerStore = createStore<{ route: Route }>({ route: parse(location.pathname, location.search) });

window.addEventListener('popstate', () => routerStore.set({ route: parse(location.pathname, location.search) }));

export function navigate(r: Route, replace = false): void {
  const path = toPath(r);
  if (path !== location.pathname + location.search) {
    if (replace) history.replaceState(null, '', path);
    else history.pushState(null, '', path);
  }
  routerStore.set({ route: r });
}

export function useRoute(): Route {
  return useStoreSelector(routerStore, (s) => s.route);
}
