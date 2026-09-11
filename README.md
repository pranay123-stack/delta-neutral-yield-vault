# Delta-Neutral DeFi Yield Vault

An ERC-4626 USDC vault running a **delta-neutral basis strategy**: long ETH supplied to a lending
market, short the same ETH on a perpetual exchange, and USDC earning lending interest. The book earns
lending interest + funding while staying (almost) insensitive to the ETH price. Around it: an on-chain
risk engine, a keeper-driven rebalancer, a PnL engine that reconciles to NAV, an oracle layer, a
TypeScript simulator / optimizer, an indexer + REST API, and a Next.js dashboard.

> **Portfolio / demo project. No real money.** Everything runs on a local Anvil chain against mock
> markets (lending pool, perp venue, DEX, Chainlink-style feeds). The mocks implement the same
> interfaces a production integration would use. It is not audited and must not hold real funds.

```
            ┌───────────────────── share price ≈ NAV / shares ─────────────────────┐
USDC ─► ERC-4626 vault ─┬─► 10% USDC reserve ──► lending pool  (USDC supply APR)   │
                        └─► 90% basis ─┬─► 60% WETH ─► lending pool (WETH APR)  +Δ │
                                       └─► 30% USDC ─► perp margin (funding)    −Δ │
                  keeper ─► RebalanceManager ─► StrategyManager ─► RiskManager ─────┘
```

**By the numbers**

