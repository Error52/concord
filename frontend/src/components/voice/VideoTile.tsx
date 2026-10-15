import { useEffect, useRef, useState } from 'react';
import { LuExpand, LuMaximize, LuMicOff, LuMonitor, LuPictureInPicture2, LuEyeOff, LuVolume2, LuSquareArrowOutUpRight } from 'react-icons/lu';
import { voice, useVoice, type ParticipantView } from '../../webrtc/voiceEngine';
import { pipSupported } from '../../webrtc/devices';
import { useApp } from '../../state/app';
import { openContextMenu, openProfile, toast } from '../../state/ui';
import { Avatar } from '../ui/Avatar';
import { hashColor } from '../../utils/format';
import { UserVolumeSlider, voiceUserMenu } from './voiceMenus';
import { stageStore } from './stageState';

export type TileSource = 'camera' | 'screen';

/** Attaches a LiveKit track to a <video> element and keeps it attached across re-renders. */
export function useAttachedVideo(identity: string, source: TileSource, enabled: boolean) {
  const ref = useRef<HTMLVideoElement>(null);
  useVoice((v) => v.version);
  const track = enabled ? voice.getVideoTrack(identity, source) : null;
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    if (!track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track, enabled]);
  return ref;
}

export async function togglePip(video: HTMLVideoElement | null): Promise<void> {
  if (!video) return;
  if (!pipSupported()) {
    toast('Ваш браузер не поддерживает «картинку в картинке». Используйте встроенный мини-плеер.', 'info');
    return;
  }
  try {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else await video.requestPictureInPicture();
  } catch {
    toast('Не удалось открыть «картинку в картинке»', 'error');
  }
}

export async function toggleFullscreen(el: Element | null): Promise<void> {
  if (!el) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await el.requestFullscreen();
  } catch {
    toast('Полноэкранный режим недоступен', 'error');
  }
}

interface Props {
  p: ParticipantView;
  source: TileSource;
  serverId: string | null;
  focused?: boolean;
  compact?: boolean;
}

export function VideoTile({ p, source, serverId, focused, compact }: Props) {
  const user = useApp((s) => s.users[p.identity]);
  const isScreen = source === 'screen';
  const watching = !isScreen || p.isLocal || p.watchingScreen;
  const hasVideo = isScreen ? p.hasScreen && watching : p.hasCamera;
  const videoRef = useAttachedVideo(p.identity, source, hasVideo);
  const tileRef = useRef<HTMLDivElement>(null);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const name = user?.displayName || user?.username || p.name;

  const focus = () => stageStore.set({ focus: focused ? null : { identity: p.identity, source } });

  return (
    <div
      ref={tileRef}
      className={`tile${p.speaking && !isScreen ? ' speaking' : ''}${isScreen ? ' screen' : ''}${p.isLocal && !isScreen ? ' mirror' : ''}`}
      onDoubleClick={() => void toggleFullscreen(tileRef.current)}
      onContextMenu={(e) => !p.isLocal && openContextMenu(e, voiceUserMenu(p.identity, serverId))}
      style={{ ['--tile-color' as string]: user?.accentColor ?? hashColor(p.identity) }}
    >
      {hasVideo ? (
        <video ref={videoRef} autoPlay playsInline muted />
      ) : isScreen && !watching ? (
        <div className="tile-watch">
          <LuMonitor style={{ width: 36, height: 36 }} />
          <div>
            <strong>{name}</strong> демонстрирует экран
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => voice.watchStream(p.identity, true)}>
            Смотреть трансляцию
          </button>
        </div>
      ) : (
        <div className="tile-avatar">
          <Avatar user={user ?? { id: p.identity, username: p.name, displayName: null, avatarUrl: p.avatarUrl }} size={compact ? 48 : 88} speaking={p.speaking} />
        </div>
      )}
      {!compact && <span className="tile-quality" style={{ background: p.quality === 'poor' || p.quality === 'lost' ? 'var(--red)' : p.quality === 'good' ? 'var(--yellow)' : p.quality === 'excellent' ? 'var(--green)' : 'transparent' }} title={`Качество связи: ${p.quality}`} />}
      <div className="tile-label">
        {isScreen && <span className="live-badge">LIVE</span>}
        <button className="ellipsis" onClick={(e) => openProfile(p.identity, serverId, e)}>
          {name}
          {p.isLocal && ' (вы)'}
        </button>
        {!isScreen && p.micMuted && <LuMicOff className="muted-icon" aria-label="Микрофон выключен" />}
      </div>
      <div className="tile-tools">
        {isScreen && !p.isLocal && watching && p.hasScreenAudio && (
          <button onClick={() => setVolumeOpen((v) => !v)} aria-label="Громкость трансляции">
            <LuVolume2 />
          </button>
        )}
        {hasVideo && (
          <button onClick={() => void togglePip(videoRef.current)} aria-label="Картинка в картинке">
            <LuPictureInPicture2 />
          </button>
        )}
        {hasVideo && (
          <button onClick={() => stageStore.set({ focus: { identity: p.identity, source }, popped: true })} aria-label="Мини-плеер">
            <LuSquareArrowOutUpRight />
          </button>
        )}
        <button onClick={focus} aria-label={focused ? 'Свернуть' : 'Развернуть'}>
          <LuExpand />
        </button>
        <button onClick={() => void toggleFullscreen(tileRef.current)} aria-label="Во весь экран">
          <LuMaximize />
        </button>
        {isScreen && !p.isLocal && watching && (
          <button
            onClick={() => {
              voice.watchStream(p.identity, false);
              if (focused) stageStore.set({ focus: null });
            }}
            aria-label="Прекратить просмотр"
          >
            <LuEyeOff />
          </button>
        )}
      </div>
      {volumeOpen && (
        <div className="menu" style={{ position: 'absolute', top: 48, right: 8, left: 'auto' }}>
          <UserVolumeSlider userId={p.identity} stream />
        </div>
      )}
    </div>
  );
}
