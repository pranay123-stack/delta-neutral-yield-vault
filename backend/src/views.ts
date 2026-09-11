import {
  type ChainMeta,
  type DeltaView,
  type FeesView,
  MAX_UINT256,
  ORACLE_STATUSES,
  type PnlView,
  type PositionsView,
  REBALANCE_TRIGGERS,
  RISK_FLAGS,
  RISK_STATES,
  type RebalancePlanView,
  type RiskMetric,
  type RiskStateName,
  type RiskView,
  type StrategyView,
  type VaultView,
  decodeBits,
  fromFixed,
  price,
  qty,
  usd,
} from "@dnv/shared";

import type { RawState } from "./chain/reader";

/** Pure converters: raw on-chain state (bigints) -> API views (human units). */

const bpsToX = (b: bigint) => (b === MAX_UINT256 ? Number.POSITIVE_INFINITY : Number(b) / 10_000);
const finiteBps = (b: bigint) => (b === MAX_UINT256 ? null : Number(b));
const wad = (v: bigint) => fromFixed(v, 18);
const riskName = (n: number | bigint) => RISK_STATES[Number(n)] ?? "EMERGENCY";

export function meta(s: RawState, chainId: number): ChainMeta {
  return { chainId, blockNumber: Number(s.blockNumber), blockTimestamp: Number(s.timestamp) };
}

export function leverageOf(s: RawState): number {
  const snap = s.snapshot;
  if (snap.perpSize === 0n) return 0;
  if (snap.perpEquity === 0n) return Number.POSITIVE_INFINITY;
  return usd(snap.shortNotional) / usd(snap.perpEquity);
}

/** JSON can't carry Infinity: cap leverage for display. */
export const jsonLeverage = (x: number) => (Number.isFinite(x) ? x : 999);

export function vaultView(s: RawState, chainId: number, address: string, asset: string): VaultView {
  return {
    ...meta(s, chainId),
    address,
    asset,
    name: s.vault.name,
    symbol: s.vault.symbol,
    tvlUsd: usd(s.vault.totalAssets),
    sharePrice: price(s.vault.sharePrice),
    totalSupply: fromFixed(s.vault.totalSupply, 12),
    idleUsd: usd(s.vault.idle),
    availableLiquidityUsd: usd(s.vault.liquidity),
    depositCapUsd: usd(s.vault.depositCap),
    operational: s.vault.operational,
    depositsPaused: s.emergency.depositsPaused,
    strategyPaused: s.emergency.strategyPaused,
    shutdown: s.emergency.shutdown,
  };
}

export function positionsView(s: RawState, chainId: number): PositionsView {
  const snap = s.snapshot;
  const nav = usd(snap.totalNav);
  const pct = (x: bigint) => (nav > 0 ? usd(x) / nav : 0);
  const wethInterestQty = qty(s.lending.wethInterest);
  const lev = leverageOf(s);
  return {
    ...meta(s, chainId),
    ethPrice: price(snap.price),
    oracleHealthy: snap.priceHealthy,
    idle: { vaultUsd: usd(snap.vaultIdle), strategyFloatUsd: usd(snap.strategyFloat) },
    reserve: {
      suppliedUsd: usd(snap.reserveAssets),
      principalUsd: usd(s.lending.usdcPrincipal),
      interestUsd: usd(s.lending.usdcInterest),
      supplyApr: wad(snap.usdcSupplyRate),
      utilization: wad(s.lending.usdcUtilization),
      withdrawableUsd: usd(s.lending.usdcWithdrawable),
    },
    long: {
      wethQty: qty(snap.longQty),
      valueUsd: usd(snap.longValue),
      principalQty: qty(s.lending.wethPrincipal),
      interestQty: wethInterestQty,
      supplyApr: wad(snap.wethSupplyRate),
      utilization: wad(s.lending.wethUtilization),
      costBasisUsd: usd(s.accounting.spotCostBasis),
    },
    perp: {
      size: fromFixed(snap.perpSize, 18),
      entryPrice: price(s.perp.position.entryPrice),
      markPrice: price(snap.markPrice),
      markEntryPrice: price(s.perp.markAccounting.markEntryPrice),
      notionalUsd: usd(snap.shortNotional),
      marginUsd: usd(snap.perpMargin),
      equityUsd: usd(snap.perpEquity),
      unrealizedPnlUsd: usd(snap.perpUnrealizedPnl),
      pendingFundingUsd: usd(snap.perpPendingFunding),
      leverage: jsonLeverage(lev),
      liquidationPrice: snap.perpSize === 0n ? null : price(snap.liquidationPrice),
      liquidationDistanceBps: finiteBps(s.liquidationReport.distanceBps),
      maintenanceMarginUsd: usd(snap.maintenanceMargin),
      collateralRatio: s.liquidationReport.collateralRatioBps === MAX_UINT256 ? null : Number(s.liquidationReport.collateralRatioBps) / 10_000,
      fundingRatePer8h: wad(snap.fundingRatePer8h),
    },
    allocation: {
      reservePct: pct(snap.reserveAssets),
      longPct: pct(snap.longValue),
      perpPct: pct(snap.perpEquity),
      idlePct: pct(snap.vaultIdle + snap.strategyFloat),
    },
  };
}