| | |
|---|---|
| Tests | **225** Foundry (unit, fuzz, 11 invariants, scenarios, a16z ERC-4626 properties, resilience) + **24** simulator + **45** backend (23 against a live chain) |
| PnL reconciliation | `NAV − capital − attributed PnL` = **$0.0000** after a 90-day on-chain replay; checked after every random step in the invariant suite |
| Delta | worst **2 bps** of NAV across the 90-day replay; ≤ 149 bps after any rebalance in a 3,000-step random walk |
| Estimated net APY | **6.24%** at base market (gross 8.23%); Monte Carlo median **5.70%**, p5 4.48% (synthetic market) |
| Gas | deposit **248k**, redeem **255k**, rebalance **1.22M** (isolated tx); deposit −31% after optimisation |
| Real bugs found and fixed | 9, each with a regression test ([security.md](docs/security.md#2-bugs-found-during-development)) |

---

## Problem

Stablecoin holders want yield without taking ETH price risk. The two obvious sources each have a catch:

- **Lending USDC** is safe-ish but low-yield and utilisation-dependent.
- **Perp funding** pays shorts well most of the time, but a naked short is a directional bet.

The basis trade combines them: hold ETH and short the same ETH. The price exposure cancels and the
carry remains. Doing it *well* is an engineering problem: keep delta near zero as positions drift,
keep the short away from liquidation as ETH moves, don't bleed the yield away in rebalancing costs,
account for every dollar, survive oracle and venue failures, and let depositors enter and exit fairly.
That is what this repository implements.

## Strategy

→ [docs/strategy.md](docs/strategy.md), [docs/delta-neutral.md](docs/delta-neutral.md)

- **Allocation** (defaults): 10% USDC reserve, 60% WETH long in lending, 30% perp margin backing a short
  of equal size (2x leverage on the perp).
- **Delta** is measured against NAV (what the share price is exposed to) and kept inside a
  volatility-scaled band (200 bps base). The short is re-hedged against the *actual* post-trade WETH
  quantity.
- **Carry at base market:** 0.51% (USDC reserve) + 1.15% (WETH lending) + 6.57% (funding) = 8.23% gross.
- **Regime rules:** leverage scales down when EWMA realised vol exceeds 60%; when funding drops below
  −5% APR the vault goes **defensive** (70% into USDC lending). Monte Carlo shows the premium: defensive
  mode costs ~0.65% APY in benign markets, and under persistent negative funding it lifts the 5th
  percentile from **−0.65% to +2.49%**.

## Architecture

→ [docs/architecture.md](docs/architecture.md)

| Contract | Role |
|---|---|
| `DeltaNeutralVault` | ERC-4626; liquidity-bounded `maxWithdraw`; `redeemWithUnwind` (exiting user pays their own unwind); fee shares; EIP-1153 pricing window |
| `StrategyManager` | Dumb executor: runs plans with oracle-bounded slippage; spot PnL counters; best-effort emergency unwind |
| `RebalanceManager` | Decides: triggers, vol-scaled targets, cooldown, cost + carry filters, feasibility; Chainlink-Automation-shaped |
| `RiskManager` | NORMAL / WARNING / HIGH_RISK / EMERGENCY; validates every rebalance; drawdown peak; circuit breaker |
| `PositionManager` | One snapshot struct for NAV, delta, liquidation report and PnL breakdown |
| `OracleManager` | Staleness, invalid/negative, incomplete round, consecutive-round deviation, decimals, fallback, shutdown |
| `FeeManager` | Management + HWM performance fee by dilution; withdrawal fee; compile-time caps |
| `EmergencyController` | Guardian pauses (asymmetric), terminal shutdown |
| `LendingAdapter` / `PerpAdapter` / `SwapAdapter` | Venue seams (Aave-V3-shaped lending ABI); pull pattern; bound to the strategy |
| `AccessRegistry` | ADMIN (timelock), GUARDIAN (can only reduce risk), KEEPER (when, not what), STRATEGIST (targets within bounds) |

Off-chain: `simulator/` (model, scenarios, optimizer, Monte Carlo), `backend/` (block-pinned chain
reader, indexer, snapshotter, alert engine, keeper, market driver, Fastify API + OpenAPI), `frontend/`
(Next.js 16 + wagmi dashboard), Postgres.

## Economics

→ [docs/economics.md](docs/economics.md)

Management fee 0.5%/yr and performance fee 10% above a **high-water mark**, both minted as shares and
both capped by compile-time constants. Trading costs are paid at cost. Entry cost of deploying $100k is
~$100 (10 bps). Funding is the dominant driver: at 0.02%/8h the estimate is 12.15%, and at 0.005%/8h
(just under the 5.77% breakeven) 3.29%. Keeper gas makes L1 uneconomic for small vaults (~$4,300/yr),
so the design target is an L2, and keeper gas is an input to the cost filter.

## Risk

→ [docs/risk-management.md](docs/risk-management.md), [docs/oracles.md](docs/oracles.md),
[docs/threat-model.md](docs/threat-model.md)

Leverage, delta, drawdown, liquidation distance, collateral ratio, funding, venue exposure, position
size and oracle health each have warn / high / critical levels. A rebalance must end within the hard
limits **or strictly improve** every breached metric, otherwise it reverts. Urgent plans (liquidation
proximity, hard-limit breach) bypass the cooldown and cost filters. EMERGENCY trips the deposit
breaker. **Withdrawals can never be paused**; they only wait while NAV is unknown, and the guardian's
emergency unwind resolves that.

## PnL

→ [docs/pnl-accounting.md](docs/pnl-accounting.md)

```
strategyNav − netCapital == lendingUsdc + lendingWeth + funding + spot(realised+unrealised)
                           + perp(realised+unrealised) − fees − slippage + badDebtAbsorbed
```

Trading PnL is measured against the oracle/mark *at execution*, so execution cost appears only in the
fee and slippage lines. Perp realised PnL is derived as a residual, so venue-side ADL and liquidations
stay correct.

## Rebalancing

→ [docs/rebalancing.md](docs/rebalancing.md)

The trade-off, quantified with a closed form (expected exit time of a Brownian motion from the band
corridor, `a·b/σ²`) and checked against simulation:

| Bands | Rebalances / yr @ 60% vol | Costs / yr | Est. net APY |
|---|---|---|---|
| tight (2.5% / ±12.5%) | 225 | 1.88% | 5.18% |
| **default (5% / ±25%)** | **60** | **0.70%** | **6.24%** |
| wide (10% / ±50%) | 17 | 0.30% | 6.60% (short sits closer to liquidation) |

Scenario I (ETH +60% in 3 days): **keeper on**, 0 liquidations, max delta 9 bps; **keeper off**, the
short is liquidated and delta hits 8,786 bps.

## Security

→ [docs/security.md](docs/security.md)

Controls for reentrancy, inflation attacks, share-price and oracle manipulation, stale prices, adapter
abuse, accounting, rounding, unauthorised rebalancing, leverage, liquidation, bad debt, insolvency,
emergency exits, admin abuse and gas-griefing of try/catch fallbacks, each with a test. Slither: 97
results, all triaged. Eight real bugs were found during development, four of them only by *running*
the whole system (see the table in security.md).

## Testing

→ [docs/testing.md](docs/testing.md)

Unit, fuzz (512 runs; 5,000 in the deep profile), 11 invariants over 8,192-call random sequences
(user flows, price/funding/utilisation shocks, time, keeper, venue liquidations and ADL, attacker
probes), the a16z ERC-4626 property suite with fees on and zero tolerance, 3,000-step stress walks,
gas-griefing scans, simulator parity tests pinned to on-chain numbers, and backend integration tests
against a live chain.

## Simulation

→ [docs/simulation.md](docs/simulation.md)

Scenarios A-J (ETH ±20%, −40%, negative funding, APY collapse, 120% vol, stale oracle, shallow venues,
+60% squeeze, crash + negative funding), each run with the keeper on and off; custom scenarios and
Monte Carlo through `POST /simulation`; an APY estimation engine and a constrained optimizer.

## Dashboard

→ [frontend/README.md](frontend/README.md)

Ten pages over the API, all on live chain state: **Overview** (headline metrics, share-price/TVL chart,
next keeper plan, active alerts), **Vault** (deposit / mint / withdraw / redeem / `redeemWithUnwind`,
previews and per-step transaction status), **Strategy** (targets, bands, vol scaling, APY estimate and
optimizer frontier), **Positions** (all three legs + allocation), **Risk** (every metric against its
warn / high / critical thresholds, oracle, breakers, alerts, on-chain risk events), **Performance**
(TVL, share price, trailing APY, PnL split, delta, drawdown, funding, leverage), **PnL** (attribution
waterfall reconciling to NAV), **Rebalancing** (trigger history and cost per rebalance), **Simulation**
(scenarios, custom shocks, Monte Carlo, optimizer), **Transactions** (deposits and withdrawals).

`make check-web` renders all ten in headless Chrome against a live API and fails on an API error, a
crash boundary or a stuck loading skeleton.

---

## Quick start

Requirements: Foundry, Node ≥ 20.9, pnpm 9, Docker.

### Option A: everything in Docker

```bash
git clone --recursive <repo> && cd <repo>
docker compose up --build
# dashboard  http://localhost:3010
# API docs   http://localhost:4010/docs
```

Compose starts Postgres and Anvil, deploys with Forge, **replays 90 days of synthetic market through the
real contracts** (~3 min) so the charts have history, then starts the API + indexer + keeper and the
dashboard.

### Option B: local processes

```bash
make install                 # submodules + pnpm workspace
make test                    # 225 contract tests
docker run -d --name dnv-pg -e POSTGRES_USER=dnv -e POSTGRES_PASSWORD=dnv -e POSTGRES_DB=dnv -p 5476:5432 postgres:16-alpine
make chain                   # Anvil on :8555 + deploy + export ABIs
make history                 # 90 days of on-chain history (optional, ~2-3 min)
make api                     # API :4010 + indexer + keeper
pnpm --filter @dnv/frontend dev   # dashboard :3010
```

### The 16-step demo (spec §27)

```bash
make demo        # isolated Anvil on :8565 → deploy → run → stop
```

Deploys mock USDC, the ETH oracle, lending market, perp market and vault; deposits $100k; allocates;
opens the hedge; runs ETH +20% and −20%; flips funding negative and back; forces a rebalance via venue
ADL; accrues a month of carry; prints the PnL attribution and risk metrics; exits through `redeem` +
`redeemWithUnwind`. Transcript: [docs/demo-output.md](docs/demo-output.md).

### Sepolia (optional)

The deploy script takes every role from the environment, so the same stack (mocks included, since
there is no real perp/lending liquidity to integrate on a testnet) deploys to Sepolia unchanged:

```bash
export DEPLOYER_PRIVATE_KEY=...        # a throwaway testnet key; never commit it
export ADMIN_ADDRESS=... GUARDIAN_ADDRESS=... KEEPER_ADDRESS=... STRATEGIST_ADDRESS=... FEE_RECIPIENT_ADDRESS=...
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast   # writes deployments/11155111.json
CHAIN_ID=11155111 RPC_URL=$SEPOLIA_RPC_URL pnpm --filter @dnv/backend start
```

The market driver and demo use Anvil-only time warps and are local by design; on Sepolia the keeper
runs in real time.

### Wallet

The dashboard ships a **demo wallet** (wagmi mock connector over Anvil's unlocked dev accounts, no
setup) and also supports MetaMask on chain 31337 at `http://127.0.0.1:8555`. The mock USDC has a faucet.

## Repository layout

```
contracts/        core/ (vault, strategy, rebalance, risk, positions, oracle, fees, emergency)
                  adapters/  access/  interfaces/  libraries/  mocks/
test/             unit/ (incl. fuzz)  invariant/  scenario/  erc4626/  gas/  utils/
script/           ProtocolDeployer.sol (shared by deploy + tests), Deploy.s.sol
simulator/        model, planner mirror, market generator, scenarios, optimizer, Monte Carlo
backend/          chain reader, indexer, snapshots, alerts, keeper, market driver, API, demo
frontend/         Next.js dashboard (10 pages)
shared/           typed ABIs + API contracts shared by backend and frontend
docs/             14 documents + openapi.json + demo transcript
scripts/          local-chain.sh, demo.sh, e2e.sh, export-abis.mjs
docker/  docker-compose.yml  Makefile  foundry.toml  .env.example
```

## What is simulated vs production-ready

| Production-shaped | Simulated |
|---|---|
| Vault, strategy, rebalancer, risk engine, oracle layer, fee maths, access control, emergency controls, adapters' strategy-facing interfaces, keeper interface (`checkUpkeep`/`performUpkeep`), indexer/API/dashboard | The lending pool, perp venue, DEX and price feeds are mocks; funding is set by a simulator, borrowers are virtual, the perp's counterparty is an LP pool, and history is generated by replaying a synthetic market through the real contracts |

## Known limitations

- Not audited; mocks instead of real venues; single asset pair; single venue per leg.
- Centralised demo keeper; ADMIN is an EOA locally (production: timelock + multisig).
- USDC assumed $1; no L2 sequencer-uptime check; the perp marks at the oracle (no basis).
- Non-upgradeable by design: fixes require migration.
- Market generator is stylised, not calibrated; APY figures describe the machinery, not mainnet.
- Venue concentration is warning-only because there is one lending venue.

## Future production integrations

1. **Lending:** an Aave V3 adapter first (the `supply`/`withdraw` ABI is already Aave's; swap the
   balance/rate views to aToken + `getReserveData`), then Compound v3 / Morpho adapters with per-venue
   caps that turn exposure into a hard limit.
2. **Long leg:** wstETH / weETH instead of WETH to add staking yield (and LST depeg monitoring).
3. **Perp:** GMX v2 (needs a pending-order state machine in `PerpAdapter` for async execution) or a
   Hyperliquid / dYdX bridge-and-operator design; derive funding and mark from the venue.
4. **Spot:** Uniswap v3 / an aggregator behind `SwapAdapter`, keeping oracle-derived min-out.
5. **Oracles:** Chainlink ETH/USD + USDC/USD with a depeg breaker, L2 sequencer-uptime feed, and a
   primary/secondary cross-check.
6. **Keepers:** Chainlink Automation or Gelato calling the existing `checkUpkeep`/`performUpkeep`, with
   `gasCostUsd` priced from the network's fee, and a watchdog on `keeper.urgent`.
7. **Governance:** ADMIN behind a TimelockController + multisig, GUARDIAN on a separate fast multisig,
   role changes monitored by the alert engine.
8. **Deployment:** an L2 (Arbitrum / Base), with the audit, bug bounty and TVL caps ramping over time.

## Documentation

[architecture](docs/architecture.md) · [strategy](docs/strategy.md) ·
[delta-neutral](docs/delta-neutral.md) · [risk-management](docs/risk-management.md) ·
[pnl-accounting](docs/pnl-accounting.md) · [rebalancing](docs/rebalancing.md) ·
[oracles](docs/oracles.md) · [security](docs/security.md) · [threat-model](docs/threat-model.md) ·
[economics](docs/economics.md) · [testing](docs/testing.md) · [simulation](docs/simulation.md) ·
[gas-report](docs/gas-report.md) · [api](docs/api.md) · [openapi.json](docs/openapi.json) ·
[demo transcript](docs/demo-output.md)
