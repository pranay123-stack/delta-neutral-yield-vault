import { describe, expect, it } from "vitest";

import {
  DEFAULT_STRATEGY,
  HOUR,
  Rng,
  SCENARIOS,
  estimateApy,
  generateMarketPath,
  monteCarlo,
  optimize,
  runAllScenarios,
  runCustomScenario,
  simulate,
  touchProbability,
} from "../src";

const BASE = { usdcSupplyApr: 0.0512, wethSupplyApr: 0.019125, fundingRatePer8h: 0.0001, volAnnual: 0.6 };

describe("scenario engine", () => {
  const results = runAllScenarios();
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));

  it("runs the full A-J catalogue", () => {
    expect(results.map((r) => r.id)).toEqual(SCENARIOS.map((s) => s.id));
    for (const r of results) {
      expect(Number.isFinite(r.withKeeper.netPnl)).toBe(true);
      expect(r.withKeeper.vaultValue).toBeGreaterThan(90_000);
    }
  });

  it("A/B/C: price moves barely touch NAV - the hedge offsets the long", () => {
    for (const id of ["A", "B", "C"]) {
      const r = byId[id]!;
      expect(Math.abs(r.withKeeper.netReturnPct)).toBeLessThan(1);
      expect(Math.abs(r.withKeeper.hedgePnl)).toBeGreaterThan(5_000); // the hedge really moved
    }
  });

  it("A: the keeper keeps liquidation distance healthy during a rally", () => {
    const a = byId.A!;
    expect(a.withKeeper.minLiquidationDistanceBps!).toBeGreaterThan(a.withoutKeeper.minLiquidationDistanceBps!);
    expect(a.withKeeper.minLiquidationDistanceBps!).toBeGreaterThan(DEFAULT_STRATEGY.risk.liquidationDistance.warn * 0.9);
  });

  it("D: defensive mode limits the damage from negative funding", () => {
    const d = byId.D!;
    expect(d.withKeeper.fundingPnl).toBeLessThan(0);
    expect(d.withKeeper.netPnl).toBeGreaterThan(d.withoutKeeper.netPnl);
  });

  it("F: vol scaling protects against liquidation in a high-vol regime", () => {
    const f = byId.F!;
    expect(f.withKeeper.minLiquidationDistanceBps!).toBeGreaterThan(f.withoutKeeper.minLiquidationDistanceBps!);
  });

  it("I: without a keeper the squeeze liquidates the short; with one it does not", () => {
    const i = byId.I!;
    expect(i.withoutKeeper.liquidations).toBeGreaterThan(0);
    expect(i.withoutKeeper.maxAbsDeltaBps).toBeGreaterThan(5000);
    expect(i.withKeeper.liquidations).toBe(0);
    expect(i.withKeeper.maxAbsDeltaBps).toBeLessThan(DEFAULT_STRATEGY.risk.delta.high);
  });

  it("custom scenarios run from API-style input", () => {
    const r = runCustomScenario({ priceMovePct: -25, moveDays: 3, horizonDays: 14, fundingRatePer8h: -0.0001 });
    expect(r.ethMovePct).toBeCloseTo(-25, 0);
    expect(r.withKeeper.liquidations).toBe(0);
  });
});

describe("APY estimation engine", () => {
  const e = estimateApy(BASE);

  it("decomposes gross carry and costs", () => {
    expect(e.allocation.longPct).toBeCloseTo(0.6, 6);
    expect(e.allocation.marginPct).toBeCloseTo(0.3, 6);
    expect(e.gross.funding).toBeCloseTo(0.6 * 0.1095, 6);
    expect(e.grossApy).toBeCloseTo(e.gross.lendingUsdc + e.gross.lendingWeth + e.gross.funding, 10);
    expect(e.netApy).toBeCloseTo(e.grossApy - e.costs.total, 10);
    expect(e.netApy).toBeGreaterThan(0.05);
    expect(e.netApy).toBeLessThan(0.08);
  });

  it("liquidation move for a 2x short with 5% MM is ~42.9%", () => {
    expect(e.risk.liquidationMovePct).toBeCloseTo(1.5 / 1.05 - 1, 6);
    expect(e.risk.liquidationProb1dNoKeeper).toBeLessThan(1e-10);
  });

  it("closed-form rebalance frequency agrees with simulation (constant vol)", () => {
    const cfg = { ...DEFAULT_STRATEGY, volRefBps: 50_000, fundingFloorAprBps: -100_000 };
    let total = 0;
    const n = 12;
    for (let i = 0; i < n; i++) {
      const path = generateMarketPath({
        seed: 500 + i,
        days: 365,
        stepSec: 4 * HOUR,
        regimes: [{ vol: 0.6, stayProbPerDay: 1 }],
        funding: { mean8h: 0.0001, kappaPerDay: 1, sigma8hPerSqrtDay: 0, momentumBeta: 0, clip8h: 0.003 },
        utilization: { usdcMean: 0.8, wethMean: 0.6, kappaPerDay: 0, sigmaPerSqrtDay: 0 },
      });
      total += simulate(path, { tvl: 100_000, cfg, keeperIntervalSec: 4 * HOUR, recordEvery: 1e9 }).summary.rebalances;
    }
    const simulated = total / n;
    const analytic = estimateApy({ ...BASE, cfg }).rebalancesPerYear;
    expect(simulated / analytic).toBeGreaterThan(0.7);
    expect(simulated / analytic).toBeLessThan(1.6);
  });

  it("funding below breakeven -> optimizer recommends going defensive", () => {
    const o = optimize({ ...BASE, fundingRatePer8h: 0.00002 });
    expect(o.recommendation).toMatch(/breakeven/);
  });

  it("optimizer returns a feasible maximum", () => {
    const o = optimize(BASE);
    const feasible = o.frontier.filter((f) => f.feasible);
    expect(feasible.length).toBeGreaterThan(0);
    const bestNet = Math.max(...feasible.map((f) => f.netApy));
    expect(o.best.netApy).toBeCloseTo(bestNet, 10);
    expect(o.best.risk.liquidationMovePct).toBeGreaterThanOrEqual(o.constraints.minLiquidationMovePct);
  });

  it("touch probability behaves like a probability", () => {
    expect(touchProbability(0.43, 0.6, 1 / 365)).toBeLessThan(touchProbability(0.43, 0.6, 30 / 365));
    expect(touchProbability(0.1, 1.5, 1)).toBeLessThanOrEqual(1);
  });
});

describe("Monte Carlo + RNG", () => {
  it("is deterministic for a seed and returns ordered percentiles", () => {
    const a = monteCarlo({ paths: 8, days: 60, seed: 3 });
    const b = monteCarlo({ paths: 8, days: 60, seed: 3 });
    expect(a).toEqual(b);
    const q = a.annualizedReturn;
    expect(q.p5).toBeLessThanOrEqual(q.p25);
    expect(q.p25).toBeLessThanOrEqual(q.p50);
    expect(q.p50).toBeLessThanOrEqual(q.p75);
    expect(q.p75).toBeLessThanOrEqual(q.p95);
    expect(a.cvar95).toBeLessThanOrEqual(a.var95 + 1e-12);
  });

  it("normal draws have ~zero mean and unit variance", () => {
    const rng = new Rng(123);
    const xs = Array.from({ length: 20_000 }, () => rng.normal());
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length;
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(Math.abs(variance - 1)).toBeLessThan(0.05);
  });
});
