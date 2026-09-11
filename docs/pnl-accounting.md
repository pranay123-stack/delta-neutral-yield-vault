# PnL accounting

## The identity

Every dollar of NAV change is attributed to exactly one line:

```
strategyNav − netCapital  ==  lendingIncomeUsdc + lendingIncomeWeth + fundingIncome
                             + spotRealized + spotUnrealized + perpRealized + perpUnrealized
                             − tradingFees − slippage + badDebtAbsorbed
```

- **strategyNav** = strategy float + USDC reserve + WETH x oracle price + max(perp equity, 0)
- **netCapital** = USDC received from the vault − USDC returned to it

`PositionManager.pnl()` computes the breakdown on-chain; `GET /vault/pnl` returns it with the residual.
It is exact up to integer rounding:

| Where checked | Residual |
|---|---|
| `invariant_pnlReconcilesToNav`, after every call of 8,192-call random sequences | ≤ 8 units x ops (USDC has 6 decimals: < $0.001) |
| `StressWalkTest`, after each of 3,000 steps incl. venue liquidations | same bound |
| 90-day on-chain replay, final snapshot | **$0.0000** |
| TS simulator, random 120-day paths with liquidations | < 1e-6 x TVL |

The vault's management and performance fees are *dilution* (new shares), so they don't change NAV;
they appear as separate lines in the API (`managementFees`, `performanceFees`, `netPnlAfterFees`).

## Conventions (and why)

### 1. Trading PnL is measured against the oracle/mark at execution

A trade's execution price differs from the fair price by fees and price impact. If cost basis used the
execution price, execution cost would hide inside "trading PnL". Instead:

- **Spot:** cost basis is booked at the *oracle mid* (`qty x oracle price`). The difference between USDC
  paid and mid value is split into the DEX fee (`tradingFees`) and the rest (`slippage`, which can be
  negative on price improvement).
- **Perp:** `PerpAdapter` tracks a second average entry at the **mark** price at each fill, alongside
  the venue's execution-price entry. Slippage per fill = abs(exec − mark) x size.
  - `perpUnrealized` = size x (mark − markEntry)
  - `perpRealized` = (venue realised + venue unrealised + cumulative slippage) − perpUnrealized

  Realised is derived as a *residual*, so it stays correct when the venue changes the position without
  the adapter (auto-deleveraging, liquidation).

Result: `spot + perp` trading PnL is pure price PnL and nets to ~0 for a delta-neutral book; costs show
up only in the cost lines.

### 2. WETH interest is income, valued at today's price

The long leg earns WETH interest in ETH. `lendingIncomeWeth` = cumulative interest qty x current
price. Spot unrealised PnL is the *residual* `longValue − costBasis − lendingIncomeWeth`, so the total
reconciles even though interest units have zero cost basis. When WETH is sold, cost basis is released
pro-rata over *all* WETH held (interest units included), i.e. interest ETH is free ETH.

### 3. Lending income is balance growth between interactions

`LendingAdapter` checkpoints its balance on every supply and withdrawal; anything the balance grew by in
between is interest (only this adapter moves principal). The view adds interest accrued since the last
checkpoint, so income is continuous.

### 4. Funding

`fundingIncome` = funding the venue has settled into margin + funding pending since the last settlement.
Positive = received. The venue rounds against the account (payments down, charges up), so the vault
never books funding it can't collect.

### 5. Bad debt

If the short is liquidated beyond its margin, the venue absorbs the shortfall. Venue PnL lines include
the full loss, NAV floors equity at zero, and `badDebtAbsorbed` carries the difference, so the identity
still holds. If equity is negative but not yet liquidated, the (floored) gap is reported the same way.

### 6. Exit costs are borne by the exiting user

`redeemWithUnwind` burns shares at full NAV, then unwinds fraction `f` of both legs and releases
margin such that exactly `(1 − f)` of the *pre-exit* equity stays. The hedge-close fee and slippage come
out of the exiting user's proceeds, not the remaining holders'. A test found the first version got this
wrong: it released `f x equity` measured *before* the close, so remaining holders paid ~4 bps of every
exit. `test_redeemWithUnwind_exitingUserPaysOwnCost` now pins the remaining holder's value to within
0.02%.

Entry costs are socialised: deposits sit idle until the keeper deploys them in a batch, and that
batch's trading cost is shared by everyone. This is cheaper overall than per-deposit trading and is
bounded by the max-cost filter. The optional withdrawal fee (0 by default, capped at 1%) is the lever
if churning depositors ever become a problem; it stays in the vault for remaining holders.

## Worked example (from the demo)

Alice deposits $100k, and over 41 chain days the book goes through ETH +20%, ETH −20%, a
negative-funding regime (defensive delever + re-lever), a venue ADL and a month of carry.
Attribution at the end of step 14 is in [demo-output.md](demo-output.md); the key property is that
the price-PnL lines nearly cancel (the hedge works) while income and cost lines explain the result,
and the reconciliation residual is ~$0.

## Where to look

| Code | What |
|---|---|
| `contracts/core/PositionManager.sol` `pnl()` | on-chain breakdown |
| `contracts/core/StrategyManager.sol` `_buyWeth` / `_recordSale` | spot cost basis, fees, slippage |
| `contracts/adapters/PerpAdapter.sol` `trade` | mark entry + slippage |
| `contracts/adapters/LendingAdapter.sol` `_checkpoint` | interest |
| `backend/src/views.ts` `pnlView` | API view incl. residual |
| `simulator/src/model.ts` `pnlBreakdown` | the same identity in the float model |
