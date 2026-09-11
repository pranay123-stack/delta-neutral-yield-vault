# Strategy

## The trade in one paragraph

Depositors give the vault USDC. The vault buys ETH and supplies it to a lending market (earning the
ETH supply rate), and shorts an equal quantity of ETH on a perpetual futures venue (earning funding
when longs pay shorts, which is the historical norm). The long and the short cancel: a move in ETH
changes one leg's value by exactly what it changes the other's, so the share price is (almost)
insensitive to ETH. What is left is **carry**: lending interest on both the WETH long and the idle
USDC reserve, plus funding on the short, minus the cost of maintaining the hedge.

```
USDC ─► vault ─┬─► 10% USDC reserve ───────► lending pool   (USDC supply APR)
               └─► 90% basis ──┬─► 60% WETH ─► lending pool (WETH supply APR) = long  +Δ
                               └─► 30% USDC ─► perp margin  (funding APR on 60%)  = short −Δ
```

This is the structure behind the "basis trade" / cash-and-carry funds and synthetic-dollar protocols
(Ethena-style), scaled down to one asset pair and made fully on-chain and auditable.

## Where the yield comes from (base market)

At deployment the mock markets sit at 80% USDC utilisation, 60% WETH utilisation and +0.01% / 8h
funding. The estimation engine (`simulator/src/optimizer.ts`, served at `GET /strategy/apy`) gives:

| Component | Formula | Share of NAV / yr |
|---|---|---|
| USDC reserve interest | 10% x 5.12% | 0.51% |
| WETH long interest | 60% x 1.91% | 1.15% |
| Funding on the short | 60% x 10.95% | 6.57% |
| **Gross carry** | | **8.23%** |
| Entry cost (amortised over 1y) | spot + perp fees/impact on the initial trade | −0.10% |
| Rebalancing costs | ~60 rebalances/yr x cost per rebalance | −0.40% |
| Keeper gas | 60 x $5 on a $100k vault | −0.30% |
| Management fee | 0.5% / yr | −0.50% |
| Performance fee | 10% of the gain above the HWM | −0.69% |
| **Estimated net APY** | | **6.24%** |

This is an **estimate, not a promise**. Funding is the dominant term and it is volatile: at +0.002%/8h
(2.2% APR) the same book earns less than parking everything in USDC lending. The funding level at
which the basis stops beating the reserve is:

```
L·wethApr + h·L·f  =  L·(1 + h/lev)·usdcApr     =>     f* = ((1 + h/lev)·usdcApr − wethApr) / h
```

At the base market f* = **5.77% APR** (~0.0053% per 8h). Below it, carry is negative relative to the
alternative and the on-chain carry filter refuses to add basis exposure.

## Realised distribution (Monte Carlo)

200 one-year paths of a regime-switching market (GBM with 45/65/110% vol regimes, momentum-coupled OU
funding, OU utilisation), full rebalancing logic, 4-hour keeper, fees on (`pnpm --filter
@dnv/simulator report --mc 200`):

| | p5 | p25 | p50 | p75 | p95 |
|---|---|---|---|---|---|
| Annualised return (net of all costs and fees) | 4.48% | 5.17% | 5.70% | 6.25% | 6.83% |
| Max drawdown | 0.10% | 0.11% | 0.14% | 0.16% | 0.21% |
| Rebalances / yr | 77 | 90 | 96 | 105 | 117 |
| Trading cost, % of TVL | 1.30% | 1.56% | 1.77% | 2.00% | 2.27% |

P(loss over a year) = 0%, P(venue liquidation) = 0% in this model. The analytic estimate (6.24%) sits
~0.5 pts above the Monte Carlo median; the gap is almost exactly the cost of defensive mode (below),
which the closed form doesn't model. These numbers are properties of a *synthetic* market; they say
the machinery works, not what mainnet would pay.

## The two regime rules and what they cost

### Volatility-scaled leverage

The keeper feeds an on-chain EWMA of squared returns (λ = 0.94, observations ≥ 1 h apart). When
realised vol exceeds the 60% reference, target leverage is scaled down:

```
lev = targetLev · volRef / max(vol, volRef)          (floored at minLeverage = 1x)
```

