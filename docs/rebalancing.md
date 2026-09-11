# Rebalancing

`contracts/core/RebalanceManager.sol` decides; `contracts/core/StrategyManager.sol` executes. The
simulator's `simulator/src/planner.ts` is a line-for-line mirror used for Monte Carlo and scenarios.

## Target state

Everything derives from total NAV `N` (vault idle included):

```
reserve   R* = N · reserveBps                (defensiveReserveBps when funding APR < floor)
basis     B* = N − R*
long      L* = B* · lev / (lev + h)          (so that L* + h·L*/lev = B*)
equity    E* = h · L* / lev
short        = −h · (actual WETH held after the trade)
```

`lev` is the vol-scaled effective leverage, `h` the hedge ratio.

**Worked example (spec).** Vault $100k, target hedge $100k short, current hedge $92k: required
**+$8k short**. `DeltaCalculatorTest.test_specRebalanceExample` checks exactly this number.

## Triggers

| Bit | Trigger | Fires when |
|---|---|---|
| `DELTA` | delta outside band | abs(delta bps) > vol-scaled band (200 bps base) |
| `LEVERAGE_HIGH` / `LEVERAGE_LOW` | leverage outside band | outside effective leverage x (1 ± 25%) |
| `ALLOCATION` | long leg drifted | abs(L* − L) > 5% of NAV and ≥ min trade |
| `IDLE` | cash to deploy | vault idle ≥ $1,000 |
| `LIQUIDATION` | liquidation proximity | distance to liquidation < 30% (risk warn level) |
| `FUNDING_DEFENSIVE` | defensive delever | funding below floor and long above the defensive target |

A plan is **urgent** if liquidation distance < warn, leverage > 3.5x (the hard limit), or delta > 500
bps. Urgent plans skip the cooldown and cost filters: the point is not to get liquidated.

## Filters (non-urgent plans)

