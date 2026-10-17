import { api, errorMessage } from '../api/client';
import { getState, setState } from './app';
import { firstTextChannel, refreshServer } from './actions';
import { navigate,routerStore } from './router';
import { toast } from './ui';
import type { Channel, Dm, FullServer, Relation } from '../types';

async function attempt<T>(fn: () => Promise<T>, fallback: string): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    toast(errorMessage(err, fallback), 'error');
    return null;
  }
}

export async function createServer(name: string, isPublic: boolean): Promise<void> {
  const full = await attempt(() => api.post<FullServer>('/servers', { name, isPublic }), 'Не удалось создать сервер');
  if (!full) return;
  await refreshServer(full.server.id);
  navigate({ name: 'channel', serverId: full.server.id, channelId: firstTextChannel(getState(), full.server.id) });
}

export async function joinByInvite(code: string): Promise<boolean> {
  const full = await attempt(() => api.post<FullServer>(`/invites/${encodeURIComponent(code)}`), 'Не удалось принять приглашение');
  if (!full) return false;
  await refreshServer(full.server.id);
  navigate({ name: 'channel', serverId: full.server.id, channelId: firstTextChannel(getState(), full.server.id) });
  return true;
}

export async function joinPublic(serverId: string): Promise<void> {
  const full = await attempt(() => api.post<FullServer>(`/servers/${serverId}/join`), 'Не удалось присоединиться');
  if (!full) return;
  await refreshServer(serverId);
  navigate({ name: 'channel', serverId, channelId: firstTextChannel(getState(), serverId) });
}

export async function leaveServer(serverId: string): Promise<void> {
  const name = getState().servers[serverId]?.name ?? 'сервер';
  if (!confirm(`Покинуть «${name}»?`)) return;
  await attempt(() => api.post(`/servers/${serverId}/leave`), 'Не удалось покинуть сервер');
}

export async function deleteServer(serverId: string): Promise<boolean> {
  return (await attempt(() => api.del(`/servers/${serverId}`).then(() => true), 'Не удалось удалить сервер')) ?? false;
}

export async function createChannel(serverId: string, name: string, type: 'text' | 'voice', category?: string): Promise<void> {
  const ch = await attempt(() => api.post<Channel>(`/servers/${serverId}/channels`, { name, type, category }), 'Не удалось создать канал');
  if (ch) {
    setState((s) => ({ channels: { ...s.channels, [ch.id]: ch } }));
    if (type === 'text') navigate({ name: 'channel', serverId, channelId: ch.id });
  }
}

export async function deleteChannel(ch: Channel): Promise<void> {
  if (!confirm(`Удалить канал «${ch.name}»? Все сообщения будут удалены.`)) return;
  await attempt(() => api.del(`/channels/${ch.id}`), 'Не удалось удалить канал');
}

export async function openDm(userId: string): Promise<void> {
  const dm = await attempt(() => api.post<Dm>('/dm', { recipientId: userId }), 'Не удалось открыть диалог');
  if (dm) navigate({ name: 'dm', channelId: dm.id });
}

export async function closeDm(id: string): Promise<void> {
  const previous=getState().dms[id];
  const ok=await attempt(() => api.del(`/dm/${id}`).then(()=>true), 'Не удалось закрыть диалог');
  const current=getState().dms[id];
  if(!ok||(current&&current!==previous))return;
  setState((s) => {
    const { [id]: _, ...dms } = s.dms;
    return { dms };
  });
  const route=routerStore.get().route;
  if(route.name==='dm'&&route.channelId===id)navigate({name:'friends'});
}

let relationRequest=0;
async function mutateRelations(fn:()=>Promise<Relation[]>,fallback:string):Promise<Relation[]|null> {
  const request=++relationRequest,previous=getState().relationships,userId=getState().me?.id;
  const list=await attempt(fn,fallback);
  if(list&&request===relationRequest&&getState().relationships===previous&&getState().me?.id===userId){
    setState({relationships:Object.fromEntries(list.map(r=>[r.id,r]))});
  }
  return list;
}

export async function sendFriendRequest(target: { username?: string; userId?: string }): Promise<boolean> {
  const list = await mutateRelations(() => api.post<Relation[]>('/friends/request', target), 'Не удалось отправить запрос');
  if (list) toast('Запрос в друзья отправлен', 'success');
  return !!list;
}

export async function acceptFriend(userId: string): Promise<void> {
  await mutateRelations(() => api.post<Relation[]>(`/friends/${userId}/accept`), 'Не удалось принять запрос');
}

export async function removeFriend(userId: string): Promise<void> {
  await mutateRelations(() => api.del<Relation[]>(`/friends/${userId}`), 'Не удалось выполнить действие');
}

export async function blockUser(userId: string): Promise<void> {
  if (!confirm('Заблокировать пользователя? Он не сможет писать вам и добавлять в друзья.')) return;
  await mutateRelations(() => api.put<Relation[]>(`/blocks/${userId}`), 'Не удалось заблокировать');
}

export async function unblockUser(userId: string): Promise<void> {
  await mutateRelations(() => api.del<Relation[]>(`/blocks/${userId}`), 'Не удалось разблокировать');
}
