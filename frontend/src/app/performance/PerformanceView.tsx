"use client";

import type { PerformancePoint } from "@dnv/shared";
import { useMemo, useState } from "react";

import { Legend } from "@/components/charts/ChartTooltip";
import { S1, S2, S3, S4 } from "@/components/charts/palette";
import { TimeSeriesChart } from "@/components/charts/TimeSeriesChart";
import { Card } from "@/components/ui/Card";
import { ErrorState, Skeleton, Spinner } from "@/components/ui/QueryState";
import { Segmented } from "@/components/ui/Segmented";
import { Stat } from "@/components/ui/Stat";
import { fmtBps, fmtDate, fmtNum, fmtPct, fmtUsd, fmtX, pnlTone } from "@/lib/format";
import { usePerformance, useStrategy } from "@/lib/queries";

type Range = 7 | 30 | 90 | 0;
const RANGES: { value: Range; label: string }[] = [
  { value: 7, label: "7D" },
  { value: 30, label: "30D" },
  { value: 90, label: "90D" },
  { value: 0, label: "All" },
];

interface Row {
  ts: number;
  tvlUsd: number;
  sharePrice: number;
  apy7d: number | null;
  apy30d: number | null;
  strategyNetPnl: number;
  fundingIncome: number;
  lendingIncome: number;
  costsNeg: number;
  netDeltaBps: number;
  drawdownBps: number;
  fundingApr: number;
  leverage: number;
  ethPrice: number;
}

const toRow = (p: PerformancePoint): Row => ({
  ts: p.ts,
  tvlUsd: p.tvlUsd,
  sharePrice: p.sharePrice,
  apy7d: p.apy7d,
  apy30d: p.apy30d,
  strategyNetPnl: p.strategyNetPnl,
  fundingIncome: p.fundingIncome,
  lendingIncome: p.lendingIncome,
  costsNeg: -p.tradingCosts,
  netDeltaBps: p.netDeltaBps,
  drawdownBps: p.drawdownBps,
  fundingApr: p.fundingRatePer8h * 1095,
  leverage: p.leverage,
  ethPrice: p.ethPrice,
});

function ChartCard({ title, subtitle, legend, children }: { title: string; subtitle?: string; legend?: { label: string; color: string }[]; children: React.ReactNode }) {
  return (
    <Card title={title} subtitle={subtitle} action={legend ? <Legend items={legend} /> : undefined}>
      {children}
    </Card>
  );
}

