import { DAY, DEFAULT_STRATEGY, HOUR, type StrategyConfig } from "./config";
import { simulate } from "./engine";
import { type PathOptions, generateMarketPath } from "./market";

/**
 * Monte Carlo over synthetic market histories: distribution of outcomes rather than a single
 * backtest. Reports return percentiles, drawdowns, tail risk (VaR / CVaR of the period return) and
 * how often the keeper failed to prevent a venue liquidation.
 */

export interface MonteCarloOptions {
  paths: number;
  days: number;
  seed: number;
  tvl?: number;
  stepSec?: number;
  keeperIntervalSec?: number;
  cfg?: StrategyConfig;
  path?: Partial<PathOptions>;
}

export interface Percentiles {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  mean: number;
}

export interface MonteCarloResult {
  paths: number;
  days: number;
  annualizedReturn: Percentiles;
  periodReturn: Percentiles;
  maxDrawdownBps: Percentiles;
  maxAbsDeltaBps: Percentiles;
  rebalances: Percentiles;
  tradingCostPct: Percentiles; // of TVL
  var95: number; // 5th percentile period return (loss is negative)
  cvar95: number; // mean of the worst 5%
  liquidationProbability: number; // share of paths with >=1 venue liquidation
  lossProbability: number; // share of paths with negative period return
}

function percentiles(xs: number[]): Percentiles {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => {
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return s[lo]! + (s[hi]! - s[lo]!) * (idx - lo);
  };
  return { p5: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

export function monteCarlo(o: MonteCarloOptions): MonteCarloResult {
  const cfg = o.cfg ?? DEFAULT_STRATEGY;
  const tvl = o.tvl ?? 100_000;
  const stepSec = o.stepSec ?? 4 * HOUR;
  const keeper = o.keeperIntervalSec ?? stepSec;
  const ann: number[] = [];
  const period: number[] = [];
  const dd: number[] = [];
  const delta: number[] = [];
  const rebal: number[] = [];
  const cost: number[] = [];
  let liquidated = 0;
  for (let i = 0; i < o.paths; i++) {
    const path = generateMarketPath({ ...o.path, seed: o.seed * 7919 + i, days: o.days, stepSec });
    const r = simulate(path, { tvl, cfg, keeperIntervalSec: keeper, feeIntervalSec: DAY, recordEvery: 1_000_000 });
    ann.push(r.summary.annualizedReturn);
    period.push(r.summary.periodReturn);
    dd.push(r.summary.maxDrawdownBps);
    delta.push(r.summary.maxAbsDeltaBps);
    rebal.push(r.summary.rebalances);
    cost.push((r.summary.tradingCosts / tvl) * 100);
    if (r.summary.liquidations > 0) liquidated++;
  }
  const sorted = [...period].sort((a, b) => a - b);
  const tail = sorted.slice(0, Math.max(1, Math.floor(sorted.length * 0.05)));
  return {
    paths: o.paths,
    days: o.days,
    annualizedReturn: percentiles(ann),
    periodReturn: percentiles(period),
    maxDrawdownBps: percentiles(dd),
    maxAbsDeltaBps: percentiles(delta),
    rebalances: percentiles(rebal),
    tradingCostPct: percentiles(cost),
    var95: percentiles(period).p5,
    cvar95: tail.reduce((a, b) => a + b, 0) / tail.length,
    liquidationProbability: liquidated / o.paths,
    lossProbability: period.filter((x) => x < 0).length / o.paths,
  };
}
