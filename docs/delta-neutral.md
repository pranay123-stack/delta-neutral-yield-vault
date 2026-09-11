# Delta neutrality

## Definitions

`contracts/libraries/DeltaCalculator.sol` computes, from a `PositionSnapshot`:

| Quantity | Definition |
|---|---|
| long exposure | WETH held (supplied + float) x oracle price |
| short exposure | abs(perp size) x oracle price |
| gross exposure | long + short |
| net delta (qty) | WETH qty + perp size (perp size is negative for a short) |
| net delta (USD) | net delta qty x oracle price |
| **delta bps** | net delta USD / **total NAV** x 10,000 |
| hedge ratio | abs(short qty) / long qty |
| target perp size | −long qty x hedgeRatio |
| required change | target − current perp size |

Spec example, reproduced by `DeltaCalculatorTest.test_specExample`: long +10 ETH, short −9.8 ETH →
net +0.2 ETH; at $3,000 that is +$600, and on a $50k NAV **+120 bps**. Required hedge change: sell 0.2
ETH more. The "$100k target vs $92k current → +$8k short" example is `test_specRebalanceExample`.

### Why delta is measured against NAV

Two choices were possible: delta relative to the hedged position (0.2 / 10 = 2%) or relative to NAV.
The risk limits use **NAV**, because that is what a depositor's share price is exposed to: at +200
bps, a 10% ETH move changes the share price by 0.2%, whatever the book's size. With the long leg at
~60% of NAV, the 200 bps band corresponds to ~3.3% of the hedged position.

### Why both legs are valued at the oracle price

The short could be valued at the perp's mark, but then a mark/index basis would look like directional
exposure and trigger hedge trades that do nothing. Both legs use the same oracle price; basis risk is
tracked separately as PnL.

## Why delta drifts at all

In this design the long and short are both in ETH units, so a price move doesn't create delta by
itself. It creates *leverage* drift (the short's margin shrinks as ETH rises) and *allocation* drift
(the long leg grows as a share of NAV). Delta itself drifts from:

1. **WETH lending interest.** The long grows by the WETH supply rate (~1.9%/yr) while the short stays
   fixed. Slow, predictable, corrected at every rebalance.
2. **Venue events.** Auto-deleveraging or partial liquidation of the short removes hedge without the
   vault acting. Scenario "venue ADL" cuts the hedge 12%: delta jumps above the 500 bps hard limit, the
   next plan is flagged urgent and bypasses the cooldown, and delta is back to ~0 bps after one
   rebalance.
3. **Execution mismatch.** A swap fills a slightly different quantity than planned. The strategy
   removes this by construction: it re-hedges to `−hedgeRatio x actual WETH held` *after* the swap,
   not to a pre-computed number.
4. **Deliberate tilts.** The strategist may set the hedge ratio anywhere in 90-110%.

## Tolerance band

```
effectiveBand = deltaBand · volRef / max(vol, volRef)     floored at deltaBand / 4
```

- Default `deltaBand` = 200 bps; floor 50 bps.
- In calm markets (vol ≤ 60%) the band is 200 bps; at 120% vol it tightens to 100 bps. The same delta
  produces twice the PnL variance when vol doubles, so the tolerance halves.
- The risk engine has separate levels: WARNING at 200 bps, HIGH_RISK (hard limit) at 500 bps, EMERGENCY
  at 1,000 bps. A rebalance may never *end* above 500 bps unless it strictly reduced delta
  (`RiskManager.validateRebalance`).

All thresholds are configurable: band and rebalance parameters by ADMIN
(`RebalanceManager.setParams`), risk levels by ADMIN (`RiskManager.setConfig`), each within
compile-time sanity bounds.

## Evidence

| Test | What it shows |
|---|---|
| `SmokeTest.test_bootstrap_opensDeltaNeutralBasis` | fresh deployment: delta 0 bps, 2.00x |
| `MarketScenariosTest` A/B/C | ETH ±20% and −40% with the keeper: delta stays inside ±200 bps |
| `RebalanceManagerTest.testFuzz_postRebalanceDeltaWithinLimit` | any price move ±30%, any gap: after a successful rebalance delta ≤ 500 bps |
| `ProtocolInvariantsTest.invariant_rebalancesRespectRiskLimits` | across 8,192 random calls per run, no rebalance ends outside limits while making things worse |
| `StressWalkTest` (3,000 steps) | worst post-rebalance delta observed: **149 bps** |
| 90-day on-chain replay | worst snapshot delta: **2 bps** |
