/** Structured client logging. Never pass tokens, SDP or ICE credentials here. */
type Fields = Record<string, unknown>;

const enabled = (): boolean => {
  try {
    return localStorage.getItem('concord.debug') === '1' || location.hostname === 'localhost';
  } catch {
    return false;
  }
};

export const log = {
  debug: (msg: string, f?: Fields) => enabled() && console.debug(`[concord] ${msg}`, f ?? ''),
  info: (msg: string, f?: Fields) => enabled() && console.info(`[concord] ${msg}`, f ?? ''),
  warn: (msg: string, f?: Fields) => console.warn(`[concord] ${msg}`, f ?? ''),
};