export function PerformanceView() {
  const [range, setRange] = useState<Range>(30);
  const days = range === 0 ? null : range;
  // Charts slice the full series client-side: trailing 7d/30d APYs are computed by the API only
  // inside the requested window, so a 30D request would carry no 30d APY at all.
  const full = usePerformance(null);
  const ranged = usePerformance(days);
  const strategy = useStrategy();

  const rows = useMemo(() => {
    if (!full.data) return [];
    const pts = full.data.points;
    const end = pts.length ? pts[pts.length - 1]!.ts : 0;
    const from = days ? end - days * 86_400 : 0;
    return pts.filter((p) => p.ts >= from).map(toRow);
  }, [full.data, days]);

  const summary = ranged.data?.summary;
  const band = strategy.data?.params.deltaBandBps;
  const targetLev = strategy.data?.targets.leverage;

  const loading = !full.data;
  const chart = (node: React.ReactNode) => (loading ? <Skeleton className="h-[200px]" /> : rows.length < 2 ? <div className="grid h-[200px] place-items-center text-xs text-muted">Not enough points in this range.</div> : node);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Segmented ariaLabel="Range" options={RANGES} value={range} onChange={setRange} />
          {(ranged.isFetching || full.isFetching) && <Spinner />}
        </div>
        {summary && (
          <div className="text-xs text-ink-2">
            {fmtDate(summary.fromTs)} → {fmtDate(summary.toTs)} · {rows.length} snapshots (chain time)
          </div>
        )}
      </div>

      {full.isError && !full.data && <ErrorState error={full.error} onRetry={() => void full.refetch()} />}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {summary ? (
          <>
            <Stat label="Period return" value={fmtPct(summary.periodReturn, 3, true)} tone={pnlTone(summary.periodReturn)} sub={`${summary.sharePriceStart.toFixed(6)} → ${summary.sharePriceEnd.toFixed(6)}`} />
            <Stat label="Annualised" value={fmtPct(summary.annualizedReturn)} tone={pnlTone(summary.annualizedReturn)} sub="share-price CAGR" />
            <Stat label="Max drawdown" value={fmtBps(summary.maxDrawdownBps, 3)} tone={summary.maxDrawdownBps > 0 ? "neg" : "neutral"} sub="peak to trough" />
            <Stat label="Volatility" value={fmtPct(summary.volatilityAnnual, 3)} sub="annualised, daily returns" />
            <Stat label="Sharpe" value={fmtNum(summary.sharpe, 2)} sub="no risk-free deduction" hint="Annualised return / annualised volatility. Very high because a hedged book has tiny share-price variance." />
            <Stat label="Rebalances" value={String(summary.rebalances)} sub="in range" />
          </>
        ) : ranged.isError ? (
          <div className="col-span-full">
            <ErrorState error={ranged.error} compact />
          </div>
        ) : (
          Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-[78px]" />)
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <ChartCard title="TVL" subtitle="Total assets (idle + strategy NAV)">
          {chart(<TimeSeriesChart data={rows} series={[{ key: "tvlUsd", label: "TVL", color: S1, format: (v) => fmtUsd(v, { digits: 0 }) }]} yFormat={(v) => fmtUsd(v, { digits: 0, compact: true })} area />)}
        </ChartCard>
        <ChartCard title="Share price" subtitle="USDC per dnUSDC, net of all costs and fees">
          {chart(<TimeSeriesChart data={rows} series={[{ key: "sharePrice", label: "Share price", color: S1, format: (v) => v.toFixed(6) }]} yFormat={(v) => v.toFixed(4)} area />)}
        </ChartCard>
        <ChartCard
          title="Realised APY"
          subtitle="Trailing, annualised share-price growth"
          legend={[
            { label: "7d trailing", color: S1 },
            { label: "30d trailing", color: S2 },
          ]}
        >
          {chart(
            <TimeSeriesChart
              data={rows}
              series={[
                { key: "apy7d", label: "7d trailing", color: S1 },
                { key: "apy30d", label: "30d trailing", color: S2 },
              ]}
              yFormat={(v) => fmtPct(v, 1)}
              refLines={[{ y: 0 }]}
            />,
          )}
        </ChartCard>
        <ChartCard
          title="Cumulative PnL"
          subtitle="Since inception; costs = trading fees + slippage"
          legend={[
            { label: "Strategy net", color: S1 },
            { label: "Funding", color: S2 },
            { label: "Lending", color: S3 },
            { label: "Costs (−)", color: S4 },
          ]}
        >
          {chart(
            <TimeSeriesChart
              data={rows}
              series={[
                { key: "strategyNetPnl", label: "Strategy net", color: S1 },
                { key: "fundingIncome", label: "Funding", color: S2 },
                { key: "lendingIncome", label: "Lending", color: S3 },
                { key: "costsNeg", label: "Costs (−)", color: S4 },
              ]}
              yFormat={(v) => fmtUsd(v, { digits: 0, compact: true })}
              refLines={[{ y: 0 }]}
            />,
          )}
        </ChartCard>
        <ChartCard title="Net delta" subtitle={band ? `% of NAV · dashed = ±${fmtBps(band, 0)} no-trade band` : "% of NAV"}>
          {chart(
            <TimeSeriesChart
              data={rows}
              series={[{ key: "netDeltaBps", label: "Net delta", color: S1, format: (v) => fmtBps(v, 2, true) }]}
              yFormat={(v) => fmtBps(v, 2)}
              refLines={band ? [{ y: band, label: "+band" }, { y: -band, label: "−band" }] : [{ y: 0 }]}
              step
            />,
          )}
        </ChartCard>
        <ChartCard title="Drawdown" subtitle="Below the running share-price peak">
          {chart(<TimeSeriesChart data={rows} series={[{ key: "drawdownBps", label: "Drawdown", color: S1, format: (v) => fmtBps(v, 3) }]} yFormat={(v) => fmtBps(v, 2)} area step />)}
        </ChartCard>
        <ChartCard title="Funding rate" subtitle="Annualised (per-8h rate × 1095); positive = short receives">
          {chart(
            <TimeSeriesChart
              data={rows}
              series={[{ key: "fundingApr", label: "Funding APR", color: S1, format: (v) => `${fmtPct(v, 2, true)} (${fmtPct(v / 1095, 4, true)}/8h)` }]}
              yFormat={(v) => fmtPct(v, 0)}
              refLines={[{ y: 0 }]}
            />,
          )}
        </ChartCard>
        <ChartCard title="Perp leverage" subtitle={targetLev ? `Notional / equity · dashed = ${fmtX(targetLev)} target` : "Notional / equity"}>
          {chart(
            <TimeSeriesChart
              data={rows}
              series={[{ key: "leverage", label: "Leverage", color: S1, format: (v) => fmtX(v, 3) }]}
              yFormat={(v) => fmtX(v, 1)}
              refLines={targetLev ? [{ y: targetLev, label: "target" }] : undefined}
              step
            />,
          )}
        </ChartCard>
        <ChartCard title="ETH price" subtitle="Oracle price (mock market driver)">
          {chart(<TimeSeriesChart data={rows} series={[{ key: "ethPrice", label: "ETH", color: S1, format: (v) => fmtUsd(v) }]} yFormat={(v) => fmtUsd(v, { digits: 0 })} />)}
        </ChartCard>
      </div>
    </div>
  );
}
