/**
 * Default configuration. Every number mirrors script/ProtocolDeployer.sol so that the simulator,
 * the optimizer and the on-chain system describe the *same* strategy. If you change a default on
 * chain, change it here (the backend's /strategy endpoint reports the live on-chain values).
 */

export const SECONDS_PER_YEAR = 365 * 24 * 3600;
export const FUNDING_PERIOD_SEC = 8 * 3600;
export const HOUR = 3600;
export const DAY = 24 * HOUR;

export interface RateModel {
  baseRate: number;
  slope1: number;
  slope2: number;
  optimalUtilization: number;
  reserveFactor: number;
}

export interface VenueParams {
  perpTakerFeeBps: number;
  perpSpreadBps: number;
  perpDepthUsd: number;
  perpMaxImpactBps: number;
  initialMarginBps: number;
  maintenanceMarginBps: number;
  liquidationPenaltyBps: number;
  dexFeeBps: number;
  dexSpreadBps: number;
  dexDepthUsd: number;
  dexMaxImpactBps: number;
  usdcRateModel: RateModel;
  wethRateModel: RateModel;
}

export interface Threshold {
  warn: number;
  high: number;
  critical: number;
}

export interface StrategyConfig {
  targetLeverageBps: number;
  hedgeRatioBps: number;
  reserveBps: number;
  defensiveReserveBps: number;
  minLeverageBps: number;
  deltaBandBps: number;
  leverageBandBps: number;
  allocationBandBps: number;
  minIntervalSec: number;
  maxCostBps: number;
  carryHorizonSec: number;
  volRefBps: number;
  fundingFloorAprBps: number;
  minTradeUsd: number;
  minDeployUsd: number;
  gasCostUsd: number;
  maxSlippageBps: number;
  managementFeeBps: number;
  performanceFeeBps: number;
  /** "allocationOnly" (default, = on-chain): leverage triggers only move margin; the long leg is
   *  resized on allocation drift. "full": any allocation/leverage trigger resets every leg. Monte
   *  Carlo shows no material difference (~1% fewer rebalances), so the cheaper on-chain rule stays. */
  resetPolicy?: "full" | "allocationOnly";
  risk: {
    leverage: Threshold; // bps
    delta: Threshold; // bps of NAV
    drawdown: Threshold; // bps
    liquidationDistance: Threshold; // bps, lower is worse
  };
}

export const DEFAULT_VENUES: VenueParams = {
  perpTakerFeeBps: 5,
  perpSpreadBps: 2,
  perpDepthUsd: 1_000_000_000,
  perpMaxImpactBps: 200,
  initialMarginBps: 1000,
  maintenanceMarginBps: 500,
  liquidationPenaltyBps: 100,
  dexFeeBps: 5,
  dexSpreadBps: 2,
  dexDepthUsd: 500_000_000,
  dexMaxImpactBps: 500,
  usdcRateModel: { baseRate: 0, slope1: 0.08, slope2: 0.6, optimalUtilization: 0.9, reserveFactor: 0.1 },
  wethRateModel: { baseRate: 0, slope1: 0.05, slope2: 0.8, optimalUtilization: 0.8, reserveFactor: 0.15 },
};

export const DEFAULT_STRATEGY: StrategyConfig = {
  targetLeverageBps: 20_000,
  hedgeRatioBps: 10_000,
  reserveBps: 1000,
  defensiveReserveBps: 7000,
  minLeverageBps: 10_000,
  deltaBandBps: 200,
  leverageBandBps: 2500,
  allocationBandBps: 500,
  minIntervalSec: HOUR,
  maxCostBps: 50,
  carryHorizonSec: 30 * DAY,
  volRefBps: 6000,
  fundingFloorAprBps: -500,
  minTradeUsd: 1000,
  minDeployUsd: 1000,
  gasCostUsd: 5,
  maxSlippageBps: 100,
  managementFeeBps: 50,
  performanceFeeBps: 1000,
  risk: {
    leverage: { warn: 25_000, high: 35_000, critical: 50_000 },
    delta: { warn: 200, high: 500, critical: 1000 },
    drawdown: { warn: 200, high: 500, critical: 1000 },
    liquidationDistance: { warn: 3000, high: 2000, critical: 1000 },
  },
};

/** Base market used by scenarios and the optimizer (matches the deploy-time seed state). */
export const BASE_MARKET = {
  price: 3000,
  fundingRatePer8h: 0.0001, // 0.01% / 8h ~ 10.95% APR
  usdcUtilization: 0.8,
  wethUtilization: 0.6,
};