export function deltaView(s: RawState, chainId: number): DeltaView {
  const r = s.deltaReport;
  const band = Number(s.rebalance.params.deltaBandBps);
  const vol = Number(s.rebalance.annualizedVolBps);
  const ref = Number(s.rebalance.params.volRefBps);
  const effective = vol > ref ? Math.max((band * ref) / vol, band / 4) : band;
  const deltaBps = Number(r.deltaBps);
  const changeQty = fromFixed(r.requiredPerpSizeChange, 18);
  return {
    ...meta(s, chainId),
    longExposureUsd: usd(r.longExposureUsd),
    shortExposureUsd: usd(r.shortExposureUsd),
    grossExposureUsd: usd(r.grossExposureUsd),
    netDeltaQty: fromFixed(r.netDeltaQty, 18),
    netDeltaUsd: usd(r.netDeltaUsd),
    deltaBps,
    hedgeRatioBps: r.hedgeRatioBps === MAX_UINT256 ? 0 : Number(r.hedgeRatioBps),
    targetPerpSize: fromFixed(r.targetPerpSize, 18),
    requiredPerpSizeChange: changeQty,
    requiredHedgeChangeUsd: changeQty * price(s.snapshot.price),
    bandBps: band,
    effectiveBandBps: Math.round(effective),
    withinBand: Math.abs(deltaBps) <= effective,
  };
}

function level(v: number | null, t: { warn: number; high: number; critical: number }, higherIsWorse: boolean): RiskStateName {
  if (v === null) return "NORMAL";
  if (higherIsWorse) return v >= t.critical ? "EMERGENCY" : v >= t.high ? "HIGH_RISK" : v >= t.warn ? "WARNING" : "NORMAL";
  return v <= t.critical ? "EMERGENCY" : v <= t.high ? "HIGH_RISK" : v <= t.warn ? "WARNING" : "NORMAL";
}

