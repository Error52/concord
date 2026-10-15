-- Concord: initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ───────────────────────────── users & auth ─────────────────────────────
CREATE TABLE users (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL,
  username         text NOT NULL,
  display_name     text,
  password_hash    text NOT NULL,
  status           text NOT NULL DEFAULT 'online' CHECK (status IN ('online','idle','dnd','invisible')),
  custom_status    text,
  custom_status_emoji text,
  totp_secret      text,
  totp_enabled     boolean NOT NULL DEFAULT false,
  is_platform_admin boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX users_username_uq ON users (lower(username));
CREATE INDEX users_username_trgm ON users USING gin (lower(username) gin_trgm_ops);
CREATE INDEX users_display_trgm ON users USING gin (lower(coalesce(display_name, '')) gin_trgm_ops);

-- Profile is 1:1 with users; kept separate so the hot "users" row stays small.
CREATE TABLE profiles (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  bio            text NOT NULL DEFAULT '',
  avatar_key     text,
  banner_key     text,
  background_key text,
  banner_color   text NOT NULL DEFAULT '#5b5bd6',
  accent_color   text NOT NULL DEFAULT '#7c6cff',
  theme          jsonb NOT NULL DEFAULT '{"preset":"default"}'::jsonb
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id          uuid NOT NULL,
  refresh_token_hash text NOT NULL,
  user_agent         text,
  ip                 text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  last_used_at       timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,
  rotated_at         timestamptz,
  replaced_by        uuid
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_family_idx ON sessions (family_id);

CREATE TABLE password_resets (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────────── servers ─────────────────────────────
CREATE TABLE servers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon_key    text,
  banner_key  text,
  owner_id    uuid NOT NULL REFERENCES users(id),
  is_public   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX servers_public_idx ON servers (created_at DESC) WHERE is_public;
CREATE INDEX servers_name_trgm ON servers USING gin (lower(name) gin_trgm_ops);

CREATE TABLE roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  color       text,
  permissions bigint NOT NULL DEFAULT 0,
  position    int NOT NULL DEFAULT 0,
  is_default  boolean NOT NULL DEFAULT false,   -- the implicit "Member" role every member has
  hoist       boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX roles_server_idx ON roles (server_id, position);
CREATE UNIQUE INDEX roles_one_default ON roles (server_id) WHERE is_default;

CREATE TABLE server_members (
  server_id     uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname      text,
  timeout_until timestamptz,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX server_members_user_idx ON server_members (user_id);

CREATE TABLE member_roles (
  server_id uuid NOT NULL,
  user_id   uuid NOT NULL,
  role_id   uuid NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (server_id, user_id, role_id),
  FOREIGN KEY (server_id, user_id) REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);
CREATE INDEX member_roles_role_idx ON member_roles (role_id);

CREATE TABLE bans (
  server_id  uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason     text,
  banned_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE invites (
  code       text PRIMARY KEY,
  server_id  uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  creator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  max_uses   int,
  uses       int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX invites_server_idx ON invites (server_id);

-- ───────────────────────────── channels (server text/voice + DMs) ─────────────────────────────
CREATE TABLE channels (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id        uuid REFERENCES servers(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('text','voice','dm')),
  name             text NOT NULL DEFAULT '',
  topic            text NOT NULL DEFAULT '',
  category         text NOT NULL DEFAULT '',
  position         int NOT NULL DEFAULT 0,
  slowmode_seconds int NOT NULL DEFAULT 0,
  dm_key           text UNIQUE,                  -- "<uuidA>:<uuidB>" sorted, only for DMs
  last_message_id  bigint,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((type = 'dm') = (server_id IS NULL))
);
CREATE INDEX channels_server_idx ON channels (server_id, position);

-- Participants of DM channels.
CREATE TABLE channel_members (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden     boolean NOT NULL DEFAULT false,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user_idx ON channel_members (user_id);

CREATE TABLE read_states (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_id  bigint NOT NULL DEFAULT 0,
  mention_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- ───────────────────────────── messages ─────────────────────────────
CREATE TABLE messages (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id        uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  author_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  content           text NOT NULL DEFAULT '',
  kind              text NOT NULL DEFAULT 'default' CHECK (kind IN ('default','system')),
  reply_to_id       bigint REFERENCES messages(id) ON DELETE SET NULL,
  embeds            jsonb NOT NULL DEFAULT '[]'::jsonb,
  mention_ids       uuid[] NOT NULL DEFAULT '{}',
  mentions_everyone boolean NOT NULL DEFAULT false,
  pinned            boolean NOT NULL DEFAULT false,
  has_link          boolean NOT NULL DEFAULT false,
  has_image         boolean NOT NULL DEFAULT false,
  has_file          boolean NOT NULL DEFAULT false,
  has_gif           boolean NOT NULL DEFAULT false,
  edited_at         timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  search            tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED
);
CREATE INDEX messages_channel_idx ON messages (channel_id, id DESC);
CREATE INDEX messages_author_idx ON messages (author_id, id DESC);
CREATE INDEX messages_search_idx ON messages USING gin (search);
CREATE INDEX messages_pinned_idx ON messages (channel_id) WHERE pinned;
CREATE INDEX messages_mentions_idx ON messages USING gin (mention_ids);

CREATE TABLE attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id  bigint REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  storage_key text NOT NULL,
  preview_key text,
  filename    text NOT NULL,
  mime        text NOT NULL,
  size        bigint NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('image','video','audio','file')),
  width       int,
  height      int,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_message_idx ON attachments (message_id);
CREATE INDEX attachments_pending_idx ON attachments (uploader_id, created_at) WHERE message_id IS NULL;

CREATE TABLE message_reactions (
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, emoji, user_id)
);

CREATE TABLE bookmarks (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

-- ───────────────────────────── social ─────────────────────────────
CREATE TABLE friend_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id),
  CHECK (from_id <> to_id)
);
CREATE INDEX friend_requests_to_idx ON friend_requests (to_id);

-- Stored once per pair with user_a < user_b.
CREATE TABLE friendships (
  user_a     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX friendships_b_idx ON friendships (user_b);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       text NOT NULL,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);

-- ───────────────────────────── voice ─────────────────────────────
CREATE TABLE voice_sessions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  room_name  text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz
);
CREATE UNIQUE INDEX voice_sessions_active ON voice_sessions (room_name) WHERE ended_at IS NULL;

CREATE TABLE voice_participants (
  session_id uuid NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  left_at    timestamptz
);
CREATE INDEX voice_participants_active ON voice_participants (session_id) WHERE left_at IS NULL;
CREATE INDEX voice_participants_user ON voice_participants (user_id) WHERE left_at IS NULL;

-- ───────────────────────────── badges & audit ─────────────────────────────
CREATE TABLE badges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  emoji       text,
  icon_key    text,
  color       text NOT NULL DEFAULT '#7c6cff',
  position    int NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX badges_server_idx ON badges (server_id, position);

CREATE TABLE user_badges (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id   uuid NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge_id)
);
CREATE INDEX user_badges_badge_idx ON user_badges (badge_id);

CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id   uuid NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_server_idx ON audit_log (server_id, id DESC);
