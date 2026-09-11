# Testing

| Layer | Framework | Tests | Command |
|---|---|---|---|
| Contracts | Foundry | **225** (unit, fuzz, invariant, scenario, ERC-4626 properties, resilience, gas, stress) | `forge test` |
| Simulator | Vitest | **24** (incl. on-chain parity) | `pnpm --filter @dnv/simulator test` |
| Backend | Vitest | **22 unit + 27 integration** | `pnpm --filter @dnv/backend test` (integration: `INTEGRATION=1`) |
| Frontend | tsc + next build + Playwright | typecheck, production build of 10 routes, every page rendered against a live API (fails on an API error, a crash boundary or a stuck skeleton), and a **browser depositor flow** that sends real transactions through wagmi | `make test-ts`, `make check-web` |
| System | scripts | 90-day on-chain replay, 16-step demo, fresh-chain e2e (optionally including the browser stage) | `make history`, `make demo`, `make e2e`, `E2E_BROWSER=1 ./scripts/e2e.sh` |

## Contract suite

| Suite | Tests | What it covers |
|---|---:|---|
| `ERC4626PropertiesTest` | 26 | a16z ERC-4626 property suite **with fees on and zero tolerance**: previews, max functions, round trips, allowances |
| `DeltaNeutralVaultTest` | 26 | first depositor, multiple depositors, previews = actuals, profit, loss, rounding direction, inflation attack (+fuzz), deposit cap, liquidity-bounded max withdraw, pauses, oracle gating, allowances, withdrawal fee, `redeemWithUnwind` |
| `OracleManagerTest` | 24 | stale, zero, negative, future, incomplete round, jump rejected then confirmed, crash, decimals mismatch (read + config), feed revert, fallback, shutdown asymmetry, last good price, config bounds, fuzz |
| `RebalanceManagerTest` | 17 | triggers, no-trade band, cooldown vs urgent, idle sweep in cooldown, carry filter, carry-blocked drift no-op, defensive mode, vol observation + scaling, strategist bounds, keeper gating, fuzz: post-rebalance delta ≤ limit |
| `MockPerpetualMarketTest` | 16 | fills, PnL signs, funding both directions + settlement, IMR, price limit, flip, liquidation-price boundary, bad debt, ADL, fuzz: funding = size x rate x mark x dt / 8h for any rate/period, conservation fuzz |
| `StrategyManagerTest` | 14 | access control, adapter binding, slippage cap, execution, reserve shortfall, oracle-bounded fills, liquid withdrawals, accounting, best-effort emergency unwind |
| `MarketScenariosTest` | 13 | spec scenarios A-H + ETH jump, venue ADL, venue liquidation, emergency unwind, exit fairness |
| `GasBenchmarksTest` | 13 | gas for every operation ([gas-report.md](gas-report.md)) |
| `RiskManagerTest` | 12 | state escalation, circuit breaker, peak/drawdown, funding, oracle, exposure, validate (worsening vs improving), size cap, config bounds |
| `ProtocolInvariantsTest` | 11 | invariants below |
| `MockLendingProtocolTest` | 11 | kinked curve, accrual, liquidity-limited withdrawal, solvency, fuzz: interest matches supplyRate(U) x t for any utilisation/period, no profit from rounding |
| `FeeManagerTest` | 9 | 0.5%/yr management fee, path independence, performance fee on gains only, HWM after loss, caps, preview includes pending fees, fee totals, fuzz: fees ≤ caps |
| `PerpMathTest` / `DeltaCalculatorTest` | 12 | spec examples (+0.2 ETH delta, +$8k hedge, $3,000 → $2,300 liquidation at 23.3%), liquidation price = MMR boundary (fuzz), realised PnL (fuzz), vol-scaled band |
| `EmergencyControllerTest` / `AccessControlMatrixTest` | 10 | pause asymmetry, breaker gating, terminal shutdown, guardian can't redirect funds, every privileged function rejects an outsider, one-tx role rotation |
| `DeepDeclineTest` | 1 | regression for PnL crystallisation (a 60% decline without no-op churn) |
| `GasGriefingTest` | 2 | every gas limit in a window: success ⇒ identical result |
| `ResilienceTest` | 4 | both feeds dead with open positions: `totalAssets`, snapshot, risk, PnL views still answer at the last good price while share operations are blocked; perp venue unreadable but oracle healthy; **lending venue unreadable** (NAV falls back to the adapter checkpoint, quoted liquidity collapses to the float); **non-monotonic clock** (a call served before the last venue checkpoint) |
| `StressWalkTest` | 2 | 3,000-step random walk; lazy-keeper walk that forces venue liquidations |
| `SmokeTest` | 2 | bootstrap book, 7-day PnL reconciliation |

