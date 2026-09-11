"use client";

import { REBALANCE_TRIGGERS, type RebalanceRecordView } from "@dnv/shared";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";

import { Legend, TooltipBox } from "@/components/charts/ChartTooltip";
import { CHROME, S1, S2, axisTick } from "@/components/charts/palette";
import { Badge, Chip } from "@/components/ui/Badge";
import { Card, Note, cx } from "@/components/ui/Card";
import { Query, Skeleton, SkeletonRows } from "@/components/ui/QueryState";
import { Segmented } from "@/components/ui/Segmented";
import { KV, Stat } from "@/components/ui/Stat";
import { fmtAgo, fmtBps, fmtDateShort, fmtDateTime, fmtDuration, fmtEth, fmtNum, fmtPct, fmtUsd, fmtX, shortHex } from "@/lib/format";
import { useApy, useDelta, useRebalances, useStrategy } from "@/lib/queries";

function Summary({ list }: { list: RebalanceRecordView[] }) {
  const total = list.reduce((a, r) => a + r.realizedCostUsd, 0);
  const est = list.reduce((a, r) => a + r.estimatedCostUsd, 0);
  const urgent = list.filter((r) => r.urgent).length;
  const byTrigger = REBALANCE_TRIGGERS.map((t) => ({ t, n: list.filter((r) => r.triggers.includes(t)).length })).filter((x) => x.n > 0);
  const maxN = Math.max(1, ...byTrigger.map((x) => x.n));
  const sorted = [...list].sort((a, b) => a.ts - b.ts);
  const span = sorted.length > 1 ? sorted[sorted.length - 1]!.ts - sorted[0]!.ts : 0;
  return (
    <div className="grid gap-5 xl:grid-cols-3">
      <div className="grid grid-cols-2 gap-3 xl:col-span-2 xl:grid-cols-3">
        <Stat label="Rebalances" value={String(list.length)} sub={span ? `over ${fmtDuration(span)} of chain time` : "indexed"} />
        <Stat label="Realised cost" value={fmtUsd(total)} sub={`avg ${fmtUsd(list.length ? total / list.length : 0)} each`} />
        <Stat label="Estimated cost" value={fmtUsd(est)} sub={`realised / est ${est ? fmtPct(total / est, 1) : "—"}`} />
        <Stat label="Urgent" value={String(urgent)} sub="bypassed interval / cost filters" />
        <Stat label="Mean interval" value={list.length > 1 ? fmtDuration(span / (list.length - 1)) : "—"} sub="between rebalances" />
        <Stat
          label="Avg |Δ delta|"
          value={fmtBps(list.length ? list.reduce((a, r) => a + Math.abs(r.preDeltaBps - r.postDeltaBps), 0) / list.length : 0, 2)}
          sub="delta removed per rebalance"
        />
      </div>
      <Card title="By trigger" subtitle="A rebalance can fire on several triggers at once">
        <div className="space-y-2">
          {byTrigger.map(({ t, n }) => (
            <div key={t} className="grid grid-cols-[130px_1fr_32px] items-center gap-2 text-xs">
              <Chip>{t}</Chip>
              <div className="h-2 rounded-sm bg-panel-3">
                <div className="h-full rounded-sm" style={{ width: `${(n / maxN) * 100}%`, background: S1 }} />
              </div>
              <span className="text-right tabular-nums text-ink">{n}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

type ChartMetric = "leverage" | "delta";

function PrePostChart({ list }: { list: RebalanceRecordView[] }) {
  const [metric, setMetric] = useState<ChartMetric>("leverage");
  const pre = list.map((r) => ({ ts: r.ts, y: metric === "leverage" ? r.preLeverage : r.preDeltaBps, id: r.id }));
  const post = list.map((r) => ({ ts: r.ts, y: metric === "leverage" ? r.postLeverage : r.postDeltaBps, id: r.id }));
  const fmt = metric === "leverage" ? (v: number) => fmtX(v, 2) : (v: number) => fmtBps(v, 2, true);
  const byId = new Map(list.map((r) => [r.id, r]));
  return (
    <Card
      title={metric === "leverage" ? "Leverage before → after" : "Net delta before → after"}
      subtitle="Each rebalance, chain time"
      action={
        <>
          <Legend
            items={[
              { label: "before", color: S2 },
              { label: "after", color: S1 },
            ]}
          />
          <Segmented
            ariaLabel="Metric"
            value={metric}
            onChange={setMetric}
            options={[
              { value: "leverage", label: "Leverage" },
              { value: "delta", label: "Delta" },
            ]}
          />
        </>
      }
    >
      <div className="h-[260px]">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={CHROME.grid} vertical={false} />
            <XAxis dataKey="ts" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => fmtDateShort(v)} tick={axisTick} stroke={CHROME.axis} tickLine={false} minTickGap={36} />
            <YAxis dataKey="y" type="number" tickFormatter={fmt} tick={axisTick} axisLine={false} tickLine={false} width={58} domain={["auto", "auto"]} />
            <ZAxis range={[48, 48]} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: CHROME.axis }}
              content={(p) => {
                if (!p.active || !p.payload?.length) return null;
                const row = p.payload[0]?.payload as { id: number } | undefined;
                const r = row ? byId.get(row.id) : undefined;
                if (!r) return null;
                return (
                  <TooltipBox
                    title={`#${r.id} · ${fmtDateTime(r.ts)}`}
                    rows={[
                      { label: "Leverage", value: `${fmtX(r.preLeverage)} → ${fmtX(r.postLeverage)}` },
                      { label: "Delta", value: `${fmtBps(r.preDeltaBps, 2, true)} → ${fmtBps(r.postDeltaBps, 2, true)}` },
                      { label: "Triggers", value: r.triggers.join(", ") },
                      { label: "Cost", value: fmtUsd(r.realizedCostUsd) },
                    ]}
                  />
                );
              }}
            />
            <Scatter name="before" data={pre} fill={S2} stroke={CHROME.surface} strokeWidth={1.5} isAnimationActive={false} />
            <Scatter name="after" data={post} fill={S1} stroke={CHROME.surface} strokeWidth={1.5} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function CostChart({ list }: { list: RebalanceRecordView[] }) {
  const rows = [...list].sort((a, b) => a.id - b.id).map((r) => ({ id: r.id, est: r.estimatedCostUsd, real: r.realizedCostUsd, r }));
  return (
    <Card
      title="Cost per rebalance"
      subtitle="Planner estimate vs realised (fees + slippage + gas), by rebalance #"
      action={
        <Legend
          items={[
            { label: "estimated", color: S2 },
            { label: "realised", color: S1 },
          ]}
        />
      }
    >
      <div className="h-[220px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={1} barCategoryGap="20%">
            <CartesianGrid stroke={CHROME.grid} vertical={false} />
            <XAxis dataKey="id" tick={axisTick} stroke={CHROME.axis} tickLine={false} minTickGap={12} />
            <YAxis tickFormatter={(v: number) => fmtUsd(v, { digits: 0 })} tick={axisTick} axisLine={false} tickLine={false} width={52} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ fill: "rgba(255,255,255,0.04)" }}
              content={(p) => {
                if (!p.active || !p.payload?.length) return null;
                const row = p.payload[0]?.payload as (typeof rows)[number] | undefined;
                if (!row) return null;
                return (
                  <TooltipBox
                    title={`#${row.id} · ${fmtDateTime(row.r.ts)}`}
                    rows={[
                      { label: "Estimated", value: fmtUsd(row.est), color: S2 },
                      { label: "Realised", value: fmtUsd(row.real), color: S1 },
                      { label: "Triggers", value: row.r.triggers.join(", ") },
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="est" name="estimated" fill={S2} radius={[2, 2, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="real" name="realised" fill={S1} radius={[2, 2, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function TradeoffCard() {
  const strategy = useStrategy();
  const apy = useApy();
  const delta = useDelta();
  return (
    <Card title="The no-trade band tradeoff" subtitle="Why the keeper does not rebalance on every tick">
      <div className="space-y-3 text-[0.8125rem] leading-relaxed text-ink-2">
        <p>
          Between rebalances the book drifts with the ETH price: the long leg's value and the short's margin move in opposite directions, so delta, leverage and allocation wander.
          A rebalance only fires when drift breaches a <span className="text-ink">no-trade band</span> - or the liquidation distance gets too thin.
        </p>
        <p>
          <span className="text-ink">Tighter bands</span> keep delta closer to zero but trade more often, paying spread, taker fees, slippage and gas each time.
          <span className="text-ink"> Wider bands</span> save costs but tolerate more directional exposure. Expected rebalance frequency scales as σ² / (up × down band), so doubling both bands cuts trading ~4x.
        </p>
        <p>
          Two filters guard non-urgent trades: a rebalance costing more than the max-cost share of NAV is skipped, and the basis is only grown when the extra carry
          over the carry horizon pays for the trade. Urgent plans (liquidation risk, leverage or delta past the high threshold) bypass both and the min interval.
        </p>
      </div>
      <div className="mt-4">
        {strategy.data ? (
          <KV
            rows={[
              { label: "Delta band", value: `±${fmtBps(strategy.data.params.deltaBandBps, 2)}${delta.data ? ` (±${fmtBps(delta.data.effectiveBandBps, 2)} vol-scaled)` : ""}` },
              { label: "Leverage band", value: `±${fmtBps(strategy.data.params.leverageBandBps, 0)} of target` },
              { label: "Allocation band", value: `±${fmtBps(strategy.data.params.allocationBandBps, 1)}` },
              { label: "Min interval", value: fmtDuration(strategy.data.params.minIntervalSec) },
              { label: "Max cost per rebalance", value: fmtBps(strategy.data.params.maxCostBps, 2) },
              { label: "Carry horizon (cost filter)", value: fmtDuration(strategy.data.params.carryHorizonSec) },
              { label: "Est. rebalances / yr at current vol", value: apy.data ? fmtNum(apy.data.estimate.rebalancesPerYear, 0) : "—" },
              {
                label: "Price move that triggers one",
                value: apy.data ? `+${fmtPct(apy.data.estimate.risk.rebalanceTriggerUpPct, 1)} / −${fmtPct(apy.data.estimate.risk.rebalanceTriggerDownPct, 1)}` : "—",
              },
              { label: "Annual cost of rebalancing (est.)", value: apy.data ? `${fmtPct(apy.data.estimate.costs.rebalancing + apy.data.estimate.costs.gas, 2)} of NAV` : "—" },
              { label: "Last rebalance", value: fmtAgo(strategy.data.lastRebalanceAt, strategy.data.blockTimestamp) },
            ]}
          />
        ) : (
          <SkeletonRows rows={6} />
        )}
      </div>
      <div className="mt-4">
        <Note>Use the Simulation page to compare the same market paths with the keeper on vs off - the difference is what active rebalancing buys.</Note>
      </div>
    </Card>
  );
}

function HistoryTable({ list }: { list: RebalanceRecordView[] }) {
  return (
    <Card title="Rebalance history" subtitle={`${list.length} executed rebalances, newest first`} flush>
      <div className="max-h-[560px] overflow-auto">
        <table className="table-dense">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Triggers</th>
              <th className="num">Long Δ</th>
              <th className="num">Margin Δ</th>
              <th className="num">Perp size Δ</th>
              <th className="num">Delta pre → post</th>
              <th className="num">Leverage pre → post</th>
              <th className="num">Cost est / real</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td className="text-ink-2">{r.id}</td>
                <td className="whitespace-nowrap text-xs text-ink-2">{fmtDateTime(r.ts)}</td>
                <td>
                  <div className="flex flex-wrap gap-1">
                    {r.urgent && <Badge level="crit">urgent</Badge>}
                    {r.triggers.map((t) => (
                      <Chip key={t} tone={t === "LIQUIDATION" ? "crit" : t === "FUNDING_DEFENSIVE" ? "warn" : "neutral"}>
                        {t}
                      </Chip>
                    ))}
                  </div>
                </td>
                <td className="num">{fmtUsd(r.longUsdDelta, { digits: 0, sign: true })}</td>
                <td className="num">{fmtUsd(r.marginDelta, { digits: 0, sign: true })}</td>
                <td className="num">{fmtEth(r.perpSizeChange, 3, true)}</td>
                <td className="num">
                  {fmtBps(r.preDeltaBps, 2, true)} → {fmtBps(r.postDeltaBps, 2, true)}
                </td>
                <td className="num">
                  {fmtX(r.preLeverage)} → <span className="text-ink">{fmtX(r.postLeverage)}</span>
                </td>
                <td className="num">
                  {fmtUsd(r.estimatedCostUsd)} / <span className={cx(r.realizedCostUsd > r.estimatedCostUsd ? "text-warn" : "text-ink")}>{fmtUsd(r.realizedCostUsd)}</span>
                </td>
                <td className="whitespace-nowrap font-mono text-xs text-ink-2" title={r.txHash}>
                  {shortHex(r.txHash)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function RebalancingView() {
  const rebalances = useRebalances();
  const sorted = useMemo(() => (rebalances.data ? [...rebalances.data].sort((a, b) => b.ts - a.ts || b.id - a.id) : []), [rebalances.data]);
  return (
    <div className="space-y-5">
      <Query
        query={rebalances}
        skeleton={<Skeleton className="h-[180px]" />}
        isEmpty={(l) => l.length === 0}
        empty="No rebalances have been executed yet. The keeper rebalances once drift breaches a band."
      >
        {() => (
          <>
            <Summary list={sorted} />
            <div className="grid gap-5 xl:grid-cols-5">
              <div className="space-y-5 xl:col-span-3">
                <PrePostChart list={sorted} />
                <CostChart list={sorted} />
              </div>
              <div className="xl:col-span-2">
                <TradeoffCard />
              </div>
            </div>
            <HistoryTable list={sorted} />
          </>
        )}
      </Query>
    </div>
  );
}
