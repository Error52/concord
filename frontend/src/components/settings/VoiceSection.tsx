import { useEffect, useRef, useState } from 'react';
import { settingsStore, updateSettings, useSettings, formatKeybind, type StreamQuality } from '../../state/settings';
import { uiStore, toast } from '../../state/ui';
import { ensureLabels, listDevices, mediaErrorMessage, onDeviceChange, outputSelectionSupported, type DeviceLists } from '../../webrtc/devices';
import { dbToMeter } from '../../webrtc/audioMeter';
import { startMicTest, STREAM_QUALITIES, type MicTest } from '../../webrtc/voiceEngine';
import { Switch } from '../ui/Overlays';

/** Typical names of loopback/system-audio capture devices. */
const LOOPBACK_RE = /monitor|blackhole|loopback|soundflower|stereo mix|стерео микшер|vb-audio|cable output|virtual/i;

function StreamAudioHelp() {
  return (
    <details className="field-hint" style={{ lineHeight: 1.5 }}>
      <summary style={{ cursor: 'pointer', color: 'var(--text-1)', fontWeight: 600 }}>Как сделать, чтобы все слышали весь звук компьютера</summary>
      <p>
        <strong>Windows (Chrome/Edge):</strong> при выборе «Весь экран» включите «Поделиться системным звуком» — дополнительно ничего не нужно.
      </p>
      <p>
        <strong>macOS:</strong> браузеры отдают звук только у вкладки. Для всего звука: установите бесплатный BlackHole (<code className="md-inline-code">brew install blackhole-2ch</code>), в «Настройке Audio-MIDI»
        создайте «Устройство с несколькими выходами» (ваши динамики + BlackHole 2ch) и выберите его как выход системы — так вы продолжите слышать звук. Здесь выберите
        источником «BlackHole 2ch».
      </p>
      <p>
        <strong>Linux:</strong> выберите здесь «Monitor of …» (монитор вашего выхода PipeWire/PulseAudio). Если его нет в списке — выберите любой вход, начните демонстрацию и в{' '}
        <code className="md-inline-code">pavucontrol</code> → «Запись» переключите поток браузера на «Monitor of …».
      </p>
      <p>Совет: тому, кто показывает, лучше быть в наушниках — иначе микрофон повторно подхватит звук демонстрации.</p>
    </details>
  );
}

