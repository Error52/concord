import { useState, type MouseEvent } from 'react';
import {
  LuHeadphoneOff,
  LuHeadphones,
  LuMic,
  LuMicOff,
  LuMonitorUp,
  LuPhoneOff,
  LuSettings,
  LuSignal,
  LuVideo,
  LuVideoOff,
  LuMonitorOff,
} from 'react-icons/lu';
import { useApp, setState } from '../../state/app';
import { navigate } from '../../state/router';
import { uiStore, openContextMenu } from '../../state/ui';
import { streamQualityMenu } from '../voice/voiceMenus';
import { useSettings, formatKeybind } from '../../state/settings';
import { voice, useVoice } from '../../webrtc/voiceEngine';
import { api, errorMessage } from '../../api/client';
import { toast } from '../../state/ui';
import { Avatar, STATUS_LABEL } from '../ui/Avatar';
import { Tooltip } from '../ui/Overlays';
import { ConnectionDetails, qualityColor } from '../voice/ConnectionDetails';
import type { ChosenStatus, SelfUser } from '../../types';

const STATUS_OPTIONS: { value: ChosenStatus; label: string; hint: string }[] = [
  { value: 'online', label: 'В сети', hint: '' },
  { value: 'idle', label: 'Неактивен', hint: '' },
  { value: 'dnd', label: 'Не беспокоить', hint: 'Уведомления и звонки отключены' },
  { value: 'invisible', label: 'Невидимый', hint: 'Вы будете казаться не в сети' },
];

async function setStatus(status: ChosenStatus): Promise<void> {
  try {
    const me = await api.patch<SelfUser>('/users/me/status', { status });
    setState({ me });
  } catch (err) {
    toast(errorMessage(err, 'Не удалось изменить статус'), 'error');
  }
}

async function setCustomStatus(): Promise<void> {
  const text = prompt('Пользовательский статус (например, «🎮 Играю в Minecraft»). Пусто — убрать.');
  if (text === null) return;
  const m = /^(\p{Extended_Pictographic}️?)\s*(.*)$/u.exec(text.trim());
  const customStatus = text.trim() ? { emoji: m?.[1] ?? null, text: (m ? (m[2] ?? '') : text).trim() || null } : null;
  try {
    const me = await api.patch<SelfUser>('/users/me', { customStatus });
    setState({ me });
  } catch (err) {
    toast(errorMessage(err), 'error');
  }
}

