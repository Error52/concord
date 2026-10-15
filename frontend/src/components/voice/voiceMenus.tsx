import { useState } from 'react';
import { api, errorMessage } from '../../api/client';
import { getState } from '../../state/app';
import { channelsOf } from '../../state/actions';
import { blockUser, openDm, sendFriendRequest } from '../../state/serverActions';
import { toast, uiStore, type ContextMenuItem } from '../../state/ui';
import { voice, STREAM_QUALITIES } from '../../webrtc/voiceEngine';
import { settingsStore, updateSettings, useSettings, type StreamQuality } from '../../state/settings';
import { can, Perm } from '../../utils/permissions';

/** Per-user volume slider, 0–100% (remote audio plays through media elements so echo cancellation works). Stored locally; never affects what other people hear. */
export function UserVolumeSlider({ userId, stream = false }: { userId: string; stream?: boolean }) {
  const key = stream ? `stream:${userId}` : userId;
  const stored = useSettings((s) => Math.min(1, s.userVolumes[key] ?? 1));
  const [value, setValue] = useState(stored);
  return (
    <label className="col" style={{ gap: 6, minWidth: 200 }}>
      <span className="row" style={{ fontSize: '0.8125rem', fontWeight: 600 }}>
        <span className="grow">{stream ? 'Громкость трансляции' : 'Громкость пользователя'}</span>
        <span className="muted">{Math.round(value * 100)}%</span>
      </span>
      <input
        className="range"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          setValue(v);
          voice.setUserVolume(key, v);
        }}
        aria-label="Громкость"
      />
    </label>
  );
}

async function moderate(serverId: string, userId: string, body: Record<string, unknown>, fallback: string): Promise<void> {
  try {
    await api.patch(`/servers/${serverId}/voice/${userId}`, body);
  } catch (err) {
    toast(errorMessage(err, fallback), 'error');
  }
}

export function voiceUserMenu(userId: string, serverId: string | null): ContextMenuItem[] {
  const s = getState();
  const isMe = userId === s.me?.id;
  const items: ContextMenuItem[] = [];
  if (!isMe) {
    const muted = settingsStore.get().userMuted[userId] ?? false;
    items.push({ label: muted ? 'Включить звук' : 'Заглушить для себя', onSelect: () => voice.setUserMuted(userId, !muted) });
    items.push({ label: 'volume', render: () => <UserVolumeSlider userId={userId} /> });
    items.push({ divider: true, label: '' });
  }
  items.push({ label: 'Профиль', onSelect: () => uiStore.set({ fullProfile: { userId, serverId } }) });
  if (!isMe) {
    items.push({ label: 'Написать сообщение', onSelect: () => void openDm(userId) });
    const rel = s.relationships[userId]?.type;
    if (!rel) items.push({ label: 'Добавить в друзья', onSelect: () => void sendFriendRequest({ userId }) });
    if (rel !== 'blocked') items.push({ label: 'Заблокировать', danger: true, onSelect: () => void blockUser(userId) });
  }

  // Moderation entries are only shown with the matching permission; the backend re-checks anyway.
  const perms = serverId ? s.permissions[serverId] : undefined;
  const vs = s.voiceStates[userId];
  if (serverId && vs?.serverId === serverId && can(perms, Perm.MANAGE_VOICE)) {
    items.push({ divider: true, label: '' });
    items.push({ label: vs.serverMute ? 'Снять серверный мут' : 'Серверный мут', danger: !vs.serverMute, onSelect: () => void moderate(serverId, userId, { serverMute: !vs.serverMute }, 'Не удалось изменить мут') });
    items.push({ label: vs.serverDeaf ? 'Вернуть звук (сервер)' : 'Серверное оглушение', danger: !vs.serverDeaf, onSelect: () => void moderate(serverId, userId, { serverDeaf: !vs.serverDeaf }, 'Не удалось изменить оглушение') });
    for (const ch of channelsOf(s, serverId).filter((c) => c.type === 'voice' && c.id !== vs.channelId)) {
      items.push({ label: `Переместить в «${ch.name}»`, onSelect: () => void moderate(serverId, userId, { channelId: ch.id }, 'Не удалось переместить') });
    }
    items.push({
      label: 'Отключить от голоса',
      danger: true,
      onSelect: () => void api.del(`/servers/${serverId}/voice/${userId}`).catch((err) => toast(errorMessage(err, 'Не удалось отключить'), 'error')),
    });
  }
  if (serverId && !isMe && can(perms, Perm.MODERATE_MEMBERS)) {
    items.push({
      label: 'Тайм-аут на 10 минут',
      danger: true,
      onSelect: () =>
        void api
          .post(`/servers/${serverId}/members/${userId}/timeout`, { minutes: 10 })
          .then(() => toast('Участник получил тайм-аут', 'success'))
          .catch((err) => toast(errorMessage(err, 'Не удалось выдать тайм-аут'), 'error')),
    });
  }
  return items;
}

/** Quick quality switch for your own screen share (also in Settings → Voice & video). */
export function streamQualityMenu(): ContextMenuItem[] {
  const current = settingsStore.get().streamQuality;
  return (Object.keys(STREAM_QUALITIES) as StreamQuality[]).map((k) => ({
    label: `${k === current ? '✓ ' : '\u2003 '}${STREAM_QUALITIES[k].label}`,
    onSelect: () => updateSettings({ streamQuality: k }),
  }));
}
