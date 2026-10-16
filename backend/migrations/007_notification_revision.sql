-- Revisions let reconnect snapshots and out-of-order HTTP/pubsub replies agree.
ALTER TABLE users ADD COLUMN notification_revision bigint NOT NULL DEFAULT 0;
