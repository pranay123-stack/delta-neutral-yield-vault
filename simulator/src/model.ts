import { FUNDING_PERIOD_SEC, SECONDS_PER_YEAR, type StrategyConfig, type VenueParams } from "./config";
import { supplyRate } from "./rates";

/**
 * Float-precision model of the vault + strategy + venues. It mirrors the on-chain maths
 * (PerpMath, MockPerpetualMarket, MockSpotDEX, MockLendingProtocol, FeeManager) closely enough to
 * reproduce on-chain outcomes to within fractions of a basis point, while running thousands of
 * paths per second for scenarios, the optimizer and Monte Carlo.
 */

export interface MarketState {
  time: number; // seconds
  price: number; // ETH/USD
  fundingRatePer8h: number; // fraction, + = longs pay shorts
  usdcUtilization: number;
  wethUtilization: number;
  oracleHealthy: boolean;
  venues: VenueParams;
}

export interface PerpPosition {
  size: number; // ETH, negative = short
  entry: number; // execution-price average entry
  markEntry: number; // mark-price average entry (for clean attribution)
  margin: number; // USD, may go negative before liquidation resolves it
}

/** Cumulative PnL attribution, USD. Mirrors Types.PnLBreakdown. */
export interface Ledger {
  lendingUsdc: number;
  lendingWeth: number;
  funding: number;
  spotRealized: number;
  perpRealizedAtMark: number;
  tradingFees: number;
  slippage: number;
  liquidationPenalties: number;
  badDebtAbsorbed: number;
  managementFees: number;
  performanceFees: number;
}

export interface Portfolio {
  idle: number; // USD in the vault
  reserve: number; // USD supplied to lending
  weth: number; // ETH supplied to lending (long leg)
  spotCostBasis: number; // mid-price cost of held WETH
  perp: PerpPosition;
  ledger: Ledger;
  netCapital: number; // user deposits - withdrawals
  shares: number; // user shares (1 share = 1 USD at inception)
  feeShares: number; // shares minted to the fee recipient
  hwm: number; // share price high-water mark
  lastFeeAccrual: number;
  lastRebalanceAt: number;
  vol: { ewmaVar: number; lastPrice: number; lastTime: number };
  rebalances: number;
  liquidations: number;
}

export interface Valuation {
  price: number;
  longValue: number;
  perpEquityRaw: number;
  perpEquity: number;
  unrealizedPnl: number;
  shortNotional: number;
  strategyNav: number;
  nav: number;
  sharePrice: number;
  netDeltaQty: number;
  netDeltaUsd: number;
  deltaBps: number;
  hedgeRatio: number;
  leverage: number; // Infinity if equity 0 with an open position
  liquidationPrice: number | null;
  liquidationDistanceBps: number | null;
  maintenanceMargin: number;
}

export function emptyLedger(): Ledger {
  return {
    lendingUsdc: 0,
    lendingWeth: 0,
    funding: 0,
    spotRealized: 0,
    perpRealizedAtMark: 0,
    tradingFees: 0,
    slippage: 0,
    liquidationPenalties: 0,
    badDebtAbsorbed: 0,
    managementFees: 0,
    performanceFees: 0,
  };
}

export function newPortfolio(tvl: number, t0: number, volRefBps: number): Portfolio {
  const refVol = volRefBps / 10_000;
  return {
    idle: tvl,
    reserve: 0,
    weth: 0,
    spotCostBasis: 0,
    perp: { size: 0, entry: 0, markEntry: 0, margin: 0 },
    ledger: emptyLedger(),
    netCapital: tvl,
    shares: tvl,
    feeShares: 0,
    hwm: 1,
    lastFeeAccrual: t0,
    lastRebalanceAt: -Infinity,
    vol: { ewmaVar: refVol * refVol, lastPrice: 0, lastTime: t0 },
    rebalances: 0,
    liquidations: 0,
  };
}

export function clonePortfolio(p: Portfolio): Portfolio {
  return structuredClone(p);
}

// ---------------------------------------------------------------------------
// Pure maths (PerpMath mirror)
// ---------------------------------------------------------------------------

export function pnl(size: number, entry: number, price: number): number {
  return size * (price - entry);
}

