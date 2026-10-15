import { useEffect, useRef, useState } from 'react';
import {
  LuHeadphoneOff,
  LuHeadphones,
  LuMaximize,
  LuMenu,
  LuMic,
  LuMicOff,
  LuMonitorOff,
  LuMonitorUp,
  LuGauge,
  LuPanelLeftClose,
  LuPhoneOff,
  LuRefreshCw,
  LuSignal,
  LuSwitchCamera,
  LuUsers,
  LuVideo,
  LuVideoOff,
  LuVolume2,
} from 'react-icons/lu';
import { voice, useVoice, type ParticipantView } from '../../webrtc/voiceEngine';
import { useApp } from '../../state/app';
import { openContextMenu, uiStore, useUi } from '../../state/ui';
import { streamQualityMenu } from './voiceMenus';
import { formatDuration } from '../../utils/format';
import { Tooltip } from '../ui/Overlays';
import { VideoTile, toggleFullscreen } from './VideoTile';
import { stageStore, useStage } from './stageState';
import { ConnectionDetails, qualityColor } from './ConnectionDetails';
import { qualityLabel } from '../../webrtc/stats';

interface Tile {
  key: string;
  p: ParticipantView;
  source: 'camera' | 'screen';
}

function useCallTimer(since: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? formatDuration((Date.now() - since) / 1000) : '';
}

export function Controls({ channelId }: { channelId: string }) {
  const v = useVoice((s) => ({ selfMute: s.selfMute, selfDeaf: s.selfDeaf, serverMute: s.serverMute, camera: s.camera, screen: s.screen, quality: s.stats?.quality ?? 'unknown' }));
  const hideParticipants = useStage((s) => s.hideParticipants);
  const sidebarHidden = useUi((s) => s.sidebarHidden);
  const [details, setDetails] = useState<DOMRect | null>(null);
  const isMultiCam = useMultipleCameras();
  void channelId;
  return (
    <div className="stage-controls">
      <Tooltip text={v.serverMute ? 'Отключено модератором' : v.selfMute ? 'Включить микрофон' : 'Выключить микрофон'}>
        <button className={`ctrl${v.selfMute || v.serverMute ? ' off' : ''}`} onClick={() => voice.toggleMute()} aria-label="Микрофон" aria-pressed={!v.selfMute}>
          {v.selfMute || v.serverMute ? <LuMicOff /> : <LuMic />}
        </button>
      </Tooltip>
      <Tooltip text={v.selfDeaf ? 'Включить звук' : 'Выключить звук'}>
        <button className={`ctrl${v.selfDeaf ? ' off' : ''}`} onClick={() => voice.toggleDeafen()} aria-label="Звук" aria-pressed={!v.selfDeaf}>
          {v.selfDeaf ? <LuHeadphoneOff /> : <LuHeadphones />}
        </button>
      </Tooltip>
      <Tooltip text={v.camera ? 'Выключить камеру' : 'Включить камеру'}>
        <button className={`ctrl${v.camera ? ' on' : ''}`} onClick={() => void voice.setCamera(!v.camera)} aria-label="Камера" aria-pressed={v.camera}>
          {v.camera ? <LuVideo /> : <LuVideoOff />}
        </button>
      </Tooltip>
      {v.camera && isMultiCam && (
        <Tooltip text="Сменить камеру">
          <button className="ctrl" onClick={() => void voice.switchCamera()} aria-label="Сменить камеру">
            <LuSwitchCamera />
          </button>
        </Tooltip>
      )}
      <Tooltip text={v.screen ? 'Остановить демонстрацию' : 'Демонстрация экрана'}>
        <button className={`ctrl${v.screen ? ' on' : ''}`} onClick={() => void (v.screen ? voice.stopScreenShare() : voice.startScreenShare())} aria-label="Демонстрация экрана" aria-pressed={v.screen}>
          {v.screen ? <LuMonitorOff /> : <LuMonitorUp />}
        </button>
      </Tooltip>
      {v.screen && (
        <Tooltip text="Качество демонстрации">
          <button
            className="ctrl"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openContextMenu({ clientX: r.left, clientY: r.top - 8, preventDefault: () => undefined }, streamQualityMenu());
            }}
            aria-label="Качество демонстрации"
          >
            <LuGauge />
          </button>
        </Tooltip>
      )}
      {v.screen && (
        <Tooltip text="Сменить источник">
          <button className="ctrl" onClick={() => void voice.changeScreenSource()} aria-label="Сменить источник демонстрации">
            <LuRefreshCw />
          </button>
        </Tooltip>
      )}
      <span className="ctrl-sep" />
      <Tooltip text={`Соединение: ${qualityLabel[v.quality]}`}>
        <button className="ctrl" style={{ color: qualityColor(v.quality) }} onClick={(e) => setDetails(e.currentTarget.getBoundingClientRect())} aria-label="Сведения о соединении">
          <LuSignal />
        </button>
      </Tooltip>
      <Tooltip text={hideParticipants ? 'Показать участников' : 'Скрыть участников'}>
        <button className={`ctrl${hideParticipants ? ' on' : ''}`} onClick={() => stageStore.set({ hideParticipants: !hideParticipants })} aria-label="Скрыть участников">
          <LuUsers />
        </button>
      </Tooltip>
      <Tooltip text={sidebarHidden ? 'Показать боковую панель' : 'Скрыть боковую панель'}>
        <button className={`ctrl${sidebarHidden ? ' on' : ''}`} onClick={() => uiStore.set((s) => ({ sidebarHidden: !s.sidebarHidden }))} aria-label="Боковая панель" aria-pressed={sidebarHidden}>
          <LuPanelLeftClose />
        </button>
      </Tooltip>
      <Tooltip text="Во весь экран">
        <button className="ctrl" onClick={() => void toggleFullscreen(document.querySelector('.stage'))} aria-label="Во весь экран">
          <LuMaximize />
        </button>
      </Tooltip>
      <Tooltip text="Отключиться">
        <button className="ctrl hangup" onClick={() => void voice.disconnect()} aria-label="Отключиться">
          <LuPhoneOff />
        </button>
      </Tooltip>
      {details && <ConnectionDetails anchor={details} onClose={() => setDetails(null)} />}
    </div>
  );
}

