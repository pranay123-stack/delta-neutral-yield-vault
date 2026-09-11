import { ORACLE_STATUSES, RISK_STATES, fromFixed, price, qty, usd } from "@dnv/shared";

import type { Chain_ } from "./chain/clients";
import { type RawState, readRawState } from "./chain/reader";
import { type SnapshotRow, insertSnapshot } from "./db/repo";
import type { Db } from "./db/pool";
import { jsonLeverage, leverageOf } from "./views";

/** Flatten a RawState into the three snapshot tables. Pure. */
export function toSnapshotRow(s: RawState): SnapshotRow {
  const snap = s.snapshot;
  const p = s.pnl;
  const d = s.deltaReport;
  const liq = s.liquidationReport.distanceBps;
  return {
    blockNumber: Number(s.blockNumber),
    ts: Number(s.timestamp),
    tvlUsd: usd(s.vault.totalAssets),
    sharePrice: price(s.vault.sharePrice),
    totalSupply: fromFixed(s.vault.totalSupply, 12),
    idleUsd: usd(s.vault.idle),
    availableLiquidityUsd: usd(s.vault.liquidity),
    ethPrice: price(snap.price),
    oracleStatus: ORACLE_STATUSES[Number(s.oracle.status)] ?? "FEED_FAILURE",
    riskState: RISK_STATES[Number(s.risk.report.state)] ?? "EMERGENCY",
    riskFlags: Number(s.risk.report.flags),
    netDeltaBps: Number(d.deltaBps),
    netDeltaUsd: usd(d.netDeltaUsd),
    hedgeRatio: d.hedgeRatioBps >= 2n ** 255n ? 0 : Number(d.hedgeRatioBps) / 10_000,
    leverage: jsonLeverage(leverageOf(s)),
    liquidationDistanceBps: liq >= 2n ** 255n ? null : Number(liq),
    drawdownBps: Number(s.risk.report.drawdownBps),
    fundingRate8h: fromFixed(snap.fundingRatePer8h, 18),
    usdcSupplyApr: fromFixed(snap.usdcSupplyRate, 18),
    wethSupplyApr: fromFixed(snap.wethSupplyRate, 18),
    annualizedVolBps: Number(s.rebalance.annualizedVolBps),
    effectiveLeverage: Number(s.rebalance.effectiveLeverageBps) / 10_000,
    depositsPaused: s.emergency.depositsPaused,
    strategyPaused: s.emergency.strategyPaused,
    shutdown: s.emergency.shutdown,
    mgmtFeesUsd: usd(s.fees.totalMgmt),
    perfFeesUsd: usd(s.fees.totalPerf),
    positions: {
      reserveUsd: usd(snap.reserveAssets),
      longQty: qty(snap.longQty),
      longValueUsd: usd(snap.longValue),
      perpSize: fromFixed(snap.perpSize, 18),
      perpEntryPrice: price(s.perp.position.entryPrice),
      markPrice: price(snap.markPrice),
      perpMarginUsd: usd(snap.perpMargin),
      perpEquityUsd: usd(snap.perpEquity),
      perpUpnlUsd: usd(snap.perpUnrealizedPnl),
      pendingFundingUsd: usd(snap.perpPendingFunding),
      shortNotionalUsd: usd(snap.shortNotional),
      liquidationPrice: snap.perpSize === 0n ? null : price(snap.liquidationPrice),
      maintenanceMarginUsd: usd(snap.maintenanceMargin),
    },
    pnl: {
      lendingUsdc: usd(p.lendingIncomeUsdc),
      lendingWeth: usd(p.lendingIncomeWeth),
      funding: usd(p.fundingIncome),
      spotRealized: usd(p.spotRealizedPnl),
      spotUnrealized: usd(p.spotUnrealizedPnl),
      perpRealized: usd(p.perpRealizedPnl),
      perpUnrealized: usd(p.perpUnrealizedPnl),
      tradingFees: usd(p.tradingFees),
      slippage: usd(p.slippage),
      badDebtAbsorbed: usd(p.badDebtAbsorbed),
      netPnl: usd(p.netPnl),
      netCapital: usd(p.netCapital),
      strategyNav: usd(p.strategyNav),
    },
  };
}

export async function takeSnapshot(chain: Chain_, db: Db, blockNumber?: bigint): Promise<{ state: RawState; inserted: boolean }> {
  const state = await readRawState(chain, blockNumber);
  const inserted = await insertSnapshot(db, toSnapshotRow(state));
  return { state, inserted };
}
