import type { AlertSeverity, DeltaView, PositionsView, RiskView, StrategyView } from "@dnv/shared";

import type { Db } from "./db/pool";

export interface AlertCandidate {
  key: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  value: number | null;
  threshold: number | null;
}

export interface AlertInputs {
  risk: RiskView;
  delta: DeltaView;
  positions: PositionsView;
  strategy: StrategyView;
  nowTs: number; // chain time
}

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;

/**
 * Pure alert rules. Thresholds come from the *on-chain* risk config carried in the views, so alerts
 * and the contracts can never disagree about what "dangerous" means.
 */
export function evaluateAlerts(i: AlertInputs): AlertCandidate[] {
  const out: AlertCandidate[] = [];
  const metric = (k: string) => i.risk.metrics.find((m) => m.key === k)!;

  // --- liquidation proximity (the most important one) ---
  const liq = metric("LIQUIDATION");
  if (liq.value !== null && liq.value < liq.thresholds.warn) {
    const critical = liq.value < liq.thresholds.high;
    out.push({
      key: "liquidation.distance",
      severity: critical ? "CRITICAL" : "WARNING",
      title: critical ? "Hedge close to liquidation" : "Liquidation buffer shrinking",
      message: `Short is ${pct(liq.value)} from its liquidation price $${i.risk.liquidation.liquidationPrice?.toFixed(0)} (mark $${i.risk.liquidation.markPrice.toFixed(0)}). ${critical ? "Urgent rebalance should add margin now." : "Next rebalance will restore margin."}`,
      value: liq.value,
      threshold: critical ? liq.thresholds.high : liq.thresholds.warn,
    });
  }

  // --- delta ---
  const absDelta = Math.abs(i.delta.deltaBps);
  if (absDelta > i.delta.effectiveBandBps) {
    const critical = absDelta > metric("DELTA").thresholds.high;
    out.push({
      key: "delta.band",
      severity: critical ? "CRITICAL" : "WARNING",
      title: critical ? "Delta beyond hard limit" : "Delta outside tolerance band",
      message: `Net delta ${i.delta.deltaBps > 0 ? "+" : ""}${pct(i.delta.deltaBps)} of NAV ($${i.delta.netDeltaUsd.toFixed(0)}); band is ±${pct(i.delta.effectiveBandBps)}. Hedge needs ${i.delta.requiredPerpSizeChange > 0 ? "+" : ""}${i.delta.requiredPerpSizeChange.toFixed(3)} ETH.`,
      value: absDelta,
      threshold: i.delta.effectiveBandBps,
    });
  }

  // --- overall risk state ---
  if (i.risk.state !== "NORMAL") {
    out.push({
      key: "risk.state",
      severity: i.risk.state === "WARNING" ? "WARNING" : "CRITICAL",
      title: `Risk state ${i.risk.state.replace("_", " ")}`,
      message: `Flags: ${i.risk.flags.join(", ") || "none"}.`,
      value: null,
      threshold: null,
    });
  }

  // --- oracle ---
  if (i.risk.oracle.status !== "OK") {
    const fallback = i.risk.oracle.status === "FALLBACK";
    out.push({
      key: "oracle.health",
      severity: fallback ? "WARNING" : "CRITICAL",
      title: fallback ? "Primary oracle down - using fallback" : `Oracle unhealthy (${i.risk.oracle.status})`,
      message: fallback
        ? "Prices come from the secondary feed. Trading continues."
        : "No trustworthy price: rebalancing and share operations are blocked until the feed recovers.",
      value: null,
      threshold: null,
    });
  }

  // --- funding ---
  const f = metric("FUNDING");
  if (i.positions.perp.size !== 0 && f.value !== null && f.value < 0) {
    const critical = f.value < f.thresholds.high;
    out.push({
      key: "funding.negative",
      severity: critical ? "CRITICAL" : "WARNING",
      title: critical ? "Funding deeply negative" : "Funding turned negative",
      message: `The short is paying ${pct(-f.value)} APR. ${i.strategy.defensive ? "Defensive mode active (basis shrinking)." : "Below the defensive floor the basis will shrink."}`,
      value: f.value,
      threshold: f.thresholds.warn,
    });
  }

  // --- drawdown ---
  const dd = metric("DRAWDOWN");
  if (dd.value !== null && dd.value >= dd.thresholds.warn) {
    out.push({
      key: "drawdown",
      severity: dd.value >= dd.thresholds.high ? "CRITICAL" : "WARNING",
      title: "Share price drawdown",
      message: `Share price is ${pct(dd.value)} below its peak of $${i.risk.peakSharePrice.toFixed(4)}.`,
      value: dd.value,
      threshold: dd.thresholds.warn,
    });
  }

  // --- withdrawal liquidity (lending utilisation can lock the reserve) ---
  const reserve = i.positions.reserve;
  if (reserve.suppliedUsd > 0 && reserve.withdrawableUsd < reserve.suppliedUsd * 0.5) {
    out.push({
      key: "liquidity.reserve",
      severity: reserve.withdrawableUsd < reserve.suppliedUsd * 0.1 ? "CRITICAL" : "WARNING",
      title: "Reserve liquidity constrained",
      message: `Lending utilisation ${(reserve.utilization * 100).toFixed(1)}%: only $${reserve.withdrawableUsd.toFixed(0)} of the $${reserve.suppliedUsd.toFixed(0)} reserve is withdrawable right now.`,
      value: reserve.withdrawableUsd,
      threshold: reserve.suppliedUsd * 0.5,
    });
  }

  // --- circuit breakers ---
  const cb = i.risk.circuitBreakers;
  if (cb.shutdown) out.push({ key: "breaker.shutdown", severity: "CRITICAL", title: "Vault shut down", message: "Emergency unwind executed: exits only.", value: null, threshold: null });
  else {
    if (cb.depositsPaused) out.push({ key: "breaker.deposits", severity: "CRITICAL", title: "Deposits paused", message: "Circuit breaker or guardian paused deposits. Withdrawals remain open.", value: null, threshold: null });
    if (cb.strategyPaused) out.push({ key: "breaker.strategy", severity: "CRITICAL", title: "Strategy trading paused", message: "Guardian paused rebalancing.", value: null, threshold: null });
  }

  // --- keeper liveness: a rebalance is due but hasn't happened for a while ---
  const plan = i.strategy.nextPlan;
  if (plan.execute && plan.urgent) {
    out.push({
      key: "keeper.urgent",
      severity: "CRITICAL",
      title: "Urgent rebalance pending",
      message: `Triggers: ${plan.triggers.join(", ")}. Keeper should execute immediately.`,
      value: null,
      threshold: null,
    });
  } else if (plan.execute && i.strategy.lastRebalanceAt > 0 && i.nowTs - i.strategy.lastRebalanceAt > 6 * 3600) {
    out.push({
      key: "keeper.stale",
      severity: "WARNING",
      title: "Rebalance due",
      message: `Triggers ${plan.triggers.join(", ")} have fired and the last rebalance was ${((i.nowTs - i.strategy.lastRebalanceAt) / 3600).toFixed(1)}h ago.`,
      value: null,
      threshold: null,
    });
  }
  return out;
}