function DeviceSelect({ label, kind, value, onChange, devices, disabled }: { label: string; kind: keyof DeviceLists; value: string; onChange: (id: string) => void; devices: DeviceLists; disabled?: boolean }) {
  const list = devices[kind];
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <select className="select" value={list.some((d) => d.deviceId === value) ? value : 'default'} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {!list.some((d) => d.deviceId === 'default') && <option value="default">По умолчанию</option>}
        {list.map((d, i) => (
          <option key={d.deviceId || i} value={d.deviceId}>
            {d.label || `${kind === 'audioinput' ? 'Микрофон' : kind === 'audiooutput' ? 'Динамики' : 'Камера'} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Live input level meter with the voice-activity threshold marker. */
function LevelMeter({ level, threshold }: { level: number; threshold: number }) {
  const blocks = 30;
  const lit = Math.round(dbToMeter(level) * blocks);
  return (
    <div>
      <div className="meter" role="meter" aria-valuemin={-60} aria-valuemax={0} aria-valuenow={Math.round(level)} aria-label="Уровень сигнала">
        <div className="meter-fill" style={{ width: `${dbToMeter(level) * 100}%` }} />
        <div className="meter-threshold" style={{ left: `${dbToMeter(threshold) * 100}%` }} title="Порог активации" />
      </div>
      <div className="row muted" style={{ fontSize: '0.75rem', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
        <span>{'█'.repeat(lit)}{'░'.repeat(blocks - lit)}</span>
        <span className="grow" />
        <span>{level > -100 ? `${level.toFixed(0)} dBFS` : '—'}</span>
      </div>
    </div>
  );
}

function playTestSound(sinkId: string): void {
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  const notes = [523.25, 659.25, 783.99, 1046.5];
  notes.forEach((f, i) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = f;
    const t = ctx.currentTime + i * 0.18;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.4);
  });
  const audio = new Audio();
  audio.srcObject = dest.stream;
  audio.volume = Math.min(1, settingsStore.get().outputVolume);
  const play = () => audio.play().catch(() => toast('Браузер заблокировал воспроизведение', 'error'));
  if (sinkId !== 'default') {
    if ('setSinkId' in audio) {
      void (audio as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(sinkId).then(play, () => {
        toast('Не удалось выбрать устройство вывода — звук идёт в устройство по умолчанию', 'error');
        void play();
      });
    } else {
      toast('Браузер не поддерживает выбор устройства вывода (setSinkId) — звук идёт в устройство по умолчанию', 'info');
      void play();
    }
  } else void play();
  setTimeout(() => void ctx.close(), 1500);
}

export function VoiceSection() {
  const s = useSettings((x) => x);
  const [devices, setDevices] = useState<DeviceLists>({ audioinput: [], audiooutput: [], videoinput: [] });
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState({ db: -100, thr: s.vadThresholdDb });
  const test = useRef<MicTest | null>(null);
  const [camOn, setCamOn] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loopback, setLoopback] = useState(true);

  useEffect(() => {
    const refresh = () => void listDevices().then(setDevices);
    ensureLabels('audio')
      .catch((err) => toast(mediaErrorMessage(err, 'mic'), 'error'))
      .finally(refresh);
    const off = onDeviceChange(refresh);
    return () => {
      off();
      test.current?.stop();
    };
  }, []);

  // Restart the test when input settings change so you hear the effect immediately.
  useEffect(() => {
    if (!testing) return;
    let cancelled = false;
    let t: MicTest | null = null;
    let last = 0;
    startMicTest({
      loopback,
      onLevel: (db, thr) => {
        const now = performance.now();
        if (now - last > 50) {
          last = now;
          setLevel({ db, thr });
        }
      },
    }).then(
      (mt) => {
        if (cancelled) mt.stop();
        else t = test.current = mt;
      },
      (err) => {
        toast(mediaErrorMessage(err, 'mic'), 'error');
        setTesting(false);
      },
    );
    return () => {
      cancelled = true;
      t?.stop();
      test.current = null;
    };
  }, [testing, loopback, s.inputDeviceId, s.noiseSuppression, s.echoCancellation, s.autoGainControl, s.outputDeviceId]);

  useEffect(() => {
    if (!camOn) return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: s.videoDeviceId !== 'default' ? { deviceId: { exact: s.videoDeviceId } } : true })
      .then((st) => {
        stream = st;
        if (videoRef.current) videoRef.current.srcObject = st;
        void listDevices().then(setDevices);
      })
      .catch((err) => {
        toast(mediaErrorMessage(err, 'camera'), 'error');
        setCamOn(false);
      });
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [camOn, s.videoDeviceId]);

  return (
    <>
      <h2>Голос и видео</h2>
      <div className="settings-grid">
        <DeviceSelect label="Устройство ввода" kind="audioinput" devices={devices} value={s.inputDeviceId} onChange={(id) => updateSettings({ inputDeviceId: id })} />
        <DeviceSelect label="Устройство вывода" kind="audiooutput" devices={devices} value={s.outputDeviceId} onChange={(id) => updateSettings({ outputDeviceId: id })} disabled={!outputSelectionSupported()} />
      </div>
      {!outputSelectionSupported() && <p className="field-hint">Ваш браузер не поддерживает выбор устройства вывода (HTMLMediaElement.setSinkId) — используется системное устройство. Попробуйте Chrome или Edge.</p>}
      <div className="settings-grid" style={{ marginTop: 16 }}>
        <label className="field">
          <span className="field-label">Громкость микрофона — {Math.round(s.inputVolume * 100)}%</span>
          <input className="range" type="range" min={0} max={2} step={0.01} value={s.inputVolume} onChange={(e) => updateSettings({ inputVolume: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span className="field-label">Громкость звука — {Math.round(Math.min(1, s.outputVolume) * 100)}%</span>
          <input className="range" type="range" min={0} max={1} step={0.01} value={Math.min(1, s.outputVolume)} onChange={(e) => updateSettings({ outputVolume: Number(e.target.value) })} />
        </label>
      </div>

      <h3>Проверка микрофона</h3>
      <div className="card col">
        <p className="muted" style={{ margin: 0 }}>Скажите что-нибудь — шкала показывает реальный уровень сигнала. Включите «Слышать себя», чтобы услышать, как вас слышат другие.</p>
        <div className="row">
          <button className={`btn ${testing ? 'btn-danger' : 'btn-primary'}`} onClick={() => setTesting(!testing)}>
            {testing ? 'Остановить' : 'Проверить'}
          </button>
          <label className="row" style={{ fontSize: '0.875rem' }}>
            <Switch checked={loopback} onChange={setLoopback} label="Слышать себя" /> Слышать себя
          </label>
          <span className="grow" />
          <button className="btn btn-secondary" onClick={() => playTestSound(s.outputDeviceId)}>
            Проверить динамики
          </button>
        </div>
        <LevelMeter level={testing ? level.db : -100} threshold={testing ? level.thr : s.vadThresholdDb} />
      </div>

      <h3>Режим ввода</h3>
      <div className="card col">
        <div className="segmented" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={s.inputMode === 'vad'} onClick={() => updateSettings({ inputMode: 'vad' })}>
            Активация голосом
          </button>
          <button aria-pressed={s.inputMode === 'ptt'} onClick={() => updateSettings({ inputMode: 'ptt' })}>
            Режим рации (Push-to-Talk)
          </button>
        </div>
        {s.inputMode === 'vad' ? (
          <>
            <div className="toggle-row">
              <div className="grow">
                <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Автоматическая чувствительность</div>
                <div className="field-hint">Порог подстраивается под уровень фонового шума.</div>
              </div>
              <Switch checked={s.vadAuto} onChange={(v) => updateSettings({ vadAuto: v })} label="Автоматическая чувствительность" />
            </div>
            {!s.vadAuto && (
              <label className="field">
                <span className="field-label">Чувствительность ввода — {s.vadThresholdDb} dBFS</span>
                <input className="range" type="range" min={-80} max={-10} step={1} value={s.vadThresholdDb} onChange={(e) => updateSettings({ vadThresholdDb: Number(e.target.value) })} />
                <span className="field-hint">Микрофон передаёт звук, только когда уровень выше порога (белая метка на шкале).</span>
              </label>
            )}
          </>
        ) : (
          <>
            <div className="row">
              <span className="grow">
                Клавиша: <span className="kbd">{formatKeybind(s.keybinds.pushToTalk)}</span>
              </span>
              <button className="btn btn-secondary btn-sm" onClick={() => uiStore.set({ settings: 'keybinds' })}>
                Изменить
              </button>
            </div>
            <label className="field">
              <span className="field-label">Задержка отпускания — {s.pttReleaseDelayMs} мс</span>
              <input className="range" type="range" min={0} max={1000} step={10} value={s.pttReleaseDelayMs} onChange={(e) => updateSettings({ pttReleaseDelayMs: Number(e.target.value) })} />
            </label>
            <p className="field-hint" style={{ margin: 0 }}>
              Браузер получает нажатия клавиш только когда вкладка Concord активна. При переключении на другое окно микрофон автоматически отключается.
            </p>
          </>
        )}
        <div className="toggle-row">
          <div className="grow">
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Выключать микрофон при уходе из окна</div>
            <div className="field-hint">Защита от случайно оставленного микрофона.</div>
          </div>
          <Switch checked={s.muteOnBlur} onChange={(v) => updateSettings({ muteOnBlur: v })} label="Выключать микрофон при уходе из окна" />
        </div>
      </div>

      <h3>Обработка голоса</h3>
      <div className="card">
        {(
          [
            ['noiseSuppression', 'Шумоподавление', 'Убирает постоянный фоновый шум'],
            ['echoCancellation', 'Эхоподавление', 'Не даёт звуку из динамиков попадать в микрофон'],
            ['autoGainControl', 'Автоматическая регулировка усиления', 'Выравнивает громкость голоса'],
          ] as const
        ).map(([k, l, h]) => (
          <div key={k} className="toggle-row">
            <div className="grow">
              <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>{l}</div>
              <div className="field-hint">{h}</div>
            </div>
            <Switch checked={s[k]} onChange={(v) => updateSettings({ [k]: v })} label={l} />
          </div>
        ))}
      </div>

      <h3>Демонстрация экрана</h3>
      <div className="card col">
        <label className="field">
          <span className="field-label">Качество вашей демонстрации</span>
          <select className="select" value={s.streamQuality} onChange={(e) => updateSettings({ streamQuality: e.target.value as StreamQuality })}>
            {(Object.keys(STREAM_QUALITIES) as StreamQuality[]).map((k) => (
              <option key={k} value={k}>
                {STREAM_QUALITIES[k].label}
              </option>
            ))}
          </select>
          <span className="field-hint">
            «Авто» — до 1440p / 60 fps для игр и видео; на слабом устройстве — до 1080p / 30 fps. Для текста — «Текст и код». При перегрузке нагрузка снижается и затем восстанавливается. Меняется на ходу. Звук демонстрации — стерео до 192 кбит/с, голос — до 96 кбит/с.
          </span>
        </label>
        <div className="toggle-row">
          <div className="grow">
            <div style={{ fontWeight: 600, color: 'var(--text-0)' }}>Автоматически смотреть и слушать трансляции</div>
            <div className="field-hint">Как общий показ: когда кто-то в канале включает демонстрацию, вы сразу видите её и слышите её звук.</div>
          </div>
          <Switch checked={s.autoWatchStreams} onChange={(v) => updateSettings({ autoWatchStreams: v })} label="Автоматически смотреть трансляции" />
        </div>
        <label className="field">
          <span className="field-label">Источник звука демонстрации</span>
          <select className="select" value={s.streamAudioDeviceId} onChange={(e) => updateSettings({ streamAudioDeviceId: e.target.value })}>
            <option value="auto">Авто — звук, который отдаёт браузер (вкладка / системный звук)</option>
            {devices.audioinput
              .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
              .map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {LOOPBACK_RE.test(d.label) ? '🔊 ' : ''}
                  {d.label || `Вход ${i + 1}`}
                </option>
              ))}
          </select>
          <span className="field-hint">
            Звук этого устройства уходит всем участникам вместе с экраном в музыкальном качестве (стерео, 192 кбит/с), без шумо- и эхоподавления.
          </span>
        </label>
        <StreamAudioHelp />
      </div>

      <h3>Видео</h3>
      <div className="card col">
        <DeviceSelect label="Камера" kind="videoinput" devices={devices} value={s.videoDeviceId} onChange={(id) => updateSettings({ videoDeviceId: id })} />
        {camOn ? <video ref={videoRef} className="camera-preview" autoPlay playsInline muted /> : <div className="camera-preview" style={{ display: 'grid', placeItems: 'center', transform: 'none' }}><span className="muted">Предпросмотр выключен</span></div>}
        <button className="btn btn-secondary" style={{ alignSelf: 'flex-start' }} onClick={() => setCamOn(!camOn)}>
          {camOn ? 'Выключить предпросмотр' : 'Проверить камеру'}
        </button>
      </div>
    </>
  );
}
