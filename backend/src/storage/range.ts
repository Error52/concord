export type ByteRange = { first: bigint; last?: bigint } | { suffix: bigint };

/** We support one byte range. Ignore malformed/unsupported fields, as for a full GET. */
export function parseByteRange(value?: string): ByteRange | null {
  const match = value ? /^bytes=(\d*)-(\d*)$/.exec(value) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) return { suffix: BigInt(match[2]!) };
  const first = BigInt(match[1]);
  const last = match[2] ? BigInt(match[2]) : undefined;
  if (last !== undefined && last < first) return null;
  return { first, last };
}