function useMultipleCameras(): boolean {
  const [multi, setMulti] = useState(false);
  useEffect(() => {
    void navigator.mediaDevices?.enumerateDevices().then((d) => setMulti(d.filter((x) => x.kind === 'videoinput').length > 1 || /Android|iPhone|iPad/i.test(navigator.userAgent)));
  }, []);
  return multi;
}

/** Shared stage for server voice channels and DM calls. */
export function Stage({ channelId, serverId, mode }: { channelId: string; serverId: string | null; mode: 'channel' | 'call' }) {
  const connected = useVoice((v) => v.channelId === channelId && v.status !== 'idle');
  const status = useVoice((v) => v.status);
  const participants = useVoice((v) => v.participants);
  const audioBlocked = useVoice((v) => v.audioBlocked);
  const joinedAt = useVoice((v) => v.joinedAt);
  const focus = useStage((s) => s.focus);
  const hideParticipants = useStage((s) => s.hideParticipants);
  const others = useApp((s) => Object.values(s.voiceStates).filter((x) => x.channelId === channelId));
  const channelName = useApp((s) => s.channels[channelId]?.name);
  const timer = useCallTimer(mode === 'call' && connected ? joinedAt : null);
  const ref = useRef<HTMLDivElement>(null);

  if (!connected) {
    return (
      <section className={`stage${mode === 'call' ? ' call' : ''}`} ref={ref}>
        <button className="icon-btn stage-join-nav" onClick={() => uiStore.set({ mobilePanel: 'nav' })} aria-label="Меню">
          <LuMenu />
        </button>
        <div className="stage-join">
          <div>
            <LuVolume2 style={{ width: 48, height: 48, opacity: 0.7 }} />
            <h2 style={{ marginTop: 10 }}>{mode === 'call' ? 'Идёт звонок' : channelName}</h2>
            <p className="muted">
              {others.length ? `Сейчас здесь: ${others.length}` : 'Сейчас здесь никого нет.'}
            </p>
            <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => void voice.join(channelId)}>
              {mode === 'call' ? 'Присоединиться к звонку' : 'Подключиться'}
            </button>
          </div>
        </div>
      </section>
    );
  }

  const tiles: Tile[] = [];
  for (const p of Object.values(participants)) {
    tiles.push({ key: `${p.identity}:camera`, p, source: 'camera' });
    if (p.hasScreen) tiles.push({ key: `${p.identity}:screen`, p, source: 'screen' });
  }
  tiles.sort((a, b) => Number(b.source === 'screen') - Number(a.source === 'screen') || Number(a.p.isLocal) - Number(b.p.isLocal));
  const focused = focus ? tiles.find((t) => t.p.identity === focus.identity && t.source === focus.source) : null;
  const rest = focused ? tiles.filter((t) => t !== focused) : tiles;
  const sharer = Object.values(participants).find((p) => p.hasScreen && !p.isLocal);
  const n = tiles.length;
  const gridClass = n <= 6 ? `n${n}` : 'many';

  return (
    <section className={`stage${mode === 'call' ? ' call' : ''}`} ref={ref}>
      <div className="stage-head">
        <button className="icon-btn mobile-only" style={{ color: '#fff' }} onClick={() => uiStore.set({ mobilePanel: 'nav' })} aria-label="Меню">
          <LuMenu />
        </button>
        <strong>{mode === 'call' ? 'Звонок' : channelName}</strong>
        {timer && <span className="muted">{timer}</span>}
        {status === 'reconnecting' && <span style={{ color: 'var(--yellow)' }}>Переподключение…</span>}
        {sharer && (
          <span className="row" style={{ gap: 6 }}>
            <span className="live-badge">LIVE</span>
            <span className="muted">{sharer.name} демонстрирует экран</span>
          </span>
        )}
      </div>
      {audioBlocked && (
        <button className="btn btn-primary btn-sm audio-blocked" onClick={() => void voice.startAudioPlayback()}>
          Нажмите, чтобы включить звук
        </button>
      )}
      <div className="stage-body">
        {focused ? (
          <>
            <div className="stage-focus">
              <VideoTile p={focused.p} source={focused.source} serverId={serverId} focused />
            </div>
            {!hideParticipants && rest.length > 0 && (
              <div className="stage-strip">
                {rest.map((t) => (
                  <VideoTile key={t.key} p={t.p} source={t.source} serverId={serverId} compact />
                ))}
              </div>
            )}
          </>
        ) : (
          <div className={`stage-grid ${gridClass}`}>
            {(hideParticipants ? tiles.filter((t) => t.source === 'screen' || t.p.hasCamera) : tiles).map((t) => (
              <VideoTile key={t.key} p={t.p} source={t.source} serverId={serverId} />
            ))}
          </div>
        )}
      </div>
      <Controls channelId={channelId} />
    </section>
  );
}
