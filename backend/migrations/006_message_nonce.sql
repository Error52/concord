-- A retried HTTP request must not create a second message or consume attachments twice.
ALTER TABLE messages ADD COLUMN client_nonce varchar(64), ADD COLUMN request_hash char(64);
CREATE UNIQUE INDEX messages_client_nonce ON messages (author_id, channel_id, client_nonce)
  WHERE client_nonce IS NOT NULL;
