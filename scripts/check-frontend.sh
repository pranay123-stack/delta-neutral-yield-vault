#!/usr/bin/env bash
# Render every dashboard page in headless Chrome against a running frontend + API and fail if any page
# shows an API error, a crash boundary, or is still stuck on loading skeletons after data should be in.
#   usage: FRONTEND_URL=http://localhost:3010 ./scripts/check-frontend.sh
set -euo pipefail

URL="${FRONTEND_URL:-http://localhost:3010}"
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}"
[[ -n "$CHROME" ]] || { echo "no Chrome/Chromium found (set CHROME=...)" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail=0
for route in / /vault /strategy /positions /risk /performance /pnl /rebalancing /simulation /transactions; do
  dom="$TMP/page.html"
  timeout 90 "$CHROME" --headless=new --disable-gpu --no-sandbox --user-data-dir="$TMP/profile" \
    --virtual-time-budget=15000 --window-size=1440,2000 --dump-dom "${URL}${route}" >"$dom" 2>/dev/null || true
  errors="$(grep -o -E 'HTTP [0-9]{3} on [^<]{0,80}|API unreachable|Application error|Something went wrong' "$dom" | sort -u | head -3 || true)"
  skeletons="$(grep -c 'animate-pulse' "$dom" || true)"
  if [[ ! -s "$dom" || -n "$errors" || "$skeletons" -gt 0 ]]; then
    printf 'FAIL %-14s bytes=%s skeletons=%s %s\n' "$route" "$(wc -c <"$dom")" "$skeletons" "${errors//$'\n'/ | }"
    fail=1
  else
    printf 'ok   %-14s bytes=%s\n' "$route" "$(wc -c <"$dom")"
  fi
done
exit "$fail"
