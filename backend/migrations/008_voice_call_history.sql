-- One durable history entry per completed SFU session, including concurrent departures.
ALTER TABLE voice_sessions ADD COLUMN call_logged_at timestamptz;
