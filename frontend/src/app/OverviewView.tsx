"use client";

import Link from "next/link";
import { useState } from "react";

import { AllocationBar } from "@/components/charts/AllocationBar";
import { S1, S2, S3, S4 } from "@/components/charts/palette";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { Badge, Chip, RiskBadge, SeverityBadge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { EmptyState, ErrorState, Query, Skeleton, SkeletonRows } from "@/components/ui/QueryState";
import { Segmented } from "@/components/ui/Segmented";
import { KV, Stat } from "@/components/ui/Stat";
import {
  fmtAgo,
  fmtBps,
  fmtDateTime,
  fmtEth,
  fmtFunding8h,
  fmtPct,
  fmtUsd,
  fmtX,
  pnlTone,
} from "@/lib/format";
import { useAlerts, useDelta, useMetrics, usePerformance, usePositions, useStrategy } from "@/lib/queries";

function KpiGrid() {
  const metrics = useMetrics();
  if (!metrics.data) {
    if (metrics.isError) return <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />;
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7">
        {Array.from({ length: 14 }, (_, i) => (
          <Skeleton key={i} className="h-[78px]" />
        ))}
      </div>
    );
  }
  const m = metrics.data;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-7">
      <Stat label="TVL" value={fmtUsd(m.tvlUsd, { digits: 0 })} sub={`ETH ${fmtUsd(m.ethPrice)}`} />
      <Stat label="Share price" value={m.sharePrice.toFixed(6)} sub="USDC per dnUSDC" />
      <Stat label="Net APY (realised)" value={fmtPct(m.netApy)} tone={pnlTone(m.netApy)} sub="30d, after costs & fees" hint="Annualised share-price growth over the trailing 30 days of chain time." />
      <Stat label="Gross APY" value={fmtPct(m.grossApy)} sub="carry before costs & fees" hint="Realised lending + funding income over average TVL." />
      <Stat label="Est. forward net APY" value={fmtPct(m.estimatedNetApy)} tone={pnlTone(m.estimatedNetApy)} sub="at current rates" hint="Simulator estimation engine on live rates, vol and config." />
      <Stat label="Lending APY" value={fmtPct(m.lendingApy)} sub={`USDC ${fmtPct(m.usdcSupplyApr)} · WETH ${fmtPct(m.wethSupplyApr)}`} />
      <Stat label="Funding rate" value={fmtFunding8h(m.fundingRatePer8h)} sub={`APR ${fmtPct(m.fundingApr, 2, true)} · short ${m.fundingRatePer8h >= 0 ? "receives" : "pays"}`} />
      <Stat label="Net delta" value={fmtBps(m.netDeltaBpsExact, 2, true)} sub={`${fmtUsd(m.netDeltaUsd, { sign: true })} of NAV`} />
      <Stat label="Hedge ratio" value={fmtPct(m.hedgeRatio, 2)} sub="perp short / spot long" />
      <Stat label="Leverage" value={fmtX(m.leverage)} sub="perp notional / equity" />
      <Stat label="Liquidation distance" value={fmtBps(m.liquidationDistanceBps, 1)} sub="ETH rise to liquidate short" />
      <Stat label="Drawdown" value={fmtBps(m.drawdownBps, 2)} tone={m.drawdownBps > 0 ? "neg" : "neutral"} sub="from peak share price" />
      <Stat label="Total PnL" value={fmtUsd(m.totalPnlUsd, { sign: true })} tone={pnlTone(m.totalPnlUsd)} sub="strategy, net of vault fees" />
      <div className="min-w-0 rounded-lg border border-line bg-panel px-4 py-3">
        <div className="text-[0.7rem] font-medium uppercase tracking-[0.06em] text-muted">Risk level</div>
        <div className="mt-2">
          <RiskBadge state={m.riskState} />
        </div>
        <Link href="/risk" className="mt-1.5 block text-xs text-accent-strong hover:underline">
          Risk engine →
        </Link>
      </div>
    </div>
  );
}

function HistoryCard() {
  const [view, setView] = useState<"price" | "tvl">("price");
  const perf = usePerformance(null);
  return (
    <Card
      title={view === "price" ? "Share price" : "TVL"}
      subtitle="Full history · chain time (UTC)"
      action={
        <Segmented
          ariaLabel="History metric"
          value={view}
          onChange={setView}
          options={[
            { value: "price", label: "Share price" },
            { value: "tvl", label: "TVL" },
          ]}
        />
      }
    >
      <Query query={perf} skeleton={<Skeleton className="h-[240px]" />} isEmpty={(d) => d.points.length < 2} empty="Not enough history yet.">
        {(d) =>
          view === "price" ? (
            <TimeSeriesChart data={d.points} series={[{ key: "sharePrice", label: "Share price", color: S1 }]} yFormat={(v) => v.toFixed(4)} height={240} area />
          ) : (
            <TimeSeriesChart
              data={d.points}
              series={[{ key: "tvlUsd", label: "TVL", color: S1, format: (v) => fmtUsd(v, { digits: 0 }) }]}
              yFormat={(v) => fmtUsd(v, { digits: 0, compact: true })}
              height={240}
              area
            />
          )
        }
      </Query>
      {perf.data && (
        <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-ink-2 sm:grid-cols-4">
          <span>
            Period return <span className={`font-medium ${pnlTone(perf.data.summary.periodReturn) === "neg" ? "text-neg" : "text-ink"}`}>{fmtPct(perf.data.summary.periodReturn, 3, true)}</span>
          </span>
          <span>
            Annualised <span className="font-medium text-ink">{fmtPct(perf.data.summary.annualizedReturn)}</span>
          </span>
          <span>
            Max drawdown <span className="font-medium text-ink">{fmtBps(perf.data.summary.maxDrawdownBps, 2)}</span>
          </span>
          <span>
            Rebalances <span className="font-medium text-ink">{perf.data.summary.rebalances}</span>
          </span>
        </div>
      )}
    </Card>
  );
}

