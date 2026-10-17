#!/usr/bin/env bash
# Atomic backup set. --quiesce stops the backend briefly for a consistent files/database snapshot.
set -euo pipefail
cd "$(dirname "$0")/.."
QUIESCE=0
case "${1:-}" in --quiesce) QUIESCE=1 ;; '') ;; *) echo 'Usage: scripts/backup.sh [--quiesce]' >&2; exit 2 ;; esac
umask 077
mkdir -p backups
chmod 700 backups
STORAGE_KIND="$(docker compose exec -T backend printenv STORAGE_DRIVER)"
[ "$STORAGE_KIND" = local ] || { echo 'This backup includes local uploads only. Back up external S3 objects with the storage provider.' >&2; exit 1; }
TEMP="$(mktemp -d backups/.pending.XXXXXX)"
STOPPED=0
cleanup() {
  local code=$?
  if [ "$STOPPED" = 1 ]; then docker compose start backend >/dev/null || code=1; fi
  case "$TEMP" in backups/.pending.*) rm -rf -- "$TEMP" ;; esac
  exit "$code"
}
trap cleanup EXIT
if [ "$QUIESCE" = 1 ]; then
  if [ -z "$(docker compose ps --status running -q backend)" ]; then echo 'Backend is not running; start it before requesting --quiesce.' >&2; exit 1; fi
  STOPPED=1
  docker compose stop -t 30 backend >/dev/null
fi
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$TEMP/database.sql.gz"
if [ "$QUIESCE" = 1 ]; then
  docker compose run --rm --no-deps -T --entrypoint tar backend -czf - -C /app/data uploads > "$TEMP/uploads.tar.gz"
else
  docker compose exec -T backend tar -czf - -C /app/data uploads > "$TEMP/uploads.tar.gz"
fi
gzip -t "$TEMP/database.sql.gz"
tar -tzf "$TEMP/uploads.tar.gz" >/dev/null
printf 'created_utc=%s\nbackend_quiesced=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$QUIESCE" > "$TEMP/metadata.txt"
TARGET="backups/$(date -u +%Y%m%d-%H%M%S)-${TEMP##*.}"
mv -- "$TEMP" "$TARGET"
echo "Saved: $TARGET"
if [ "$QUIESCE" = 0 ]; then echo 'Live snapshot: uploads may change during copying. Use --quiesce for a consistent local-volume backup.'; fi
