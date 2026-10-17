/** Local operator recovery. Passwords are read from a hidden TTY or bounded JSON stdin, never argv. */
import { emitKeypressEvents } from 'node:readline';
import { pool } from './pool.js';
import { closeRedis } from '../redis.js';
import { operatorResetPassword } from '../services/authService.js';

function hiddenPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Нужен терминал либо --stdin с JSON через стандартный ввод');
  process.stderr.write(prompt);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (error?: Error) => {
      process.stdin.off('keypress', keypress);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stderr.write('\n');
      if (error) reject(error); else resolve(value);
    };
    const keypress = (text: string | undefined, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) return done(new Error('Операция отменена'));
      if (key.name === 'return' || key.name === 'enter') return done();
      if (key.name === 'backspace') value = Array.from(value).slice(0, -1).join('');
      else if (text && !key.ctrl && !/[\u0000-\u001f\u007f]/u.test(text)) {
        if (value.length + text.length > 128) return done(new Error('Новый пароль — не более 128 символов'));
        value += text;
      }
    };
    process.stdin.on('keypress', keypress);
  });
}

async function readInput(args: string[]): Promise<{ identifier: string; newPassword: string }> {
  if (args.length === 1 && args[0] === '--stdin') {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > 4096) throw new Error('Слишком большой ввод');
      chunks.push(data);
    }
    let value: unknown;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Ожидается JSON: identifier и newPassword'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Ожидается JSON-объект');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some(key => key !== 'identifier' && key !== 'newPassword') || typeof input.identifier !== 'string' || typeof input.newPassword !== 'string') {
      throw new Error('Разрешены только строковые поля identifier и newPassword');
    }
    return { identifier: input.identifier, newPassword: input.newPassword };
  }
  if (args.length !== 1 || args[0]!.startsWith('--')) throw new Error('Usage: recover-account-cli <username-or-email> | --stdin');
  const newPassword = await hiddenPassword('Новый пароль (ввод скрыт): ');
  if (newPassword !== await hiddenPassword('Повторите новый пароль: ')) throw new Error('Пароли не совпадают');
  return { identifier: args[0]!, newPassword };
}

let code = 0;
try {
  const input = await readInput(process.argv.slice(2));
  input.identifier = input.identifier.trim();
  if (input.identifier.length < 2 || input.identifier.length > 254) throw new Error('Укажите имя пользователя или email');
  const result = await operatorResetPassword(input);
  console.log(JSON.stringify({ ok: true, username: result.username, administrator: result.isPlatformAdmin, revokedSessions: result.revokedSessions }));
} catch (error) {
  // Never print input, stack traces, SQL or dependency error messages that can contain credentials.
  const message = error instanceof Error && /^(Нужен терминал|Операция отменена|Новый пароль|Слишком большой ввод|Ожидается JSON|Разрешены только|Usage:|Пароли не совпадают|Укажите имя|Пользователь не найден|Настройки аккаунта изменились)/u.test(error.message)
    ? error.message : 'Восстановление не выполнено. Проверьте пользователя и доступность PostgreSQL/Redis';
  console.error(message);
  code = 1;
} finally {
  await Promise.allSettled([pool.end(), closeRedis()]);
}
process.exitCode = code;
