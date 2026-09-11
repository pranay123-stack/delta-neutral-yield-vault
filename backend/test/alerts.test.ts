import { describe, expect, it } from "vitest";

import { type AlertInputs, evaluateAlerts } from "../src/alerts";
import { deltaView, positionsView, riskView, strategyView } from "../src/views";
import { loadRawState } from "./helpers";

function inputs(): AlertInputs {
  const s = loadRawState();
  return {
    risk: riskView(s, 31337),
    delta: deltaView(s, 31337),
    positions: positionsView(s, 31337),
    strategy: strategyView(s, 31337),
    nowTs: Number(s.timestamp),
  };
}

const keys = (i: AlertInputs) => evaluateAlerts(i).map((a) => `${a.key}:${a.severity}`);

describe("alert rules", () => {
  it("healthy captured state raises no critical alerts", () => {
    expect(evaluateAlerts(inputs()).filter((a) => a.severity === "CRITICAL")).toEqual([]);
  });

  it("liquidation distance: warning below warn, critical below high", () => {
    const i = inputs();
    const m = i.risk.metrics.find((x) => x.key === "LIQUIDATION")!;
    m.value = 2500;
    expect(keys(i)).toContain("liquidation.distance:WARNING");
    m.value = 1500;
    expect(keys(i)).toContain("liquidation.distance:CRITICAL");
  });

  it("delta outside the effective band, and beyond the hard limit", () => {
    const i = inputs();
    i.delta.deltaBps = i.delta.effectiveBandBps + 10;
    expect(keys(i)).toContain("delta.band:WARNING");
    i.delta.deltaBps = -900;
    expect(keys(i)).toContain("delta.band:CRITICAL");
  });

  it("oracle: fallback is a warning, stale is critical", () => {
    const i = inputs();
    i.risk.oracle.status = "FALLBACK";
    expect(keys(i)).toContain("oracle.health:WARNING");
    i.risk.oracle.status = "STALE";
    expect(keys(i)).toContain("oracle.health:CRITICAL");
  });

  it("negative funding while short", () => {
    const i = inputs();
    const f = i.risk.metrics.find((x) => x.key === "FUNDING")!;
    f.value = -300;
    expect(keys(i)).toContain("funding.negative:WARNING");
    f.value = -1500;
    expect(keys(i)).toContain("funding.negative:CRITICAL");
  });

  it("reserve liquidity locked by lending utilisation", () => {
    const i = inputs();
    i.positions.reserve.withdrawableUsd = i.positions.reserve.suppliedUsd * 0.3;
    expect(keys(i)).toContain("liquidity.reserve:WARNING");
    i.positions.reserve.withdrawableUsd = 0;
    expect(keys(i)).toContain("liquidity.reserve:CRITICAL");
  });

  it("circuit breakers and shutdown", () => {
    const i = inputs();
    i.risk.circuitBreakers.depositsPaused = true;
    expect(keys(i)).toContain("breaker.deposits:CRITICAL");
    i.risk.circuitBreakers.shutdown = true;
    const k = keys(i);
    expect(k).toContain("breaker.shutdown:CRITICAL");
    expect(k).not.toContain("breaker.deposits:CRITICAL"); // shutdown supersedes
  });

  it("urgent plan pending, and stale keeper", () => {
    const i = inputs();
    i.strategy.nextPlan = { ...i.strategy.nextPlan, execute: true, urgent: true, triggers: ["LIQUIDATION"] };
    expect(keys(i)).toContain("keeper.urgent:CRITICAL");
    i.strategy.nextPlan.urgent = false;
    i.strategy.lastRebalanceAt = i.nowTs - 7 * 3600;
    expect(keys(i)).toContain("keeper.stale:WARNING");
  });

  it("risk state maps to severity", () => {
    const i = inputs();
    i.risk.state = "HIGH_RISK";
    expect(keys(i)).toContain("risk.state:CRITICAL");
    i.risk.state = "WARNING";
    expect(keys(i)).toContain("risk.state:WARNING");
  });
});
