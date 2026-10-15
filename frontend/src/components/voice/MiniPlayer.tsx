import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { LuExpand, LuMaximize, LuPictureInPicture2, LuVolume2, LuX } from 'react-icons/lu';
import { useVoice } from '../../webrtc/voiceEngine';
import { useRoute, navigate } from '../../state/router';
import { stageStore, useStage } from './stageState';
import { toggleFullscreen, togglePip, VideoTile } from './VideoTile';
import { UserVolumeSlider } from './voiceMenus';

const MARGIN = 12;
const DEFAULT_W = 400;
const DEFAULT_H = 225;

/** Keeps the box fully inside the window (the old clamp assumed a 228px width, so a 380px player hung off-screen). */
function clamp(pos: { x: number; y: number }, w: number, h: number): { x: number; y: number } {
  return {
    x: Math.max(MARGIN, Math.min(pos.x, window.innerWidth - w - MARGIN)),
    y: Math.max(MARGIN, Math.min(pos.y, window.innerHeight - h - MARGIN)),
  };
}

/**
 * Floating in-app mini-player: draggable by its top bar, resizable from the corner (CSS resize),
 * always kept inside the window, visible on every page while a stream/video is focused and you're
 * away from the stage.
 */
export function MiniPlayer() {
  const focus = useStage((s) => s.focus);
  const popped = useStage((s) => s.popped);
  const p = useVoice((v) => (focus ? v.participants[focus.identity] : undefined));
  const voiceChannel = useVoice((v) => ({ channelId: v.channelId, serverId: v.serverId, isDm: v.isDm }));
  const route = useRoute();
  const [pos, setPos] = useState(() => clamp({ x: window.innerWidth, y: window.innerHeight - DEFAULT_H - 90 }, DEFAULT_W, DEFAULT_H));
  const [volumeOpen, setVolumeOpen] = useState(false);
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const onStage =
    (route.name === 'channel' && route.channelId === voiceChannel.channelId) || (route.name === 'dm' && route.channelId === voiceChannel.channelId);
  const visible = !!focus && !!p && !(onStage && !popped);

  // Re-clamp when the window or the player itself is resized.
  useLayoutEffect(() => {
    if (!visible) return;
    const box = boxRef.current;
    const fit = () => {
      const w = box?.offsetWidth ?? DEFAULT_W;
      const h = box?.offsetHeight ?? DEFAULT_H;
      setPos((cur) => {
        const next = clamp(cur, w, h);
        return next.x === cur.x && next.y === cur.y ? cur : next;
      });
    };
    fit();
    window.addEventListener('resize', fit);
    const ro = box && 'ResizeObserver' in window ? new ResizeObserver(fit) : null;
    if (box) ro?.observe(box);
    return () => {
      window.removeEventListener('resize', fit);
      ro?.disconnect();
    };
  }, [visible]);

  useEffect(() => {
    if (!visible) setVolumeOpen(false);
  }, [visible]);

  if (!visible || !focus || !p) return null;

  const back = () => {
    stageStore.set({ popped: false });
    if (!voiceChannel.channelId) return;
    if (voiceChannel.isDm) navigate({ name: 'dm', channelId: voiceChannel.channelId });
    else if (voiceChannel.serverId) navigate({ name: 'channel', serverId: voiceChannel.serverId, channelId: voiceChannel.channelId });
  };
  const isRemoteStream = focus.source === 'screen' && !p.isLocal && p.hasScreenAudio;

  return (
    <div ref={boxRef} className="mini-player" style={{ left: pos.x, top: pos.y, width: DEFAULT_W, height: DEFAULT_H }}>
      <div
        className="mini-player-bar"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('button')) return;
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const box = boxRef.current;
          setPos(clamp({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy }, box?.offsetWidth ?? DEFAULT_W, box?.offsetHeight ?? DEFAULT_H));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <span className="grow ellipsis">{p.name}</span>
        {isRemoteStream && (
          <button onClick={() => setVolumeOpen((v) => !v)} aria-label="Громкость трансляции" aria-pressed={volumeOpen}>
            <LuVolume2 />
          </button>
        )}
        <button onClick={() => void togglePip(boxRef.current?.querySelector('video') ?? null)} aria-label="Картинка в картинке">
          <LuPictureInPicture2 />
        </button>
        <button onClick={() => void toggleFullscreen(boxRef.current?.querySelector('.tile') ?? null)} aria-label="Во весь экран">
          <LuMaximize />
        </button>
        <button onClick={back} aria-label="Вернуться к звонку">
          <LuExpand />
        </button>
        <button onClick={() => stageStore.set({ focus: null, popped: false })} aria-label="Закрыть">
          <LuX />
        </button>
      </div>
      {volumeOpen && (
        <div className="menu mini-player-volume">
          <UserVolumeSlider userId={p.identity} stream />
        </div>
      )}
      <VideoTile p={p} source={focus.source} serverId={voiceChannel.serverId} compact />
    </div>
  );
}
