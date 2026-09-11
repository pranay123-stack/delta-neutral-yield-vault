import type { PerformancePoint } from "@dnv/shared";
import { describe, expect, it } from "vitest";

import { annualize, summarize, withTrailingApy } from "../src/performance";

const DAY = 86_400;

function series(days: number, dailyReturn: number, dipDay?: number): Omit<PerformancePoint, "apy7d" | "apy30d">[] {
  let pps = 1;
  return Array.from({ length: days + 1 }, (_, i) => {
    if (i > 0) pps *= 1 + dailyReturn * (i === dipDay ? -20 : 1);
    return {
      ts: 1_000_000 + i * DAY,
      blockNumber: i,
      tvlUsd: 100_000 * pps,
      sharePrice: pps,
      ethPrice: 3000,
      netDeltaBps: 0,
      leverage: 2,
      liquidationDistanceBps: 4000,
      drawdownBps: 0,
      fundingRatePer8h: 0.0001,
      usdcSupplyApr: 0.05,
      wethSupplyApr: 0.02,
      strategyNetPnl: 0,
      fundingIncome: 0,
      lendingIncome: 0,
      tradingCosts: 0,
      riskState: "NORMAL" as const,
    };
  });
}

describe("performance maths", () => {
  it("annualises compound returns and refuses sub-day windows", () => {
    expect(annualize(1, 1.01, 365 * DAY)).toBeCloseTo(0.01, 10);
    expect(annualize(1, 1.001, 30 * DAY)!).toBeCloseTo(Math.pow(1.001, 365 / 30) - 1, 10);
    expect(annualize(1, 1.1, 3600)).toBeNull();
  });

  it("trailing 7d / 30d APY recover a constant growth rate", () => {
    const pts = withTrailingApy(series(60, 0.0002));
    const last = pts[pts.length - 1]!;
    const expected = Math.pow(1.0002, 365) - 1;
    expect(last.apy7d!).toBeCloseTo(expected, 6);
    expect(last.apy30d!).toBeCloseTo(expected, 6);
    expect(pts[3]!.apy30d).toBeNull(); // not enough history yet
  });

  it("summary: max drawdown, vol and Sharpe", () => {
    const pts = withTrailingApy(series(90, 0.0002, 45));
    const sum = summarize(pts, 7);
    expect(sum.maxDrawdownBps).toBeCloseTo(40, 0); // one -0.4% day
    expect(sum.volatilityAnnual!).toBeGreaterThan(0);
    expect(sum.sharpe!).toBeGreaterThan(0);
    expect(sum.rebalances).toBe(7);
  });

  it("empty series has neutral summary", () => {
    expect(summarize([], 0).periodReturn).toBe(0);
  });
});
