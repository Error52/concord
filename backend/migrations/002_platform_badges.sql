-- Platform-wide ("special") badges: server_id IS NULL. Managed only by platform admins (users.is_platform_admin).
ALTER TABLE badges ALTER COLUMN server_id DROP NOT NULL;
CREATE INDEX badges_global_idx ON badges (position, created_at) WHERE server_id IS NULL;

-- Separate audit trail for platform-admin actions (the server audit log is scoped to a server).
CREATE TABLE platform_audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
  target_type text,
  target_id   text,
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_audit_log_created_idx ON platform_audit_log (created_at DESC);