Fuzz: 512 runs by default, 5,000 under `FOUNDRY_PROFILE=deep`.

## Invariants (`test/invariant/ProtocolInvariants.t.sol`)

A handler drives 16 actions: deposit, withdraw, redeem, redeemWithUnwind, withdraw-over-limit probe,
price moves (±10% per round, inside the oracle guard), funding ±0.05%/8h, lending utilisation 0-95%,
time warps up to 2 days, keeper rebalance, volatility observation, fee accrual, risk checkpoint, venue
liquidation, venue ADL, and unauthorised rebalance attempts. The default profile runs 128 sequences
x 64 calls per invariant (8,192 calls each), with zero reverts.

| Invariant | Spec requirement |
|---|---|
| `invariant_assetsEqualSumOfLegs`: vault = idle + strategy NAV; NAV = float + reserve + long + perp equity | vault assets = idle + lending + strategy assets + PnL |
| `invariant_pnlReconcilesToNav`: NAV − net capital = attributed PnL (± rounding) | realised/unrealised PnL accounting |
| `invariant_sharesBacked`: supply = sum of balances; supply ⇒ assets | shares can't go negative / unbacked |
| `invariant_maxWithdrawWithinLiquidity` + over-limit probe never succeeds | vault can't withdraw more than available |
| `invariant_rebalancesRespectRiskLimits`: no rebalance ends beyond delta/leverage/size limits while making it worse | leverage ≤ max; delta within limits after a successful rebalance; position ≤ limits |
| `invariant_positionSizeWithinCap` | position size ≤ strategy limits |
| `invariant_feesWithinCaps` | fees ≤ configured limits |
| `invariant_unauthorizedNeverRebalances` | unauthorised accounts can't rebalance |
| `invariant_perpVenueConservation`, `invariant_lendingVenueSolvent` | liquidation can't leave accounting inconsistent |
| `invariant_noStrandedFunds`: adapters and strategy never hold idle tokens | adapter safety |

`StressWalkTest` asserts the core invariants after *every* step: 3,000 steps with 235 executed
rebalances (worst post-rebalance delta 149 bps), and a lazy-keeper walk that produces real venue
liquidations.

## Simulator suite

- **On-chain parity:** the initial deployment reproduces the Foundry smoke test's NAV, long value, perp
  equity and perp size to within 0.005%; 7-day funding and lending income to within 1%; the rate model
  and liquidation price exactly.
- Attribution reconciles on random paths with liquidations (< 1e-6 x TVL); fees are pure dilution.
- Scenario properties: price moves don't move NAV; the keeper keeps liquidation distance healthy; the
  squeeze liquidates without a keeper and not with one; defensive mode helps under negative funding.
- APY engine: decomposition identities; the closed-form rebalance frequency agrees with simulation
  within 0.7-1.6x; the optimizer returns the feasible maximum; Monte Carlo is deterministic with ordered
  percentiles.
- Regression: a deep decline doesn't cause no-op churn.

## Backend suite

- **Views on real state:** `test/fixtures/raw-state.json` is a full `RawState` captured from the chain
  after the 90-day replay (`src/tools/captureFixture.ts`). Tests check unit conversion, that legs sum
  to NAV, net delta = long − short, PnL reconciliation, the HWM unit conversion and sentinel handling
  (uint256.max → null).
- **Alert rules:** every rule's warning and critical branch.
- **Performance maths:** annualisation, trailing APY, drawdown, volatility, Sharpe.
- **Integration** (`INTEGRATION=1`, needs Anvil + Postgres): every spec endpoint returns 200, metrics
  are consistent, PnL reconciles through the API, history exists, POST/GET `/simulation` round trip,
  invalid input → 400 (including a custom scenario missing its required fields), windowed performance
  keeps trailing APYs defined from its first point, the optimizer's `current` equals the live estimate,
  exact delta agrees with the on-chain integer, alerts carry units and risk events decoded flags, and the
  OpenAPI document covers every endpoint.