function PositionsCard() {
  const positions = usePositions();
  return (
    <Card title="Current positions" subtitle="Three legs + idle" action={<Link href="/positions" className="text-xs text-accent-strong hover:underline">Details →</Link>}>
      <Query query={positions} skeleton={<SkeletonRows rows={6} />}>
        {(p) => (
          <div className="space-y-4">
            <AllocationBar
              compact
              slices={[
                { label: "USDC reserve", value: p.reserve.suppliedUsd, pct: p.allocation.reservePct, color: S1 },
                { label: "WETH long", value: p.long.valueUsd, pct: p.allocation.longPct, color: S2 },
                { label: "Perp margin", value: p.perp.equityUsd, pct: p.allocation.perpPct, color: S3 },
                { label: "Idle", value: p.idle.vaultUsd + p.idle.strategyFloatUsd, pct: p.allocation.idlePct, color: S4 },
              ]}
            />
            <div className="space-y-2.5 text-[0.8125rem]">
              <Leg name="Reserve · USDC lending" main={fmtUsd(p.reserve.suppliedUsd, { digits: 0 })} detail={`APR ${fmtPct(p.reserve.supplyApr)} · util ${fmtPct(p.reserve.utilization, 1)}`} />
              <Leg name="Long · WETH lending" main={fmtEth(p.long.wethQty, 3)} detail={`${fmtUsd(p.long.valueUsd, { digits: 0 })} · APR ${fmtPct(p.long.supplyApr)}`} />
              <Leg
                name="Short · ETH perp"
                main={fmtEth(p.perp.size, 3)}
                detail={`${fmtUsd(p.perp.notionalUsd, { digits: 0 })} notional · ${fmtX(p.perp.leverage)} · liq ${p.perp.liquidationPrice ? fmtUsd(p.perp.liquidationPrice, { digits: 0 }) : "none"}`}
              />
              <Leg name="Idle" main={fmtUsd(p.idle.vaultUsd + p.idle.strategyFloatUsd, { digits: 0 })} detail="vault + strategy float" />
            </div>
          </div>
        )}
      </Query>
    </Card>
  );
}

function Leg({ name, main, detail }: { name: string; main: string; detail: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-ink">{name}</div>
        <div className="truncate text-xs text-muted">{detail}</div>
      </div>
      <div className="shrink-0 font-medium tabular-nums">{main}</div>
    </div>
  );
}

function AlertsCard() {
  const alerts = useAlerts(true);
  return (
    <Card title="Active alerts" subtitle="Alert engine (polls every 5s)" action={<Link href="/risk" className="text-xs text-accent-strong hover:underline">History →</Link>}>
      <Query query={alerts} skeleton={<SkeletonRows rows={3} />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyState>
              <Badge level="normal">All clear</Badge>
              <div className="mt-2">No active alerts.</div>
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {list.map((a) => (
                <li key={a.id} className="rounded-md border border-line bg-panel-2 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[0.8125rem] font-medium text-ink">{a.title}</span>
                    <SeverityBadge severity={a.severity} />
                  </div>
                  <p className="mt-1 text-xs text-ink-2">{a.message}</p>
                  <p className="mt-1 text-[0.68rem] text-muted">Opened {fmtDateTime(a.openedAt)}</p>
                </li>
              ))}
            </ul>
          )
        }
      </Query>
    </Card>
  );
}

function RebalancePlanCard() {
  const strategy = useStrategy();
  const delta = useDelta();
  return (
    <Card title="Next rebalance" subtitle="Keeper plan from the on-chain RebalanceManager" action={<Link href="/rebalancing" className="text-xs text-accent-strong hover:underline">History →</Link>}>
      <Query query={strategy} skeleton={<SkeletonRows rows={5} />}>
        {(s) => {
          const plan = s.nextPlan;
          return (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {plan.execute ? (
                  <Badge level={plan.urgent ? "crit" : "warn"}>{plan.urgent ? "Urgent rebalance due" : "Rebalance due"}</Badge>
                ) : (
                  <Badge level="normal">No trade needed</Badge>
                )}
                {plan.triggers.map((t) => (
                  <Chip key={t} tone={plan.urgent ? "crit" : "accent"}>
                    {t}
                  </Chip>
                ))}
                {s.defensive && <Chip tone="warn">DEFENSIVE</Chip>}
              </div>
              <KV
                rows={[
                  { label: "Long leg change", value: fmtUsd(plan.longUsdDelta, { sign: true }) },
                  { label: "Margin change", value: fmtUsd(plan.marginDelta, { sign: true }) },
                  { label: "Idle to sweep", value: fmtUsd(plan.sweepIdleUsd) },
                  { label: "Estimated cost", value: fmtUsd(plan.estimatedCostUsd) },
                  {
                    label: "Delta vs band",
                    value: delta.data ? `${fmtBps(delta.data.deltaBpsExact, 2, true)} / ±${fmtBps(delta.data.effectiveBandBps, 2)}` : "—",
                    hint: "Net delta against the volatility-scaled no-trade band",
                  },
                  { label: "Last rebalance", value: `${fmtAgo(s.lastRebalanceAt, s.blockTimestamp)} (#${s.rebalanceCount})` },
                ]}
              />
            </div>
          );
        }}
      </Query>
    </Card>
  );
}

export function OverviewView() {
  return (
    <div className="space-y-5">
      <KpiGrid />
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <HistoryCard />
        </div>
        <RebalancePlanCard />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <PositionsCard />
        <AlertsCard />
      </div>
    </div>
  );
}
