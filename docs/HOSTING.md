# Public Concord

Concord needs a Linux server with a public IPv4 address and inbound WebRTC ports. The complete Docker stack includes PostgreSQL, Redis, LiveKit, coturn, nginx and Caddy. A static frontend host alone does not run this stack.

```bash
git clone https://github.com/Error52/concord.git
cd concord
sudo ./scripts/install-server.sh chat.example.com you@example.com
```

The first run creates `.env` and stops until SMTP is configured. Set `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` and TLS/STARTTLS there, then repeat the installer. Without your own domain the installer can use an IP-based sslip.io hostname. Keep port 80 available for certificate issuance. The normal public HTTPS port is 443.

If 443 is already used, set `PUBLIC_HTTPS_PORT=8443` and `APP_URL=https://chat.example.com:8443` in `.env`. Caddy, its port mapping and HTTP redirects use that port. Open its TCP/UDP port in the firewall. Do not stop an unrelated service to free a port. The internal nginx host port (`HTTP_PORT`, bound to `127.0.0.1`) must also be free; it can be changed independently.

Public setup uses `SEED_ON_START=0` and `BOOTSTRAP_FIRST_ADMIN=false`. Register and confirm your account, then deliberately grant its platform rights from the server:

```bash
make admin EMAIL=you@example.com
make admins
```

Platform administration is under user settings → «Платформа» → «Админ-панель». Creating a community server does not require platform administration. Existing admins survive an update. The API and CLI both protect the last administrator and serialize concurrent revocations.

An explicitly chosen beta may use `DEMO_MAILBOX=true`, `SMTP_HOST=` and no Mailpit container. The UI then opens only the signed-in account's verification letter. It never supplies password-reset links or other users' letters, and it does not prove ownership of the submitted email address. Email-based admin allowlists are disabled in this mode. Configure real SMTP and set `DEMO_MAILBOX=false` before relying on email ownership or email password recovery.

## Checks and updates

`/api/health` is process liveness. `/api/ready` checks PostgreSQL and Redis and returns 200/503 without internal error details. Docker health and the installer use readiness. Check a real two-user call and screen share from outside the server network as well: readiness alone cannot prove media-port reachability.

```bash
git pull --ff-only
sudo ./scripts/install-server.sh
docker compose ps
```

Preserve `.env`, database image family and volumes. The installer refuses to regenerate secrets over an existing database; see [UPGRADING.md](UPGRADING.md). Container restart policies survive a Docker/host restart. Logs rotate at 10 MB × 3 files per service. nginx resolves recreated backend and LiveKit containers through Docker DNS without requiring a frontend restart.

Docker media uses `LIVEKIT_ADVERTISE_INTERNAL_IP=true`: LiveKit supplies its public and bridge candidates. The TURN startup wrapper resolves only the `livekit` service's exact IPv4 address as a private-peer exception and refreshes it after an address change. Other private addresses stay denied; TCP peer relaying is disabled. Client-to-TURN TCP transport remains supported. This avoids a broken public-IP hairpin route between containers on the same host without granting the relay access to PostgreSQL or Redis.

## Backups

```bash
make backup QUIESCE=1
```

This briefly stops the backend, writes a consistent local database/uploads set and restarts the backend even on backup failure. A completed set appears atomically under `backups/<UTC timestamp>-<id>/`; failed or partial sets are not reported as saved. Backups and files are private to their owner. Copy completed sets to a separate machine or backup service; a copy on the application server alone does not survive loss of that server.

`make backup` without `QUIESCE=1` stays online but cannot guarantee consistency between a changing database and changing files. External S3 objects require a storage-provider backup; the script refuses to label an empty local volume as a complete S3 backup. Do not restore over a running installation: prepare a separate stack, restore its database and files, preserve the corresponding application secrets, and test it before switching traffic.

Screen quality adapts to actual network and encoder capacity. Automatic mode prioritizes smooth motion; a chosen 1080p/60 setting is a ceiling. WAN results depend on both clients, their routes, the server and the available bandwidth.
