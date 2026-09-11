import { DEFAULT_STRATEGY, DEFAULT_VENUES, type StrategyConfig, type VenueParams } from "./config";
import { quoteBuyWeth, perpExecPrice } from "./model";
import { fundingApr } from "./rates";

/**
 * Expected-APY estimation engine. Closed-form, so it can evaluate thousands of configurations
 * instantly; tests check it against the full path simulator.
 *
 *   gross  = reserve*usdcApr + L*wethApr + h*L*fundingApr                 (fractions of NAV / yr)
 *   costs  = entry (amortised) + rebalances/yr * cost-per-rebalance + gas + vault fees
 *
 * Rebalance frequency: between rebalances the book drifts with price. A rebalance fires when the
 * log-price has moved far enough to breach either the allocation band or the leverage band. For a
 * driftless Brownian motion started between barriers -a and +b the expected exit time is a*b/sigma^2,
 * so rebalances/yr ~= sigma^2 / (a*b). This is an estimate, not a guarantee of returns.
 */

export interface ApyInputs {
  usdcSupplyApr: number;
  wethSupplyApr: number;
  fundingRatePer8h: number;
  volAnnual: number;
  targetLeverage?: number;
  reserveRatio?: number;
  hedgeRatio?: number;
  tvl?: number;
  holdingPeriodYears?: number; // amortisation horizon for entry costs
  venues?: VenueParams;
  cfg?: StrategyConfig;
}

export interface ApyEstimate {
  inputs: Required<Omit<ApyInputs, "venues" | "cfg">>;
  allocation: { reservePct: number; longPct: number; marginPct: number };
  gross: { lendingUsdc: number; lendingWeth: number; funding: number; total: number };
  costs: {
    entryAmortized: number;
    rebalancing: number;
    gas: number;
    managementFee: number;
    performanceFee: number;
    total: number;
  };
  netApy: number;
  grossApy: number;
  rebalancesPerYear: number;
  risk: {
    liquidationMovePct: number; // ETH rise that liquidates the short at target leverage
    rebalanceTriggerUpPct: number;
    rebalanceTriggerDownPct: number;
    liquidationProb1dNoKeeper: number;
    liquidationProb7dNoKeeper: number;
    fundingBreakevenApr: number; // funding APR at which the basis earns no more than the USDC reserve
  };
}

const erf = (x: number) => {
  // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x);
  const a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};
const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Probability the (driftless log) price touches +m within T years: reflection principle. */
export function touchProbability(movePct: number, volAnnual: number, years: number): number {
  if (movePct <= 0) return 1;
  const z = Math.log(1 + movePct) / (volAnnual * Math.sqrt(years));
  return Math.min(1, 2 * (1 - normCdf(z)));
}

function spotCostFrac(notional: number, price: number, v: VenueParams): number {
  if (notional <= 0) return 0;
  const q = quoteBuyWeth(notional, price, v);
  return (notional - q.qty * price) / notional;
}

function perpCostFrac(notional: number, price: number, v: VenueParams): number {
  if (notional <= 0) return 0;
  const size = -notional / price;
  const exec = perpExecPrice(size, price, v);
  return Math.abs(exec - price) / price + v.perpTakerFeeBps / 10_000;
}

