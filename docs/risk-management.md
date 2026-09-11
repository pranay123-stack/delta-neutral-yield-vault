# Risk management

`contracts/core/RiskManager.sol` classifies the book into **NORMAL / WARNING / HIGH_RISK /
EMERGENCY**, validates every rebalance, tracks the share-price peak for drawdown, and trips the deposit
circuit breaker on EMERGENCY. The backend alert engine uses the same on-chain thresholds.

## Metrics and thresholds

Each metric has three levels. The portfolio state is the worst metric's level.

| Metric | Definition | WARNING | HIGH_RISK (hard limit) | EMERGENCY |
|---|---|---|---|---|
| Leverage | perp notional / perp equity | ≥ 2.5x | ≥ 3.5x | ≥ 5x |
| Net delta | abs(net delta) / NAV | ≥ 200 bps | ≥ 500 bps | ≥ 1,000 bps |
| Drawdown | peak share price → current | ≥ 2% | ≥ 5% | ≥ 10% |
| Liquidation distance | abs(liq price − mark) / mark | ≤ 30% | ≤ 20% | ≤ 10% |
| Collateral ratio | perp equity / maintenance margin | ≤ 6x | ≤ 4x | ≤ 2x |
| Funding | annualised funding while short | < 0% | < −10% | - |
| Venue exposure | largest single-venue share of NAV | ≥ 85% | *(capped at WARNING)* | - |
| Position size | perp notional | - | > $8M | - |
| Oracle | unhealthy while positions are open | - | HIGH_RISK | - |

Plus limits the strategy enforces on every trade: **max slippage 1%** (hard ceiling 5%) and max
position notional.

**Defaults in context.** At the 2x target, equity / MM = 1 / (2 x 5%) = 10x and the short liquidates
after a +42.9% rally. A single +20% jump with no rebalance takes the book to ~4x leverage and ~19%
from liquidation: HIGH_RISK. Scenario "ETH jump" shows the next plan is urgent and restores ~2x in one
transaction.

**Why exposure is warning-only.** With a single mock lending venue, the USDC reserve *is* concentrated
by construction. Defensive mode puts ~93% of NAV in one lending pool, and escalating that to HIGH_RISK
would fight the risk-reducing action. With several `LendingAdapter`s in production (Aave + Compound +
Morpho), this becomes a hard limit on each venue.

### Sanity bounds on configuration

`setConfig` rejects configurations that switch risk controls off: leverage high ≤ 5x, liquidation
distance high ≥ 5%, slippage 0 < x ≤ 5%, thresholds monotone, position cap > 0. A compromised or
careless admin can tighten risk freely but can't disable it. Fee caps (`FeeManager`) and rebalance
bounds (`RebalanceManager`) follow the same pattern.

## Enforcement points

| Where | What |
|---|---|
| `RiskManager.validateRebalance(pre, post)` | After every rebalance: leverage, delta, liquidation distance, collateral ratio and position size must be within the HIGH level, **or strictly better than before**. Otherwise the whole rebalance reverts. De-risking out of a bad state is always allowed; making it worse never is. |
| `RiskManager.checkpoint` | Keeper (and every rebalance): updates the peak share price, persists state, emits `RiskStateChanged`, trips the deposit breaker on EMERGENCY. |
| `RebalanceManager` urgency | Liquidation proximity or hard-limit breaches make the next plan urgent: no cooldown, no cost filter. |
| `StrategyManager` | Oracle-bounded slippage on every trade; `MAX_SLIPPAGE_BPS` hard cap. |
| `DeltaNeutralVault` | Share operations blocked while the oracle is unhealthy and positions are open; deposits blocked when paused, shut down, or over the cap. |

## Circuit breakers and emergency powers

```
RiskManager.checkpoint ─► state == EMERGENCY ─► EmergencyController.tripCircuitBreaker ─► deposits paused
Guardian ─► pauseDeposits | pauseStrategy | emergencyUnwind(minSellPrice, maxBuyPrice)
Admin    ─► unpause (not possible after shutdown)
```

- The guardian can only make the system **safer**. Unpausing needs ADMIN (intended: a timelock).
- **Withdrawals can't be paused** by anyone. They are only unavailable while NAV is unknown (oracle
  unhealthy *and* positions open), and the guardian's emergency unwind resolves that by turning
  everything into USDC.
- `emergencyUnwind` is best-effort per venue and repeatable; funds can only go back to the vault.

## Liquidation risk

`PositionManager.liquidationReport(minDistance)` exposes mark price, liquidation price, distance, safety
buffer over the configured minimum, leverage and collateral ratio. The liquidation price uses the venue
formula with pending funding included:

```
short:  P_liq = (M + s·E) / (s·(1 + mm))        long: P_liq = (s·E − M) / (s·(1 − mm))
```

Spec example (`PerpMathTest.test_liquidationPrice_specExample`): a long at $3,000 with $700 margin per
ETH liquidates at **$2,300**, a **23.3%** drop. For the strategy's 2x short: $4,285.71, 42.9% above the
entry. The fuzz test `testFuzz_liquidationPrice_isEquityEqualsMaintenance` checks the formula against
the venue's actual liquidation condition, and a boundary test checks that the mock venue flips to
liquidatable exactly there.

Alerts (`backend/src/alerts.ts`): WARNING below 30% distance, CRITICAL below 20%, with the message
naming the liquidation price and mark. `keeper.urgent` fires while an urgent plan is pending.

## Bad debt and strategy insolvency

The perp is isolated margin: if the short is liquidated beyond its margin, the venue's insurance fund
and LP pool absorb the loss (`badDebt`), and the vault's exposure is capped at its posted margin. NAV
floors perp equity at zero; the gap is reported as `badDebtAbsorbed` so the PnL still reconciles. The
invariant suite's lazy-keeper walk forces venue liquidations and checks the accounting after every
step. After a liquidation the strategy is left long-only (huge delta → urgent), and the next rebalance
sells part of the long to fund margin and re-hedges from what's left (`test_perpLiquidation_...`).

## Oracle risk

See [oracles.md](oracles.md): staleness, invalid and negative answers, incomplete rounds, consecutive-
round deviation, decimals mismatch, fallback feed, guardian shutdown.
