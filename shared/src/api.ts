/**
 * REST API response contracts. The backend builds these from chain reads + Postgres; the frontend
 * consumes them. All money is in human units (USD as JS numbers, ETH as numbers), ratios in bps.
 */

export type RiskStateName = "NORMAL" | "WARNING" | "HIGH_RISK" | "EMERGENCY";
export const RISK_STATES: RiskStateName[] = ["NORMAL", "WARNING", "HIGH_RISK", "EMERGENCY"];

export type OracleStatusName =
  | "OK"
  | "FALLBACK"
  | "STALE"
  | "INVALID_PRICE"
  | "INCOMPLETE_ROUND"
  | "DEVIATION"
  | "DECIMALS_MISMATCH"
  | "FEED_FAILURE"
  | "SHUTDOWN"
  | "NOT_CONFIGURED";
export const ORACLE_STATUSES: OracleStatusName[] = [
  "OK",
  "FALLBACK",
  "STALE",
  "INVALID_PRICE",
  "INCOMPLETE_ROUND",
  "DEVIATION",
  "DECIMALS_MISMATCH",
  "FEED_FAILURE",
  "SHUTDOWN",
  "NOT_CONFIGURED",
];

export const REBALANCE_TRIGGERS = [
  "DELTA",
  "LEVERAGE_HIGH",
  "LEVERAGE_LOW",
  "ALLOCATION",
  "IDLE",
  "LIQUIDATION",
  "FUNDING_DEFENSIVE",
] as const;
export type RebalanceTrigger = (typeof REBALANCE_TRIGGERS)[number];

