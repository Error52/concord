import { api, errorMessage } from '../../api/client';
import { getState } from '../../state/app';
import { blockUser, openDm, removeFriend, sendFriendRequest } from '../../state/serverActions';
import { toast, uiStore, type ContextMenuItem } from '../../state/ui';
import { can, Perm } from '../../utils/permissions';
import { voiceUserMenu } from '../voice/voiceMenus';

async function act(fn: () => Promise<unknown>, ok: string, fail: string): Promise<void> {
  try {
    await fn();
    toast(ok, 'success');
  } catch (err) {
    toast(errorMessage(err, fail), 'error');
  }
}

/** Right-click menu for a server member. Moderation entries are permission-gated (and re-checked by the API). */
export function memberMenu(userId: string, serverId: string | null): ContextMenuItem[] {
  const s = getState();
  if (s.voiceStates[userId] && serverId && s.voiceStates[userId]!.serverId === serverId) return voiceUserMenu(userId, serverId);
  const isMe = userId === s.me?.id;
  const items: ContextMenuItem[] = [{ label: 'Профиль', onSelect: () => uiStore.set({ fullProfile: { userId, serverId } }) }];
  if (!isMe) {
    items.push({ label: 'Написать сообщение', onSelect: () => void openDm(userId) });
    const rel = s.relationships[userId]?.type;
    if (rel === 'friend') items.push({ label: 'Удалить из друзей', onSelect: () => void removeFriend(userId) });
    else if (!rel) items.push({ label: 'Добавить в друзья', onSelect: () => void sendFriendRequest({ userId }) });
    if (rel !== 'blocked') items.push({ label: 'Заблокировать', danger: true, onSelect: () => void blockUser(userId) });
  }
  items.push({ label: 'Копировать ID', onSelect: () => void navigator.clipboard?.writeText(userId) });
  if (!serverId || isMe) return items;
  const perms = s.permissions[serverId];
  const mod: ContextMenuItem[] = [];
  if (can(perms, Perm.MANAGE_ROLES) || can(perms, Perm.MANAGE_BADGES)) {
    mod.push({ label: 'Роли и значки…', onSelect: () => uiStore.set({ serverSettings: { serverId, tab: `member:${userId}` } }) });
  }
  if (can(perms, Perm.MODERATE_MEMBERS)) {
    mod.push({ label: 'Тайм-аут на 10 минут', danger: true, onSelect: () => void act(() => api.post(`/servers/${serverId}/members/${userId}/timeout`, { minutes: 10 }), 'Тайм-аут выдан', 'Не удалось выдать тайм-аут') });
    mod.push({ label: 'Снять тайм-аут', onSelect: () => void act(() => api.post(`/servers/${serverId}/members/${userId}/timeout`, { minutes: 0 }), 'Тайм-аут снят', 'Не удалось') });
  }
  if (can(perms, Perm.KICK_MEMBERS)) {
    mod.push({
      label: 'Выгнать',
      danger: true,
      onSelect: () => confirm('Выгнать участника с сервера?') && void act(() => api.post(`/servers/${serverId}/members/${userId}/kick`, {}), 'Участник выгнан', 'Не удалось выгнать'),
    });
  }
  if (can(perms, Perm.BAN_MEMBERS)) {
    mod.push({
      label: 'Забанить',
      danger: true,
      onSelect: () => {
        const reason = prompt('Причина бана (необязательно)');
        if (reason === null) return;
        void act(() => api.put(`/servers/${serverId}/bans/${userId}`, { reason: reason || undefined }), 'Участник забанен', 'Не удалось забанить');
      },
    });
  }
  if (mod.length) items.push({ divider: true, label: '' }, ...mod);
  return items;
}
