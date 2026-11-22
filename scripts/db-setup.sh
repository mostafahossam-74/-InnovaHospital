#!/usr/bin/env bash
# Local development and tests only: recreates a database, applies migrations
# and sets the local password of the runtime role. Production uses the host
# secret manager and a migration pipeline instead.
set -euo pipefail
DB="${1:-innovahospital}"
PSQL=(psql -v ON_ERROR_STOP=1 -q)
if ! pg_isready -q; then
  echo "PostgreSQL is not accepting connections. Start it (e.g. 'service postgresql start') and retry." >&2
  exit 1
fi
run_pg() { if [[ "$(id -un)" == postgres ]]; then "$@"; else su postgres -c "$(printf '%q ' "$@")"; fi; }
run_pg "${PSQL[@]}" -d postgres -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE)"
run_pg "${PSQL[@]}" -d postgres -c "CREATE DATABASE \"$DB\""
for f in "$(dirname "$0")"/../db/migrations/*.sql; do
  run_pg "${PSQL[@]}" -d "$DB" -1 -f "$(readlink -f "$f")"
done
run_pg "${PSQL[@]}" -d "$DB" -c "ALTER ROLE ih_web PASSWORD 'ih_web_local'"
echo "Database $DB ready."
