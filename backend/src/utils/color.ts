/** WCAG 2.x contrast helpers used to reject unreadable profile themes. */

export const HEX_RE = /^#[0-9a-f]{6}$/i;

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** The card text color is chosen automatically (light or dark); the background must support one of them. */
export function bestTextColor(bg: string): string {
  return contrastRatio(bg, '#ffffff') >= contrastRatio(bg, '#0b0b10') ? '#ffffff' : '#0b0b10';
}

export function isReadableBackground(bg: string, minRatio = 4.5): boolean {
  return contrastRatio(bg, bestTextColor(bg)) >= minRatio;
}

/**
 * A two-color gradient is readable if a single text color reaches the minimum contrast on both stops.
 */
export function isReadableGradient(a: string, b: string, minRatio = 4.5): boolean {
  return ['#ffffff', '#0b0b10'].some((t) => contrastRatio(a, t) >= minRatio && contrastRatio(b, t) >= minRatio);
}
