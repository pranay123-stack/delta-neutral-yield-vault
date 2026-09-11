"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Legend, TooltipBox } from "@/components/charts/ChartTooltip";
import { CHROME, S1, S2, axisTick } from "@/components/charts/palette";
import { RangeBar } from "@/components/charts/RangeBar";
import { Badge } from "@/components/ui/Badge";
import { Card, Note, cx } from "@/components/ui/Card";
import { ErrorState, Query, Skeleton, Spinner } from "@/components/ui/QueryState";
import { Stat } from "@/components/ui/Stat";
import { api } from "@/lib/api";
import { fmtBps, fmtNum, fmtPct, fmtUsd, fmtX, pnlTone, toneClass } from "@/lib/format";
import { useScenarios } from "@/lib/queries";
import type { MonteCarloResult, OptimizeResult, ScenarioResult, SimulationRequest } from "@/lib/types";

type Metrics = ScenarioResult["withKeeper"];

// ---- scenario metric definitions -----------------------------------------------------------------

interface MetricDef {
  key: keyof Metrics;
  label: string;
  fmt: (v: number | null) => string;
  /** Signed formatter for the ON − OFF column. */
  diff: (v: number) => string;
  pnl?: boolean;
  /** For the ON-vs-OFF delta column: is a higher value better? */
  higherBetter?: boolean;
}

const usd0 = (v: number | null) => fmtUsd(v, { digits: 0, sign: true });
const usdDiff = (v: number) => fmtUsd(v, { digits: 0, sign: true });
const bpsDiff = (v: number) => fmtBps(v, 2, true);
const countDiff = (v: number) => fmtNum(v, 0, true);
const METRICS: MetricDef[] = [
  { key: "netPnl", label: "Net PnL", fmt: usd0, diff: usdDiff, pnl: true, higherBetter: true },
  { key: "netReturnPct", label: "Net return", fmt: (v) => (v === null ? "—" : fmtPct(v / 100, 2, true)), diff: (v) => fmtPct(v / 100, 2, true), pnl: true, higherBetter: true },
  { key: "hedgePnl", label: "Hedge PnL", fmt: usd0, diff: usdDiff, pnl: true },
  { key: "spotPnl", label: "Spot PnL", fmt: usd0, diff: usdDiff, pnl: true },
  { key: "fundingPnl", label: "Funding", fmt: usd0, diff: usdDiff, pnl: true, higherBetter: true },
  { key: "lendingIncome", label: "Lending", fmt: usd0, diff: usdDiff, pnl: true, higherBetter: true },
  { key: "tradingCosts", label: "Trading costs", fmt: (v) => fmtUsd(v, { digits: 0 }), diff: usdDiff, higherBetter: false },
  { key: "maxAbsDeltaBps", label: "Max |delta|", fmt: (v) => fmtBps(v, 2), diff: bpsDiff, higherBetter: false },
  { key: "minLiquidationDistanceBps", label: "Min liq. distance", fmt: (v) => (v === null ? "no short" : fmtBps(v, 1)), diff: bpsDiff, higherBetter: true },
  { key: "maxDrawdownBps", label: "Max drawdown", fmt: (v) => fmtBps(v, 2), diff: bpsDiff, higherBetter: false },
  { key: "maxLeverage", label: "Max leverage", fmt: (v) => fmtX(v, 2), diff: (v) => fmtNum(v, 2, true), higherBetter: false },
  { key: "rebalances", label: "Rebalances", fmt: (v) => fmtNum(v, 0), diff: countDiff },
  { key: "liquidations", label: "Liquidations", fmt: (v) => fmtNum(v, 0), diff: countDiff, higherBetter: false },
  { key: "badDebtAbsorbed", label: "Bad debt", fmt: (v) => fmtUsd(v, { digits: 0 }), diff: usdDiff, higherBetter: false },
];

const TABLE_METRICS: (keyof Metrics)[] = [
  "netPnl",
  "liquidations",
  "minLiquidationDistanceBps",
  "maxAbsDeltaBps",
  "maxDrawdownBps",
  "rebalances",
  "hedgePnl",
  "fundingPnl",
  "lendingIncome",
  "tradingCosts",
];

