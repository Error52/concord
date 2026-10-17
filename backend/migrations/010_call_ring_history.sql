-- Ring signalling expires quickly; its history marker must survive Redis expiry/restarts.
ALTER TABLE voice_sessions
  ADD COLUMN call_ring_id uuid,
  ADD COLUMN call_ring_caller_id uuid REFERENCES users(id) ON DELETE SET NULL;
