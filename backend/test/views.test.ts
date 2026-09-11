import { MAX_UINT256 } from "@dnv/shared";
import { describe, expect, it } from "vitest";

import { toSnapshotRow } from "../src/snapshot";
import { deltaView, feesView, leverageOf, pnlView, positionsView, riskView, strategyView, vaultView } from "../src/views";
import { clone, loadRawState } from "./helpers";

const s = loadRawState();

describe("view converters on real chain state", () => {
  it("vault view converts units", () => {
    const v = vaultView(s, 31337, "0xv", "0xa");
    expect(v.tvlUsd).toBeCloseTo(Number(s.vault.totalAssets) / 1e6, 6);
    expect(v.sharePrice).toBeGreaterThan(0.99);
    expect(v.sharePrice).toBeLessThan(1.1);
    expect(v.totalSupply).toBeCloseTo(Number(s.vault.totalSupply) / 1e12, 3);
  });

  it("positions: legs add up to NAV and leverage is notional / equity", () => {
    const p = positionsView(s, 31337);
    const nav = Number(s.snapshot.totalNav) / 1e6;
    const legs = p.reserve.suppliedUsd + p.long.valueUsd + p.perp.equityUsd + p.idle.vaultUsd + p.idle.strategyFloatUsd;
    expect(legs).toBeCloseTo(nav, 3);
    expect(p.perp.leverage).toBeCloseTo(p.perp.notionalUsd / p.perp.equityUsd, 6);
    const pctSum = p.allocation.reservePct + p.allocation.longPct + p.allocation.perpPct + p.allocation.idlePct;
    expect(pctSum).toBeCloseTo(1, 6);
    expect(p.perp.size).toBeLessThan(0); // short
    expect(p.perp.liquidationPrice!).toBeGreaterThan(p.perp.markPrice); // short liquidates on a rally
  });

  it("delta: net = long - short, and the required hedge change closes it", () => {
    const d = deltaView(s, 31337);
    expect(d.longExposureUsd - d.shortExposureUsd).toBeCloseTo(d.netDeltaUsd, 0);
    expect(d.requiredHedgeChangeUsd).toBeCloseTo(-d.netDeltaUsd, 0);
    expect(d.withinBand).toBe(Math.abs(d.deltaBps) <= d.effectiveBandBps);
    expect(d.effectiveBandBps).toBeLessThanOrEqual(d.bandBps);
  });

  it("pnl view reconciles to NAV", () => {
    const p = pnlView(s, 31337);
    expect(Math.abs(p.reconciliationResidualUsd)).toBeLessThan(0.01);
    const sum =
      p.lendingIncomeUsdc + p.lendingIncomeWeth + p.fundingIncome + p.spotRealizedPnl + p.spotUnrealizedPnl +
      p.perpRealizedPnl + p.perpUnrealizedPnl - p.tradingFees - p.slippage + p.badDebtAbsorbed;
    expect(sum).toBeCloseTo(p.strategyNetPnl, 3);
    expect(p.netPnlAfterFees).toBeCloseTo(p.strategyNetPnl - p.managementFees - p.performanceFees, 6);
  });

  it("fees: HWM is expressed as USDC per share, like the share price", () => {
    const f = feesView(s, 31337);
    expect(f.highWaterMark).toBeGreaterThan(0.99);
    expect(f.highWaterMark).toBeLessThan(1.1);
    expect(f.caps.performanceFeeBps).toBe(2000);
  });

  it("risk view carries all metrics with on-chain thresholds", () => {
    const r = riskView(s, 31337);
    expect(r.metrics.map((m) => m.key)).toEqual(["LEVERAGE", "DELTA", "DRAWDOWN", "LIQUIDATION", "COLLATERAL", "FUNDING", "EXPOSURE"]);
    const lev = r.metrics.find((m) => m.key === "LEVERAGE")!;
    expect(lev.thresholds.high).toBe(3.5);
    expect(r.oracle.status).toBe("OK");
  });

  it("strategy view decodes the plan", () => {
    const v = strategyView(s, 31337);
    expect(v.targets.leverage).toBe(2);
    expect(v.params.gasCostUsd).toBe(5);
    expect(Array.isArray(v.nextPlan.triggers)).toBe(true);
  });

  it("flat book: leverage 0, no liquidation price, uint256.max sentinels become null", () => {
    const f = clone(s);
    f.snapshot.perpSize = 0n;
    f.snapshot.shortNotional = 0n;
    f.liquidationReport.distanceBps = MAX_UINT256;
    f.liquidationReport.collateralRatioBps = MAX_UINT256;
    expect(leverageOf(f)).toBe(0);
    const p = positionsView(f, 31337);
    expect(p.perp.liquidationPrice).toBeNull();
    expect(p.perp.liquidationDistanceBps).toBeNull();
    expect(p.perp.collateralRatio).toBeNull();
  });

  it("snapshot row flattens every table's columns", () => {
    const row = toSnapshotRow(s);
    expect(row.blockNumber).toBe(Number(s.blockNumber));
    expect(row.pnl.strategyNav - row.pnl.netCapital - row.pnl.netPnl).toBeCloseTo(0, 2);
    expect(row.positions.perpSize).toBeLessThan(0);
    expect(row.oracleStatus).toBe("OK");
  });
});
