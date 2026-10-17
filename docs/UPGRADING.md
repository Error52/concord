# Updating an existing installation

Keep `.env`, uploads and database volumes. Do not use `docker compose down -v` to update an installation.

## Sessions, voice history and read markers

This update adds `008_voice_call_history.sql`, `009_read_state_revision.sql` and `010_call_ring_history.sql`. Backend startup applies them automatically. Deploy frontend/backend together and stop older backend replicas: every writer must advance read-state revisions and use the new call-history claim. Account data and uploads are retained. The durable ring marker preserves missed-call history after the ringing key expires in Redis; a solo visit without a call does not create a missed-call entry.

Access checks now confirm the active session family in PostgreSQL as well as Redis. Refresh rotation keeps earlier access/media grants valid while that family is active; logout, password reset and session revocation invalidate the family. New LiveKit grants carry a server-signed session identifier. Revoking a family removes its active participant without removing a participant signed in through another device. Signed join webhooks and periodic reconciliation also reject revoked, foreign and malformed session bindings. SFU removal remains best effort during an SFU/network outage; a join can briefly reach the SFU before its webhook is processed.

Old, unfinished MFA tickets and 2FA setup payloads must be started again after deployment. Existing enabled 2FA secrets are preserved. With mandatory email verification enabled, users must confirm their email before setting up 2FA.

Legacy participants without a session binding are accepted only during the first five minutes after a backend process starts. Webhooks and the 30-second reconciliation cycle remove them after that grace, even if the SFU refreshed their old grant. Reconnect the client to obtain a new bound grant; restarting the backend starts its transition grace again. Stop older replicas, which do not enforce the binding.

See [the detailed verification report](VERIFICATION-DEEP-2026-10-17.md) for regression tests, media measurements and remaining limits.

The follow-up regression update requires no additional migration. Deploy frontend/backend together: updated clients attach their participant SID to `call:end`, so a stale tab cannot cancel a newer call from the same account. Calls created without a bound SID retain the legacy API contract. Session admission now shares the user-session lock with logout/reset, and gateway authentication rechecks session validity after indexing the connection. See [the regression report](VERIFICATION-REGRESSION-2026-10-17.md).

## Concurrent sends, calls and notifications

The latest update adds migrations `006_message_nonce.sql` (durable retry keys) and `007_notification_revision.sql` (notification revisions). Backend startup applies both automatically. Existing accounts, messages, attachments and sessions are retained. Deploy frontend/backend together and stop old backend replicas, which do not advance notification revisions. The new frontend also identifies each ringing call so stale tab actions cannot cancel a newer call. Results: [concurrency verification](VERIFICATION-CONCURRENCY-2026-10-16.md).

## PostgreSQL image and collation

Set `POSTGRES_IMAGE` to the image family that originally created the database volume. New installations use `postgres:16-bookworm`. An existing Alpine installation must explicitly retain `POSTGRES_IMAGE=postgres:16-alpine` until a planned migration. Compose refuses to guess when this variable is missing. The installer can preserve the image from the existing labelled PostgreSQL container.

Changing libc/locale providers can invalidate text indexes. Changing an environment variable or refreshing a collation version does not rebuild indexes. Take a logical backup and restore it into a new volume with the intended locale/provider when changing image families. Verify login, uniqueness and search before switching traffic; retain the original volume for rollback.

If the same PostgreSQL 16 cluster has already been started with a different libc/collation definition, stop application writes and rebuild affected indexes after saving a backup. The explicit helper `bash scripts/reindex-db.sh /absolute/path/to/new-backup.sql` stops the backend, creates a restricted-permission `pg_dump`, runs `REINDEX DATABASE`, refreshes the database collation version and only then restarts the backend. It does not delete any volume and does not run automatically. A duplicate-key failure requires investigation; do not discard accounts to get past it.

Sources: [PostgreSQL collation changes](https://www.postgresql.org/docs/16/sql-altercollation.html), [REINDEX](https://www.postgresql.org/docs/16/sql-reindex.html).

## Email and account verification

LAN demos use `DEMO_MAILBOX=true`; this proves password authentication, not ownership of an external address. Public server mode requires a real `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` and TLS/STARTTLS configuration. The installer stops with a configuration message before exposing an unusable signup flow when SMTP is missing. Do not enable demo mail to validate external email ownership.

New mail bodies are AES-256-GCM encrypted. Startup encrypts pre-upgrade plaintext queue rows. Delivered letters are erased, except currently valid verification letters retained encrypted for demo mail; expired/used link bodies are erased by maintenance. `MAIL_ENCRYPTION_KEY` defaults to `JWT_SECRET`; set a separate stable 32+ character key before changing JWT_SECRET, or drain queued mail first. Losing/changing the encryption key makes existing queued letters unreadable; request fresh links after the configuration change. Database backups taken before this update can still contain old plaintext letters and require their existing access protection.

Migration `005_verified_admin.sql` records real SMTP verification separately from demo verification. `PLATFORM_ADMIN_EMAILS` only grants new admins after real verification, and startup does not promote demo accounts. Existing explicitly assigned admins and the first-install admin are preserved. Use `make admin EMAIL=...` for deliberate local administration.

Deploy frontend/backend together and stop old backend replicas before starting this version: old replicas cannot decrypt the new queue format. No user passwords or existing sessions need to be reset. Old media cookies remain unauthorized; updated open clients refresh their own session once and retry attachment loading.

## npm download timeouts during Docker build

Run installs through the Dockerfiles; `npm install --frozen-lockfile` is not a pnpm lockfile install. The Docker build uses pinned pnpm, a persistent package cache, four concurrent requests, five retries and a five-minute per-request timeout. Restart `sudo ./scripts/install-server.sh --lan` after `git pull --ff-only`; cached downloads are reused. Do not clear volumes or remove the lockfile.

If the default npm registry is unreachable from the server, set `NPM_REGISTRY=https://YOUR-TRUSTED-REGISTRY` in `.env`, then rebuild. No third-party mirror is selected automatically. HTTPS certificate validation, release-age policies and package integrity checks stay enabled. A blocked network still needs working DNS/HTTPS access or an explicitly chosen trusted registry; retries cannot create connectivity.

Media ports come from `LIVEKIT_TCP_PORT`/`LIVEKIT_UDP_PORT`; the installer opens those configured ports. Windows native LAN scripts record their media ports in `lan.json`. Public mode disables loopback candidates; local mode retains them. Linux native development requires the Mailpit release binary in PATH (installation steps are in `scripts/dev-native.sh`). Windows native launch uses Node on PATH or `CONCORD_NODE`.