export function riskView(s: RawState, chainId: number): RiskView {
  const r = s.risk.report;
  const c = s.risk.config;
  const th = (x: { warn: number; high: number; critical: number }) => ({ warn: x.warn, high: x.high, critical: x.critical });
  const lev = finiteBps(r.leverageBps);
  const liq = finiteBps(r.liquidationDistanceBps);
  const coll = finiteBps(r.collateralRatioBps);
  const exposure = Math.max(Number(r.lendingExposureBps), Number(r.perpExposureBps));
  const funding = Number(r.fundingAprBps);
  const metrics: RiskMetric[] = [
    { key: "LEVERAGE", label: "Perp leverage", value: lev === null ? null : lev / 10_000, unit: "x", level: level(lev, th(c.leverage), true), thresholds: { warn: c.leverage.warn / 10_000, high: c.leverage.high / 10_000, critical: c.leverage.critical / 10_000 }, higherIsWorse: true },
    { key: "DELTA", label: "Net delta (% NAV)", value: Number(r.absDeltaBps), unit: "bps", level: level(Number(r.absDeltaBps), th(c.delta), true), thresholds: th(c.delta), higherIsWorse: true },
    { key: "DRAWDOWN", label: "Drawdown from peak", value: Number(r.drawdownBps), unit: "bps", level: level(Number(r.drawdownBps), th(c.drawdown), true), thresholds: th(c.drawdown), higherIsWorse: true },
    { key: "LIQUIDATION", label: "Distance to liquidation", value: liq, unit: "bps", level: level(liq, th(c.liquidationDistance), false), thresholds: th(c.liquidationDistance), higherIsWorse: false },
    { key: "COLLATERAL", label: "Equity / maintenance margin", value: coll === null ? null : coll / 10_000, unit: "x", level: level(coll, th(c.collateralRatio), false), thresholds: { warn: c.collateralRatio.warn / 10_000, high: c.collateralRatio.high / 10_000, critical: c.collateralRatio.critical / 10_000 }, higherIsWorse: false },
    { key: "FUNDING", label: "Funding APR", value: funding, unit: "apr", level: s.snapshot.perpSize === 0n ? "NORMAL" : funding < c.fundingHighAprBps ? "HIGH_RISK" : funding < c.fundingWarnAprBps ? "WARNING" : "NORMAL", thresholds: { warn: c.fundingWarnAprBps, high: c.fundingHighAprBps, critical: null }, higherIsWorse: false },
    { key: "EXPOSURE", label: "Largest venue exposure", value: exposure, unit: "bps", level: (() => { const l = level(exposure, th(c.protocolExposure), true); return l === "HIGH_RISK" || l === "EMERGENCY" ? "WARNING" : l; })(), thresholds: th(c.protocolExposure), higherIsWorse: true },
  ];
  return {
    ...meta(s, chainId),
    state: riskName(r.state),
    persistedState: riskName(s.risk.persistedState),
    flags: decodeBits(Number(r.flags), RISK_FLAGS),
    metrics,
    peakSharePrice: price(s.risk.peakSharePrice),
    oracle: {
      status: ORACLE_STATUSES[Number(s.oracle.status)] ?? "FEED_FAILURE",
      price: price(s.oracle.price),
      lastGoodPrice: price(s.oracle.lastGoodPrice),
      lastGoodAt: Number(s.oracle.lastGoodAt),
      shutdown: s.oracle.shutdown,
    },
    liquidation: {
      markPrice: price(s.liquidationReport.markPrice),
      liquidationPrice: s.snapshot.perpSize === 0n ? null : price(s.liquidationReport.liquidationPrice),
      distanceBps: liq,
      safetyBufferBps: finiteBps(s.liquidationReport.safetyBufferBps),
      leverage: jsonLeverage(bpsToX(s.liquidationReport.leverageBps)),
    },
    circuitBreakers: {
      depositsPaused: s.emergency.depositsPaused,
      strategyPaused: s.emergency.strategyPaused,
      shutdown: s.emergency.shutdown,
    },
    limits: { maxSlippageBps: c.maxSlippageBps, maxPositionNotionalUsd: usd(c.maxPositionNotional) },
  };
}

export function pnlView(s: RawState, chainId: number): PnlView {
  const p = s.pnl;
  const net = usd(p.netPnl);
  const mgmt = usd(s.fees.totalMgmt);
  const perf = usd(s.fees.totalPerf);
  return {
    ...meta(s, chainId),
    lendingIncomeUsdc: usd(p.lendingIncomeUsdc),
    lendingIncomeWeth: usd(p.lendingIncomeWeth),
    fundingIncome: usd(p.fundingIncome),
    spotRealizedPnl: usd(p.spotRealizedPnl),
    spotUnrealizedPnl: usd(p.spotUnrealizedPnl),
    perpRealizedPnl: usd(p.perpRealizedPnl),
    perpUnrealizedPnl: usd(p.perpUnrealizedPnl),
    tradingFees: usd(p.tradingFees),
    slippage: usd(p.slippage),
    badDebtAbsorbed: usd(p.badDebtAbsorbed),
    strategyNetPnl: net,
    managementFees: mgmt,
    performanceFees: perf,
    netPnlAfterFees: net - mgmt - perf,
    netCapital: usd(p.netCapital),
    strategyNav: usd(p.strategyNav),
    reconciliationResidualUsd: usd(p.strategyNav) - usd(p.netCapital) - net,
  };
}

