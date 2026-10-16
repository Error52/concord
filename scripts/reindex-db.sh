#!/usr/bin/env bash
# Explicit maintenance after a libc/collation change. Never run automatically on startup.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ $# -ne 1 ] || [ -e "$1" ]; then
  echo 'Usage: ./scripts/reindex-db.sh /absolute/path/to/NEW-backup.sql' >&2; exit 2
fi
BACKUP="$1"
case "$BACKUP" in /*) ;; *) echo 'Use an absolute backup path.' >&2; exit 2 ;; esac
umask 077
docker compose stop backend
# Do not restart the app if backup or rebuilding fails: the operator must inspect the database.
echo 'Saving database backup. Backend stays stopped until maintenance succeeds.'
(set -o noclobber; docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$BACKUP")
test -s "$BACKUP"
docker compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT format('REINDEX DATABASE %I', current_database()) \gexec
SELECT format('ALTER DATABASE %I REFRESH COLLATION VERSION', current_database()) \gexec
SQL
docker compose up -d backend
echo "Completed. Backup saved at $BACKUP"
