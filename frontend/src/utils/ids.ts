/** Message ids are bigint strings; compare them without losing precision. */
export function cmpId(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

export const isNewer = (a: string | null | undefined, b: string | null | undefined): boolean => !!a && (!b || cmpId(a, b) > 0);
