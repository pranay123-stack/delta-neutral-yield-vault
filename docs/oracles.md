# Oracles

`contracts/core/OracleManager.sol` wraps Chainlink-style `AggregatorV3Interface` feeds and returns a
validated price normalised to 18 decimals.

## Validation pipeline

For the primary feed, then the secondary if the primary fails:

| # | Check | Status on failure |
|---|---|---|
| 1 | `latestRoundData()` must not revert | `FEED_FAILURE` |
| 2 | `decimals()` must equal the configured decimals (catches feed migrations) | `DECIMALS_MISMATCH` |
| 3 | `answer > 0` (negative / zero answers) | `INVALID_PRICE` |
| 4 | `updatedAt` non-zero and not in the future | `INVALID_PRICE` |
| 5 | `answeredInRound >= roundId` | `INCOMPLETE_ROUND` |
| 6 | `now − updatedAt <= heartbeat` (1 h default, max 2 days) | `STALE` |
| 7 | abs(answer − previous round) / previous round ≤ maxDeviation (20% default) | `DEVIATION` |

Primary OK → `OK`. Primary failed, secondary OK → `FALLBACK` (usable). Both failed → the primary's
reason. The guardian can shut the oracle down entirely (`SHUTDOWN`); only ADMIN can restore it.

### The deviation check is stateless (Liquity-style)

Check 7 compares **consecutive rounds of the feed itself** rather than the last price the protocol
stored. A single manipulated or fat-fingered round is rejected, and a genuine move is accepted as soon
as the next round confirms it (`test_extremeJump_rejectedUntilConfirmed`). Nothing needs to be poked
for the check to work, and there's no stored price that can go stale and block legitimate updates.
If the previous round can't be read (new aggregator phase) the check is skipped rather than bricking
the feed; staleness and sanity checks still apply.

## Consumers

| API | Reverts? | Used by |
|---|---|---|
| `getPrice(asset)` | yes, unless OK/FALLBACK | every trade bound in `StrategyManager`, vol observation |
| `tryGetPrice(asset)` | no, returns `(price, status)` | vault `isOperational`, monitoring, alerts |
| `getPriceOrLastGood(asset)` | no, last good price if unhealthy | **valuation only**: `totalAssets()` must not revert (ERC-4626) |
| `poke(asset)` | no, records the price as last good if healthy | keeper, every tick |

The rule: the last good price may be used to *display* NAV, never to *act* on it. While the oracle is
unhealthy and positions are open, the vault reports `maxDeposit = maxWithdraw = maxRedeem = 0` and
`deposit`/`redeemWithUnwind` revert, and no rebalance can trade. If a feed is permanently broken the
guardian's `emergencyUnwind(minSellPrice, maxBuyPrice)` exits with explicit price bounds; after that,
NAV is pure USDC and needs no oracle.

## Decimal normalisation

`value x 10^(18 − d)` for d < 18, `value / 10^(d − 18)` for d > 18. Tested with 8-, 18- and
20-decimal feeds (`test_normalises18And20DecimalFeeds`). A feed whose decimals don't match its config is
rejected at configuration time *and* at read time.

## Test matrix (`test/unit/OracleManager.t.sol`, 24 tests)

stale price, exactly-at-heartbeat freshness, zero price, negative price, future timestamp, incomplete
round, +30% jump rejected then confirmed, −50% crash rejected, decimals mismatch (read time and config
time), feed revert, fallback when primary fails, both bad, not configured, guardian shutdown / admin
restore asymmetry, random user can't shut down, poke records last good, poke never records a bad price,
admin-only configuration, config bounds, plus fuzz tests for normalisation and the exact deviation
boundary.

System-level: scenario G (oracle stale) blocks share operations and trading and recovers automatically
on the next fresh round; the risk engine flags `ORACLE` as HIGH_RISK while exposed; the alert engine
raises `oracle.health` (WARNING for fallback, CRITICAL otherwise).

## Gas-griefing hardening

Every try/catch fallback (feed calls here, venue reads in `PositionManager`/`StrategyManager`) is
wrapped with `GasGuard.checkNotStarved`: if the callee failed because it was starved of gas (EIP-150
forwards only 63/64) rather than genuinely reverting, the whole call reverts instead of taking the
fallback. Otherwise a caller could pick a gas limit that makes the previous-round read fail and skip the
deviation check. `test/unit/GasGriefing.t.sol` scans every gas limit in a window for `totalAssets` and
`deposit` and asserts that any successful call returns exactly the full-gas result. Today there is no
reachable window even without the guard (the remaining work after each catch costs far more than 1/63
of the starved call); the guard and the scans exist so a future, more expensive integration can't open
one silently.

## Production notes

- Add an L2 **sequencer-uptime** feed check (Arbitrum/Base/Optimism) with a grace period after restart.
- Price USDC with its own feed and add a depeg breaker; this demo assumes 1 USDC = $1.
- Consider a TWAP or second-source cross-check between primary and fallback instead of plain failover.
- Perp venues mark with their own index; monitor mark−oracle basis as a separate risk metric.