/** Persist: open alerts whose key isn't active, refresh active ones, resolve the rest. */
export async function syncAlerts(db: Db, candidates: AlertCandidate[], nowTs: number): Promise<{ opened: number; resolved: number }> {
  const active = await db.query("SELECT id, key FROM alerts WHERE active");
  const activeKeys = new Map<string, number>(active.rows.map((r) => [r.key, r.id]));
  let opened = 0;
  let resolved = 0;
  const seen = new Set<string>();
  for (const c of candidates) {
    seen.add(c.key);
    const id = activeKeys.get(c.key);
    if (id) {
      await db.query("UPDATE alerts SET severity = $2, title = $3, message = $4, value = $5, threshold = $6 WHERE id = $1", [
        id, c.severity, c.title, c.message, c.value, c.threshold,
      ]);
    } else {
      await db.query(
        "INSERT INTO alerts (key, severity, title, message, value, threshold, opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [c.key, c.severity, c.title, c.message, c.value, c.threshold, nowTs],
      );
      opened++;
    }
  }
  for (const [key, id] of activeKeys) {
    if (!seen.has(key)) {
      await db.query("UPDATE alerts SET active = false, resolved_at = $2 WHERE id = $1", [id, nowTs]);
      resolved++;
    }
  }
  return { opened, resolved };
}
