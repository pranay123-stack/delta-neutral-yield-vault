import { DAY, DEFAULT_STRATEGY, HOUR, SECONDS_PER_YEAR, type StrategyConfig } from "./config";
import {
  type MarketState,
  type Portfolio,
  accrue,
  accrueFees,
  isLiquidatable,
  liquidate,
  newPortfolio,
  pnlBreakdown,
  supplyAprs,
  valuation,
} from "./model";
import { TRIGGERS, executePlan, observeVolatility, planRebalance } from "./planner";

export interface SimOptions {
  tvl: number;
  cfg?: StrategyConfig;
  keeperIntervalSec?: number;
  /** false = keeper offline: the book is deployed once and never rebalanced. */
  rebalancing?: boolean;
  feeIntervalSec?: number;
  /** record every Nth step into the series (the summary always uses every step). */
  recordEvery?: number;
}

export interface SeriesPoint {
  time: number;
  price: number;
  nav: number;
  sharePrice: number;
  deltaBps: number;
  leverage: number;
  liquidationDistanceBps: number | null;
  drawdownBps: number;
  fundingRatePer8h: number;
  usdcApr: number;
  wethApr: number;
  strategyPnl: number;
  fundingPnl: number;
  lendingPnl: number;
  hedgePnl: number;
  costs: number;
  volAnnual: number;
  rebalanced: boolean;
  liquidated: boolean;
}

export interface SimSummary {
  days: number;
  startNav: number;
  endNav: number;
  startSharePrice: number;
  endSharePrice: number;
  periodReturn: number; // share price, net of fees
  annualizedReturn: number;
  grossPnl: number; // strategy PnL before vault fees
  fundingPnl: number;
  lendingPnl: number;
  hedgePnl: number;
  spotPnl: number;
  tradingCosts: number; // fees + slippage + liquidation penalties
  vaultFees: number;
  maxDrawdownBps: number;
  maxAbsDeltaBps: number;
  endDeltaBps: number;
  minLiquidationDistanceBps: number | null;
  endLiquidationDistanceBps: number | null;
  maxLeverage: number;
  rebalances: number;
  /** How many executed rebalances each trigger participated in (a rebalance can have several). */
  triggerCounts: Record<string, number>;
  /** Trading cost (fees + slippage) attributed to rebalances by their primary trigger. */
  costByTrigger: Record<string, number>;
  liquidations: number;
  badDebtAbsorbed: number;
  reconciliationResidual: number;
}

const TRIGGER_NAMES = Object.entries(TRIGGERS) as [string, number][];

/** Primary trigger = the most risk-relevant one that fired. */
function primaryTrigger(mask: number): string {
  const order = ["LIQUIDATION", "DELTA", "FUNDING_DEFENSIVE", "LEVERAGE_HIGH", "LEVERAGE_LOW", "ALLOCATION", "IDLE"];
  return order.find((n) => (mask & TRIGGERS[n as keyof typeof TRIGGERS]) !== 0) ?? "NONE";
}

export interface SimResult {
  series: SeriesPoint[];
  summary: SimSummary;
  portfolio: Portfolio;
}

