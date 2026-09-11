# Simulation

The `simulator/` package is a float-precision model of the vault, strategy and venues. It powers:

- the **scenario engine** (`GET /strategy/scenarios`, `POST /simulation {type:"scenario"|"custom"}`)
- the **APY estimation engine and optimizer** (`GET /strategy/apy`, `POST /simulation {type:"optimizer"}`)
- **Monte Carlo** (`POST /simulation {type:"montecarlo"}`)
- the **market generator** the backend's market driver replays on-chain to build dashboard history

```
pnpm --filter @dnv/simulator report            # scenario table, APY estimate, optimizer, Monte Carlo
pnpm --filter @dnv/simulator report --json     # same, machine-readable
```

## Fidelity: why trust the model

The model mirrors the contract maths function by function: `PerpMath` → `applyTrade` / `pnl` /
`liquidationPrice`; `MockPerpetualMarket` → impact, fees, funding, liquidation with bad debt;
`MockSpotDEX` → fee + linear impact; `MockLendingProtocol` → kinked rate curve and linear accrual;
`FeeManager` → dilution + HWM; `RebalanceManager` → triggers, vol scaling, cooldown, cost and carry
filters, feasibility solve, PnL crystallisation. **Parity tests** pin it to numbers produced by the
Solidity contracts:

| Quantity | On-chain (Foundry) | Simulator | Tolerance |
|---|---|---|---|
| NAV after deploying $100k | 99,905.26 | matches | < 0.005% |
| Long leg / perp equity / perp size | 59,950.81 / 29,954.45 / −19.98360 ETH | matches | < 0.005% |
| 7-day funding / USDC interest / WETH interest | 125.90 / 9.81 / 21.90 | matches | < 1% |

When the model and the contracts disagreed, one of them had a bug. Several real contract bugs were found
this way (see [security.md](security.md) §2).

## Market generator

`generateMarketPath` (deterministic, seeded):

- **ETH**: GBM with a 3-state volatility regime (45% / 65% / 110% annualised) with clustering.
- **Funding**: OU mean-reverting around a level that rises with 3-day momentum (longs pay more in
  uptrends, funding goes negative in sell-offs), clipped at ±0.3%/8h.
- **Lending utilisation**: OU around 80% (USDC) and 60% (WETH), mapped to APR through the mock's
  kinked curve.

This is a *demo* generator with stylised facts, not a calibrated model of ETH. Results describe how the
machinery behaves, not what mainnet would pay.

## Scenario catalogue ($100k, 30 days, keeper every hour; "on / off" = keeper online / offline)

| | Scenario | ETH | Net PnL on / off | Hedge PnL | Funding | Lending | Costs | Max abs(delta) on / off | Min liq. distance on / off | Liquidations on / off |
|---|---|---|---|---|---|---|---|---|---|---|
| A | ETH +20% | +20% | $583 / $699 | −$11,347 | $553 | $138 | $109 | 8 / 11 bps | 33.4% / **19.2%** | 0 / 0 |
| B | ETH −20% | −20% | $538 / $463 | +$12,867 | $515 | $132 | $109 | 8 / 8 bps | 42.8% / 42.8% | 0 / 0 |
| C | ETH −40% | −40% | $239 / $130 | +$12,603 | $270 | $204 | $234 | 6 / 6 bps | 42.7% / 42.8% | 0 / 0 |
| D | Funding turns negative | 0% | **−$339 / −$1,505** | $0 | −$504 | $320 | $155 | 3 / 10 bps | 40.2% / 40.4% | 0 / 0 |
| E | Lending APY drops | 0% | $451 / $451 | $0 | $540 | $6 | $95 | 0 / 0 bps | 42.8% / 42.8% | 0 / 0 |
| F | High volatility (120%) | +15% | $331 / $631 | −$8,947 | $418 | $115 | $205 | 1 / 11 bps | 42.8% / **6.9%** | 0 / 0 |
| G | Oracle stale 3 days | +15% | $575 / $667 | −$8,993 | $544 | $137 | $107 | 8 / 11 bps | 24.6% / 24.3% | 0 / 0 |
| H | Large slippage (200x shallower) | −15% | $527 / $491 | +$8,993 | $464 | $158 | $95 | 7 / 8 bps | 42.8% / 42.8% | 0 / 0 |
| I | ETH +60% squeeze | +60% | $573 / $9,365* | −$29,196 | $564 | $140 | $132 | 9 / **8,786 bps** | 33.8% / **0.4%** | 0 / **1** |
| J | Crash + negative funding | −30% | −$746 / −$1,950 | +$8,243 | −$645 | $50 | $151 | 0 / 1 bps | 42.7% / 42.8% | 0 / 0 |

Reading the table:

- **A/B/C:** a ±20% or −40% ETH move produces a ±$11-13k hedge PnL that the long leg offsets almost
  exactly; the vault ends up by its carry.
- **A, F, I:** the keeper's job is survival. Without it, a rally shrinks the short's margin (A: 19%
  from liquidation, HIGH_RISK), vol spikes nearly liquidate it (F: 6.9%), and a squeeze liquidates it
  (I).
- **\*I without a keeper "earns" $9,365** only because after the short is liquidated the vault holds a
  naked ETH long (88% of NAV) through the rest of the rally. That is a directional bet that happened to
  pay, not a strategy outcome; the same path downward would have lost it.
- **D/J:** defensive mode cuts the funding bleed by ~75% (D: −$339 vs −$1,505).
- **G:** no trade happens on a stale price, so leverage drifts for three days (distance falls to
  ~24.5%) and is fixed on the first fresh round.
- **H:** with shallow venues the cost filter defers non-urgent re-levers: 2 rebalances in the month,
  and costs stay at the entry cost. (Before the carry-blocked-drift fix this scenario ran 7, five of
  them pointless margin shuffles.)

## Custom scenarios

`POST /simulation` with `{ "type": "custom", "priceMovePct": -30, "moveDays": 2, "horizonDays": 10,
"fundingRatePer8h": -0.0001, "oracleOutageDays": 1, "liquidityMultiplier": 0.1, "leverageBps": 25000,
"reserveBps": 1500 }`. Every run is persisted in `simulation_results` and retrievable at
`GET /simulation/:id`. The dashboard's Simulation page drives it.

## Monte Carlo

200 x 365-day paths of the regime-switching market, 4 h keeper, fees on:

| | p5 | p50 | p95 |
|---|---|---|---|
| Annualised net return | 4.48% | 5.70% | 6.83% |
| Max drawdown | 0.10% | 0.14% | 0.21% |
| Rebalances / yr | 77 | 96 | 117 |
| Trading cost (% TVL) | 1.30% | 1.77% | 2.27% |

VaR95 (1y) = +4.48%, CVaR95 = +4.27%, P(loss) = 0%, P(venue liquidation) = 0%. The worst 5% of years
still earn ~4.3% *in this market model*. The defensive-mode A/B under persistent negative funding (in
[strategy.md](strategy.md)) is the stress case that matters: there the no-defence p5 is −0.65%.

## Model limitations

- Execution is instantaneous at the modelled price (no latency, no partial fills, no MEV).
- Funding is an exogenous process, not derived from open interest or the premium.
- Venue liquidation is checked at each step (gap risk inside a step is not modelled).
- One asset pair, one venue per leg; no correlation between venue failures and market moves.
- The market generator is stylised, not calibrated to historical ETH data.
