# API

REST API served by the backend (`backend/src/api/server.ts`, Fastify 5). Interactive docs at
**http://localhost:4010/docs**; the OpenAPI 3.0 document is at `/openapi.json` and committed as
[`docs/openapi.json`](openapi.json) (regenerate with `pnpm --filter @dnv/backend openapi`). Response
types are shared with the frontend in `shared/src/api.ts`.

Conventions: money in human units (USD and ETH as JSON numbers), ratios in **basis points**, rates as
**fractions** (0.05 = 5%). Every live endpoint carries `chainId`, `blockNumber` and `blockTimestamp`.
**Timestamps are chain time**: the local demo warps time to build history. All chain reads for one
response are pinned to one block; responses are cached for 1.5 s.

## Endpoints

| Method | Path | Returns | Source |
|---|---|---|---|
| GET | `/health` | chain, DB, indexer lag, last keeper action | live |
| GET | `/vault` | address, TVL, share price, supply, idle, liquidity, cap, operational, pauses | chain |
| GET | `/vault/metrics` | TVL, share price, **net APY** (realised, trailing 30d), **gross APY**, **estimated net APY**, lending/USDC/WETH APR, funding (8h + APR), net delta, hedge ratio, leverage, liquidation distance, drawdown, total PnL, risk state, ETH price | chain + DB + simulator |
| GET | `/vault/performance?days=N` | time series (TVL, share price, ETH, delta, leverage, liquidation distance, drawdown, funding, APRs, PnL, 7d/30d APY, risk state) + summary (return, annualised, max drawdown, vol, Sharpe, rebalances) | DB snapshots |
| GET | `/vault/positions` | every leg: reserve, long (qty, value, principal/interest, APR, utilisation, cost basis), perp (size, entry, mark, margin, equity, uPnL, pending funding, leverage, liquidation price and distance, MM, collateral ratio), allocation % | chain |
| GET | `/vault/risk` | risk state (live + persisted), flags, each metric vs its thresholds, peak share price, oracle status, liquidation report, circuit breakers, limits | chain |
| GET | `/vault/delta` | long/short/gross exposure, net delta (qty, USD, bps), hedge ratio, target size, required change, configured and vol-scaled band | chain |
| GET | `/vault/funding` | current rate/APR, settled + pending funding, annualised income at current size, rate history, settlements | chain + DB |
| GET | `/vault/pnl` | full attribution + fees + reconciliation residual | chain |
| GET | `/vault/fees` | rates, caps, HWM vs share price, totals, fee recipient position | chain |
| GET | `/vault/transactions` | deposits and withdrawals | DB (indexer) |
| GET | `/strategy` | targets, bounds, params, effective leverage, vol, defensive flag, rebalance count, **next plan** (triggers, urgent, deltas, cost) | chain |
| GET | `/strategy/apy` | APY estimate (gross components, costs, net, rebalances/yr, risk) + optimizer (best, frontier, recommendation) at *live* rates and parameters | chain + simulator |
| GET | `/strategy/scenarios` | scenarios A-J under the live on-chain config, keeper on vs off | simulator |
| GET | `/rebalance/history?limit=N` | executed rebalances with triggers, deltas, pre/post delta and leverage, estimated vs realised cost | DB (indexer) |
| GET | `/alerts?active=true` | alerts (active first) with severity, value, threshold, opened/resolved | DB (alert engine) |
| GET | `/risk/events` | on-chain risk events: state changes, pauses, breaker trips, unwinds, venue liquidations/ADL, PnL crystallisation | DB (indexer) |
| POST | `/simulation` | run and persist a simulation: `scenario`, `custom`, `montecarlo`, `optimizer` | simulator + DB |
| GET | `/simulation/:id` | a stored simulation | DB |

## Examples

```bash
curl -s localhost:4010/vault/metrics | jq '{tvlUsd, sharePrice, netApy, estimatedNetApy, netDeltaBps, leverage, liquidationDistanceBps, riskState}'

curl -s localhost:4010/vault/pnl | jq '{fundingIncome, lendingIncomeUsdc, tradingFees, strategyNetPnl, reconciliationResidualUsd}'

curl -s -X POST localhost:4010/simulation -H 'content-type: application/json' \
  -d '{"type":"custom","priceMovePct":-35,"moveDays":2,"horizonDays":14,"fundingRatePer8h":-0.0002}' \
  | jq '.result.withKeeper | {netPnl, maxAbsDeltaBps, minLiquidationDistanceBps, liquidations}'

curl -s -X POST localhost:4010/simulation -H 'content-type: application/json' \
  -d '{"type":"montecarlo","paths":200,"days":365,"seed":7}' | jq '.result.annualizedReturn'
```

Sample `/vault/metrics` after the 90-day replay:

```json
{
  "tvlUsd": 466472.51, "sharePrice": 1.008792,
  "netApy": 0.0787, "grossApy": 0.1044, "estimatedNetApy": 0.0065,
  "fundingRatePer8h": 0.0000023, "netDeltaBps": 0, "netDeltaUsd": 19.47,
  "hedgeRatio": 0.9999, "leverage": 1.33, "liquidationDistanceBps": 6659,
  "drawdownBps": 0, "totalPnlUsd": 3249.32, "riskState": "NORMAL"
}
```

(`estimatedNetApy` is low there because funding had fallen to ~0.26% APR at the end of that synthetic
history; realised `netApy` covers the trailing 30 days.)

## Errors

`400 { "error": "bad_request", "message": ... }` for schema violations (e.g. unknown simulation type);
`404` for a missing simulation; `500 { "error": "internal_error" }` otherwise. Chain or DB outages show
up in `/health` rather than as partial data.
