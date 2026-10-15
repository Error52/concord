#!/usr/bin/env bash
# Установка Concord на Linux-сервер одной командой (Ubuntu 22.04/24.04, Debian 12).
#
#   Сервер в интернете (VPS с публичным IP):
#     sudo ./scripts/install-server.sh chat.example.com you@example.com
#     sudo ./scripts/install-server.sh                      # без домена → https://<ip>.sslip.io
#
#   Локальный сервер (дома/в офисе, заходят с устройств в той же сети):
#     sudo ./scripts/install-server.sh --lan                # → https://<IP-в-сети>:8443
#
#   --reconfigure   пересоздать .env (новые секреты; данные в базе сохраняются только если пароль БД не менялся —
#                   поэтому для уже работающей установки используйте его вместе с 'make clean')
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=server
RECONF=0
DOMAIN=""
EMAIL=""
for a in "$@"; do
  case "$a" in
    --lan) MODE=lan ;;
    --reconfigure) RECONF=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    -*) echo "Неизвестный параметр: $a" >&2; exit 2 ;;
    *) if [ -z "$DOMAIN" ]; then DOMAIN="$a"; else EMAIL="$a"; fi ;;
  esac
done

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '  \033[31m✘\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "Запустите через sudo: sudo $0 $*"
[ "$(uname -s)" = "Linux" ] || die "Этот скрипт — для Linux-сервера."

say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
if ! docker compose version >/dev/null 2>&1; then
  apt-get update -y && (apt-get install -y docker-compose-plugin || apt-get install -y docker-compose-v2)
fi
docker compose version

# ───────────── публичный адрес или NAT ─────────────
PUBLIC_IP="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || curl -4 -fsS --max-time 5 https://ifconfig.me/ip 2>/dev/null || true)"
LOCAL_IPS="$(hostname -I 2>/dev/null || true)"
if [ "$MODE" = "server" ]; then
  if [ -n "$PUBLIC_IP" ] && ! printf ' %s ' "$LOCAL_IPS" | grep -q " $PUBLIC_IP "; then
    warn "Этот компьютер находится за NAT: его адрес в сети ($LOCAL_IPS) не совпадает с внешним IP ($PUBLIC_IP)."
    warn "Чтобы заходили из интернета, на роутере нужно пробросить на этот компьютер порты:"
    warn "  TCP 80, 443, 7881, 3478 и UDP 443, 7882, 3478, 49160-49200 — и чтобы провайдер дал «белый» IP."
    warn "Для проверки внутри своей сети проще режим LAN:  sudo $0 --lan"
    printf '  Продолжить установку для доступа из интернета? [y/N] '
    read -r ans </dev/tty || ans=n
    case "$ans" in y|Y|д|Д) ;; *) echo "  Остановлено. Для локальной сети: sudo $0 --lan"; exit 0 ;; esac
  fi
fi

say "Firewall"
PORTS_TCP="80 443 7881 3478"
PORTS_UDP="443 7882 3478"
[ "$MODE" = "lan" ] && PORTS_TCP="8443 7881 3478" && PORTS_UDP="7882 3478"
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow OpenSSH >/dev/null || true
  for p in $PORTS_TCP; do ufw allow "$p/tcp" >/dev/null; done
  for p in $PORTS_UDP; do ufw allow "$p/udp" >/dev/null; done
  ufw allow 49160:49200/udp >/dev/null
  echo "  ufw: порты открыты"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  for p in $PORTS_TCP; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
  for p in $PORTS_UDP; do firewall-cmd --permanent --add-port="$p/udp" >/dev/null; done
  firewall-cmd --permanent --add-port=49160-49200/udp >/dev/null
  firewall-cmd --reload >/dev/null
  echo "  firewalld: порты открыты"
else
  echo "  ufw/firewalld не активны — на этой машине менять нечего."
fi
[ "$MODE" = "server" ] && echo "  У облачного провайдера (security group / firewall в панели) откройте: TCP $PORTS_TCP · UDP $PORTS_UDP 49160-49200"

say "Настройки (.env)"
WANT_PROFILE=server
[ "$MODE" = "lan" ] && WANT_PROFILE="https,dev"
if [ -f .env ] && [ "$RECONF" != "1" ]; then
  HAVE_PROFILE="$(grep -E '^COMPOSE_PROFILES=' .env | cut -d= -f2- || true)"
  if [ "$HAVE_PROFILE" != "$WANT_PROFILE" ]; then
    warn "Найден .env для другого режима (COMPOSE_PROFILES=$HAVE_PROFILE), нужен $WANT_PROFILE."
    if docker volume ls -q 2>/dev/null | grep -q '^concord_pgdata$'; then
      warn "Уже есть база данных (том concord_pgdata) со старым паролем. Чтобы начать с нуля: 'docker compose down -v', затем:"
      die "sudo $0 --reconfigure $*"
    fi
    RECONF=1
  else
    echo "  .env уже настроен для этого режима — оставляю как есть."
  fi
fi
if [ ! -f .env ] || [ "$RECONF" = "1" ]; then
  if [ "$MODE" = "lan" ]; then
    ./scripts/setup.sh --lan --force
  else
    set -- --server --force
    [ -n "$DOMAIN" ] && set -- "$@" --domain "$DOMAIN"
    [ -n "$EMAIL" ] && set -- "$@" --email "$EMAIL"
    [ -n "$PUBLIC_IP" ] && set -- "$@" --ip "$PUBLIC_IP"
    ./scripts/setup.sh "$@"
  fi
fi

say "Загрузка образов"
if ! docker compose pull --ignore-buildable; then
  warn "Не удалось скачать образы с Docker Hub."
  warn "Если Docker Hub недоступен из вашей сети/страны, включите зеркало: в /etc/docker/daemon.json"
  warn '  { "registry-mirrors": ["https://mirror.gcr.io"] }'
  warn "затем: sudo systemctl restart docker  и запустите скрипт снова."
  exit 1
fi

say "Сборка и запуск"
docker compose up --build -d
URL="$(grep -E '^APP_URL=' .env | cut -d= -f2-)"

say "Проверка ($URL)"
CURL_OPTS="-fsS --max-time 5"
[ "$MODE" = "lan" ] && CURL_OPTS="$CURL_OPTS -k"
for _ in $(seq 1 60); do
  # shellcheck disable=SC2086
  if curl $CURL_OPTS "$URL/api/health" >/dev/null 2>&1; then
    printf '\n  \033[32mConcord работает: %s\033[0m\n' "$URL"
    if [ "$MODE" = "lan" ]; then
      echo "  Откройте этот адрес на любом устройстве в вашей сети. Браузер предупредит о сертификате —"
      echo "  нажмите «Дополнительно → Перейти» (или установите сертификат: make trust-cert)."
      echo "  Демо-вход: alice@concord.local / demo12345"
    else
      echo "  Зарегистрируйтесь первым, создайте сервер и отправьте друзьям ссылку-приглашение."
    fi
    exit 0
  fi
  sleep 5
done
echo "  Пока не открывается. Логи: docker compose logs --tail=50 backend caddy-public caddy" >&2
[ "$MODE" = "server" ] && echo "  Проверьте DNS-запись A и что порты 80/443 доступны снаружи (нужны для сертификата Let's Encrypt)." >&2
exit 1
