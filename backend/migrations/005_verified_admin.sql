-- Demo confirmation does not establish ownership of an external address.
ALTER TABLE users ADD COLUMN email_verified_via_smtp boolean NOT NULL DEFAULT false;
