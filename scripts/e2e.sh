#!/usr/bin/env bash
# End-to-end: isolated Anvil + throwaway Postgres -> deploy -> replay history -> backend integration tests.
# Never touches the dev chain/DB (own ports, own container, own deployment file). Cleans up on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_PORT="${E2E_ANVIL_PORT:-8575}"
PG_PORT="${E2E_PG_PORT:-5486}"
DAYS="${E2E_DAYS:-14}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
OUT="deployments/e2e-31337.json"
PG_NAME="dnv-e2e-postgres"

for p in "$ANVIL_PORT" "$PG_PORT"; do
  if ss -ltn 2>/dev/null | grep -q ":${p} "; then echo "port ${p} busy" >&2; exit 1; fi
done

cleanup() {
  [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  rm -f "$OUT"
}
trap cleanup EXIT

echo "== anvil ${RPC}"
anvil --port "$ANVIL_PORT" --chain-id 31337 --silent >/dev/null 2>&1 &
ANVIL_PID=$!

echo "== postgres :${PG_PORT}"
docker run -d --rm --name "$PG_NAME" -e POSTGRES_USER=dnv -e POSTGRES_PASSWORD=dnv -e POSTGRES_DB=dnv \
  -p "${PG_PORT}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do docker exec "$PG_NAME" pg_isready -U dnv -d dnv >/dev/null 2>&1 && break; sleep 0.5; done
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

echo "== deploy"
forge build --quiet
DEPLOYMENT_OUT="$OUT" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --quiet
node scripts/export-abis.mjs >/dev/null

export RPC_URL="$RPC" DATABASE_URL="postgres://dnv:dnv@127.0.0.1:${PG_PORT}/dnv" DEPLOYMENT_FILE="$(pwd)/${OUT}"

echo "== replay ${DAYS} days of synthetic market through the contracts"
pnpm --silent --filter @dnv/backend exec tsx src/index.ts history "$DAYS" 6

echo "== backend unit + integration tests"
INTEGRATION=1 pnpm --silent --filter @dnv/backend exec vitest run

echo "== e2e passed"