export function estimateApy(inputs: ApyInputs): ApyEstimate {
  const cfg = inputs.cfg ?? DEFAULT_STRATEGY;
  const v = inputs.venues ?? DEFAULT_VENUES;
  const lev = inputs.targetLeverage ?? cfg.targetLeverageBps / 10_000;
  const r = inputs.reserveRatio ?? cfg.reserveBps / 10_000;
  const h = inputs.hedgeRatio ?? cfg.hedgeRatioBps / 10_000;
  const tvl = inputs.tvl ?? 100_000;
  const hold = inputs.holdingPeriodYears ?? 1;
  const price = 3000;
  const sigma = Math.max(inputs.volAnnual, 1e-6);

  // allocation (fractions of NAV)
  const basis = 1 - r;
  const longPct = (basis * lev) / (lev + h);
  const marginPct = (h * longPct) / lev;

  const fApr = fundingApr(inputs.fundingRatePer8h);
  const gross = {
    lendingUsdc: r * inputs.usdcSupplyApr,
    lendingWeth: longPct * inputs.wethSupplyApr,
    funding: h * longPct * fApr,
    total: 0,
  };
  gross.total = gross.lendingUsdc + gross.lendingWeth + gross.funding;

  // rebalance triggers (price moves that breach a band)
  const allocBand = cfg.allocationBandBps / 10_000;
  const levBand = cfg.leverageBandBps / 10_000;
  const xAlloc = allocBand / longPct;
  const xLevUp = levBand / (1 + lev * (1 + levBand));
  const xLevDown = levBand / (1 + lev * (1 - levBand));
  const up = Math.min(xAlloc, xLevUp);
  const down = Math.min(xAlloc, xLevDown);
  const rebalancesPerYear = (sigma * sigma) / (up * down);

  // per-rebalance cost: trade the drift on both legs (~the average barrier), plus keeper gas
  const avgMove = (up + down) / 2;
  const turnoverUsd = avgMove * longPct * tvl;
  const perRebalanceFrac =
    (turnoverUsd * (spotCostFrac(turnoverUsd, price, v) + perpCostFrac(h * turnoverUsd, price, v) * h)) / tvl;
  const rebalancing = rebalancesPerYear * perRebalanceFrac;
  const gas = (rebalancesPerYear * cfg.gasCostUsd) / tvl;

  const entryUsd = longPct * tvl;
  const entryFrac =
    (entryUsd * spotCostFrac(entryUsd, price, v) + h * entryUsd * perpCostFrac(h * entryUsd, price, v)) / tvl;
  const entryAmortized = entryFrac / hold;

  const managementFee = cfg.managementFeeBps / 10_000;
  const preFee = gross.total - rebalancing - gas - entryAmortized;
  const performanceFee = Math.max(preFee - managementFee, 0) * (cfg.performanceFeeBps / 10_000);
  const costsTotal = entryAmortized + rebalancing + gas + managementFee + performanceFee;

  const mm = v.maintenanceMarginBps / 10_000;
  const liquidationMovePct = (1 + 1 / lev) / (1 + mm) - 1;
  // funding APR at which basis carry equals leaving the capital in the USDC reserve:
  //   L*wethApr + h*L*f = L*(1 + h/lev)*usdcApr
  const fundingBreakevenApr = ((1 + h / lev) * inputs.usdcSupplyApr - inputs.wethSupplyApr) / h;

  return {
    inputs: {
      usdcSupplyApr: inputs.usdcSupplyApr,
      wethSupplyApr: inputs.wethSupplyApr,
      fundingRatePer8h: inputs.fundingRatePer8h,
      volAnnual: sigma,
      targetLeverage: lev,
      reserveRatio: r,
      hedgeRatio: h,
      tvl,
      holdingPeriodYears: hold,
    },
    allocation: { reservePct: r, longPct, marginPct },
    gross,
    costs: { entryAmortized, rebalancing, gas, managementFee, performanceFee, total: costsTotal },
    grossApy: gross.total,
    netApy: gross.total - costsTotal,
    rebalancesPerYear,
    risk: {
      liquidationMovePct,
      rebalanceTriggerUpPct: up,
      rebalanceTriggerDownPct: down,
      liquidationProb1dNoKeeper: touchProbability(liquidationMovePct, sigma, 1 / 365),
      liquidationProb7dNoKeeper: touchProbability(liquidationMovePct, sigma, 7 / 365),
      fundingBreakevenApr,
    },
  };
}

export interface OptimizeConstraints {
  minLiquidationMovePct: number; // e.g. 0.3 = the short must survive a 30% rally without a keeper
  maxRebalancesPerYear: number;
  maxLiquidationProb7d: number;
}

export interface OptimizeResult {
  best: ApyEstimate;
  current: ApyEstimate;
  frontier: { leverage: number; reservePct: number; netApy: number; liquidationMovePct: number; rebalancesPerYear: number; feasible: boolean }[];
  constraints: OptimizeConstraints;
  recommendation: string;
}

/**
 * Grid search over target leverage and reserve share, maximising net APY within risk constraints.
 * `current` is the estimate at the leverage/reserve passed in (the live configuration when called with
 * on-chain inputs); the grid overrides both.
 */
export function optimize(
  base: ApyInputs,
  constraints: OptimizeConstraints = { minLiquidationMovePct: 0.3, maxRebalancesPerYear: 150, maxLiquidationProb7d: 1e-4 },
): OptimizeResult {
  const cfg = base.cfg ?? DEFAULT_STRATEGY;
  const current = estimateApy({ ...base });
  const frontier: OptimizeResult["frontier"] = [];
  let best: ApyEstimate | null = null;
  for (let lev = 1; lev <= 3.0001; lev += 0.25) {
    for (let res = 0.05; res <= 0.5001; res += 0.05) {
      const e = estimateApy({ ...base, targetLeverage: lev, reserveRatio: res });
      const feasible =
        e.risk.liquidationMovePct >= constraints.minLiquidationMovePct &&
        e.rebalancesPerYear <= constraints.maxRebalancesPerYear &&
        e.risk.liquidationProb7dNoKeeper <= constraints.maxLiquidationProb7d &&
        lev * 10_000 >= cfg.minLeverageBps;
      frontier.push({
        leverage: Number(lev.toFixed(2)),
        reservePct: Number(res.toFixed(2)),
        netApy: e.netApy,
        liquidationMovePct: e.risk.liquidationMovePct,
        rebalancesPerYear: e.rebalancesPerYear,
        feasible,
      });
      if (feasible && (best === null || e.netApy > best.netApy)) best = e;
    }
  }
  const chosen = best ?? current;
  const fApr = fundingApr(base.fundingRatePer8h);
  let recommendation: string;
  if (fApr < chosen.risk.fundingBreakevenApr) {
    recommendation = `Funding (${(fApr * 100).toFixed(1)}% APR) is below the ${(chosen.risk.fundingBreakevenApr * 100).toFixed(1)}% breakeven: the basis earns less than the USDC reserve. Shrink the basis (defensive reserve).`;
  } else {
    recommendation = `Target ${chosen.inputs.targetLeverage.toFixed(2)}x leverage with a ${(chosen.inputs.reserveRatio * 100).toFixed(0)}% reserve: est. net APY ${(chosen.netApy * 100).toFixed(2)}%, short survives a ${(chosen.risk.liquidationMovePct * 100).toFixed(0)}% rally, ~${chosen.rebalancesPerYear.toFixed(0)} rebalances/yr.`;
  }
  return { best: chosen, current, frontier, constraints, recommendation };
}
