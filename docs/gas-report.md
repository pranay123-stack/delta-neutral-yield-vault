# Gas report

## Method

`test/gas/GasBenchmarks.t.sol` measures each user- and keeper-facing operation against a **running
book** ($1M deployed, positions open, fees on), the state real users hit, not an empty vault. Numbers
are from Foundry's `--isolate` mode, where each top-level call is its own transaction: cold storage,
cold accounts, the 21k intrinsic cost included. Without `--isolate` a test's earlier calls warm
storage and flatter every later measurement.

```
forge test --match-contract GasBenchmarksTest --gas-report --isolate     # make gas
forge snapshot --match-contract GasBenchmarksTest --isolate              # .gas-snapshot
```

## Results (isolated transactions, median)

| Operation | Before | After | Δ |
|---|---:|---:|---:|
| `deposit` | 360,809 | **247,827** | −31.3% |
| `mint` | 404,115 | **246,229** | −39.1% |
| `withdraw` | 368,162 | **265,942** | −27.8% |
| `redeem` | 374,909 | **255,826** | −31.8% |
| `redeemWithUnwind` (trades on 3 venues) | 893,426 | **816,912** | −8.6% |
| `accrueFees` (fee collection) | 226,485 | **209,299** | −7.6% |
| `performUpkeep` (rebalance) | 1,355,046 | **1,217,950** | −10.1% |
| `riskManager.checkpoint` | 365,088 | **321,791** | −11.9% |
| `rebalancer.setTargets` (strategy update) | 38,111 | 38,111 | 0 |
| `checkUpkeep` (view, off-chain) | 341,590 | 345,463 | +1.1% (reads `gasCostUsd`) |
| `vault.totalAssets` (view, cold) | 143,536 | 144,281 | - |

`performUpkeep` ranges from 992,262 (deploy idle capital) to 1,217,950 (sell + margin + re-hedge after
a price move).

The "After" column includes the venue-failure fallbacks added later (try/catch around every lending
read, mirroring the perp leg): those cost **+439 gas on `totalAssets`** and +567 on a deposit, ~0.2%.

## Where the gas goes

A single **cold NAV valuation costs ~133k gas**: the oracle (3 feed calls: `latestRoundData`,
`decimals`, previous round), the lending pool (2 balance reads with interest projection), the perp venue
(position, equity with a funding-index projection and 2 more feed reads) and 5 adapter hops. That is
the price of a **live mark-to-market NAV across three venues**. Most of it is in the mock venues'
view code, which is representative in shape but not in exact cost of Aave/GMX/Chainlink.

Before optimisation, a deposit walked that NAV path **three to four times**: fee accrual, `maxDeposit`,
`previewDeposit` (twice via the fee-share preview) and `isOperational` (which validated the oracle a
second time).

## Optimisations applied

### 1. Transient-storage pricing window (EIP-1153), deposit −31%, mint −39%

Each entry point opens a window: **one** `strategy.valuation()` call returns NAV, price dependence and
oracle health together; fees crystallise against that NAV; NAV and operational status are cached in
Solidity 0.8.28 `transient` variables for the limit check and preview; the window closes before any
token moves.

```solidity
uint256 private transient _navCache;   // totalAssets + 1 while open
uint256 private transient _opCache;    // 1 = not operational, 2 = operational
bool    private transient _feesSettled; // pending fee shares are 0 inside the window
```

**Security consideration.** A cache that outlived the pricing phase would let an external view (e.g. a
read-only-reentrancy probe inside a token transfer) see a stale NAV next to an updated supply. The
window is therefore closed *before* `_deposit`/`_withdraw`, and the a16z ERC-4626 property suite (exact
previews, `_delta_ = 0`) runs against the optimised code.

### 2. One-pass valuation, a further ~15k per user operation

`StrategyManager.valuation()` returns `(nav, priceDependent, priceHealthy)` in a single pass instead of
separate `totalAssets()` and `isPriceDependent()` calls, which read the oracle twice.

### 3. Snapshot reuse in rebalance, `performUpkeep` −10%, `checkpoint` −12%

- `validateRebalance` no longer computes drawdown (it doesn't use it). Drawdown needs the share
  price, which is another full NAV walk.
- The post-rebalance risk checkpoint takes the snapshot `performUpkeep` already built
  (`checkpointWith(post)`, RebalanceManager-only) instead of re-reading every position.
- `checkpoint` computes the share price once instead of twice.

### 4. Structural choices made up front

- **Standing approvals** from adapters to their venues (set once in the constructor): saves an
  approval (~22-46k) per supply/swap/margin deposit. The venues are the trusted counterparties the
  adapter exists to talk to.
- **Idle deposits are batched.** Deposits don't touch the strategy; the keeper sweeps idle once per tick.
- **`ReentrancyGuardTransient`** everywhere: ~2.1k cheaper per guarded call than the storage guard.
- **Custom errors, immutables, packed config structs** (`uint32` bps fields). No `unchecked` blocks:
  checked arithmetic plus `SafeCast` was kept everywhere, because the savings would be small next to
  the external-call cost that dominates every path.

## Optimisations considered and rejected

| Idea | Saving | Why not |
|---|---|---|
| **Cached NAV with periodic reports** (Yearn V3 style: vault stores `totalDebt`, strategy reports PnL) | ~130k per deposit/withdraw | Reintroduces a discrete NAV jump at report time. That's sandwichable unless profit is time-locked, and a stale price makes entry/exit unfair between reports. Live NAV is the more defensible design for a delta-neutral book whose NAV moves every block with funding. |
| Skip the `decimals()` check on every oracle read | ~2.6k (cold) | It detects feed migrations that silently change decimals: a mis-scaled price is catastrophic. |
| Skip the previous-round deviation read | ~5k | It is the manipulation guard. |
| Call venues directly instead of through adapters | ~5-8k per leg | The adapter is the integration seam; removing it couples the strategy to one venue's ABI. |
| Upgradeable proxies to "save deployment gas" | - | Adds admin risk; immutability is a security feature here. |

## Keeper economics

A trading rebalance is ~1.0-1.2M gas. At ~60 rebalances/yr (default bands, 60% vol):

| Chain | Gas price assumption | Per rebalance | Per year |
|---|---|---|---|
| Ethereum L1 | 20 gwei, ETH $3,000 (1.2M gas = 0.024 ETH) | ~$72 | ~$4,300 |
| L2 (Arbitrum/Base) | ~$0.01-0.1 per 1M gas + L1 data | ~$0.1-5 | ~$6-300 |

On L1, keeper gas alone would consume ~4.3% of a $100k vault's NAV per year (most of its yield), so
the deployment target is an L2. `Params.gasCostUsd` makes the planner gas-aware: it's included in every rebalance's estimated
cost, so on an expensive chain the cost filter automatically trades less often.

## Snapshot

`.gas-snapshot` (checked in) pins these benchmarks; a gas regression shows up as a diff in review.
