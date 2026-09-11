import { FUNDING_PERIOD_SEC, HOUR, SECONDS_PER_YEAR, type StrategyConfig } from "./config";
import {
  type MarketState,
  type Portfolio,
  buyWeth,
  perpExecPrice,
  perpTrade,
  quoteBuyWeth,
  quoteSellWeth,
  sellWeth,
  supplyAprs,
  valuation,
} from "./model";

/** Mirrors RebalanceManager trigger bits. */
export const TRIGGERS = {
  DELTA: 1 << 0,
  LEVERAGE_HIGH: 1 << 1,
  LEVERAGE_LOW: 1 << 2,
  ALLOCATION: 1 << 3,
  IDLE: 1 << 4,
  LIQUIDATION: 1 << 5,
  FUNDING_DEFENSIVE: 1 << 6,
} as const;

export interface Plan {
  execute: boolean;
  urgent: boolean;
  triggers: number;
  sweepIdle: number;
  longUsdDelta: number;
  marginDelta: number;
  estimatedCost: number;
  effectiveLeverage: number;
  targetLong: number;
}

const EWMA_LAMBDA = 0.94;
const MIN_OBS_INTERVAL = HOUR;

/** EWMA variance including the observation that would be recorded now (mirror of _projectedVariance). */
export function projectedVariance(p: Portfolio, price: number, now: number): number {
  const { lastPrice, lastTime, ewmaVar } = p.vol;
  const dt = now - lastTime;
  if (lastPrice === 0 || dt < MIN_OBS_INTERVAL) return ewmaVar;
  const r = Math.abs(price - lastPrice) / lastPrice;
  const sample = (r * r * SECONDS_PER_YEAR) / dt;
  return EWMA_LAMBDA * ewmaVar + (1 - EWMA_LAMBDA) * sample;
}

export function observeVolatility(p: Portfolio, price: number, now: number): void {
  if (p.vol.lastPrice !== 0 && now - p.vol.lastTime < MIN_OBS_INTERVAL) return;
  p.vol.ewmaVar = projectedVariance(p, price, now);
  p.vol.lastPrice = price;
  p.vol.lastTime = now;
}

export function annualizedVol(p: Portfolio, m: MarketState): number {
  return Math.sqrt(projectedVariance(p, m.oracleHealthy ? m.price : 0, m.time));
}

export function effectiveLeverage(p: Portfolio, m: MarketState, cfg: StrategyConfig): number {
  const target = cfg.targetLeverageBps / 10_000;
  const vol = annualizedVol(p, m);
  const ref = cfg.volRefBps / 10_000;
  const lev = vol > ref ? (target * ref) / vol : target;
  return Math.max(lev, cfg.minLeverageBps / 10_000);
}