export const RISK_FLAGS = [
  "LEVERAGE",
  "DELTA",
  "DRAWDOWN",
  "LIQUIDATION",
  "COLLATERAL",
  "FUNDING",
  "EXPOSURE",
  "ORACLE",
  "POSITION_SIZE",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export function decodeBits<T extends string>(mask: number, names: readonly T[]): T[] {
  return names.filter((_, i) => (mask & (1 << i)) !== 0);
}

export interface ChainMeta {
  chainId: number;
  blockNumber: number;
  blockTimestamp: number; // chain time (the demo warps time, so this is the simulated clock)
}

export interface VaultView extends ChainMeta {
  address: string;
  asset: string;
  name: string;
  symbol: string;
  tvlUsd: number;
  sharePrice: number; // USDC per share
  totalSupply: number; // shares
  idleUsd: number;
  availableLiquidityUsd: number;
  depositCapUsd: number;
  operational: boolean;
  depositsPaused: boolean;
  strategyPaused: boolean;
  shutdown: boolean;
}

export interface VaultMetrics extends ChainMeta {
  tvlUsd: number;
  sharePrice: number;
  netApy: number | null; // realised, annualised from share price history (fraction)
  grossApy: number | null; // realised before fees and trading costs
  estimatedNetApy: number; // forward-looking, from current rates (simulator estimation engine)
  lendingApy: number; // blended USDC + WETH supply APR on deployed capital (fraction)
  usdcSupplyApr: number;
  wethSupplyApr: number;
  fundingRatePer8h: number; // fraction
  fundingApr: number; // fraction
  netDeltaBps: number;
  netDeltaUsd: number;
  hedgeRatio: number; // short / long
  leverage: number; // perp notional / perp equity
  liquidationDistanceBps: number | null;
  drawdownBps: number;
  totalPnlUsd: number;
  riskState: RiskStateName;
  ethPrice: number;
}

export interface PositionsView extends ChainMeta {
  ethPrice: number;
  oracleHealthy: boolean;
  idle: { vaultUsd: number; strategyFloatUsd: number };
  reserve: {
    suppliedUsd: number;
    principalUsd: number;
    interestUsd: number;
    supplyApr: number;
    utilization: number;
    withdrawableUsd: number;
  };
  long: {
    wethQty: number;
    valueUsd: number;
    principalQty: number;
    interestQty: number;
    supplyApr: number;
    utilization: number;
    costBasisUsd: number;
  };
  perp: {
    size: number; // ETH, negative = short
    entryPrice: number;
    markPrice: number;
    markEntryPrice: number;
    notionalUsd: number;
    marginUsd: number;
    equityUsd: number;
    unrealizedPnlUsd: number;
    pendingFundingUsd: number;
    leverage: number;
    liquidationPrice: number | null;
    liquidationDistanceBps: number | null;
    maintenanceMarginUsd: number;
    collateralRatio: number | null; // equity / maintenance margin
    fundingRatePer8h: number;
  };
  allocation: { reservePct: number; longPct: number; perpPct: number; idlePct: number };
}

export interface DeltaView extends ChainMeta {
  longExposureUsd: number;
  shortExposureUsd: number;
  grossExposureUsd: number;
  netDeltaQty: number;
  netDeltaUsd: number;
  deltaBps: number;
  hedgeRatioBps: number;
  targetPerpSize: number;
  requiredPerpSizeChange: number;
  requiredHedgeChangeUsd: number;
  bandBps: number; // configured tolerance
  effectiveBandBps: number; // after volatility scaling
  withinBand: boolean;
}

export interface RiskMetric {
  key: RiskFlag;
  label: string;
  value: number | null;
  unit: "bps" | "x" | "apr";
  level: RiskStateName;
  thresholds: { warn: number; high: number; critical: number | null };
  higherIsWorse: boolean;
}

export interface RiskView extends ChainMeta {
  state: RiskStateName;
  persistedState: RiskStateName; // last checkpointed state
  flags: RiskFlag[];
  metrics: RiskMetric[];
  peakSharePrice: number;
  oracle: {
    status: OracleStatusName;
    price: number;
    lastGoodPrice: number;
    lastGoodAt: number;
    shutdown: boolean;
  };
  liquidation: {
    markPrice: number;
    liquidationPrice: number | null;
    distanceBps: number | null;
    safetyBufferBps: number | null;
    leverage: number;
  };
  circuitBreakers: { depositsPaused: boolean; strategyPaused: boolean; shutdown: boolean };
  limits: { maxSlippageBps: number; maxPositionNotionalUsd: number };
}

export interface FundingPoint {
  ts: number;
  ratePer8h: number;
  cumulativeFundingUsd: number;
}

export interface FundingView extends ChainMeta {
  ratePer8h: number;
  apr: number;
  settledFundingUsd: number;
  pendingFundingUsd: number;
  cumulativeFundingUsd: number;
  shortNotionalUsd: number;
  annualizedIncomeUsd: number; // at current rate and size
  history: FundingPoint[];
  settlements: { ts: number; blockNumber: number; amountUsd: number; txHash: string }[];
}

export interface PnlView extends ChainMeta {
  lendingIncomeUsdc: number;
  lendingIncomeWeth: number;
  fundingIncome: number;
  spotRealizedPnl: number;
  spotUnrealizedPnl: number;
  perpRealizedPnl: number;
  perpUnrealizedPnl: number;
  tradingFees: number;
  slippage: number;
  badDebtAbsorbed: number;
  strategyNetPnl: number; // before vault fees
  managementFees: number;
  performanceFees: number;
  netPnlAfterFees: number;
  netCapital: number;
  strategyNav: number;
  reconciliationResidualUsd: number; // strategyNav - netCapital - strategyNetPnl (should be ~0)
}

export interface FeesView extends ChainMeta {
  managementFeeBps: number;
  performanceFeeBps: number;
  withdrawalFeeBps: number;
  caps: { managementFeeBps: number; performanceFeeBps: number; withdrawalFeeBps: number };
  highWaterMark: number; // share price
  sharePrice: number;
  aboveHighWaterMark: boolean;
  totalManagementFeesUsd: number;
  totalPerformanceFeesUsd: number;
  feeRecipient: string;
  feeRecipientShares: number;
  feeRecipientValueUsd: number;
  lastAccrual: number;
}

export interface RebalancePlanView {
  execute: boolean;
  urgent: boolean;
  triggers: RebalanceTrigger[];
  sweepIdleUsd: number;
  longUsdDelta: number;
  marginDelta: number;
  estimatedCostUsd: number;
}

export interface StrategyView extends ChainMeta {
  targets: { leverage: number; hedgeRatio: number; reservePct: number; defensiveReservePct: number };
  bounds: {
    minLeverage: number;
    maxLeverage: number;
    minHedgeRatio: number;
    maxHedgeRatio: number;
    minReservePct: number;
    maxReservePct: number;
  };
  params: {
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
  };
  effectiveLeverage: number;
  annualizedVolBps: number;
  defensive: boolean;
  lastRebalanceAt: number;
  rebalanceCount: number;
  nextPlan: RebalancePlanView;
}

export interface PerformancePoint {
  ts: number;
  blockNumber: number;
  tvlUsd: number;
  sharePrice: number;
  ethPrice: number;
  netDeltaBps: number;
  leverage: number;
  liquidationDistanceBps: number | null;
  drawdownBps: number;
  fundingRatePer8h: number;
  usdcSupplyApr: number;
  wethSupplyApr: number;
  strategyNetPnl: number;
  fundingIncome: number;
  lendingIncome: number;
  tradingCosts: number;
  riskState: RiskStateName;
  apy7d: number | null;
  apy30d: number | null;
}

export interface PerformanceView {
  points: PerformancePoint[];
  summary: {
    fromTs: number;
    toTs: number;
    sharePriceStart: number;
    sharePriceEnd: number;
    periodReturn: number; // fraction
    annualizedReturn: number | null;
    maxDrawdownBps: number;
    volatilityAnnual: number | null; // of daily share-price returns
    sharpe: number | null;
    rebalances: number;
  };
}

export interface RebalanceRecordView {
  id: number;
  ts: number;
  blockNumber: number;
  txHash: string;
  triggers: RebalanceTrigger[];
  urgent: boolean;
  longUsdDelta: number;
  marginDelta: number;
  perpSizeChange: number;
  preDeltaBps: number;
  postDeltaBps: number;
  preLeverage: number;
  postLeverage: number;
  estimatedCostUsd: number;
  realizedCostUsd: number;
}

export type AlertSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface AlertView {
  id: number;
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  value: number | null;
  threshold: number | null;
  openedAt: number; // chain time
  resolvedAt: number | null;
  active: boolean;
}

export interface TransactionView {
  id: number;
  kind: "DEPOSIT" | "WITHDRAW";
  ts: number;
  blockNumber: number;
  txHash: string;
  sender: string;
  owner: string;
  receiver: string;
  assetsUsd: number;
  shares: number;
}

export interface HealthView {
  ok: boolean;
  chain: { connected: boolean; blockNumber: number | null; chainId: number | null };
  db: { connected: boolean };
  indexer: { lastBlock: number | null; lagBlocks: number | null };
  keeper: { enabled: boolean; lastRunAt: number | null; lastAction: string | null };
}
