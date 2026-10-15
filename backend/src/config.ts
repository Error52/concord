import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_URL: z.string().url().default('http://localhost'),
  CORS_ORIGINS: z.string().default('http://localhost,http://localhost:5173'),
  TRUST_PROXY: bool,

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SEC: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  COOKIE_SECURE: bool,
  REQUIRE_EMAIL_VERIFICATION: z.enum(['true', 'false', '1', '0']).default('true').transform((v) => v === 'true' || v === '1'),
  // Explicit demo-only mode: own verification letter is visible after password authentication.
  // Keep off when validating real email ownership through SMTP.
  DEMO_MAILBOX: bool,

  STORAGE_DRIVER: z.enum(['s3', 'local']).default('s3'),
  STORAGE_LOCAL_DIR: z.string().default('./data/uploads'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('concord'),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z.string().optional().transform((v) => v !== 'false'),
  MAX_UPLOAD_MB: z.coerce.number().default(25),

  LIVEKIT_URL: z.string().default('http://livekit:7880'),
  LIVEKIT_PUBLIC_URL: z.string().default('ws://localhost/livekit'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('devsecret_change_me_devsecret_change_me'),

  GIF_PROVIDER: z.enum(['giphy', 'tenor', 'none']).default('giphy'),
  GIF_API_KEY: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_STARTTLS: bool,
  SMTP_TLS: bool,
  MAIL_FROM: z.string().default('Concord <no-reply@concord.local>'),

  /** Comma-separated emails that are always platform admins (admin panel, special badges). */
  PLATFORM_ADMIN_EMAILS: z.string().default(''),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();
export const isProd = config.NODE_ENV === 'production';
export const corsOrigins = new Set(config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
export const platformAdminEmails = config.PLATFORM_ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