export function planRebalance(p: Portfolio, m: MarketState, cfg: StrategyConfig, availableReserve?: number): Plan {
  const plan: Plan = {
    execute: false,
    urgent: false,
    triggers: 0,
    sweepIdle: 0,
    longUsdDelta: 0,
    marginDelta: 0,
    estimatedCost: 0,
    effectiveLeverage: 0,
    targetLong: 0,
  };
  const v = valuation(p, m);
  if (!m.oracleHealthy || v.nav <= 0) return plan;

  const h = cfg.hedgeRatioBps / 10_000;
  const lev = effectiveLeverage(p, m, cfg);
  plan.effectiveLeverage = lev;
  const fundingAprBps = m.fundingRatePer8h * 1095 * 10_000;
  const defensive = fundingAprBps < cfg.fundingFloorAprBps;
  const reserveBps = defensive ? Math.max(cfg.reserveBps, cfg.defensiveReserveBps) : cfg.reserveBps;
  const basis = (v.nav * (10_000 - reserveBps)) / 10_000;
  const targetLong = (basis * lev) / (lev + h);
  plan.targetLong = targetLong;

  // volatility-scaled delta band, floored at base/4
  const vol = annualizedVol(p, m);
  const ref = cfg.volRefBps / 10_000;
  let band = cfg.deltaBandBps;
  if (vol > ref) band = Math.max((cfg.deltaBandBps * ref) / vol, cfg.deltaBandBps / 4);

  const absDelta = Math.abs(v.deltaBps);
  if (absDelta > band) plan.triggers |= TRIGGERS.DELTA;
  if (p.perp.size !== 0) {
    if (v.leverage > lev * (1 + cfg.leverageBandBps / 10_000)) plan.triggers |= TRIGGERS.LEVERAGE_HIGH;
    else if (v.leverage < lev * (1 - cfg.leverageBandBps / 10_000)) plan.triggers |= TRIGGERS.LEVERAGE_LOW;
  }
  const drift = Math.abs(targetLong - v.longValue);
  if (drift > (v.nav * cfg.allocationBandBps) / 10_000 && drift >= cfg.minTradeUsd) {
    plan.triggers |= TRIGGERS.ALLOCATION;
    if (defensive && v.longValue > targetLong) plan.triggers |= TRIGGERS.FUNDING_DEFENSIVE;
  }
  if (p.idle >= cfg.minDeployUsd && p.idle > 0) plan.triggers |= TRIGGERS.IDLE;
  if (p.perp.size !== 0 && (v.liquidationDistanceBps ?? Infinity) < cfg.risk.liquidationDistance.warn) {
    plan.triggers |= TRIGGERS.LIQUIDATION;
  }
  if (plan.triggers === 0) return plan;

  plan.urgent =
    (plan.triggers & TRIGGERS.LIQUIDATION) !== 0 || v.leverage > cfg.risk.leverage.high / 10_000 || absDelta > cfg.risk.delta.high;
  plan.sweepIdle = p.idle;

  const cooling = m.time < p.lastRebalanceAt + cfg.minIntervalSec;
  if (!plan.urgent && cooling) return sweepOnly(plan);

  // --- size trades ---
  // default mirrors the on-chain planner (leverage triggers move margin only)
  const resetMask =
    cfg.resetPolicy === "full"
      ? TRIGGERS.ALLOCATION | TRIGGERS.LEVERAGE_HIGH | TRIGGERS.LEVERAGE_LOW | TRIGGERS.LIQUIDATION
      : TRIGGERS.ALLOCATION;
  if ((plan.triggers & resetMask) !== 0 || plan.urgent) {
    const d = targetLong - v.longValue;
    if (Math.abs(d) >= cfg.minTradeUsd) plan.longUsdDelta = d;
  }
  let cash = (availableReserve ?? p.reserve) + plan.sweepIdle;
  if (plan.longUsdDelta < 0) cash += -plan.longUsdDelta;
  if (plan.longUsdDelta > 0) {
    const need = plan.longUsdDelta + (h * (v.longValue + plan.longUsdDelta)) / lev - v.perpEquity;
    if (need > cash) {
      const room = cash + v.perpEquity - (h * v.longValue) / lev;
      plan.longUsdDelta = room > 0 ? (room * lev) / (lev + h) : 0;
      if (Math.abs(plan.longUsdDelta) < cfg.minTradeUsd) plan.longUsdDelta = 0;
    }
  }
  sizeMargin(p, v.longValue + plan.longUsdDelta, v.perpEquity, lev, h, cfg, plan);
  if (plan.marginDelta > 0) {
    const left = Math.max(cash - Math.max(plan.longUsdDelta, 0), 0);
    plan.marginDelta = Math.min(plan.marginDelta, left);
  }

  plan.estimatedCost = estimateCost(p, m, plan, cfg);
  if (!plan.urgent) {
    if (plan.estimatedCost > (v.nav * cfg.maxCostBps) / 10_000) return sweepOnly(plan);
    if (plan.longUsdDelta > 0 && !carryPaysForCost(m, cfg, lev, h, plan)) {
      plan.longUsdDelta = 0;
      // mirror: only re-size margin when leverage itself is out of band
      const leverageOff = (plan.triggers & (TRIGGERS.LEVERAGE_HIGH | TRIGGERS.LEVERAGE_LOW | TRIGGERS.LIQUIDATION)) !== 0;
      if (leverageOff) sizeMargin(p, v.longValue, v.perpEquity, lev, h, cfg, plan);
      else plan.marginDelta = 0;
      plan.estimatedCost = estimateCost(p, m, plan, cfg);
      const riskParts = (plan.triggers & (TRIGGERS.DELTA | TRIGGERS.LEVERAGE_HIGH | TRIGGERS.LEVERAGE_LOW)) !== 0;
      if (!riskParts && plan.marginDelta === 0) return sweepOnly(plan);
    }
  }
  plan.execute = true;
  return plan;
}

function sizeMargin(
  p: Portfolio,
  newLong: number,
  equity: number,
  lev: number,
  h: number,
  cfg: StrategyConfig,
  plan: Plan,
): void {
  const resize =
    (plan.triggers & (TRIGGERS.LEVERAGE_HIGH | TRIGGERS.LEVERAGE_LOW | TRIGGERS.ALLOCATION | TRIGGERS.LIQUIDATION)) !== 0 ||
    plan.urgent ||
    (p.perp.size === 0 && newLong > 0);
  plan.marginDelta = 0;
  if (!resize) return;
  const d = (newLong * h) / lev - equity;
  if (Math.abs(d) >= cfg.minTradeUsd) plan.marginDelta = d;
}

function sweepOnly(plan: Plan): Plan {
  plan.longUsdDelta = 0;
  plan.marginDelta = 0;
  plan.estimatedCost = 0;
  plan.triggers &= TRIGGERS.IDLE;
  plan.execute = (plan.triggers & TRIGGERS.IDLE) !== 0;
  return plan;
}

