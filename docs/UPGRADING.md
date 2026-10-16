# Updating an existing installation

Keep `.env`, uploads and database volumes. Do not use `docker compose down -v` to update an installation.

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
