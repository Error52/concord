import { z } from 'zod';

/** Shared request validation schemas. */

export const uuid = z.string().uuid('Некорректный идентификатор');
export const snowflake = z.string().regex(/^\d{1,19}$/, 'Некорректный идентификатор сообщения');
export const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Цвет должен быть в формате #RRGGBB');

export const username = z
  .string()
  .trim()
  .min(2, 'Имя пользователя — от 2 символов')
  .max(32, 'Имя пользователя — до 32 символов')
  .regex(/^[a-zA-Z0-9_.]+$/, 'Только латиница, цифры, «_» и «.»');

export const password = z.string().min(8, 'Пароль — минимум 8 символов').max(128, 'Пароль — максимум 128 символов');
export const email = z.string().trim().email('Некорректный email').max(254);

export const profileTheme = z.object({
  preset: z.string().max(32),
  primary: hexColor.optional(),
  secondary: hexColor.optional(),
  background: z.enum(['solid', 'gradient', 'image']).optional(),
  glow: z.boolean().optional(),
  cardStyle: z.enum(['default', 'glass', 'outline']).optional(),
});

export const register = z.object({
  username,
  email,
  password,
  displayName: z.string().trim().max(32).optional(),
  bannerColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  theme: profileTheme.optional(),
});

export const login = z.object({ email, password: z.string().min(1).max(128) });
export const mfa = z.object({ ticket: z.string().min(10), code: z.string().regex(/^\d{6}$/, 'Код — 6 цифр') });

export const profilePatch = z.object({
  username: username.optional(),
  displayName: z.string().trim().max(32).nullable().optional(),
  bio: z.string().max(400, 'Не более 400 символов').optional(),
  bannerColor: hexColor.optional(),
  accentColor: hexColor.optional(),
  theme: profileTheme.optional(),
  customStatus: z
    .object({ text: z.string().max(128).nullable(), emoji: z.string().max(32).nullable() })
    .nullable()
    .optional(),
});

export const serverCreate = z.object({
  name: z.string().trim().min(2, 'Название — от 2 символов').max(100),
  description: z.string().max(500).optional(),
  isPublic: z.boolean().optional(),
});
export const serverPatch = serverCreate.partial();

export const channelCreate = z.object({
  name: z.string().trim().min(1).max(64),
  type: z.enum(['text', 'voice']),
  category: z.string().trim().max(64).optional(),
  topic: z.string().max(1024).optional(),
});
export const channelPatch = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  topic: z.string().max(1024).optional(),
  category: z.string().trim().max(64).optional(),
  position: z.number().int().min(0).max(1000).optional(),
  slowmodeSeconds: z.number().int().min(0).max(21600).optional(),
});

export const gifEmbed = z.object({
  url: z.string().url().max(2048),
  previewUrl: z.string().url().max(2048),
  width: z.number().int().min(1).max(4096),
  height: z.number().int().min(1).max(4096),
  title: z.string().max(200).optional(),
});

export const messageCreate = z.object({
  content: z.string().max(4000).default(''),
  replyToId: snowflake.nullable().optional(),
  attachmentIds: z.array(uuid).max(10).optional(),
  gif: gifEmbed.nullable().optional(),
  nonce: z.string().max(64).optional(),
});
export const messageEdit = z.object({ content: z.string().min(1).max(4000) });

export const roleCreate = z.object({
  name: z.string().trim().min(1).max(64),
  color: hexColor.nullable().optional(),
  permissions: z.string().regex(/^\d{1,20}$/).optional(),
  hoist: z.boolean().optional(),
});
export const rolePatch = roleCreate.partial();

export const inviteCreate = z.object({
  maxUses: z.number().int().min(1).max(1000).nullable().optional(),
  expiresInSec: z.number().int().min(60).max(30 * 86400).nullable().optional(),
});

export const badgeInput = z.object({
  name: z.string().trim().min(1).max(32),
  description: z.string().max(200).optional(),
  emoji: z.string().max(16).nullable().optional(),
  color: hexColor.optional(),
  position: z.number().int().min(0).max(1000).optional(),
});
