#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY: recreates the local database, creates the dev signing
# key, and makes "platform-admin" a platform admin for the dev issuer.
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/db-setup.sh innovahospital
node scripts/dev-token.ts platform-admin > /dev/null
SQL="INSERT INTO platform_admin VALUES ('${OIDC_ISSUER:-https://dev.innovahospital.invalid/}', 'platform-admin') ON CONFLICT DO NOTHING"
if [[ "$(id -un)" == postgres ]]; then psql -d innovahospital -qc "$SQL"; else su postgres -c "psql -d innovahospital -qc \"$SQL\""; fi
echo "Dev database ready. Platform admin: platform-admin"