1. **Cooldown.** No trading within 1 h of the last trading rebalance. A cost-free idle sweep is still
   allowed, and a sweep does *not* reset the cooldown (otherwise a stream of deposits could starve risk
   rebalances; there's a test for this).
2. **Max cost.** Estimated fees + price impact + keeper gas must be ≤ 50 bps of NAV, from live venue
   quotes (`swapAdapter.quote`, `perpAdapter.quoteExecutionPrice`).
3. **Carry pays for cost** (re-levers only). Moving `dL` from the reserve into the basis must earn back
   the execution cost within the carry horizon (30 days):
   ```
   dL · (wethApr + h·fundingApr − (1 + h/lev)·usdcApr) · horizon  >  estimatedCost
   ```
   If it doesn't, the long-leg trade is dropped. Margin is re-sized only if *leverage itself* is out
   of band. An allocation drift whose re-lever was refused must not turn into a margin shuffle.
   That rule came from replaying a 90-day market on-chain: before it, six rebalances were $1-2k margin
   moves with leverage already inside its band. `test_carryBlockedDrift_withLeverageInBand_isNoOp`
   reproduces the old behaviour ($4,764 shuffle) and fails without the fix.

## Sizing and feasibility

When any trigger fires, the plan moves **to target**, not to the band edge. Rebalancing to the band
edge minimises traded notional per rebalance, but the book immediately sits on a boundary and
rebalances again soon; to-target trades more each time and less often. With a fixed per-trade gas cost
the latter wins for small vaults.

Cash for buys and margin comes from the withdrawable reserve, idle, sale proceeds and released margin.
If a re-lever can't be fully funded (e.g. lending utilisation has locked the reserve), the planner
solves for the largest affordable size:

```
dL + h·(L + dL)/lev − E ≤ cash    =>    dL_max = (cash + E − h·L/lev) · lev / (lev + h)
```

## Execution order

`StrategyManager.executeRebalance` raises cash before it spends it:

1. **Sell** WETH if the long shrinks → USDC float.
2. **Margin:** deposit if needed (before any short increase, so the venue's initial-margin check passes),
   or withdraw what is *currently* free above IMR.
3. **Buy** WETH if the long grows (float first, then the reserve).
4. **Re-hedge** the short to `−h x actual WETH held`. Fills are matched exactly.
5. **Withdraw** margin freed by a short reduction.
6. **Park** any float in the USDC reserve.

Every trade has an oracle-derived bound: swap min-out and perp acceptable price at `oracle ±
maxSlippageBps` (1% default, hard-capped at 5%). A manipulated DEX or venue price can't fill the
strategy worse than that.

### Crystallising PnL

After a long ETH decline almost all perp equity is *unrealised* profit on the short, and venues only
pay out cash margin. A plain "withdraw excess margin" then does nothing: before the fix, relevers
reverted (`InsufficientReserve`) and leverage-low rebalances fired every interval without effect. The
Monte Carlo found this (one path: 57 no-op rebalances), and `DeepDeclineTest` reproduces it on-chain.
The fix: when needed cash exceeds cash margin but equity has room, close and immediately reopen the
slice of the short that realises exactly the missing profit (`q = size x needed / uPnL`, +2% for fees).
Cost: two taker fees on that slice.

## The tradeoff

```
more frequent rebalancing  →  tighter delta, healthier leverage   →  more gas + fees + impact
less frequent rebalancing  →  lower costs                          →  more directional drift, closer to liquidation
```

The bands set this. Expected rebalances per year come from a closed form: between rebalances the
log-price is a driftless Brownian motion started between two barriers `−a` and `+b` (the moves that
breach the allocation or leverage band), and its expected exit time is `a·b/σ²`:

| Band setting | ETH move that triggers (up / down) | Rebalances / yr at σ = 60% | Rebalance + gas cost / yr | Est. net APY |
|---|---|---|---|---|
| Allocation 2.5%, leverage ±12.5% (tight) | +3.8% / −4.2% | 225 | 1.88% | 5.18% |
| **Allocation 5%, leverage ±25% (default)** | **+7.1% / −8.3%** | **60** | **0.70%** | **6.24%** |
| Allocation 10%, leverage ±50% (wide) | +12.5% / −16.7% | 17 | 0.30% | 6.60% |

(`estimateApy` on a $100k vault at the base market.) The wide setting earns more on paper, but the
short sits closer to liquidation between rebalances and delta is looser, which is the other half of
the tradeoff. The default keeps a +7% move from ever pushing leverage past 2.5x.

Simulated counts with a 4 h keeper (constant 60% vol, no defensive mode) come out ~64/yr against the
closed form's 60; the test suite asserts agreement within 0.7-1.6x. With realistic regime-switching
vol and funding the simulated median is 96/yr: vol clustering, vol-scaled targets and defensive round
trips all add rebalances.

What the scenarios show about *not* rebalancing:

| Scenario (30 days, $100k) | Keeper on | Keeper off |
|---|---|---|
| A. ETH +20% | min distance to liquidation **33.4%**, 5 rebalances, $109 costs | **19.2%** (HIGH_RISK) |
| F. 120% vol | min distance **42.8%**, 14 rebalances, $205 costs | **6.9%**, one bad day from liquidation |
| I. ETH +60% squeeze | 0 liquidations, max delta 9 bps | **liquidated**, max delta **8,786 bps** (naked long) |

The keeper costs a little carry in quiet markets and is what keeps the book alive in fast ones.

## Keepers

`checkUpkeep`/`performUpkeep` follow the Chainlink Automation interface. `performUpkeep` is
keeper-gated and recomputes the plan from on-chain state, so a keeper only decides *when*. Views
include the volatility observation that `performUpkeep` itself will record, so `checkUpkeep` and
`performUpkeep` always agree. Before that fix, a large move between keeper ticks could make check say
"yes" and perform revert `NothingToRebalance`, wasting a keeper transaction.

The demo keeper (`backend/src/keeper.ts`) also pokes the oracle, observes volatility, crystallises fees
daily and checkpoints the risk engine. It simulates every transaction first and sends with a 30% gas
buffer, because gas depends on the next block's timestamp: interest and funding accrual short-circuit
when `dt == 0`, as they do inside an estimate.

**Limitation:** the demo keeper is a single, centralised process with a hot key. Production would use
a decentralised network (Chainlink Automation / Gelato) calling the same functions, keeper
reimbursement priced into `gasCostUsd`, and a watchdog alerting when an urgent plan stays pending (the
alert engine already raises `keeper.urgent` / `keeper.stale`).
