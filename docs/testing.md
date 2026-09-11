# Testing

| Layer | Framework | Tests | Command |
|---|---|---|---|
| Contracts | Foundry | **219** (unit, fuzz, invariant, scenario, ERC-4626 properties, gas, stress) | `forge test` |
| Simulator | Vitest | **24** (incl. on-chain parity) | `pnpm --filter @dnv/simulator test` |
| Backend | Vitest | **22 unit + 20 integration** | `pnpm --filter @dnv/backend test` (integration: `INTEGRATION=1`) |
| System | scripts | 90-day on-chain replay, 16-step demo | `make history`, `make demo` |

## Contract suite

| Suite | Tests | What it covers |
|---|---:|---|
| `ERC4626PropertiesTest` | 26 | a16z ERC-4626 property suite **with fees on and zero tolerance**: previews, max functions, round trips, allowances |
| `DeltaNeutralVaultTest` | 26 | first depositor, multiple depositors, previews = actuals, profit, loss, rounding direction, inflation attack (+fuzz), deposit cap, liquidity-bounded max withdraw, pauses, oracle gating, allowances, withdrawal fee, `redeemWithUnwind` |
| `OracleManagerTest` | 24 | stale, zero, negative, future, incomplete round, jump rejected then confirmed, crash, decimals mismatch (read + config), feed revert, fallback, shutdown asymmetry, last good price, config bounds, fuzz |
| `RebalanceManagerTest` | 17 | triggers, no-trade band, cooldown vs urgent, idle sweep in cooldown, carry filter, carry-blocked drift no-op, defensive mode, vol observation + scaling, strategist bounds, keeper gating, fuzz: post-rebalance delta ≤ limit |
| `MockPerpetualMarketTest` | 15 | fills, PnL signs, funding both directions + settlement, IMR, price limit, flip, liquidation-price boundary, bad debt, ADL, conservation fuzz |
| `StrategyManagerTest` | 14 | access control, adapter binding, slippage cap, execution, reserve shortfall, oracle-bounded fills, liquid withdrawals, accounting, best-effort emergency unwind |
| `MarketScenariosTest` | 13 | spec scenarios A-H + ETH jump, venue ADL, venue liquidation, emergency unwind, exit fairness |
| `GasBenchmarksTest` | 13 | gas for every operation ([gas-report.md](gas-report.md)) |
| `RiskManagerTest` | 12 | state escalation, circuit breaker, peak/drawdown, funding, oracle, exposure, validate (worsening vs improving), size cap, config bounds |
| `ProtocolInvariantsTest` | 11 | invariants below |
| `MockLendingProtocolTest` | 10 | kinked curve, accrual, liquidity-limited withdrawal, solvency, fuzz |
| `FeeManagerTest` | 9 | 0.5%/yr management fee, path independence, performance fee on gains only, HWM after loss, caps, preview includes pending fees, fee totals, fuzz: fees ≤ caps |
| `PerpMathTest` / `DeltaCalculatorTest` | 12 | spec examples (+0.2 ETH delta, +$8k hedge, $3,000 → $2,300 liquidation at 23.3%), liquidation price = MMR boundary (fuzz), realised PnL (fuzz), vol-scaled band |
| `EmergencyControllerTest` / `AccessControlMatrixTest` | 10 | pause asymmetry, breaker gating, terminal shutdown, guardian can't redirect funds, every privileged function rejects an outsider, one-tx role rotation |
| `DeepDeclineTest` | 1 | regression for PnL crystallisation (a 60% decline without no-op churn) |
| `GasGriefingTest` | 2 | every gas limit in a window: success ⇒ identical result |
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
  invalid input → 400, and the OpenAPI document covers every endpoint.

## Running it all

```bash
forge test                                   # 219 contract tests
FOUNDRY_PROFILE=deep forge test              # heavier fuzzing
pnpm --filter @dnv/simulator test
pnpm --filter @dnv/backend test
./scripts/e2e.sh                             # fresh chain + DB, replay, integration tests
```