export function VoicePanel() {
  const v = useVoice((s) => ({ status: s.status, channelId: s.channelId, serverId: s.serverId, isDm: s.isDm, camera: s.camera, screen: s.screen, screenAudio: s.screenAudio, quality: s.stats?.quality ?? 'unknown', rtt: s.stats?.rttMs ?? null }));
  const channelName = useApp((s) => (v.channelId ? s.channels[v.channelId]?.name : ''));
  const serverName = useApp((s) => (v.serverId ? s.servers[v.serverId]?.name : null));
  const dmName = useApp((s) => {
    if (!v.isDm || !v.channelId) return null;
    const u = s.dms[v.channelId]?.recipients[0];
    return u ? (s.users[u.id]?.displayName ?? u.displayName ?? u.username) : null;
  });
  const [details, setDetails] = useState<DOMRect | null>(null);
  if (v.status === 'idle') return null;
  const reconnecting = v.status === 'reconnecting' || v.status === 'connecting';
  const goToStage = () => {
    if (!v.channelId) return;
    if (v.isDm) navigate({ name: 'dm', channelId: v.channelId });
    else if (v.serverId) navigate({ name: 'channel', serverId: v.serverId, channelId: v.channelId });
  };
  return (
    <div className="vpanel">
      <div className="vpanel-top">
        <Tooltip text={v.rtt !== null ? `${Math.round(v.rtt)} мс` : 'Сведения о соединении'}>
          <button className={`vpanel-signal ${v.quality === 'excellent' || v.quality === 'good' ? '' : v.quality}`} style={{ color: qualityColor(v.quality) }} onClick={(e) => setDetails(e.currentTarget.getBoundingClientRect())} aria-label="Сведения о соединении">
            <LuSignal />
          </button>
        </Tooltip>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className={`vpanel-title${reconnecting ? ' reconnecting' : ''}`}>
            {v.status === 'connecting' ? 'Подключение…' : v.status === 'reconnecting' ? 'Переподключение…' : 'Голосовая связь подключена'}
          </div>
          <button className="vpanel-sub ellipsis" style={{ display: 'block', maxWidth: '100%' }} onClick={goToStage}>
            {v.isDm ? `Звонок · ${dmName ?? ''}` : `${channelName ?? ''}${serverName ? ` / ${serverName}` : ''}`}
            {v.rtt !== null && ` · ${Math.round(v.rtt)} мс`}
          </button>
        </div>
        <Tooltip text="Отключиться">
          <button className="icon-btn" onClick={() => void voice.disconnect()} aria-label="Отключиться">
            <LuPhoneOff />
          </button>
        </Tooltip>
      </div>
      <div className="vpanel-row">
        <Tooltip text={v.camera ? 'Выключить камеру' : 'Включить камеру'}>
          <button className={v.camera ? 'on' : ''} onClick={() => void voice.setCamera(!v.camera)} aria-label="Камера" aria-pressed={v.camera}>
            {v.camera ? <LuVideo /> : <LuVideoOff />}
          </button>
        </Tooltip>
        <Tooltip text={v.screen ? 'Остановить демонстрацию' : 'Демонстрация экрана'}>
          <button
            className={v.screen ? 'on' : ''}
            onClick={() => void (v.screen ? voice.stopScreenShare() : voice.startScreenShare())}
            onContextMenu={(e) => openContextMenu(e, streamQualityMenu())}
            aria-label="Демонстрация экрана"
            aria-pressed={v.screen}
          >
            {v.screen ? <LuMonitorOff /> : <LuMonitorUp />}
          </button>
        </Tooltip>
        <Tooltip text="Сведения о соединении">
          <button onClick={(e) => setDetails(e.currentTarget.getBoundingClientRect())} aria-label="Сведения о соединении">
            <LuSignal />
          </button>
        </Tooltip>
        <Tooltip text="Настройки голоса и видео">
          <button onClick={() => uiStore.set({ settings: 'voice' })} aria-label="Настройки голоса">
            <LuSettings />
          </button>
        </Tooltip>
      </div>
      {v.screen && (
        <div className="vpanel-sharing">
          Вы демонстрируете экран{v.screenAudio === false ? ' (без звука)' : v.screenAudio ? ' со звуком' : ''}
          <button className="link-btn" style={{ marginLeft: 'auto' }} onClick={() => void voice.changeScreenSource()}>
            Сменить
          </button>
        </div>
      )}
      {details && <ConnectionDetails anchor={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

export function UserPanel() {
  const me = useApp((s) => s.me);
  const v = useVoice((s) => ({ status: s.status, selfMute: s.selfMute, selfDeaf: s.selfDeaf, serverMute: s.serverMute, pttHeld: s.pttHeld, speaking: s.localSpeaking }));
  const inputMode = useSettings((s) => s.inputMode);
  const ptt = useSettings((s) => s.keybinds.pushToTalk);
  if (!me) return null;
  const inVoice = v.status !== 'idle';
  const statusMenu = (e: MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({ clientX: r.left, clientY: r.top - 260, preventDefault() {} }, [
      ...STATUS_OPTIONS.map((o) => ({ label: o.label + (me.chosenStatus === o.value ? ' ✓' : ''), onSelect: () => void setStatus(o.value) })),
      { divider: true, label: '' },
      { label: me.customStatus ? 'Изменить свой статус' : 'Задать свой статус', onSelect: () => void setCustomStatus() },
      { label: 'Мой профиль', onSelect: () => uiStore.set({ fullProfile: { userId: me.id, serverId: null } }) },
    ]);
  };
  const statusText = inVoice && inputMode === 'ptt' ? `Рация: ${formatKeybind(ptt)}` : me.customStatus?.text ? `${me.customStatus.emoji ?? ''} ${me.customStatus.text}` : me.chosenStatus === 'invisible' ? 'Невидимый' : STATUS_LABEL[me.status];
  return (
    <div className="upanel">
      <button className="upanel-me" onClick={statusMenu} aria-haspopup="menu">
        <Avatar user={me} size={34} status={me.chosenStatus === 'invisible' ? 'offline' : me.status} speaking={v.speaking} ring="var(--bg-3)" />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="upanel-name ellipsis" style={{ display: 'block' }}>{me.displayName || me.username}</span>
          <span className={`upanel-status ellipsis${v.pttHeld ? ' ptt-on' : ''}`} style={{ display: 'block' }}>
            {statusText}
          </span>
        </span>
      </button>
      <Tooltip text={v.serverMute ? 'Микрофон отключён модератором' : v.selfMute ? 'Включить микрофон' : 'Выключить микрофон'}>
        <button className={`icon-btn${v.selfMute || v.serverMute ? ' off' : ''}`} onClick={() => voice.toggleMute()} aria-label="Микрофон" aria-pressed={v.selfMute}>
          {v.selfMute || v.serverMute ? <LuMicOff /> : <LuMic />}
        </button>
      </Tooltip>
      <Tooltip text={v.selfDeaf ? 'Включить звук' : 'Выключить звук'}>
        <button className={`icon-btn${v.selfDeaf ? ' off' : ''}`} onClick={() => voice.toggleDeafen()} aria-label="Звук" aria-pressed={v.selfDeaf}>
          {v.selfDeaf ? <LuHeadphoneOff /> : <LuHeadphones />}
        </button>
      </Tooltip>
      <Tooltip text="Настройки">
        <button className="icon-btn" onClick={() => uiStore.set({ settings: 'account' })} aria-label="Настройки">
          <LuSettings />
        </button>
      </Tooltip>
    </div>
  );
}
