import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useVoice } from '../../webrtc/voiceEngine';
import { formatBitrate, qualityLabel, type Quality } from '../../webrtc/stats';
import { useApp } from '../../state/app';
import { useClampedPosition } from '../ui/Overlays';

const QUALITY_COLOR: Record<Quality, string> = {
  excellent: 'var(--green)',
  good: 'var(--green)',
  average: 'var(--yellow)',
  poor: 'var(--red)',
  unknown: 'var(--text-3)',
};

export function qualityColor(q: Quality): string {
  return QUALITY_COLOR[q];
}

const fmt = (v: number | null, unit: string, digits = 0): string => (v === null ? '—' : `${v.toFixed(digits)} ${unit}`);

/** "Connection Details" — every number comes from RTCPeerConnection.getStats(), refreshed every 1.5 s. */
export function ConnectionDetails({ anchor, onClose }: { anchor: DOMRect; onClose: () => void }) {
  const stats = useVoice((v) => v.stats);
  const status = useVoice((v) => v.status);
  const gatewayPing = useApp((s) => s.gateway);
  const { ref, pos } = useClampedPosition(anchor.left, anchor.top - 330, [stats === null]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && closeRef.current();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    const timer = setTimeout(() => window.addEventListener('mousedown', onDown), 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [ref]);

  const rows: [string, string][] = stats
    ? [
        ['Задержка (RTT)', fmt(stats.rttMs, 'мс')],
        ['Джиттер', fmt(stats.jitterMs, 'мс', 1)],
        ['Буфер звука', fmt(stats.audioBufferMs, 'мс', 1)],
        ['Буфер видео', fmt(stats.videoBufferMs, 'мс', 1)],
        ['Потери пакетов', fmt(stats.packetLossPct, '%', 1)],
        ['Кодек', stats.codec ?? '—'],
        ['Битрейт звука', formatBitrate(stats.audioBitrateKbps)],
        ['Отправка', formatBitrate(stats.uploadKbps)],
        ['Приём', formatBitrate(stats.downloadKbps)],
        ['Соединение', stats.transport ?? '—'],
        ['ICE', stats.iceState ?? '—'],
        ['DTLS', stats.dtlsState ?? '—'],
      ]
    : [];

  return createPortal(
    <div className="menu conn-details" ref={ref} style={{ ...pos, width: 300 }} role="dialog" aria-label="Сведения о соединении">
      <div style={{ padding: '6px 8px 10px' }}>
        <div style={{ fontWeight: 700, color: 'var(--text-0)', fontFamily: 'var(--font-display)' }}>Сведения о соединении</div>
        <div style={{ fontSize: '0.8125rem', marginTop: 4 }}>
          Статус:{' '}
          <strong style={{ color: stats ? QUALITY_COLOR[stats.quality] : 'var(--text-2)' }}>
            {status === 'reconnecting' ? 'Переподключение…' : stats ? qualityLabel[stats.quality] : 'Измерение…'}
          </strong>
        </div>
      </div>
      <table className="stats-table">
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
          <tr>
            <td>Шлюз (WebSocket)</td>
            <td>{gatewayPing === 'connected' ? 'подключён' : 'переподключение'}</td>
          </tr>
        </tbody>
      </table>
      {!stats && <p className="muted" style={{ fontSize: '0.8125rem', padding: '0 8px 8px' }}>Сбор статистики WebRTC…</p>}
    </div>,
    document.body,
  );
}
