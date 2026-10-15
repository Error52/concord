ALTER TABLE outbound_emails
  ADD COLUMN purpose text CHECK (purpose IN ('verification', 'password-reset')),
  ADD COLUMN token_hash text,
  ADD COLUMN expires_at timestamptz;

-- Keep old queued authentication letters subject to their original token's lifetime.
UPDATE outbound_emails SET purpose = CASE
  WHEN subject = 'Concord — подтвердите почту' THEN 'verification'
  WHEN subject = 'Concord — восстановление пароля' THEN 'password-reset'
END;
UPDATE outbound_emails SET token_hash = encode(sha256(convert_to(
  substring(text_body FROM '[?]token=([A-Za-z0-9_-]+)'), 'UTF8')), 'hex')
WHERE purpose IS NOT NULL;
UPDATE outbound_emails e SET expires_at = CASE
  WHEN purpose = 'verification' THEN coalesce((SELECT v.expires_at FROM email_verifications v
    WHERE v.user_id=e.user_id AND v.token_hash=e.token_hash),e.created_at)
  WHEN purpose = 'password-reset' THEN coalesce((SELECT r.expires_at FROM password_resets r
    WHERE r.user_id=e.user_id AND r.token_hash=e.token_hash),e.created_at)
  ELSE e.created_at + interval '24 hours'
END;
ALTER TABLE outbound_emails ALTER COLUMN expires_at SET NOT NULL;
ALTER TABLE outbound_emails ALTER COLUMN expires_at SET DEFAULT now() + interval '24 hours';
