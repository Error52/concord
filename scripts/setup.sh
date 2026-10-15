#!/usr/bin/env bash
# Concord setup for macOS and Linux. Writes .env with fresh random secrets and the right network addresses.
#
#   ./scripts/setup.sh                               # this computer only: http://localhost
#   ./scripts/setup.sh --lan                         # devices in your home/office network: https://<LAN-IP>:8443
#   ./scripts/setup.sh --server --domain chat.example.com --email you@example.com
#                                                    # public server on the internet: https://chat.example.com
#   ./scripts/setup.sh --server                      # public server without your own domain: https://<ip>.sslip.io
#
# Other options: --port N (HTTP port for local mode), --https-port N (LAN mode), --ip X (override detected IP), --force
# Compatible with the stock bash 3.2 on macOS (no bash-4 features, no GNU-only sed flags).
set -euo pipefail

cd "$(dirname "$0")/.."

MODE=local
HTTP_PORT=80
HTTPS_PORT=8443
FORCE=0
DOMAIN=""
EMAIL=""
IP_OVERRIDE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --lan) MODE=lan ;;
    --server) MODE=server ;;
    --domain) DOMAIN="${2:?--domain needs a value}"; shift ;;
    --email) EMAIL="${2:?--email needs a value}"; shift ;;
    --ip) IP_OVERRIDE="${2:?--ip needs a value}"; shift ;;
    --port) HTTP_PORT="${2:?--port needs a value}"; shift ;;
    --https-port) HTTPS_PORT="${2:?--https-port needs a value}"; shift ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
bold "Concord setup — $OS/$ARCH, mode: $MODE"

# ───────────── prerequisites ─────────────
command -v docker >/dev/null 2>&1 || {
  if [ "$OS" = "Darwin" ]; then fail "Docker not found. Install Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/) or OrbStack/Colima."
  else fail "Docker not found. Install Docker Engine: https://docs.docker.com/engine/install/ (or run scripts/install-server.sh on a server)"; fi
}
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 not found ('docker compose'). Update Docker or install the compose plugin (docker-compose-plugin)."
ok "$(docker compose version | head -n1)"
if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then warn "Docker daemon is not running — start Docker Desktop (or 'colima start') before 'make up'."
  else warn "Docker daemon not reachable. Start it (sudo systemctl start docker) and make sure your user is in the 'docker' group."; fi
else
  ok "Docker daemon is running"
fi

if [ "$MODE" = "local" ] && [ "$OS" = "Linux" ] && [ "$HTTP_PORT" -lt 1024 ] && docker info 2>/dev/null | grep -qi rootless; then
  warn "Rootless Docker detected: port $HTTP_PORT is privileged — switching to 8080."
  HTTP_PORT=8080
fi

port_busy() {
  if command -v lsof >/dev/null 2>&1; then lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then ss -ltn "( sport = :$1 )" 2>/dev/null | grep -q LISTEN
  else return 1; fi
}
if [ "$MODE" = "server" ]; then CHECK_PORTS="80 443 7881 3478"; else CHECK_PORTS="$HTTP_PORT 7881 3478"; fi
for p in $CHECK_PORTS; do
  if port_busy "$p"; then warn "Port $p is already in use (another web server?). Free it before 'make up'."; fi
done
if [ "$OS" = "Darwin" ] && [ "$HTTP_PORT" = "5000" ]; then warn "On macOS port 5000 is used by AirPlay Receiver."; fi

# ───────────── network addresses ─────────────
detect_lan_ip() {
  local ip=""
  if [ "$OS" = "Darwin" ]; then
    local iface
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
    [ -n "$iface" ] && ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    [ -z "$ip" ] && ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  else
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
    [ -z "$ip" ] && ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  printf '%s' "$ip"
}

detect_public_ip() {
  local ip=""
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$ip" in *.*.*.*) printf '%s' "$ip"; return 0 ;; esac
  done
  return 1
}

resolve_host() {
  if command -v getent >/dev/null 2>&1; then getent ahostsv4 "$1" 2>/dev/null | awk 'NR==1{print $1}'
  elif command -v dig >/dev/null 2>&1; then dig +short A "$1" | tail -n1
  else host "$1" 2>/dev/null | awk '/has address/{print $4; exit}'; fi
}

DENY_A=""; DENY_B=""; DENY_C=""
HTTP_BIND=0.0.0.0
SEED=1
case "$MODE" in
  local)
    MEDIA_IP="${IP_OVERRIDE:-127.0.0.1}"
    PUBLIC_HOST=localhost
    if [ "$HTTP_PORT" = "80" ]; then APP_URL="http://localhost"; else APP_URL="http://localhost:$HTTP_PORT"; fi
    COOKIE_SECURE=false
    PROFILES=dev
    ;;
  lan)
    MEDIA_IP="${IP_OVERRIDE:-$(detect_lan_ip)}"
    [ -n "$MEDIA_IP" ] || fail "Could not detect the LAN IP. Pass it with --ip 192.168.x.y"
    ok "LAN IP: $MEDIA_IP"
    APP_URL="https://$MEDIA_IP:$HTTPS_PORT"
    PUBLIC_HOST="$MEDIA_IP"
    COOKIE_SECURE=true
    PROFILES="https,dev"
    ;;
  server)
    [ "$OS" = "Linux" ] || warn "Server mode is meant for a Linux VPS; continuing anyway."
    MEDIA_IP="${IP_OVERRIDE:-$(detect_public_ip || true)}"
    [ -n "$MEDIA_IP" ] || fail "Could not detect the public IP. Pass it with --ip <your server IP>"
    ok "Public IP: $MEDIA_IP"
    if [ -z "$DOMAIN" ]; then
      # Free wildcard DNS: 203-0-113-5.sslip.io → 203.0.113.5, so Let's Encrypt works without buying a domain.
      DOMAIN="$(printf '%s' "$MEDIA_IP" | tr '.' '-').sslip.io"
      warn "No --domain given — using $DOMAIN (free DNS name that points to this IP)."
    else
      RESOLVED="$(resolve_host "$DOMAIN" || true)"
      if [ -z "$RESOLVED" ]; then
        warn "$DOMAIN does not resolve yet. Create a DNS A record: $DOMAIN → $MEDIA_IP (the certificate is issued once it resolves)."
      elif [ "$RESOLVED" != "$MEDIA_IP" ]; then
        warn "$DOMAIN points to $RESOLVED, but this server is $MEDIA_IP. Fix the DNS A record (or Cloudflare proxy must be OFF / grey cloud)."
      else
        ok "DNS: $DOMAIN → $MEDIA_IP"
      fi
    fi
    [ -n "$EMAIL" ] || EMAIL="admin@$DOMAIN"
    APP_URL="https://$DOMAIN"
    PUBLIC_HOST="$DOMAIN"
    COOKIE_SECURE=true
    PROFILES=server
    HTTP_BIND=127.0.0.1
    HTTP_PORT=8080
    SEED=0
    DENY_A=10.0.0.0-10.255.255.255
    DENY_B=172.16.0.0-172.31.255.255
    DENY_C=192.168.0.0-192.168.255.255
    ;;