function metricDef(key: keyof Metrics): MetricDef {
  return METRICS.find((m) => m.key === key)!;
}

function valueTone(def: MetricDef, v: number | null): string {
  if (def.key === "liquidations") return v ? "text-neg font-semibold" : "text-ink";
  if (def.pnl) return toneClass[pnlTone(v, 0.5)];
  return "text-ink";
}

// ---- catalogue -----------------------------------------------------------------------------------

function ScenarioChart({ list }: { list: ScenarioResult[] }) {
  const rows = list.map((s) => ({ label: `${s.id} · ${s.name}`, on: s.withKeeper.netPnl, off: s.withoutKeeper.netPnl, s }));
  return (
    <div style={{ height: rows.length * 34 + 40 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barGap={2} barCategoryGap={6}>
          <CartesianGrid stroke={CHROME.grid} horizontal={false} />
          <XAxis type="number" tickFormatter={(v: number) => fmtUsd(v, { digits: 0, compact: true })} tick={axisTick} stroke={CHROME.axis} tickLine={false} />
          <YAxis type="category" dataKey="label" width={170} tick={{ ...axisTick, fill: CHROME.ink }} axisLine={false} tickLine={false} interval={0} />
          <ReferenceLine x={0} stroke={CHROME.axis} />
          <Tooltip
            isAnimationActive={false}
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            content={(p) => {
              if (!p.active || !p.payload?.length) return null;
              const row = p.payload[0]?.payload as (typeof rows)[number] | undefined;
              if (!row) return null;
              return (
                <TooltipBox
                  title={row.label}
                  rows={[
                    { label: "Keeper on", value: fmtUsd(row.on, { sign: true }), color: S1 },
                    { label: "Keeper off", value: fmtUsd(row.off, { sign: true }), color: S2 },
                    { label: "Liquidations (on / off)", value: `${row.s.withKeeper.liquidations} / ${row.s.withoutKeeper.liquidations}` },
                  ]}
                />
              );
            }}
          />
          <Bar dataKey="on" name="Keeper on" fill={S1} radius={2} maxBarSize={12} isAnimationActive={false} />
          <Bar dataKey="off" name="Keeper off" fill={S2} radius={2} maxBarSize={12} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function Catalogue() {
  const scenarios = useScenarios();
  return (
    <Card
      title="Scenario catalogue A–J"
      subtitle="Deterministic 30-day market paths under the live on-chain config, each run with the keeper ON and OFF (TVL = max(vault TVL, $100k))"
      flush
    >
      <Query query={scenarios} skeleton={<div className="p-4"><Skeleton className="h-[420px]" /></div>} isEmpty={(l) => l.length === 0} empty="No scenarios returned.">
        {(list) => (
          <div>
            <div className="overflow-x-auto">
              <table className="table-dense">
                <thead>
                  <tr>
                    <th>Scenario</th>
                    <th className="num">ETH move</th>
                    {TABLE_METRICS.map((k) => (
                      <th key={k} className="num">
                        {metricDef(k).label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {list.map((s) => (
                    <tr key={s.id}>
                      <td className="min-w-[200px]">
                        <div className="font-medium text-ink">
                          <span className="mr-1.5 font-mono text-accent-strong">{s.id}</span>
                          {s.name}
                        </div>
                        <div className="max-w-[260px] text-[0.7rem] leading-snug text-muted">{s.description}</div>
                      </td>
                      <td className={cx("num", toneClass[pnlTone(s.ethMovePct, 0.01)])}>{fmtPct(s.ethMovePct / 100, 1, true)}</td>
                      {TABLE_METRICS.map((k) => {
                        const def = metricDef(k);
                        const on = s.withKeeper[k] as number | null;
                        const off = s.withoutKeeper[k] as number | null;
                        return (
                          <td key={k} className="num">
                            <div className={valueTone(def, on)}>{def.fmt(on)}</div>
                            <div className={cx("text-[0.72rem] opacity-70", valueTone(def, off))}>{def.fmt(off)}</div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-xs text-ink-2">
              <span>
                Each cell: <span className="text-ink">top = keeper ON</span> · <span className="opacity-70">bottom = keeper OFF</span>. Liquidations in red.
              </span>
            </div>
            <div className="border-t border-line p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[0.8125rem] font-semibold text-ink">Net PnL by scenario</span>
                <Legend
                  items={[
                    { label: "Keeper on", color: S1 },
                    { label: "Keeper off", color: S2 },
                  ]}
                />
              </div>
              <ScenarioChart list={list} />
            </div>
          </div>
        )}
      </Query>
    </Card>
  );
}

// ---- result renderers ----------------------------------------------------------------------------

export function ScenarioResultView({ result }: { result: ScenarioResult }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium text-ink">{result.name}</div>
          <div className="text-xs text-ink-2">
            {result.days}d horizon · ETH {fmtUsd(result.ethPriceStart, { digits: 0 })} → {fmtUsd(result.ethPriceEnd, { digits: 0 })} ({fmtPct(result.ethMovePct / 100, 1, true)})
          </div>
        </div>
        <div className="flex gap-2">
          {result.withKeeper.liquidations > 0 && <Badge level="crit">keeper ON liquidated</Badge>}
          {result.withoutKeeper.liquidations > 0 && <Badge level="crit">keeper OFF liquidated</Badge>}
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="table-dense">
          <thead>
            <tr>
              <th>Metric</th>
              <th className="num">Keeper ON</th>
              <th className="num">Keeper OFF</th>
              <th className="num">ON − OFF</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((def) => {
              const on = result.withKeeper[def.key] as number | null;
              const off = result.withoutKeeper[def.key] as number | null;
              const diff = on !== null && off !== null ? on - off : null;
              const better = diff === null || def.higherBetter === undefined || Math.abs(diff) < 1e-9 ? null : def.higherBetter ? diff > 0 : diff < 0;
              return (
                <tr key={def.key}>
                  <td className="text-ink-2">{def.label}</td>
                  <td className={cx("num", valueTone(def, on))}>{def.fmt(on)}</td>
                  <td className={cx("num", valueTone(def, off))}>{def.fmt(off)}</td>
                  <td className="num text-xs">
                    {diff === null ? "—" : def.diff(diff)}
                    {better !== null && <span className={cx("ml-1.5 text-[0.68rem]", better ? "text-accent-strong" : "text-muted")}>{better ? "keeper better" : "keeper worse"}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const PCTL_ROWS: { key: keyof Pick<MonteCarloResult, "annualizedReturn" | "periodReturn" | "maxDrawdownBps" | "maxAbsDeltaBps" | "rebalances" | "tradingCostPct">; label: string; fmt: (v: number) => string }[] = [
  { key: "annualizedReturn", label: "Annualised return", fmt: (v) => fmtPct(v, 2, true) },
  { key: "periodReturn", label: "Period return", fmt: (v) => fmtPct(v, 2, true) },
  { key: "maxDrawdownBps", label: "Max drawdown", fmt: (v) => fmtBps(v, 2) },
  { key: "maxAbsDeltaBps", label: "Max |delta|", fmt: (v) => fmtBps(v, 2) },
  { key: "rebalances", label: "Rebalances", fmt: (v) => fmtNum(v, 1) },
  { key: "tradingCostPct", label: "Trading costs (% TVL)", fmt: (v) => fmtPct(v / 100, 2) },
];

export function MonteCarloResultView({ result }: { result: MonteCarloResult }) {
  const ar = result.annualizedReturn;
  const lo = Math.min(0, ar.p5);
  const hi = Math.max(0, ar.p95);
  const pad = (hi - lo) * 0.1 || 0.01;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Median annualised" value={fmtPct(ar.p50, 2, true)} tone={pnlTone(ar.p50)} sub={`mean ${fmtPct(ar.mean, 2, true)}`} />
        <Stat label="VaR 95 (period)" value={fmtPct(result.var95, 2, true)} tone={pnlTone(result.var95)} sub={`CVaR 95 ${fmtPct(result.cvar95, 2, true)}`} hint="5th-percentile period return; CVaR = mean of the worst 5% of paths" />
        <Stat label="P(loss)" value={fmtPct(result.lossProbability, 1)} sub="paths with negative return" />
        <Stat label="P(liquidation)" value={fmtPct(result.liquidationProbability, 1)} tone={result.liquidationProbability > 0 ? "neg" : "neutral"} sub="paths with ≥1 venue liquidation" />
      </div>
      <div>
        <div className="mb-1 text-xs text-ink-2">
          Annualised return distribution · {result.paths} paths × {result.days} days (whisker p5–p95, box p25–p75, tick = median)
        </div>
        <RangeBar {...ar} domain={[lo - pad, hi + pad]} format={(v) => fmtPct(v, 1)} />
      </div>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="table-dense">
          <thead>
            <tr>
              <th>Percentiles</th>
              <th className="num">p5</th>
              <th className="num">p25</th>
              <th className="num">p50</th>
              <th className="num">p75</th>
              <th className="num">p95</th>
              <th className="num">mean</th>
            </tr>
          </thead>
          <tbody>
            {PCTL_ROWS.map((row) => {
              const p = result[row.key];
              return (
                <tr key={row.key}>
                  <td className="text-ink-2">{row.label}</td>
                  {(["p5", "p25", "p50", "p75", "p95", "mean"] as const).map((q) => (
                    <td key={q} className={cx("num", q === "p50" && "font-semibold text-ink")}>
                      {row.fmt(p[q])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OptimizerResultView({ result }: { result: OptimizeResult }) {
  return (
    <div className="space-y-2 text-[0.8125rem]">
      <Note>{result.recommendation}</Note>
      <div className="text-ink-2">
        Best: {fmtX(result.best.inputs.targetLeverage)} leverage, {fmtPct(result.best.inputs.reserveRatio, 0)} reserve → est. net APY {fmtPct(result.best.netApy)} (current {fmtPct(result.current.netApy)}).
      </div>
    </div>
  );
}

// ---- forms ---------------------------------------------------------------------------------------

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1 block text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-0.5 block text-[0.68rem] text-muted">{hint}</span>}
    </label>
  );
}

const num = (s: string): number | undefined => {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

function useElapsed(running: boolean) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    setElapsed(0);
    const t = window.setInterval(() => setElapsed((performance.now() - start) / 1000), 100);
    return () => window.clearInterval(t);
  }, [running]);
  return elapsed;
}

function CustomScenario() {
  const [f, setF] = useState({
    priceMovePct: "30",
    moveDays: "3",
    horizonDays: "30",
    fundingPct8h: "",
    usdcUtilPct: "",
    wethUtilPct: "",
    oracleOutageDays: "",
    liquidityMultiplier: "",
    leverage: "",
    reservePct: "",
    tvl: "100000",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const run = useMutation({ mutationFn: (body: SimulationRequest) => api.simulate<ScenarioResult>(body) });
  const [formError, setFormError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const priceMovePct = num(f.priceMovePct);
    const moveDays = num(f.moveDays);
    const horizonDays = num(f.horizonDays);
    if (priceMovePct === undefined || priceMovePct <= -100) return setFormError("ETH move must be a number above -100%.");
    if (moveDays === undefined || moveDays < 0 || moveDays > 365) return setFormError("Move days must be between 0 and 365.");
    if (horizonDays === undefined || horizonDays < 1 || horizonDays > 365) return setFormError("Horizon must be between 1 and 365 days.");
    setFormError(null);
    const opt = (v: number | undefined, scale = 1) => (v === undefined ? undefined : v * scale);
    const body: SimulationRequest = {
      type: "custom",
      priceMovePct,
      moveDays,
      horizonDays,
      fundingRatePer8h: opt(num(f.fundingPct8h), 1 / 100),
      usdcUtilization: opt(num(f.usdcUtilPct), 1 / 100),
      wethUtilization: opt(num(f.wethUtilPct), 1 / 100),
      oracleOutageDays: opt(num(f.oracleOutageDays)),
      liquidityMultiplier: opt(num(f.liquidityMultiplier)),
      leverageBps: opt(num(f.leverage), 10_000),
      reserveBps: opt(num(f.reservePct), 100),
      tvl: opt(num(f.tvl)),
    };
    // drop undefined keys (the API rejects unknown props, not missing ones)
    run.mutate(JSON.parse(JSON.stringify(body)) as SimulationRequest);
  }

  return (
    <Card title="Custom scenario" subtitle="POST /simulation · type custom - a price move plus optional regime overrides">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Field label="ETH move %">
            <input className="input" inputMode="decimal" value={f.priceMovePct} onChange={set("priceMovePct")} />
          </Field>
          <Field label="Over (days)">
            <input className="input" inputMode="decimal" value={f.moveDays} onChange={set("moveDays")} />
          </Field>
          <Field label="Horizon (days)">
            <input className="input" inputMode="decimal" value={f.horizonDays} onChange={set("horizonDays")} />
          </Field>
          <Field label="Funding %/8h" hint="blank = 0.01% base">
            <input className="input" inputMode="decimal" placeholder="e.g. -0.03" value={f.fundingPct8h} onChange={set("fundingPct8h")} />
          </Field>
          <Field label="USDC utilisation %" hint="blank = market">
            <input className="input" inputMode="decimal" placeholder="80" value={f.usdcUtilPct} onChange={set("usdcUtilPct")} />
          </Field>
          <Field label="WETH utilisation %" hint="blank = market">
            <input className="input" inputMode="decimal" placeholder="60" value={f.wethUtilPct} onChange={set("wethUtilPct")} />
          </Field>
          <Field label="Oracle outage (days)" hint="stale feed from day 0">
            <input className="input" inputMode="decimal" placeholder="0" value={f.oracleOutageDays} onChange={set("oracleOutageDays")} />
          </Field>
          <Field label="Liquidity multiplier" hint="1 = normal, 0.01 = 100x shallower">
            <input className="input" inputMode="decimal" placeholder="1" value={f.liquidityMultiplier} onChange={set("liquidityMultiplier")} />
          </Field>
          <Field label="Target leverage (x)" hint="blank = default 2x">
            <input className="input" inputMode="decimal" placeholder="2" value={f.leverage} onChange={set("leverage")} />
          </Field>
          <Field label="Reserve %" hint="blank = default">
            <input className="input" inputMode="decimal" placeholder="10" value={f.reservePct} onChange={set("reservePct")} />
          </Field>
          <Field label="TVL (USD)">
            <input className="input" inputMode="decimal" value={f.tvl} onChange={set("tvl")} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={run.isPending}>
            {run.isPending && <Spinner className="text-white" />}
            {run.isPending ? "Running…" : "Run scenario"}
          </button>
          {run.data && <span className="text-xs text-muted">saved as simulation #{run.data.id}</span>}
        </div>
        {formError && <p className="text-xs text-crit">{formError}</p>}
      </form>
      <div className="mt-4">
        {run.isError && <ErrorState error={run.error} compact />}
        {run.isPending && <Skeleton className="h-[300px]" />}
        {run.data && !run.isPending && <ScenarioResultView result={run.data.result} />}
      </div>
      <p className="mt-3 text-[0.68rem] text-muted">Custom runs use the simulator's default strategy config with your leverage / reserve overrides (the catalogue uses the live on-chain config).</p>
    </Card>
  );
}

function MonteCarlo() {
  const [f, setF] = useState({ paths: "200", days: "365", seed: "42", tvl: "100000" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  const run = useMutation({ mutationFn: (body: SimulationRequest) => api.simulate<MonteCarloResult>(body) });
  const elapsed = useElapsed(run.isPending);
  const [formError, setFormError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    const paths = num(f.paths);
    const days = num(f.days);
    const seed = num(f.seed);
    const tvl = num(f.tvl);
    if (!paths || !Number.isInteger(paths) || paths < 1 || paths > 500) return setFormError("Paths must be an integer from 1 to 500.");
    if (!days || !Number.isInteger(days) || days < 1 || days > 730) return setFormError("Days must be an integer from 1 to 730.");
    if (seed === undefined || !Number.isInteger(seed)) return setFormError("Seed must be an integer.");
    if (tvl !== undefined && tvl <= 0) return setFormError("TVL must be positive.");
    setFormError(null);
    run.mutate({ type: "montecarlo", paths, days, seed, ...(tvl ? { tvl } : {}) });
  }

  return (
    <Card title="Monte Carlo" subtitle="POST /simulation · type montecarlo - synthetic regime-switching markets, full path simulation per path">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Paths" hint="max 500">
            <input className="input" inputMode="numeric" value={f.paths} onChange={set("paths")} />
          </Field>
          <Field label="Days" hint="max 730">
            <input className="input" inputMode="numeric" value={f.days} onChange={set("days")} />
          </Field>
          <Field label="Seed" hint="same seed = same paths">
            <input className="input" inputMode="numeric" value={f.seed} onChange={set("seed")} />
          </Field>
          <Field label="TVL (USD)">
            <input className="input" inputMode="decimal" value={f.tvl} onChange={set("tvl")} />
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className="btn btn-primary" disabled={run.isPending}>
            {run.isPending && <Spinner className="text-white" />}
            {run.isPending ? `Simulating… ${elapsed.toFixed(1)}s` : "Run Monte Carlo"}
          </button>
          {run.data && <span className="text-xs text-muted">saved as simulation #{run.data.id}</span>}
        </div>
        {formError && <p className="text-xs text-crit">{formError}</p>}
      </form>
      <div className="mt-4">
        {run.isError && <ErrorState error={run.error} compact />}
        {run.isPending && (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-strong text-xs text-ink-2">
            <Spinner className="h-6 w-6" />
            Running {f.paths} paths × {f.days} days on the backend… ({elapsed.toFixed(1)}s)
          </div>
        )}
        {run.data && !run.isPending && <MonteCarloResultView result={run.data.result} />}
      </div>
    </Card>
  );
}

function StoredLookup() {
  const [input, setInput] = useState("");
  const [id, setId] = useState<number | null>(null);
  const stored = useQuery({
    queryKey: ["simulation", id],
    queryFn: ({ signal }) => api.simulation(id!, signal),
    enabled: id !== null,
    retry: false,
    staleTime: Infinity,
  });
  return (
    <Card title="Stored simulation" subtitle="GET /simulation/:id - every run above is persisted">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(input);
          if (Number.isInteger(n) && n > 0) setId(n);
        }}
      >
        <input className="input max-w-[140px]" inputMode="numeric" placeholder="id, e.g. 1" value={input} onChange={(e) => setInput(e.target.value)} />
        <button type="submit" className="btn btn-ghost">
          Load
        </button>
      </form>
      <div className="mt-4">
        {id === null ? (
          <p className="text-xs text-muted">Enter a simulation id to reload its input and result.</p>
        ) : (
          <Query query={stored} skeleton={<Skeleton className="h-[160px]" />}>
            {(s) => (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
                  <Badge level="info">{s.kind}</Badge>
                  <span>#{s.id}</span>
                  <span>created {new Date(s.createdAt).toISOString().replace("T", " ").slice(0, 19)} UTC (wall clock)</span>
                </div>
                <pre className="max-h-32 overflow-auto rounded-md border border-line bg-bg p-2 font-mono text-[0.7rem] text-ink-2">{JSON.stringify(s.input, null, 1)}</pre>
                {(s.kind === "scenario" || s.kind === "custom") && <ScenarioResultView result={s.result as ScenarioResult} />}
                {s.kind === "montecarlo" && <MonteCarloResultView result={s.result as MonteCarloResult} />}
                {s.kind === "optimizer" && <OptimizerResultView result={s.result as OptimizeResult} />}
              </div>
            )}
          </Query>
        )}
      </div>
    </Card>
  );
}

export function SimulationView() {
  return (
    <div className="space-y-5">
      <Catalogue />
      <div className="grid gap-5 2xl:grid-cols-2">
        <CustomScenario />
        <MonteCarlo />
      </div>
      <StoredLookup />
    </div>
  );
}