export function feesView(s: RawState, chainId: number): FeesView {
  const f = s.fees;
  // HWM is stored as assets(6d) * 1e18 / shares(12d); x1e6 converts it to USDC per whole share
  const hwm = fromFixed(f.hwm * 1_000_000n, 18);
  const pps = price(s.vault.sharePrice);
  return {
    ...meta(s, chainId),
    managementFeeBps: Number(f.mgmtBps),
    performanceFeeBps: Number(f.perfBps),
    withdrawalFeeBps: Number(f.withdrawalBps),
    caps: { managementFeeBps: Number(f.caps.maxMgmt), performanceFeeBps: Number(f.caps.maxPerf), withdrawalFeeBps: Number(f.caps.maxWithdrawal) },
    highWaterMark: hwm,
    sharePrice: pps,
    aboveHighWaterMark: pps > hwm,
    totalManagementFeesUsd: usd(f.totalMgmt),
    totalPerformanceFeesUsd: usd(f.totalPerf),
    feeRecipient: f.feeRecipient,
    feeRecipientShares: fromFixed(f.feeRecipientShares, 12),
    feeRecipientValueUsd: usd(f.feeRecipientAssets),
    lastAccrual: Number(f.lastAccrual),
  };
}

export function planView(s: RawState): RebalancePlanView {
  const [plan, execute] = s.rebalance.preview;
  return {
    execute,
    urgent: plan.urgent,
    triggers: decodeBits(Number(plan.triggers), REBALANCE_TRIGGERS),
    sweepIdleUsd: usd(plan.sweepIdle),
    longUsdDelta: usd(plan.longUsdDelta),
    marginDelta: usd(plan.marginDelta),
    estimatedCostUsd: usd(plan.estimatedCost),
  };
}

export function strategyView(s: RawState, chainId: number): StrategyView {
  const t = s.rebalance.targets;
  const b = s.rebalance.bounds;
  const p = s.rebalance.params;
  const fundingAprBps = wad(s.snapshot.fundingRatePer8h) * 1095 * 10_000;
  return {
    ...meta(s, chainId),
    targets: {
      leverage: t.targetLeverageBps / 10_000,
      hedgeRatio: t.hedgeRatioBps / 10_000,
      reservePct: t.reserveBps / 10_000,
      defensiveReservePct: t.defensiveReserveBps / 10_000,
    },
    bounds: {
      minLeverage: b.minLeverageBps / 10_000,
      maxLeverage: b.maxLeverageBps / 10_000,
      minHedgeRatio: b.minHedgeRatioBps / 10_000,
      maxHedgeRatio: b.maxHedgeRatioBps / 10_000,
      minReservePct: b.minReserveBps / 10_000,
      maxReservePct: b.maxReserveBps / 10_000,
    },
    params: {
      deltaBandBps: p.deltaBandBps,
      leverageBandBps: p.leverageBandBps,
      allocationBandBps: p.allocationBandBps,
      minIntervalSec: p.minIntervalSec,
      maxCostBps: p.maxCostBps,
      carryHorizonSec: p.carryHorizonSec,
      volRefBps: p.volRefBps,
      fundingFloorAprBps: p.fundingFloorAprBps,
      minTradeUsd: usd(p.minTradeUsd),
      minDeployUsd: usd(p.minDeployUsd),
      gasCostUsd: usd(p.gasCostUsd),
    },
    effectiveLeverage: Number(s.rebalance.effectiveLeverageBps) / 10_000,
    annualizedVolBps: Number(s.rebalance.annualizedVolBps),
    defensive: fundingAprBps < p.fundingFloorAprBps,
    lastRebalanceAt: Number(s.rebalance.lastRebalanceAt),
    rebalanceCount: Number(s.rebalance.rebalanceCount),
    nextPlan: planView(s),
  };
}