export function estimateCost(p: Portfolio, m: MarketState, plan: Plan, cfg: StrategyConfig): number {
  let cost = cfg.gasCostUsd;
  let newQty = p.weth;
  if (plan.longUsdDelta > 0) {
    const q = quoteBuyWeth(plan.longUsdDelta, m.price, m.venues);
    cost += Math.max(plan.longUsdDelta - q.qty * m.price, 0);
    newQty += q.qty;
  } else if (plan.longUsdDelta < 0) {
    const qty = Math.min(-plan.longUsdDelta / m.price, p.weth);
    const q = quoteSellWeth(qty, m.price, m.venues);
    cost += Math.max(qty * m.price - q.usd, 0);
    newQty -= qty;
  }
  const hedgeDelta = -newQty * (cfg.hedgeRatioBps / 10_000) - p.perp.size;
  if (Math.abs(hedgeDelta) > 0) {
    const exec = perpExecPrice(hedgeDelta, m.price, m.venues);
    cost += Math.abs(exec - m.price) * Math.abs(hedgeDelta);
    cost += (Math.abs(hedgeDelta) * exec * m.venues.perpTakerFeeBps) / 10_000;
  }
  return cost;
}

/** dL*wethApr + h*dL*fundingApr - dL*(1 + h/lev)*usdcApr over the horizon must beat the cost. */
export function carryPaysForCost(m: MarketState, cfg: StrategyConfig, lev: number, h: number, plan: Plan): boolean {
  const aprs = supplyAprs(m);
  const fundingAprFrac = m.fundingRatePer8h * (SECONDS_PER_YEAR / FUNDING_PERIOD_SEC);
  const carry = aprs.weth + h * fundingAprFrac - (1 + h / lev) * aprs.usdc;
  const benefit = (plan.longUsdDelta * carry * cfg.carryHorizonSec) / SECONDS_PER_YEAR;
  return benefit > plan.estimatedCost;
}

/** Execute with the strategy's ordering: raise cash (sells, free margin) -> spend -> hedge -> park. */
export function executePlan(p: Portfolio, plan: Plan, m: MarketState, cfg: StrategyConfig): { fees: number; slippage: number } {
  let fees = 0;
  let slippage = 0;
  // sweep idle into the reserve
  p.reserve += plan.sweepIdle;
  p.idle -= plan.sweepIdle;
  const tradesNeeded = plan.longUsdDelta !== 0 || plan.marginDelta !== 0 || (plan.triggers & ~TRIGGERS.IDLE) !== 0;
  if (!tradesNeeded) return { fees, slippage };

  if (plan.longUsdDelta < 0) {
    const r = sellWeth(p, -plan.longUsdDelta / m.price, m);
    p.reserve += r.usd;
    fees += r.fee;
    slippage += r.slippage;
  }
  let marginOut = plan.marginDelta < 0 ? -plan.marginDelta : 0;
  if (plan.marginDelta > 0) {
    const amt = Math.min(plan.marginDelta, p.reserve);
    p.reserve -= amt;
    p.perp.margin += amt;
  } else if (marginOut > 0) {
    marginOut -= withdrawFreeMargin(p, m, marginOut);
  }
  if (plan.longUsdDelta > 0) {
    const amt = Math.min(plan.longUsdDelta, p.reserve);
    p.reserve -= amt;
    const r = buyWeth(p, amt, m);
    fees += r.fee;
    slippage += r.slippage;
  }
  const target = -p.weth * (cfg.hedgeRatioBps / 10_000);
  const diff = target - p.perp.size;
  if (Math.abs(diff) >= 0.001) {
    const r = perpTrade(p, diff, m);
    fees += r.fee;
    slippage += r.slippage;
  }
  if (marginOut > 0) withdrawFreeMargin(p, m, marginOut);
  p.lastRebalanceAt = m.time;
  p.rebalances += 1;
  return { fees, slippage };
}

function freeMargin(p: Portfolio, m: MarketState): { free: number; excess: number } {
  if (p.perp.size === 0) return { free: Math.max(p.perp.margin, 0), excess: Math.max(p.perp.margin, 0) };
  const v = valuation(p, m);
  const imr = (v.shortNotional * m.venues.initialMarginBps) / 10_000;
  const excess = Math.max((v.perpEquityRaw - imr) * 0.99, 0);
  return { free: Math.min(Math.max(p.perp.margin, 0), excess), excess };
}

/** Mirror of StrategyManager._withdrawFreeMargin: crystallises unrealised profit when cash is short. */
function withdrawFreeMargin(p: Portfolio, m: MarketState, wanted: number): number {
  let { free, excess } = freeMargin(p, m);
  if (free < wanted && excess > free) {
    const upnl = p.perp.size * (m.price - p.perp.entry);
    if (upnl > 0) {
      const target = Math.min((Math.min(wanted, excess) - free) * 1.02, upnl);
      const q = (Math.abs(p.perp.size) * target) / upnl;
      if (q >= 0.001) {
        const close = p.perp.size < 0 ? q : -q;
        perpTrade(p, close, m);
        perpTrade(p, -close, m);
      }
    }
    ({ free } = freeMargin(p, m));
  }
  const w = Math.min(wanted, free);
  p.perp.margin -= w;
  p.reserve += w;
  return w;
}

