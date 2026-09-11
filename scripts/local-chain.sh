#!/usr/bin/env bash
# (Re)start this project's Anvil on $ANVIL_PORT (default 8555), deploy the full stack and export ABIs.
# Only ever kills the Anvil process it started itself (tracked in .anvil.pid).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${ANVIL_PORT:-8555}"
RPC="http://127.0.0.1:${PORT}"
PIDFILE=".anvil.pid"

if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "stopping previous project anvil (pid $(cat "$PIDFILE"))"
  kill "$(cat "$PIDFILE")" && sleep 1
fi
if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
  echo "port ${PORT} is in use by another process - set ANVIL_PORT to a free port" >&2
  exit 1
fi

anvil --port "$PORT" --chain-id 31337 --silent >.anvil.log 2>&1 &
echo $! >"$PIDFILE"
for _ in $(seq 1 50); do cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
echo "anvil up on ${RPC} (pid $(cat "$PIDFILE"))"

forge build --quiet
forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --quiet
node scripts/export-abis.mjs
echo "deployed: $(grep -o '"vault": "[^"]*"' deployments/31337.json)"
