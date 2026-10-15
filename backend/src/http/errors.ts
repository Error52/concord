/** Error with a stable machine code and a user-facing (Russian) message. Never carries internals. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (message = 'Некорректный запрос', details?: unknown) => new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details: unknown) => new AppError(400, 'VALIDATION', 'Проверьте введённые данные', details),
  unauthorized: (message = 'Требуется авторизация') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Недостаточно прав') => new AppError(403, 'FORBIDDEN', message),
  notFound: (what = 'Ресурс') => new AppError(404, 'NOT_FOUND', `${what} не найден`),
  conflict: (code: string, message: string) => new AppError(409, code, message),
  tooLarge: (message = 'Файл слишком большой') => new AppError(413, 'TOO_LARGE', message),
  unsupported: (message = 'Неподдерживаемый тип файла') => new AppError(415, 'UNSUPPORTED_MEDIA', message),
  rateLimited: (retryAfter: number) => new AppError(429, 'RATE_LIMITED', 'Слишком много запросов, попробуйте позже', { retryAfter }),
  unavailable: (code: string, message: string) => new AppError(503, code, message),
};