A 2x short liquidates after a ~43% rally; at 1.2x it takes a ~74% rally. Scenario F (120% vol for a
month) shows why: without a keeper the unscaled 2x book came within **6.9%** of its liquidation price;
with vol scaling the minimum distance stayed at **42.8%**. The cost is extra rebalancing as the target
moves.

### Defensive mode (negative funding)

When funding APR drops below the floor (−5%), the reserve target jumps from 10% to 70% of NAV: most of
the basis is unwound into USDC lending. Re-levering later has to pass the carry filter, which acts as
exit hysteresis.

This is **insurance, and it has a measurable premium** (Monte Carlo A/B, 60 paths each):

| Funding regime | Defensive at −5% | Defensive off |
|---|---|---|
| Fast mean-reverting (κ = 0.35/day) | median 5.72%, p5 4.35% | median 6.37%, p5 5.16% |
| Persistent, bear-market style (κ = 0.03/day) | median 5.38%, **p5 2.49%**, P(loss) 0% | median 4.13%, **p5 −0.65%**, P(loss) 8%, p95 drawdown 2.72% |

In benign markets defensive mode costs ~0.65% APY: round-trip trading on 40% of NAV each time funding
dips below the floor and recovers. In a persistent negative-funding regime it is the difference between
a 2.5% worst case and losing money. A −15% floor is dominated in both regimes. The default stays at −5%.
On the 90-day on-chain replay, four defensive round trips made up ~$1,900 of the $2,602 total trading
cost, which is the same premium showing up in real contract execution.

## Why these defaults

| Parameter | Default | Reasoning |
|---|---|---|
| Target leverage | 2x | 60% of NAV earns funding; the short survives a 43% rally with no keeper. 3x adds only +0.57% APY but cuts the survivable rally to 27% and needs ~50% more rebalances (table below). |
| Hedge ratio | 100% | Delta-neutral by definition; strategist bounds are 90-110% for deliberate tilts. |
| USDC reserve | 10% | Covers typical withdrawals without trading; more reserve = more liquidity, less funding income (optimizer frontier). |
| Allocation band | 5% of NAV | Resize the basis when the long leg drifts 5% of NAV from target (≈ 8.3% ETH move). |
| Leverage band | ±25% of target | 1.5x-2.5x around 2x. |
| Delta band | 200 bps of NAV | A 2% net delta means a 10% ETH move shifts the share price by 0.2%. Tightens with vol. |
| Cooldown | 1 h | Non-urgent trades at most hourly; urgent ones (liquidation proximity, hard-limit breaches) bypass it. |
| Carry horizon | 30 days | A re-lever must earn back its execution cost within a month at current rates. |
| Max cost / rebalance | 50 bps of NAV | Non-urgent rebalances that would cost more are skipped. |

Leverage is the main risk/return dial (estimation engine, base market):

| Target leverage | Est. net APY | ETH rally that liquidates the short | Rebalances / yr |
|---|---|---|---|
| 1.0x | 4.84% | 90.5% | 29 |
| 1.5x | 5.71% | 58.7% | 45 |
| **2.0x (default)** | **6.24%** | **42.9%** | **60** |
| 3.0x | 6.81% | 27.0% | 92 |

Going from 2x to 3x buys 0.57% of APY with 16 points of liquidation headroom; the curve flattens fast
because only the margin sleeve shrinks.

The optimizer (`GET /strategy/apy` → `optimizer.frontier`) evaluates every (leverage, reserve) pair on
a grid under constraints (short survives a ≥30% rally, ≤150 rebalances/yr, 7-day unmonitored
liquidation probability ≤ 1e-4) and recommends targets. The strategist role can apply them on-chain
within admin-set bounds.

## What this strategy does *not* hedge

- **Funding risk** is the main economic risk: the yield can go to zero or negative for months.
  Defensive mode limits the damage but can't create yield.
- **Counterparty / venue risk**: the lending pool, the perp venue and the DEX are all trusted to
  settle. A perp-venue failure leaves a naked long (see [threat-model.md](threat-model.md)).
- **Basis / mark-index divergence**: the mock marks the perp at the oracle price; real venues don't.
- **Liquidity risk on exit**: large exits pay real unwind costs (borne by the exiting user by design).
