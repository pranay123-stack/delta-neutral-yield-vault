"use client";

import type { AlertView, RiskMetric } from "@dnv/shared";

import { Badge, Chip, Flag, RISK_LEVEL, RiskBadge, SeverityBadge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Query, SkeletonRows } from "@/components/ui/QueryState";
import { KV } from "@/components/ui/Stat";
import { ThresholdBar } from "@/components/ui/ThresholdBar";
import { fmtAgo, fmtBps, fmtDateTime, fmtDuration, fmtNum, fmtUsd, fmtX, shortHex } from "@/lib/format";
import { useAlerts, useRisk, useRiskEvents } from "@/lib/queries";

/** Metric values come in three units: bps of NAV, multiples, and APR expressed in bps. */
function metricFormatter(m: RiskMetric): (v: number) => string {
  if (m.unit === "x") return (v) => fmtX(v, 2);
  if (m.unit === "apr") return (v) => `${fmtBps(v, 2)} APR`;
  return (v) => fmtBps(v, 2);
}

/** Alert values carry the unit of the metric they watch (ALERT_UNITS in @dnv/shared). */
function alertFormatter(unit: AlertView["unit"]): (v: number) => string {
  if (unit === "usd") return (v) => fmtUsd(v);
  if (unit === "apr") return (v) => `${fmtBps(v, 0)} APR`;
  if (unit === "bps") return (v) => fmtBps(v, 0);
  return (v) => fmtNum(v, 0);
}

function MetricRow({ m }: { m: RiskMetric }) {
  const f = metricFormatter(m);
  const tick = m.unit === "x" ? (v: number) => fmtX(v, 1) : (v: number) => fmtBps(v, 0);
  return (
    <div className="grid gap-x-6 gap-y-2 py-3 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[0.8125rem] font-medium text-ink">{m.label}</span>
          <Badge level={RISK_LEVEL[m.level]}>{m.level.replace("_", " ")}</Badge>
        </div>
        <div className="mt-0.5 text-lg font-semibold tabular-nums text-ink">{m.value === null ? "—" : f(m.value)}</div>
        <div className="text-[0.68rem] text-muted">
          {m.higherIsWorse ? "higher is worse" : "lower is worse"} · warn {f(m.thresholds.warn)} · high {f(m.thresholds.high)}
          {m.thresholds.critical !== null && ` · critical ${f(m.thresholds.critical)}`}
        </div>
      </div>
      <div className="self-center pt-1">
        <ThresholdBar value={m.value} thresholds={m.thresholds} higherIsWorse={m.higherIsWorse} format={tick} />
      </div>
    </div>
  );
}

function RiskStateCard() {
  const risk = useRisk();
  return (
    <Card title="Risk engine" subtitle="Live assessment vs thresholds (RiskManager)">
      <Query query={risk} skeleton={<SkeletonRows rows={8} />}>
        {(r) => (
          <div>
            <div className="flex flex-wrap items-center gap-3 border-b border-line pb-3">
              <div>
                <div className="text-[0.7rem] uppercase tracking-[0.06em] text-muted">Current state</div>
                <div className="mt-1">
                  <RiskBadge state={r.state} />
                </div>
              </div>
              <div>
                <div className="text-[0.7rem] uppercase tracking-[0.06em] text-muted">Last checkpoint</div>
                <div className="mt-1">
                  <RiskBadge state={r.persistedState} />
                </div>
              </div>
              <div className="min-w-0">
                <div className="text-[0.7rem] uppercase tracking-[0.06em] text-muted">Flags</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {r.flags.length === 0 ? <span className="text-xs text-ink-2">none raised</span> : r.flags.map((f) => <Chip key={f} tone="warn">{f}</Chip>)}
                </div>
              </div>
              <div className="ml-auto text-right text-xs text-ink-2">
                Peak share price <span className="font-medium text-ink">{r.peakSharePrice.toFixed(6)}</span>
              </div>
            </div>
            <div className="divide-y divide-line">
              {r.metrics.map((m) => (
                <MetricRow key={m.key} m={m} />
              ))}
            </div>
          </div>
        )}
      </Query>
    </Card>
  );
}