export function simulate(path: MarketState[], opts: SimOptions): SimResult {
  const cfg = opts.cfg ?? DEFAULT_STRATEGY;
  const keeperEvery = opts.keeperIntervalSec ?? HOUR;
  const feeEvery = opts.feeIntervalSec ?? DAY;
  const recordEvery = opts.recordEvery ?? 1;
  const rebalancing = opts.rebalancing ?? true;
  if (path.length < 2) throw new Error("path needs at least two points");

  const m0 = path[0]!;
  const p = newPortfolio(opts.tvl, m0.time, cfg.volRefBps);
  // initial deployment always happens (a keeper-less run still starts from a deployed book)
  observeVolatility(p, m0.price, m0.time);
  const first = planRebalance(p, m0, cfg);
  if (first.execute) executePlan(p, first, m0, cfg);

  const series: SeriesPoint[] = [];
  const triggerCounts: Record<string, number> = {};
  const costByTrigger: Record<string, number> = {};
  let lastKeeper = m0.time;
  let lastFee = m0.time;
  let peak = valuation(p, m0).sharePrice;
  const s = {
    maxDd: 0,
    maxAbsDelta: 0,
    minLiq: null as number | null,
    maxLev: 0,
  };
  let prev = m0;
  const push = (m: MarketState, rebalanced: boolean, liquidated: boolean, i: number) => {
    const v = valuation(p, m);
    peak = Math.max(peak, v.sharePrice);
    const dd = peak > 0 ? ((peak - v.sharePrice) / peak) * 10_000 : 0;
    s.maxDd = Math.max(s.maxDd, dd);
    s.maxAbsDelta = Math.max(s.maxAbsDelta, Math.abs(v.deltaBps));
    if (v.liquidationDistanceBps !== null) s.minLiq = s.minLiq === null ? v.liquidationDistanceBps : Math.min(s.minLiq, v.liquidationDistanceBps);
    if (Number.isFinite(v.leverage)) s.maxLev = Math.max(s.maxLev, v.leverage);
    if (i % recordEvery !== 0 && !rebalanced && !liquidated && i !== path.length - 1) return;
    const b = pnlBreakdown(p, m);
    const aprs = supplyAprs(m);
    series.push({
      time: m.time,
      price: m.price,
      nav: v.nav,
      sharePrice: v.sharePrice,
      deltaBps: v.deltaBps,
      leverage: Number.isFinite(v.leverage) ? v.leverage : 99,
      liquidationDistanceBps: v.liquidationDistanceBps,
      drawdownBps: dd,
      fundingRatePer8h: m.fundingRatePer8h,
      usdcApr: aprs.usdc,
      wethApr: aprs.weth,
      strategyPnl: b.strategyNetPnl,
      fundingPnl: b.fundingIncome,
      lendingPnl: b.lendingIncomeUsdc + b.lendingIncomeWeth,
      hedgePnl: b.hedgePnl,
      costs: b.tradingFees + b.slippage,
      volAnnual: Math.sqrt(p.vol.ewmaVar),
      rebalanced,
      liquidated,
    });
  };
  push(m0, first.execute, false, 0);

  for (let i = 1; i < path.length; i++) {
    const m = path[i]!;
    // interest and funding accrue at the rates that prevailed over the interval
    accrue(p, { ...prev, time: m.time, price: m.price }, m.time - prev.time);
    let liquidated = false;
    if (isLiquidatable(p, m)) {
      liquidate(p, m);
      liquidated = true;
    }
    let rebalanced = false;
    if (m.time - lastKeeper >= keeperEvery) {
      lastKeeper = m.time;
      // no trading on an unhealthy oracle (mirrors performUpkeep reverting), and none at all offline
      if (m.oracleHealthy) {
        observeVolatility(p, m.price, m.time);
        if (rebalancing) {
          const plan = planRebalance(p, m, cfg);
          if (plan.execute) {
            const r = executePlan(p, plan, m, cfg);
            rebalanced = true;
            for (const [name, bit] of TRIGGER_NAMES) if ((plan.triggers & bit) !== 0) triggerCounts[name] = (triggerCounts[name] ?? 0) + 1;
            const key = primaryTrigger(plan.triggers);
            costByTrigger[key] = (costByTrigger[key] ?? 0) + r.fees + r.slippage;
          }
        }
      }
    }
    if (m.time - lastFee >= feeEvery && m.oracleHealthy) {
      lastFee = m.time;
      accrueFees(p, m, cfg);
    }
    push(m, rebalanced, liquidated, i);
    prev = m;
  }

  const last = path[path.length - 1]!;
  const v0 = series[0]!;
  const v = valuation(p, last);
  const b = pnlBreakdown(p, last);
  const days = (last.time - m0.time) / DAY;
  const periodReturn = v.sharePrice / v0.sharePrice - 1;
  return {
    series,
    portfolio: p,
    summary: {
      days,
      startNav: opts.tvl,
      endNav: v.nav,
      startSharePrice: v0.sharePrice,
      endSharePrice: v.sharePrice,
      periodReturn,
      annualizedReturn: days > 0 ? Math.pow(1 + periodReturn, SECONDS_PER_YEAR / DAY / days) - 1 : 0,
      grossPnl: b.strategyNetPnl,
      fundingPnl: b.fundingIncome,
      lendingPnl: b.lendingIncomeUsdc + b.lendingIncomeWeth,
      hedgePnl: b.hedgePnl,
      spotPnl: b.spotRealizedPnl + b.spotUnrealizedPnl,
      tradingCosts: b.tradingFees + b.slippage,
      vaultFees: b.managementFees + b.performanceFees,
      maxDrawdownBps: s.maxDd,
      maxAbsDeltaBps: s.maxAbsDelta,
      endDeltaBps: v.deltaBps,
      minLiquidationDistanceBps: s.minLiq,
      endLiquidationDistanceBps: v.liquidationDistanceBps,
      maxLeverage: s.maxLev,
      rebalances: p.rebalances,
      triggerCounts,
      costByTrigger,
      liquidations: p.liquidations,
      badDebtAbsorbed: b.badDebtAbsorbed,
      reconciliationResidual: b.reconciliationResidual,
    },
  };
}
