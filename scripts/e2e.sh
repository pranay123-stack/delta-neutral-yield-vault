#!/usr/bin/env bash
# End-to-end: isolated Anvil + throwaway Postgres -> deploy -> replay history -> backend integration tests.
# Never touches the dev chain/DB (own ports, own container, own deployment file). Cleans up on exit.
set -euo pipefail
cd "$(dirname "$0")/.."

ANVIL_PORT="${E2E_ANVIL_PORT:-8575}"
PG_PORT="${E2E_PG_PORT:-5486}"
E2E_API_PORT="${E2E_API_PORT:-4015}"
E2E_WEB_PORT="${E2E_WEB_PORT:-3015}"
DAYS="${E2E_DAYS:-14}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
OUT="deployments/e2e-31337.json"
PG_NAME="dnv-e2e-postgres"

PORTS=("$ANVIL_PORT" "$PG_PORT")
if [[ "${E2E_BROWSER:-0}" == "1" ]]; then PORTS+=("$E2E_API_PORT" "$E2E_WEB_PORT"); fi
for p in "${PORTS[@]}"; do
  if ss -ltn 2>/dev/null | grep -q ":${p} "; then echo "port ${p} busy" >&2; exit 1; fi
done

cleanup() {
  for pid in "${WEB_PID:-}" "${API_PID:-}" "${ANVIL_PID:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
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

# Opt-in browser stage (E2E_BROWSER=1): the same stack, plus the API and the dashboard, checked in a
# real Chrome - every page rendered, then the depositor flow sending real transactions through wagmi.
if [[ "${E2E_BROWSER:-0}" == "1" ]]; then
  echo "== api :${E2E_API_PORT}"
  API_PORT="$E2E_API_PORT" KEEPER_ENABLED=false pnpm --silent --filter @dnv/backend exec tsx src/index.ts api >/tmp/dnv-e2e-api.log 2>&1 &
  API_PID=$!
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:${E2E_API_PORT}/health" >/dev/null && break; sleep 0.5; done
  curl -sf "http://127.0.0.1:${E2E_API_PORT}/health" >/dev/null || { echo "api did not come up" >&2; tail -20 /tmp/dnv-e2e-api.log >&2; exit 1; }

  echo "== dashboard :${E2E_WEB_PORT} (build + start)"
  # own dist dir: never clobber the .next a locally running `next start` is serving
  export NEXT_DIST_DIR=".next-e2e"
  NEXT_PUBLIC_API_URL="http://localhost:${E2E_API_PORT}" NEXT_PUBLIC_RPC_URL="$RPC" \
    pnpm --silent --filter @dnv/frontend build >/dev/null
  NEXT_PUBLIC_API_URL="http://localhost:${E2E_API_PORT}" NEXT_PUBLIC_RPC_URL="$RPC" \
    pnpm --silent --filter @dnv/frontend exec next start -p "$E2E_WEB_PORT" >/tmp/dnv-e2e-web.log 2>&1 &
  WEB_PID=$!
  for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:${E2E_WEB_PORT}/" >/dev/null && break; sleep 0.5; done

  echo "== browser: render every page"
  FRONTEND_URL="http://localhost:${E2E_WEB_PORT}" ./scripts/check-frontend.sh

  echo "== browser: depositor flow"
  FRONTEND_URL="http://localhost:${E2E_WEB_PORT}" pnpm --silent --filter @dnv/frontend test:e2e
fi

echo "== e2e passed"
