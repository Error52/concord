/** WCAG contrast helpers (same rules the backend enforces for profile themes). */

export const HEX_RE = /^#[0-9a-f]{6}$/i;

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function readableTextOn(a: string, b: string = a): '#ffffff' | '#0b0b10' | null {
  for (const t of ['#ffffff', '#0b0b10'] as const) if (contrastRatio(a, t) >= 4.5 && contrastRatio(b, t) >= 4.5) return t;
  return null;
}

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const PRESET_THEMES: Record<string, { label: string; primary: string; secondary: string }> = {
  default: { label: 'Стандарт', primary: '#1e1f2e', secondary: '#2b2d42' },
  dark: { label: 'Тёмная', primary: '#0d0d12', secondary: '#1a1a24' },
  purple: { label: 'Фиолетовая', primary: '#2a1650', secondary: '#4b2a8a' },
  blue: { label: 'Синяя', primary: '#0f2347', secondary: '#1d4a8f' },
  sunset: { label: 'Закат', primary: '#5a1f3d', secondary: '#8a3b1f' },
  cyber: { label: 'Кибер', primary: '#0b2a2f', secondary: '#3a0f4f' },
  neon: { label: 'Неон', primary: '#140a2e', secondary: '#063a3a' },
  minimal: { label: 'Минимал', primary: '#202225', secondary: '#202225' },
};
