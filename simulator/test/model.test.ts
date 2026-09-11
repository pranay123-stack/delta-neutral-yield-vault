import { describe, expect, it } from "vitest";

import {
  DAY,
  DEFAULT_STRATEGY,
  DEFAULT_VENUES,
  HOUR,
  baseMarket,
  executePlan,
  generateMarketPath,
  liquidationPrice,
  newPortfolio,
  planRebalance,
  pnlBreakdown,
  simulate,
  supplyRate,
  valuation,
} from "../src";

/**
 * Parity with the Solidity system. The expected numbers are read from the Foundry smoke test
 * (test/unit/Smoke.t.sol, `forge test --match-contract SmokeTest -vv`) so the TS model cannot drift
 * away from the contracts unnoticed.
 */
const ONCHAIN_BOOTSTRAP = {
  nav: 99_905.261321,
  reserve: 10_000,
  longValue: 59_950.813198,
  perpEquity: 29_954.448123,
  perpSize: -19.9836043994,
};
const ONCHAIN_7D = { funding: 125.896707, lendingUsdc: 9.809366, lendingWeth: 21.901188 };

function bootstrapped() {
  const m = baseMarket(0);
  const p = newPortfolio(100_000, 0, DEFAULT_STRATEGY.volRefBps);
  const plan = planRebalance(p, m, DEFAULT_STRATEGY);
  executePlan(p, plan, m, DEFAULT_STRATEGY);
  return { p, m, plan };
}

describe("parity with on-chain contracts", () => {
  it("rate model matches MockLendingProtocol", () => {
    expect(supplyRate(DEFAULT_VENUES.usdcRateModel, 0.8)).toBeCloseTo(0.0512, 6);
    expect(supplyRate(DEFAULT_VENUES.wethRateModel, 0.6)).toBeCloseTo(0.019125, 6);
  });

  it("initial deployment reproduces the on-chain book", () => {
    const { p, m, plan } = bootstrapped();
    const v = valuation(p, m);
    expect(plan.longUsdDelta).toBeCloseTo(60_000, -1);
    expect(plan.marginDelta).toBeCloseTo(30_000, -1);
    expect(v.nav / ONCHAIN_BOOTSTRAP.nav - 1).toBeLessThan(5e-5);
    expect(Math.abs(v.longValue / ONCHAIN_BOOTSTRAP.longValue - 1)).toBeLessThan(5e-5);
    expect(Math.abs(v.perpEquity / ONCHAIN_BOOTSTRAP.perpEquity - 1)).toBeLessThan(5e-5);
    expect(Math.abs(p.perp.size / ONCHAIN_BOOTSTRAP.perpSize - 1)).toBeLessThan(5e-5);
    expect(p.reserve).toBeCloseTo(ONCHAIN_BOOTSTRAP.reserve, 0);
    expect(Math.abs(v.deltaBps)).toBeLessThan(1);
    expect(v.leverage).toBeCloseTo(2, 2);
  });

  it("seven days of carry match the on-chain accrual", () => {
    const path = generateMarketPath({
      seed: 1,
      days: 7,
      stepSec: HOUR,
      regimes: [{ vol: 0, stayProbPerDay: 1 }],
      funding: { mean8h: 0.0001, kappaPerDay: 0, sigma8hPerSqrtDay: 0, momentumBeta: 0, clip8h: 0.01 },
      utilization: { usdcMean: 0.8, wethMean: 0.6, kappaPerDay: 0, sigmaPerSqrtDay: 0 },
    });
    const r = simulate(path, { tvl: 100_000, rebalancing: false, feeIntervalSec: 365 * DAY });
    const b = pnlBreakdown(r.portfolio, path[path.length - 1]!);
    expect(Math.abs(b.fundingIncome / ONCHAIN_7D.funding - 1)).toBeLessThan(0.002);
    expect(Math.abs(b.lendingIncomeUsdc / ONCHAIN_7D.lendingUsdc - 1)).toBeLessThan(0.01);
    expect(Math.abs(b.lendingIncomeWeth / ONCHAIN_7D.lendingWeth - 1)).toBeLessThan(0.01);
  });

  it("liquidation price matches PerpMath", () => {
    expect(liquidationPrice(-1, 3000, 1500, 500)).toBeCloseTo(4285.7142857, 5);
    expect(liquidationPrice(1, 3000, 700, 0)).toBeCloseTo(2300, 8); // spec example
  });
});

describe("accounting", () => {
  it("PnL attribution reconciles with NAV on random paths (incl. liquidations)", () => {
    for (const seed of [3, 4, 5]) {
      const path = generateMarketPath({ seed, days: 120, stepSec: 4 * HOUR, driftAnnual: 0.8 });
      for (const rebalancing of [true, false]) {
        const r = simulate(path, { tvl: 250_000, rebalancing, keeperIntervalSec: 4 * HOUR });
        expect(Math.abs(r.summary.reconciliationResidual)).toBeLessThan(1e-6 * 250_000);
      }
    }
  });

  it("vault fees are dilution: they never change NAV", () => {
    const path = generateMarketPath({ seed: 9, days: 60, stepSec: 4 * HOUR });
    const withFees = simulate(path, { tvl: 100_000 });
    const noFees = simulate(path, { tvl: 100_000, cfg: { ...DEFAULT_STRATEGY, managementFeeBps: 0, performanceFeeBps: 0 } });
    expect(withFees.summary.endNav).toBeCloseTo(noFees.summary.endNav, 6);
    expect(withFees.summary.endSharePrice).toBeLessThan(noFees.summary.endSharePrice);
    expect(withFees.summary.vaultFees).toBeGreaterThan(0);
  });
});

describe("rebalancing behaviour", () => {
  it("keeps delta inside the band on a random year", () => {
    const path = generateMarketPath({ seed: 21, days: 365, stepSec: HOUR });
    const r = simulate(path, { tvl: 100_000, recordEvery: 1_000_000 });
    // between keeper ticks delta drifts only with WETH interest; after rebalances it is ~0
    expect(r.summary.maxAbsDeltaBps).toBeLessThan(DEFAULT_STRATEGY.risk.delta.high);
    expect(r.summary.liquidations).toBe(0);
  });

  it("regression: a deep decline does not cause no-op rebalance churn (PnL crystallisation)", () => {
    const path = generateMarketPath({
      seed: 102,
      days: 365,
      stepSec: HOUR,
      regimes: [{ vol: 0.6, stayProbPerDay: 1 }],
      funding: { mean8h: 0.0001, kappaPerDay: 1, sigma8hPerSqrtDay: 0, momentumBeta: 0, clip8h: 0.003 },
      utilization: { usdcMean: 0.8, wethMean: 0.6, kappaPerDay: 0, sigmaPerSqrtDay: 0 },
    });
    expect(path[path.length - 1]!.price).toBeLessThan(1300); // this seed falls ~60%
    const r = simulate(path, {
      tvl: 100_000,
      cfg: { ...DEFAULT_STRATEGY, volRefBps: 50_000, fundingFloorAprBps: -100_000 },
      recordEvery: 1_000_000,
    });
    expect(r.summary.triggerCounts.LEVERAGE_LOW ?? 0).toBeLessThan(15); // was 57 before the fix
    expect(r.summary.rebalances).toBeLessThan(110);
  });

  it("keeper offline never trades after the initial deployment", () => {
    const path = generateMarketPath({ seed: 5, days: 30, stepSec: HOUR });
    const r = simulate(path, { tvl: 100_000, rebalancing: false });
    expect(r.summary.rebalances).toBe(1);
  });
});