- **Gas headroom vs a real node** (`gasHeadroom.integration.test.ts`, only on the throwaway e2e chain):
  for deposit, withdraw, redeem and `redeemWithUnwind`, the node's estimate is taken right after a block
  that wrote the accrual checkpoints, and the transaction is sent with `withGasHeadroom(estimate)` so it
  lands exactly one second later - it must succeed. This is the race behind bug 10; each probe is undone
  with `evm_snapshot` / `evm_revert`.

## Browser checks (`make check-web`)

Two things a typecheck and a production build cannot prove: that the pages actually render live data,
and that the wallet wiring actually moves money.

1. `scripts/check-frontend.sh` renders all 10 routes in headless Chrome against a running API and fails
   on an API error, a crash boundary or a stuck loading skeleton.
2. `frontend/e2e/vault-flow.spec.ts` (Playwright, driving the system Chrome - no browser download)
   walks one depositor session against the local Anvil: connect a demo wallet → faucet → approve +
   deposit → withdraw → an over-limit withdrawal that must be **refused at simulation with a decoded
   `ERC4626ExceededMaxWithdraw`** → `redeemWithUnwind` of exactly the shares the test minted. Every
   assertion is on the *change* a step caused, so it does not depend on replay history, and the run
   fails on any uncaught client-side error.

Verified against the chain rather than the UI's own numbers: one run advanced the chain by exactly 4
blocks (the approve was already unlimited), moved the wallet's USDC by +25,000.00 net and returned its
share balance to within 0.00005 dnUSDC of where it started - and the rejected withdrawal mined nothing.

Both need a running stack. Locally that is `make chain && make history && make api && make web`, then
`make check-web`. **In CI they run too**: `E2E_BROWSER=1 ./scripts/e2e.sh` builds the dashboard against
its own isolated chain/DB, serves it, and runs both checks - so a regression in the write path fails
the build, and a failed run uploads the Playwright trace as an artifact.

## Coverage

`forge coverage --no-match-path "test/invariant/*" --ir-minimum` (the invariant suites are excluded
because they dominate runtime; they exercise the same code paths). Production contracts only:

| Contract | Lines | Statements | Branches |
|---|---|---|---|
| `core/DeltaNeutralVault.sol` | 91.4% (159/174) | 90.3% | 70.4% |
| `core/StrategyManager.sol` | 92.6% (239/258) | 93.3% | 72.7% |
| `core/RebalanceManager.sol` | 91.5% (214/234) | 88.7% | 78.0% |
| `core/RiskManager.sol` | 97.4% (114/117) | 94.4% | 69.0% |
| `core/OracleManager.sol` | 87.3% (69/79) | 94.0% | 81.5% |
| `core/PositionManager.sol` | 85.6% (83/97) | 87.0% | 54.5% |
| `core/FeeManager.sol` | 94.3% (50/53) | 90.3% | 71.4% |
| `core/EmergencyController.sol` | 91.2% (31/34) | 87.5% | 83.3% |
| `adapters/` (lending, perp, swap) | 85.7% / 89.1% / 76.5% | 88.5% / 90.9% / 80.0% | 80% / 67% / 50% |
| `access/` (registry, auth) | 100% | 90-100% | 67-100% |
| `libraries/` (DeltaCalculator, PerpMath, GasGuard) | 100% | 75-100% | 0-100% |
| **Total incl. mocks and deploy script** | **84.4%** (1,712/2,029) | 84.4% | 66.1% |

The uncovered remainder is dominated by defensive branches that are unreachable in tests by
construction: `GasGuard`'s starvation revert (no reachable window today - see
[security.md](security.md)), venue try/catch fallbacks that need a venue to fail *and* enough gas, and
the deploy script (`script/Deploy.s.sol`, exercised by `scripts/e2e.sh` rather than by `forge test`).
Branch coverage is the weakest number and honestly so: many branches are `x > y ? a : b` guards on
values a test would have to construct adversarially.

## Running it all

```bash
forge test                                   # 225 contract tests
FOUNDRY_PROFILE=deep forge test              # heavier fuzzing
pnpm --filter @dnv/simulator test
pnpm --filter @dnv/backend test
./scripts/e2e.sh                             # fresh chain + DB, replay, integration tests
E2E_BROWSER=1 ./scripts/e2e.sh               # ... plus the dashboard and the browser depositor flow
make check-web                               # browser checks against an already-running stack
```
