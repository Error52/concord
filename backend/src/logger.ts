import { config } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[config.LOG_LEVEL];

/** Keys whose values must never reach logs. */
const REDACT = /pass(word)?|secret|token|authorization|cookie|totp|code$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: config.NODE_ENV === 'production' ? undefined : value.stack };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = REDACT.test(k) ? '[redacted]' : redact(v, depth + 1);
  return out;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (order[level] < threshold) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
}

function make(bound: Record<string, unknown>): Logger {
  return {
    debug: (m, f) => write('debug', m, { ...bound, ...f }),
    info: (m, f) => write('info', m, { ...bound, ...f }),
    warn: (m, f) => write('warn', m, { ...bound, ...f }),
    error: (m, f) => write('error', m, { ...bound, ...f }),
    child: (b) => make({ ...bound, ...b }),
  };
}

export const log = make({});
