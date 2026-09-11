# @dnv/frontend - Delta-Neutral Vault dashboard

Next.js 16 (App Router) dashboard and depositor UI for the delta-neutral ERC-4626 vault.
**Local demo only: mock markets on a local Anvil chain, no real funds.**

## Run

Prerequisites: the project Anvil (`scripts/local-chain.sh`, port **8555**) and the backend API
(`pnpm --filter @dnv/backend start`, port **4010**) are running.

```bash
pnpm install                                # from the repo root
cp frontend/.env.example frontend/.env.local  # optional - the defaults already match the local stack
pnpm --filter @dnv/frontend dev             # http://localhost:3010 (hot reload)

# production
pnpm --filter @dnv/frontend build
pnpm --filter @dnv/frontend start           # http://localhost:3010

pnpm --filter @dnv/frontend typecheck
```

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:4010` | Backend REST API |
| `NEXT_PUBLIC_RPC_URL` | `http://127.0.0.1:8555` | Anvil RPC used by wagmi (chain id 31337) |

`NEXT_PUBLIC_*` values are inlined at build time: rebuild after changing them.

## Pages

| Route | What it shows |
|---|---|
| `/` | Overview: TVL, share price, realised net / gross APY, forward APY estimate, lending APY, funding (per 8h + APR), net delta, hedge ratio, leverage, liquidation distance, drawdown, total PnL, risk badge, share-price/TVL history, positions summary, active alerts, next rebalance plan |
| `/vault` | Wallet actions: faucet, approve + deposit, withdraw, redeem, `redeemWithUnwind` with a slippage bound, live on-chain previews and the user's position |
| `/strategy` | Targets, bounds, rebalance params, vol-scaled leverage, next plan, APY estimate breakdown, optimizer recommendation and frontier |
| `/positions` | Reserve, WETH long and perp short in detail, allocation, liquidation gauge vs thresholds, hedge / delta |
| `/risk` | Risk metrics vs warn / high / critical thresholds, flags, oracle, circuit breakers, limits, alerts, on-chain risk events |
| `/performance` | 7D / 30D / 90D / All: TVL, share price, trailing APY, cumulative PnL, delta, drawdown, funding, leverage, ETH price, summary stats |
| `/pnl` | PnL attribution waterfall + table, NAV reconciliation check, fees vs high-water mark, funding settlements |
| `/rebalancing` | Rebalance history, trigger breakdown, pre/post leverage and delta, estimated vs realised cost, the no-trade band tradeoff |
| `/simulation` | Scenario catalogue A-J (keeper on vs off), custom scenario builder, Monte Carlo, stored-simulation lookup |
| `/transactions` | Indexed deposits and withdrawals |

Every date is **chain time** (UTC) from `blockTimestamp` / `ts`: the demo warps the chain clock,
so wall-clock time would be wrong. Live panels poll every 5s, history every 30s; every panel has
loading, empty and error states (an unreachable API or RPC is reported, never shown as zeros).

## Wallets

- **Demo wallet (zero setup):** pick Alice, Bob or Carol (Anvil accounts 4-6). These use wagmi's
  `mock` connector: `eth_sendTransaction` goes straight to Anvil, which signs for its unlocked dev
  accounts. The choice is remembered across reloads.
- **Browser wallet:** MetaMask or any injected wallet. Add / switch to chain 31337 at
  `NEXT_PUBLIC_RPC_URL`; the UI offers a "Switch to Anvil" button when you are on another chain.

Every write is simulated first, so reverts are decoded before anything is sent
(for example `ERC4626ExceededMaxWithdraw` when a withdrawal exceeds the liquid assets). The UI then
waits for the receipt and refetches every API panel and on-chain read.

Standard `withdraw` / `redeem` pay out only from liquid assets (idle USDC + the USDC lending
reserve). Larger exits use `redeemWithUnwind(shares, receiver, owner, minAssetsOut)`, where the
exiting user bears the unwind cost and `minAssetsOut = previewRedeem x (1 - slippage)`.
Vault shares have 12 decimals (6 asset + 6 virtual offset); mock USDC has 6.

## Layout

```
src/app/<route>/page.tsx      server page (title + description), renders the route's client view
src/app/<route>/*View.tsx     client view wired to react-query / wagmi
src/components/ui             Card, Stat, Badge, ThresholdBar, Query (loading/error/empty), ...
src/components/charts         recharts wrappers: time series, waterfall, frontier, allocation, percentile strip
src/components/layout         shell, sidebar, top bar, demo banner, wallet menu
src/components/vault          amount input, transaction status
src/lib                       env, typed API client + hooks, formatters, wagmi config, tx runner, error decoding
```

Response types come from `@dnv/shared` (`shared/src/api.ts`); simulation payloads reuse the
`@dnv/simulator` result types (type-only imports). `lib/types.ts` declares the shapes built on the
simulator's own types, which the shared package does not re-export (`/strategy/apy`, `/simulation`).

## Checks

```bash
pnpm --filter @dnv/frontend typecheck
pnpm --filter @dnv/frontend build
pnpm --filter @dnv/frontend test:e2e   # Playwright: the depositor flow in a real browser
make check-web                         # both browser checks (needs a running stack)
```

`make check-web` does two things against a running stack (Anvil :8555, API :4010, dashboard :3010):

1. renders all 10 pages in headless Chrome and fails a page that shows an API error, hits a crash
   boundary, or is still showing loading skeletons once data should have arrived;
2. runs `e2e/vault-flow.spec.ts`, which connects a demo wallet and sends **real transactions**:
   faucet → approve + deposit → withdraw → an over-limit withdrawal that must be refused at
   simulation with a decoded `ERC4626ExceededMaxWithdraw` → `redeemWithUnwind` of exactly the shares
   it minted, leaving the demo state as it found it. Playwright drives the system Chrome
   (`channel: "chrome"`), so no browser download is needed.
