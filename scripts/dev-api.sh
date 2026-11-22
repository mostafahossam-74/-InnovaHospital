#!/usr/bin/env bash
# LOCAL DEVELOPMENT ONLY: runs the API against the local database with the dev
# signing key. Creates .dev/ keys on first use. Never use outside a laptop.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .dev/objects
[[ -f .dev/dev-jwks.json ]] || node scripts/dev-token.ts platform-admin > /dev/null
export DATABASE_URL="${DATABASE_URL:-postgres://ih_web:ih_web_local@127.0.0.1:5432/innovahospital}"
export OIDC_ISSUER="${OIDC_ISSUER:-https://dev.innovahospital.invalid/}"
export OIDC_AUDIENCE="${OIDC_AUDIENCE:-innovahospital-dev}"
export DEV_JWKS_FILE=.dev/dev-jwks.json OBJECT_STORE_DIR=.dev/objects SYNTHETIC_DATA=true
export PORT="${PORT:-8080}"
exec node src/server.ts
