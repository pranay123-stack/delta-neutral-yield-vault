# Economics

## Who earns what

| Party | Earns | Pays |
|---|---|---|
| Depositors | lending interest + funding − costs − fees, in share-price growth | entry (socialised, batched) and their own exit costs |
| Fee recipient | management fee 0.5%/yr on AUM + 10% of gains above the HWM, as newly minted shares | nothing |
| Keeper | nothing on-chain in this demo (production: Automation fee / reimbursement, priced via `gasCostUsd`) | gas |
| Venues | taker fees, DEX LP fees, lending reserve factor | interest, funding |

## Fees

All fee rates are capped by **compile-time constants** in `FeeManager`: an admin can lower or raise
them only within the caps.

| Fee | Default | Cap | Mechanism |
|---|---|---|---|
| Management | 0.50% / yr | 2% | time-based; `shares = S · f / (1 − f)`, f = rate x dt/yr, so the recipient gets exactly fraction f of the vault |
| Performance | 10% of gains | 20% | only on share-price gains above the **high-water mark** |
| Withdrawal | 0% | 1% | taken on standard exits; stays in the vault (benefits remaining holders) |
| Trading costs | at cost | - | fees + impact + gas paid to venues, never a protocol margin |

### High-water mark

```
pps  = A / S'               (S' = supply after the management-fee dilution, virtual shares included)
if pps > hwm:
    feeAssets  = (pps − hwm) · S' · perfBps
    perfShares = feeAssets · S' / (A − feeAssets)
    hwm        = A / (S' + perfShares)     (post-fee share price)
```

- After a loss the HWM stays put: **no performance fee until depositors are made whole**
  (`test_performanceFee_highWaterMark_noFeeOnRecovery`).
- The performance fee is charged on gains **net of** the management fee.
- The management fee is charged on AUM *at accrual time*. Because fees crystallise on every deposit,
  withdrawal and daily keeper tick, this is effectively time-weighted.
- **Fees are measured on the same virtual-share price that conversions use.** The first version used
  raw assets/supply. In high-yield states the gap between raw and virtual share price looked like a gain,
  so a phantom performance fee crystallised between two operations and the round trip gave back extra
  shares. The a16z ERC-4626 property suite caught it (5 round-trip properties failed); all 26 properties
  now pass with fees on and zero tolerance.
- Pending fees are included in every conversion (`_convertToShares`/`_convertToAssets`), so previews
  are exact before accrual and accrual never jumps the share price
  (`test_previewIncludesPendingFees`).

## Cost model

Venue parameters (mock defaults, chosen to be roughly mainnet-ETH-like):

| | Fee | Half-spread | Linear depth | $60k clip impact |
|---|---|---|---|---|
| Spot DEX | 5 bps | 2 bps | $500M | ~1.2 bps |
| Perp | 5 bps taker | 2 bps | $1B | ~0.6 bps |

Initial deployment of a $100k vault costs ~$95-100 (on-chain estimate $99.74 in the demo: ~10 bps of
NAV). Steady-state rebalancing is ~0.4%/yr of NAV plus gas.

**Keeper gas matters for small vaults.** A trading rebalance costs ~1.0-1.2M gas (see
[gas-report.md](gas-report.md)): at ~60/yr that is ~$300 on an L2 (≈ $5 each) but ~$4,300 on
mainnet at 20 gwei, which would eat most of the yield of a $100k vault. `Params.gasCostUsd` feeds keeper gas into the
cost filter, so the planner itself becomes less trigger-happy on an expensive chain. The deployment
target is therefore an L2.

## Capital efficiency and the reserve

| Reserve | Long / margin | Est. net APY | Liquid for instant exits |
|---|---|---|---|
| 5% | 63.3% / 31.7% | 6.35% | 5% of NAV |
| **10% (default)** | **60% / 30%** | **6.24%** | **10%** |
| 30% | 46.7% / 23.3% | 5.79% | 30% |

The optimizer's unconstrained pick is 5%; the default keeps 10% for withdrawal liquidity. Exits beyond
the reserve still work (`redeemWithUnwind`), they just trade.

## Sensitivities (estimation engine, $100k, base market unless noted)

| Change | Net APY |
|---|---|
| Funding 0.01%/8h (base, 10.95% APR) | 6.24% |
| Funding 0.02%/8h (21.9% APR) | 12.15% |
| Funding 0.005%/8h (5.5% APR, just under the 5.77% breakeven) | 3.29% |
| Funding ≤ floor (−5% APR) | defensive mode moves 70% of NAV to the USDC reserve |
| USDC utilisation 80% → 10%, WETH 60% → 5% | 4.76% (reserve earns 0.08%; funding carries the vault, scenario E) |
| Vol 60% → 120% (target leverage scales 2x → 1x) | 3.89% (long leg 45% of NAV instead of 60%) |

Funding is the dominant driver: doubling it doubles the net APY, while collapsing both lending rates
costs ~1.5 points.

## Economic attack surface

- **Share-price sandwich.** Interest and funding are marked continuously in `totalAssets`, so there is
  no discrete harvest jump to sandwich. Price moves barely move NAV (delta ≈ 0).
- **Inflation / donation.** Virtual shares with a 6-decimal offset: the attacker loses money for any
  donation size (`testFuzz_inflationAttack`).
- **Deposit → idle → withdraw churn.** Free (no trading happens) and harmless: deployment costs are
  incurred only when the keeper deploys, and then shared.
- **Withdrawing from the reserve and leaving remaining holders to refill it.** The refill is a normal
  rebalance with a socialised cost. If it ever matters, the withdrawal fee (≤ 1%) prices it.
