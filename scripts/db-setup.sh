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
# Same runner a deploy uses, connecting as the postgres superuser over the local socket.
# The caller's node, not the postgres user's PATH (on CI runners that is an older Node).
run_pg env MIGRATION_DATABASE_URL="postgresql://postgres@%2Fvar%2Frun%2Fpostgresql/$DB" \
  "$(command -v node)" "$(readlink -f "$(dirname "$0")/migrate.ts")" > /dev/null
run_pg "${PSQL[@]}" -d "$DB" -c "ALTER ROLE ih_web PASSWORD 'ih_web_local'"
echo "Database $DB ready."