function SideCards() {
  const risk = useRisk();
  return (
    <Query query={risk} skeleton={<SkeletonRows rows={10} />}>
      {(r) => (
        <div className="space-y-5">
          <Card title="Oracle" subtitle="Chainlink-style feed with fallback + last-good price">
            <div className="mb-3 flex items-center gap-2">
              <Badge level={r.oracle.status === "OK" ? "normal" : r.oracle.status === "FALLBACK" ? "warn" : "crit"}>{r.oracle.status.replace(/_/g, " ")}</Badge>
              {r.oracle.shutdown && <Badge level="crit">shutdown</Badge>}
            </div>
            <KV
              rows={[
                { label: "Price", value: fmtUsd(r.oracle.price) },
                { label: "Last good price", value: fmtUsd(r.oracle.lastGoodPrice) },
                { label: "Last good at", value: fmtDateTime(r.oracle.lastGoodAt) },
                { label: "Age", value: fmtAgo(r.oracle.lastGoodAt, r.blockTimestamp) },
              ]}
            />
          </Card>
          <Card title="Circuit breakers" subtitle="Guardian / emergency controller">
            <div className="space-y-2 text-[0.8125rem]">
              <div className="flex items-center justify-between">
                <span className="text-ink-2">Deposits paused</span>
                <Flag on={r.circuitBreakers.depositsPaused} onLabel="PAUSED" offLabel="open" />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-2">Strategy paused</span>
                <Flag on={r.circuitBreakers.strategyPaused} onLabel="PAUSED" offLabel="running" />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-2">Shutdown</span>
                <Flag on={r.circuitBreakers.shutdown} onLabel="SHUT DOWN" offLabel="no" />
              </div>
            </div>
          </Card>
          <Card title="Limits & liquidation">
            <KV
              rows={[
                { label: "Max slippage per trade", value: fmtBps(r.limits.maxSlippageBps, 2) },
                { label: "Max position notional", value: fmtUsd(r.limits.maxPositionNotionalUsd, { digits: 0 }) },
                { label: "Mark price", value: fmtUsd(r.liquidation.markPrice) },
                { label: "Liquidation price", value: r.liquidation.liquidationPrice ? fmtUsd(r.liquidation.liquidationPrice) : "none" },
                { label: "Distance", value: fmtBps(r.liquidation.distanceBps, 2) },
                { label: "Safety buffer", value: fmtBps(r.liquidation.safetyBufferBps, 2) },
                { label: "Leverage", value: fmtX(r.liquidation.leverage) },
              ]}
            />
          </Card>
        </div>
      )}
    </Query>
  );
}

function AlertsTable() {
  const alerts = useAlerts(false);
  return (
    <Card title="Alerts" subtitle="Active first, then history (chain time)" flush>
      <Query query={alerts} skeleton={<div className="p-4"><SkeletonRows rows={5} /></div>} isEmpty={(l) => l.length === 0} empty="No alerts have ever fired.">
        {(list) => (
          <div className="max-h-[420px] overflow-auto">
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Severity</th>
                  <th>Alert</th>
                  <th className="num">Value</th>
                  <th>Opened</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {list.map((a) => {
                  const f = alertFormatter(a.unit);
                  return (
                  <tr key={a.id}>
                    <td>
                      <SeverityBadge severity={a.severity} />
                    </td>
                    <td className="min-w-[240px]">
                      <div className="font-medium text-ink">{a.title}</div>
                      <div className="text-xs text-ink-2">{a.message}</div>
                      <div className="font-mono text-[0.65rem] text-muted">{a.key}</div>
                    </td>
                    <td className="num">
                      {a.value === null ? "—" : f(a.value)}
                      {a.threshold !== null && <div className="text-[0.68rem] text-muted">thr {f(a.threshold)}</div>}
                    </td>
                    <td className="whitespace-nowrap text-xs text-ink-2">{fmtDateTime(a.openedAt)}</td>
                    <td className="whitespace-nowrap text-xs">
                      {a.active ? (
                        <Badge level="warn">active</Badge>
                      ) : (
                        <span className="text-ink-2">resolved after {a.resolvedAt ? fmtDuration(a.resolvedAt - a.openedAt) : "—"}</span>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Query>
    </Card>
  );
}

function RiskEventsTable() {
  const events = useRiskEvents();
  return (
    <Card title="On-chain risk events" subtitle="Indexed RiskManager / EmergencyController events" flush>
      <Query query={events} skeleton={<div className="p-4"><SkeletonRows rows={5} /></div>} isEmpty={(l) => l.length === 0} empty="No risk events indexed yet.">
        {(list) => (
          <div className="max-h-[420px] overflow-auto">
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Transition</th>
                  <th>Flags</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {list.map((e) => (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap text-xs text-ink-2">{fmtDateTime(e.ts)}</td>
                    <td className="font-mono text-xs">{e.kind}</td>
                    <td className="whitespace-nowrap">
                      {e.previousState || e.newState ? (
                        <span className="inline-flex items-center gap-1.5">
                          {e.previousState ? <RiskBadge state={e.previousState} /> : "—"}
                          <span className="text-muted">→</span>
                          {e.newState ? <RiskBadge state={e.newState} /> : "—"}
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {e.flagNames.length ? e.flagNames.map((f) => <Chip key={f}>{f}</Chip>) : <span className="text-muted">—</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap font-mono text-xs text-ink-2" title={e.txHash}>
                      {shortHex(e.txHash)}
                      <div className="text-[0.65rem] text-muted">block {e.blockNumber}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Query>
    </Card>
  );
}

export function RiskView() {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <RiskStateCard />
        </div>
        <SideCards />
      </div>
      <div className="grid gap-5 2xl:grid-cols-2">
        <AlertsTable />
        <RiskEventsTable />
      </div>
    </div>
  );
}
