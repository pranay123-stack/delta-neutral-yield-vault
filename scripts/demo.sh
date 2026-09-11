#!/usr/bin/env bash
# One-command reproducible demo (spec section 27): isolated Anvil -> deploy -> 16 scripted steps -> stop.
# Uses its own port and deployment file, so it never disturbs a running dev chain.
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${DEMO_PORT:-8565}"
RPC="http://127.0.0.1:${PORT}"
OUT="deployments/demo-31337.json"

if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "port ${PORT} busy - set DEMO_PORT" >&2
  exit 1
fi

echo "== 1. starting Anvil on ${RPC}"
anvil --port "$PORT" --chain-id 31337 --silent >/dev/null 2>&1 &
ANVIL_PID=$!
trap 'kill ${ANVIL_PID} 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done

echo "== 2-6. deploying mock USDC/WETH, oracle, lending market, perp market, DEX and the protocol"
forge build --quiet
DEPLOYMENT_OUT="$OUT" forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --quiet
node scripts/export-abis.mjs >/dev/null

echo "== 7-16. running the scenario"
RPC_URL="$RPC" DEPLOYMENT_FILE="$(pwd)/${OUT}" pnpm --silent --filter @dnv/backend exec tsx src/demo.ts