esac

# ───────────── secrets ─────────────
secret() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "${1:-32}"
  else LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "$(( ${1:-32} * 2 ))"; fi
}

if [ -f .env ] && [ "$FORCE" != "1" ]; then
  fail ".env already exists. Re-run with --force to regenerate it (secrets and database password will change)."
fi

kv() { printf '%s=%s\n' "$1" "$2"; }
JWT="$(secret 32)"; PG="$(secret 16)"; LK="$(secret 32)"; TURN="$(secret 16)"
SMTP_DEFAULT=mailpit
[ "$MODE" = "server" ] && SMTP_DEFAULT=""
TMP="$(mktemp)"
while IFS= read -r line || [ -n "$line" ]; do
  key="${line%%=*}"
  case "$key" in
    APP_URL) kv APP_URL "$APP_URL" ;;
    DOMAIN) kv DOMAIN "$DOMAIN" ;;
    ACME_EMAIL) kv ACME_EMAIL "$EMAIL" ;;
    HTTP_BIND) kv HTTP_BIND "$HTTP_BIND" ;;
    HTTP_PORT) kv HTTP_PORT "$HTTP_PORT" ;;
    HTTPS_PORT) kv HTTPS_PORT "$HTTPS_PORT" ;;
    COOKIE_SECURE) kv COOKIE_SECURE "$COOKIE_SECURE" ;;
    DEMO_MAILBOX) if [ "$MODE" = lan ]; then kv DEMO_MAILBOX true; else kv DEMO_MAILBOX false; fi ;;
    COMPOSE_PROFILES) kv COMPOSE_PROFILES "$PROFILES" ;;
    POSTGRES_PASSWORD) kv POSTGRES_PASSWORD "$PG" ;;
    DATABASE_URL) kv DATABASE_URL "postgres://concord:$PG@localhost:5432/concord" ;;
    JWT_SECRET) kv JWT_SECRET "$JWT" ;;
    LIVEKIT_API_SECRET) kv LIVEKIT_API_SECRET "$LK" ;;
    LIVEKIT_NODE_IP) kv LIVEKIT_NODE_IP "$MEDIA_IP" ;;
    TURN_SERVER) kv TURN_SERVER "turn:$PUBLIC_HOST:3478" ;;
    TURN_PUBLIC_HOST) kv TURN_PUBLIC_HOST "$PUBLIC_HOST" ;;
    TURN_EXTERNAL_IP) kv TURN_EXTERNAL_IP "$MEDIA_IP" ;;
    TURN_PASSWORD) kv TURN_PASSWORD "$TURN" ;;
    TURN_DENY_A) kv TURN_DENY_A "$DENY_A" ;;
    TURN_DENY_B) kv TURN_DENY_B "$DENY_B" ;;
    TURN_DENY_C) kv TURN_DENY_C "$DENY_C" ;;
    SMTP_HOST) kv SMTP_HOST "$SMTP_DEFAULT" ;;
    SEED_ON_START) kv SEED_ON_START "$SEED" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.example > "$TMP"
mv "$TMP" .env
chmod 600 .env
ok ".env written with fresh secrets"

bold "Next:"
echo "  make up            # or: docker compose up --build -d"
case "$MODE" in
  local)
    echo "  open $APP_URL"
    echo "  Demo users: alice@concord.local / demo12345 (also bob, carol, dave)"
    ;;
  lan)
    echo "  open $APP_URL on any device in your network"
    echo "  Trust the local CA on every client: make trust-cert (see docs/LAN.md)."
    echo "  Demo users: alice@concord.local / demo12345 (also bob, carol, dave)"
    ;;
  server)
    echo "  open $APP_URL  — register the first account there and invite friends with an invite link."
    echo "  Firewall: open 80/tcp, 443/tcp+udp, 7881/tcp, 7882/udp, 3478/tcp+udp, 49160-49200/udp"
    echo "  (cloud providers: also in the provider's security group / firewall panel)."
    echo "  Password-reset emails need SMTP_* in .env (any SMTP provider)."
    ;;
esac
if [ "$OS" = "Darwin" ] && [ "$MODE" != "server" ]; then
  echo
  echo "  macOS: allow your browser in System Settings → Privacy & Security → Screen & System Audio Recording"
  echo "  (needed for screen sharing) and → Microphone / Camera."
fi
