#!/usr/bin/env bash
# Run Concord WITHOUT Docker on macOS or Linux (useful for development, or when Docker Desktop is slow).
#
# Needs locally: Node.js 24+, pnpm 11.25.0, PostgreSQL 14+, Redis 6+, LiveKit 1.13.9, Mailpit.
#   macOS (Homebrew):  brew install node postgresql@16 redis livekit
#                      brew services start postgresql@16 && brew services start redis
#   Ubuntu/Debian:     sudo apt install postgresql redis-server
#                      curl -sSL https://get.livekit.io | bash        # installs livekit-server
#                      Node 24: https://nodejs.org or `nvm install 24`
#
#   ./scripts/dev-native.sh            → http://localhost:5173
# Ctrl+C stops everything this script started.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OS="$(uname -s)"

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }
hint() {
  if [ "$OS" = "Darwin" ]; then printf '    macOS: %s\n' "$1"; else printf '    Linux: %s\n' "$2"; fi
}

need() {
  command -v "$1" >/dev/null 2>&1 && return 0
  printf '  \033[31m✘\033[0m %s not found\n' "$1" >&2
  hint "$2" "$3"
  exit 1
}

need node "brew install node" "https://nodejs.org (or: nvm install 24)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24+ required (found $(node -v))"
ok "node $(node -v)"
need psql "brew install postgresql@16 && brew services start postgresql@16" "sudo apt install postgresql"
need redis-cli "brew install redis && brew services start redis" "sudo apt install redis-server"
need livekit-server "brew install livekit" "curl -sSL https://get.livekit.io | bash"
need pnpm "npm install -g pnpm@11.25.0" "npm install -g pnpm@11.25.0"
need mailpit "brew install mailpit" "https://github.com/axllent/mailpit/releases/tag/v1.31.5"

# ───────────── database ─────────────
PGUSER_LOCAL="${PGUSER:-$(whoami)}"
DB_URL="${DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  # Homebrew Postgres: your macOS user is a superuser. Debian/Ubuntu: create a role once:
  #   sudo -u postgres createuser -s "$USER"
  if ! psql -d postgres -Atc 'select 1' >/dev/null 2>&1; then
    printf '  \033[31m✘\033[0m cannot connect to PostgreSQL as %s\n' "$PGUSER_LOCAL" >&2
    hint "brew services start postgresql@16" "sudo systemctl start postgresql && sudo -u postgres createuser -s \"\$USER\""
    exit 1
  fi
  psql -d postgres -Atc "select 1 from pg_database where datname='concord'" | grep -q 1 || createdb concord
  if [ "$OS" = "Darwin" ]; then
    DB_URL="postgres://localhost/concord"          # Homebrew: trust auth on localhost
  else
    SOCK_DIR="$(psql -d postgres -Atc 'show unix_socket_directories' | cut -d, -f1)"
    DB_URL="postgres:///concord?host=${SOCK_DIR:-/var/run/postgresql}"  # Debian/Ubuntu: peer auth via the socket
  fi
fi
ok "PostgreSQL connected"
redis-cli ping >/dev/null 2>&1 || { printf '  \033[31m✘\033[0m Redis is not running\n' >&2; hint "brew services start redis" "sudo systemctl start redis-server"; exit 1; }
ok "Redis"

# ───────────── dependencies & build ─────────────
(cd backend && pnpm install --frozen-lockfile --ignore-scripts)
(cd frontend && pnpm install --frozen-lockfile --ignore-scripts)
(cd frontend && npm run build >/dev/null)
ok "frontend built"

# ───────────── processes ─────────────
RUN_DIR="$ROOT/.dev"
mkdir -p "$RUN_DIR/uploads"
LK_KEY=devkey
LK_SECRET="$(cat "$RUN_DIR/livekit.secret" 2>/dev/null || true)"
if [ -z "$LK_SECRET" ]; then
  LK_SECRET="$(openssl rand -hex 32)"
  printf '%s' "$LK_SECRET" > "$RUN_DIR/livekit.secret"
fi
JWT_SECRET_LOCAL="$(cat "$RUN_DIR/jwt.secret" 2>/dev/null || true)"
if [ -z "$JWT_SECRET_LOCAL" ]; then
  JWT_SECRET_LOCAL="$(openssl rand -hex 32)"
  printf '%s' "$JWT_SECRET_LOCAL" > "$RUN_DIR/jwt.secret"
fi

cat > "$RUN_DIR/livekit.yaml" <<EOF
port: 7880
bind_addresses: ["127.0.0.1"]
log_level: info
rtc:
  tcp_port: 7881
  udp_port: 7882
  enable_loopback_candidate: true
  use_external_ip: false
  node_ip: 127.0.0.1
keys:
  $LK_KEY: $LK_SECRET
webhook:
  api_key: $LK_KEY
  urls:
    - http://localhost:4000/api/webhooks/livekit
room:
  empty_timeout: 30
EOF

PIDS=""
cleanup() {
  trap - EXIT INT TERM
  echo
  echo "Stopping…"
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

livekit-server --config "$RUN_DIR/livekit.yaml" > "$RUN_DIR/livekit.log" 2>&1 &
PIDS="$PIDS $!"
ok "livekit-server → .dev/livekit.log"
mailpit --listen 127.0.0.1:8025 --smtp 127.0.0.1:1025 --database "$RUN_DIR/mailpit.db" --disable-version-check --smtp-disable-rdns > "$RUN_DIR/mailpit.log" 2>&1 &
PIDS="$PIDS $!"
ok "local mailbox → http://localhost:8025"

(
  cd backend
  export NODE_ENV=development PORT=4000 APP_URL=http://localhost:5173 CORS_ORIGINS=http://localhost:5173 TRUST_PROXY=1 \
    DATABASE_URL="$DB_URL" REDIS_URL="${REDIS_URL:-redis://localhost:6379}" JWT_SECRET="$JWT_SECRET_LOCAL" \
    STORAGE_DRIVER=local STORAGE_LOCAL_DIR="$RUN_DIR/uploads" \
    LIVEKIT_URL=http://127.0.0.1:7880 LIVEKIT_PUBLIC_URL=/livekit LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" \
    GIF_PROVIDER="${GIF_PROVIDER:-giphy}" GIF_API_KEY="${GIF_API_KEY:-}" SEED_ON_START=1 \
    SMTP_HOST=127.0.0.1 SMTP_PORT=1025 REQUIRE_EMAIL_VERIFICATION=true
  exec pnpm exec tsx src/index.ts
) > "$RUN_DIR/backend.log" 2>&1 &
PIDS="$PIDS $!"
ok "backend → .dev/backend.log"

(cd frontend && PORT=5173 BACKEND=http://127.0.0.1:4000 LIVEKIT=http://127.0.0.1:7880 exec node scripts/serve.mjs) > "$RUN_DIR/frontend.log" 2>&1 &
PIDS="$PIDS $!"

# Wait until the API answers (migrations + seed run on first start).
i=0
until curl -fs http://localhost:5173/api/health >/dev/null 2>&1; do
  i=$((i + 1))
  if [ $i -gt 60 ]; then
    tail -n 30 "$RUN_DIR/backend.log" >&2
    fail "backend did not start"
  fi
  sleep 1
done
printf '\n  \033[1mConcord: http://localhost:5173\033[0m   (alice@concord.local / demo12345)\n  Ctrl+C to stop.\n\n'
wait
