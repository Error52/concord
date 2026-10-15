let ctx: AudioContext | null = null;
let idleTimer: number | null = null;
let lastToneEnd = 0;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    return ctx;
  } catch {
    return null;
  }
}

function tone(freqs: number[], duration = 0.12, gap = 0.04, volume = 0.08): void {
  const a = audio();
  if (!a) return;
  let t = a.currentTime;
  for (const f of freqs) {
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(volume, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(g).connect(a.destination);
    osc.start(t);
    osc.stop(t + duration + 0.02);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
    t += duration + gap;
  }
  lastToneEnd = Math.max(lastToneEnd, t);
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    if (a.state === 'running') void a.suspend().catch(() => undefined);
  }, Math.max(0, lastToneEnd - a.currentTime) * 1000 + 150);
}

export const notifySound = (): void => tone([880, 1320]);
export const joinSound = (): void => tone([523, 784], 0.1);
export const leaveSound = (): void => tone([784, 523], 0.1);
export const muteSound = (): void => tone([440], 0.07);
export const unmuteSound = (): void => tone([660], 0.07);

let ringTimer: number | null = null;
export function startRingtone(): void {
  stopRingtone();
  const ring = () => tone([660, 880, 660, 880], 0.18, 0.05, 0.1);
  ring();
  ringTimer = window.setInterval(ring, 2200);
}
export function stopRingtone(): void {
  if (ringTimer) clearInterval(ringTimer);
  ringTimer = null;
}

export function showDesktopNotification(title: string, body: string): void {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body: body.slice(0, 140), icon: '/favicon.svg', silent: true });
  } catch {
    /* some browsers require a service worker */
  }
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  return (await Notification.requestPermission()) === 'granted';
}
