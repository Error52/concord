-- A local recovery factor grants local admission, never email ownership.
ALTER TABLE users ADD COLUMN recovery_word_hash text;
ALTER TABLE users ADD COLUMN local_verified_at timestamptz;