export function applyTrade(size: number, entry: number, delta: number, price: number) {
  const newSize = size + delta;
  if (size === 0 || Math.sign(size) === Math.sign(delta)) {
    const newEntry = newSize === 0 ? 0 : (Math.abs(size) * entry + Math.abs(delta) * price) / Math.abs(newSize);
    return { newSize, newEntry, realized: 0 };
  }
  const closeQty = Math.min(Math.abs(delta), Math.abs(size));
  const realized = pnl(Math.sign(size) * closeQty, entry, price);
  let newEntry = entry;
  if (Math.abs(newSize) < 1e-12) newEntry = 0;
  else if (Math.sign(newSize) !== Math.sign(size)) newEntry = price;
  return { newSize: Math.abs(newSize) < 1e-12 ? 0 : newSize, newEntry, realized };
}

/** long: P = (sE - M)/(s(1-mm));  short: P = (M + sE)/(s(1+mm)). */
export function liquidationPrice(size: number, entry: number, margin: number, mmBps: number): number | null {
  if (size === 0) return null;
  const s = Math.abs(size);
  const mm = mmBps / 10_000;
  if (size > 0) {
    const num = s * entry - margin;
    return num <= 0 ? null : num / (s * (1 - mm));
  }
  const num = margin + s * entry;
  return num <= 0 ? 0 : num / (s * (1 + mm));
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

export function valuation(p: Portfolio, m: MarketState): Valuation {
  const price = m.price;
  const longValue = p.weth * price;
  const unrealizedPnl = pnl(p.perp.size, p.perp.entry, price);
  const perpEquityRaw = p.perp.margin + unrealizedPnl;
  const perpEquity = Math.max(perpEquityRaw, 0);
  const shortNotional = Math.abs(p.perp.size) * price;
  const strategyNav = p.reserve + longValue + perpEquity;
  const nav = strategyNav + p.idle;
  const supply = p.shares + p.feeShares;
  const netDeltaQty = p.weth + p.perp.size;
  const netDeltaUsd = netDeltaQty * price;
  const liq = liquidationPrice(p.perp.size, p.perp.entry, p.perp.margin, m.venues.maintenanceMarginBps);
  let liqDist: number | null = null;
  if (p.perp.size !== 0 && liq !== null) {
    liqDist = p.perp.size < 0 ? Math.max(0, ((liq - price) / price) * 10_000) : Math.max(0, ((price - liq) / price) * 10_000);
  }
  return {
    price,
    longValue,
    perpEquityRaw,
    perpEquity,
    unrealizedPnl,
    shortNotional,
    strategyNav,
    nav,
    sharePrice: supply > 0 ? nav / supply : 1,
    netDeltaQty,
    netDeltaUsd,
    deltaBps: nav > 0 ? (netDeltaUsd / nav) * 10_000 : 0,
    hedgeRatio: p.weth > 0 ? Math.abs(Math.min(p.perp.size, 0)) / p.weth : 0,
    leverage: p.perp.size === 0 ? 0 : perpEquity > 0 ? shortNotional / perpEquity : Infinity,
    liquidationPrice: liq,
    liquidationDistanceBps: liqDist,
    maintenanceMargin: (shortNotional * m.venues.maintenanceMarginBps) / 10_000,
  };
}

export function supplyAprs(m: MarketState) {
  return {
    usdc: supplyRate(m.venues.usdcRateModel, m.usdcUtilization),
    weth: supplyRate(m.venues.wethRateModel, m.wethUtilization),
  };
}

/** Attributed PnL. `strategyNetPnl` reconciles with (strategyNav + idle) - netCapital, before vault fees. */
export function pnlBreakdown(p: Portfolio, m: MarketState) {
  const v = valuation(p, m);
  const l = p.ledger;
  const spotUnrealized = v.longValue - p.spotCostBasis;
  const perpUnrealizedAtMark = pnl(p.perp.size, p.perp.markEntry, m.price);
  const clamp = v.perpEquityRaw < 0 ? -v.perpEquityRaw : 0;
  const strategyNetPnl =
    l.lendingUsdc +
    l.funding +
    l.spotRealized +
    spotUnrealized +
    l.perpRealizedAtMark +
    perpUnrealizedAtMark -
    l.tradingFees -
    l.slippage -
    l.liquidationPenalties +
    l.badDebtAbsorbed +
    clamp;
  return {
    lendingIncomeUsdc: l.lendingUsdc,
    lendingIncomeWeth: l.lendingWeth,
    fundingIncome: l.funding,
    spotRealizedPnl: l.spotRealized,
    spotUnrealizedPnl: spotUnrealized - l.lendingWeth,
    perpRealizedPnl: l.perpRealizedAtMark,
    perpUnrealizedPnl: perpUnrealizedAtMark,
    tradingFees: l.tradingFees + l.liquidationPenalties,
    slippage: l.slippage,
    badDebtAbsorbed: l.badDebtAbsorbed + clamp,
    strategyNetPnl,
    managementFees: l.managementFees,
    performanceFees: l.performanceFees,
    hedgePnl: l.perpRealizedAtMark + perpUnrealizedAtMark,
    reconciliationResidual: v.nav - p.netCapital - strategyNetPnl,
  };
}

// ---------------------------------------------------------------------------
// Time: interest + funding
// ---------------------------------------------------------------------------

/** Accrue `dt` seconds of lending interest and funding at the current market state. */
export function accrue(p: Portfolio, m: MarketState, dt: number): void {
  if (dt <= 0) return;
  const aprs = supplyAprs(m);
  const usdcInterest = (p.reserve * aprs.usdc * dt) / SECONDS_PER_YEAR;
  p.reserve += usdcInterest;
  p.ledger.lendingUsdc += usdcInterest;

  const wethInterest = (p.weth * aprs.weth * dt) / SECONDS_PER_YEAR;
  p.weth += wethInterest;
  p.ledger.lendingWeth += wethInterest * m.price;

  if (p.perp.size !== 0) {
    // longs pay shorts when the rate is positive
    const funding = (-p.perp.size * m.fundingRatePer8h * m.price * dt) / FUNDING_PERIOD_SEC;
    p.perp.margin += funding;
    p.ledger.funding += funding;
  }
}

// ---------------------------------------------------------------------------
// Execution (venue mirrors)
// ---------------------------------------------------------------------------

function impact(spreadBps: number, notional: number, depth: number, maxBps: number): number {
  const i = spreadBps / 10_000 + (depth > 0 ? notional / depth : 0);
  return Math.min(i, maxBps / 10_000);
}

export function perpExecPrice(sizeDelta: number, mark: number, v: VenueParams): number {
  const i = impact(v.perpSpreadBps, Math.abs(sizeDelta) * mark, v.perpDepthUsd, v.perpMaxImpactBps);
  return sizeDelta > 0 ? mark * (1 + i) : mark * (1 - i);
}

export function quoteBuyWeth(usdIn: number, price: number, v: VenueParams): { qty: number; fee: number } {
  const fee = (usdIn * v.dexFeeBps) / 10_000;
  const net = usdIn - fee;
  const i = impact(v.dexSpreadBps, net, v.dexDepthUsd, v.dexMaxImpactBps);
  return { qty: (net / price) * (1 - i), fee };
}

export function quoteSellWeth(qty: number, price: number, v: VenueParams): { usd: number; feeQty: number } {
  const feeQty = (qty * v.dexFeeBps) / 10_000;
  const notional = (qty - feeQty) * price;
  const i = impact(v.dexSpreadBps, notional, v.dexDepthUsd, v.dexMaxImpactBps);
  return { usd: notional * (1 - i), feeQty };
}

export function perpTrade(p: Portfolio, sizeDelta: number, m: MarketState): { fee: number; slippage: number } {
  if (sizeDelta === 0) return { fee: 0, slippage: 0 };
  const mark = m.price;
  const exec = perpExecPrice(sizeDelta, mark, m.venues);
  const venue = applyTrade(p.perp.size, p.perp.entry, sizeDelta, exec);
  const atMark = applyTrade(p.perp.size, p.perp.markEntry, sizeDelta, mark);
  const fee = (Math.abs(sizeDelta) * exec * m.venues.perpTakerFeeBps) / 10_000;
  const slippage = Math.abs(exec - mark) * Math.abs(sizeDelta);
  p.perp.size = venue.newSize;
  p.perp.entry = venue.newEntry;
  p.perp.markEntry = atMark.newEntry;
  p.perp.margin += venue.realized - fee;
  p.ledger.perpRealizedAtMark += atMark.realized;
  p.ledger.tradingFees += fee;
  p.ledger.slippage += slippage;
  return { fee, slippage };
}

export function buyWeth(p: Portfolio, usdIn: number, m: MarketState): { fee: number; slippage: number } {
  const q = quoteBuyWeth(usdIn, m.price, m.venues);
  const mid = q.qty * m.price;
  const slippage = usdIn - mid - q.fee;
  p.weth += q.qty;
  p.spotCostBasis += mid;
  p.ledger.tradingFees += q.fee;
  p.ledger.slippage += slippage;
  return { fee: q.fee, slippage };
}

export function sellWeth(p: Portfolio, qty: number, m: MarketState): { usd: number; fee: number; slippage: number } {
  qty = Math.min(qty, p.weth);
  if (qty <= 0) return { usd: 0, fee: 0, slippage: 0 };
  const q = quoteSellWeth(qty, m.price, m.venues);
  const mid = qty * m.price;
  const feeUsd = q.feeQty * m.price;
  const slippage = mid - q.usd - feeUsd;
  const basisPortion = (p.spotCostBasis * qty) / p.weth;
  p.spotCostBasis -= basisPortion;
  p.ledger.spotRealized += mid - basisPortion;
  p.weth -= qty;
  p.ledger.tradingFees += feeUsd;
  p.ledger.slippage += slippage;
  return { usd: q.usd, fee: feeUsd, slippage };
}

// ---------------------------------------------------------------------------
// Venue liquidation
// ---------------------------------------------------------------------------

export function isLiquidatable(p: Portfolio, m: MarketState): boolean {
  if (p.perp.size === 0) return false;
  const equity = p.perp.margin + pnl(p.perp.size, p.perp.entry, m.price);
  return equity < (Math.abs(p.perp.size) * m.price * m.venues.maintenanceMarginBps) / 10_000;
}

/** Venue closes the position at mark, charges the penalty, writes off negative margin as bad debt. */
export function liquidate(p: Portfolio, m: MarketState): { penalty: number; badDebt: number } {
  const size = p.perp.size;
  const venue = applyTrade(size, p.perp.entry, -size, m.price);
  const atMark = applyTrade(size, p.perp.markEntry, -size, m.price);
  p.perp.margin += venue.realized;
  p.ledger.perpRealizedAtMark += atMark.realized;
  const notional = Math.abs(size) * m.price;
  const penalty = Math.min((notional * m.venues.liquidationPenaltyBps) / 10_000, Math.max(p.perp.margin, 0));
  p.perp.margin -= penalty;
  p.ledger.liquidationPenalties += penalty;
  let badDebt = 0;
  if (p.perp.margin < 0) {
    badDebt = -p.perp.margin;
    p.perp.margin = 0;
    p.ledger.badDebtAbsorbed += badDebt;
  }
  p.perp = { size: 0, entry: 0, markEntry: 0, margin: p.perp.margin };
  p.liquidations += 1;
  return { penalty, badDebt };
}

// ---------------------------------------------------------------------------
// Vault fees (FeeManager mirror: dilution, HWM, perf net of mgmt)
// ---------------------------------------------------------------------------

export function accrueFees(p: Portfolio, m: MarketState, cfg: StrategyConfig): void {
  const dt = m.time - p.lastFeeAccrual;
  p.lastFeeAccrual = m.time;
  const supply = p.shares + p.feeShares;
  if (supply <= 0) return;
  const nav = valuation(p, m).nav;
  let mgmtShares = 0;
  if (dt > 0 && cfg.managementFeeBps > 0) {
    const f = (cfg.managementFeeBps / 10_000) * (dt / SECONDS_PER_YEAR);
    mgmtShares = (supply * f) / (1 - f);
  }
  const s1 = supply + mgmtShares;
  const pps = nav / s1;
  let perfShares = 0;
  if (pps > p.hwm) {
    const feeAssets = ((pps - p.hwm) * s1 * cfg.performanceFeeBps) / 10_000;
    if (feeAssets > 0 && feeAssets < nav) perfShares = (feeAssets * s1) / (nav - feeAssets);
    p.hwm = nav / (s1 + perfShares);
  }
  const totalAfter = s1 + perfShares;
  p.ledger.managementFees += (mgmtShares * nav) / totalAfter;
  p.ledger.performanceFees += (perfShares * nav) / totalAfter;
  p.feeShares += mgmtShares + perfShares;
}

/** Share price net of fees (what a depositor's share is worth). */
export function sharePrice(p: Portfolio, m: MarketState): number {
  return valuation(p, m).sharePrice;
}
