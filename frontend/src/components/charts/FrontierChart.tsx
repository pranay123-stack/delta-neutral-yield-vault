"use client";

import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { fmtPct, fmtX } from "@/lib/format";
import type { FrontierPoint } from "@/lib/types";

import { TooltipBox } from "./ChartTooltip";
import { BLUE_RAMP, CHROME, axisTick } from "./palette";

interface FrontierChartProps {
  frontier: FrontierPoint[];
  best?: { leverage: number; netApy: number } | null;
  current?: { leverage: number; netApy: number } | null;
  height?: number;
}

const key = (reserve: number) => `r${Math.round(reserve * 100)}`;

/**
 * Optimizer frontier: estimated net APY vs target leverage, one line per reserve share (ordered,
 * so a single-hue ramp: darker = smaller reserve). Filled dots are feasible under the risk
 * constraints; hollow dots are rejected.
 */
export function FrontierChart({ frontier, best, current, height = 300 }: FrontierChartProps) {
  const reserves = [...new Set(frontier.map((p) => p.reservePct))].sort((a, b) => a - b);
  const levs = [...new Set(frontier.map((p) => p.leverage))].sort((a, b) => a - b);
  const byKey = new Map(frontier.map((p) => [`${p.leverage}|${p.reservePct}`, p]));
  const rows = levs.map((lev) => {
    const row: Record<string, number> = { leverage: lev };
    for (const r of reserves) {
      const p = byKey.get(`${lev}|${r}`);
      if (p) row[key(r)] = p.netApy;
    }
    return row;
  });
  const colorFor = (i: number) => BLUE_RAMP[Math.min(BLUE_RAMP.length - 1, Math.round((i / Math.max(1, reserves.length - 1)) * (BLUE_RAMP.length - 1)))]!;

  return (
    <div className="w-full">
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={CHROME.grid} vertical={false} />
            <XAxis
              dataKey="leverage"
              type="number"
              domain={["dataMin", "dataMax"]}
              ticks={levs}
              tickFormatter={(v: number) => fmtX(v, 2)}
              tick={axisTick}
              stroke={CHROME.axis}
              tickLine={false}
            />
            <YAxis tickFormatter={(v: number) => fmtPct(v, 2)} tick={axisTick} axisLine={false} tickLine={false} width={52} />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: CHROME.axis }}
              content={(p) => {
                if (!p.active || p.label === undefined) return null;
                const lev = Number(p.label);
                const pts = reserves
                  .map((r, i) => ({ r, i, pt: byKey.get(`${lev}|${r}`) }))
                  .filter((x) => x.pt)
                  .sort((a, b) => b.pt!.netApy - a.pt!.netApy);
                return (
                  <TooltipBox
                    title={`Target leverage ${fmtX(lev)}`}
                    rows={pts.map(({ r, i, pt }) => ({
                      label: `Reserve ${fmtPct(r, 0)}${pt!.feasible ? "" : " (rejected)"}`,
                      value: `${fmtPct(pt!.netApy, 2)} · ${pt!.rebalancesPerYear.toFixed(0)}/yr`,
                      color: colorFor(i),
                    }))}
                  />
                );
              }}
            />
            {reserves.map((r, i) => {
              const color = colorFor(i);
              return (
                <Line
                  key={r}
                  dataKey={key(r)}
                  name={`Reserve ${fmtPct(r, 0)}`}
                  stroke={color}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  activeDot={false}
                  dot={(props) => {
                    const { cx, cy, payload, index } = props;
                    if (typeof cx !== "number" || typeof cy !== "number") return <g key={`${r}-${index}`} />;
                    const pt = byKey.get(`${(payload as { leverage: number }).leverage}|${r}`);
                    return pt?.feasible ? (
                      <circle key={`${r}-${index}`} cx={cx} cy={cy} r={3.5} fill={color} stroke={CHROME.surface} strokeWidth={1.5} />
                    ) : (
                      <circle key={`${r}-${index}`} cx={cx} cy={cy} r={2.5} fill={CHROME.surface} stroke={CHROME.muted} strokeWidth={1} />
                    );
                  }}
                />
              );
            })}
            {current && (
              <ReferenceDot x={current.leverage} y={current.netApy} r={6} fill="none" stroke={CHROME.ink} strokeWidth={1.5} strokeDasharray="2 2" ifOverflow="extendDomain" />
            )}
            {best && <ReferenceDot x={best.leverage} y={best.netApy} r={7} fill="none" stroke={CHROME.ink} strokeWidth={2} ifOverflow="extendDomain" />}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex h-2 w-16 overflow-hidden rounded-sm">
            {BLUE_RAMP.map((c) => (
              <span key={c} className="h-full flex-1" style={{ background: c }} />
            ))}
          </span>
          reserve {fmtPct(reserves[0] ?? 0, 0)} → {fmtPct(reserves[reserves.length - 1] ?? 0, 0)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="3.5" fill={BLUE_RAMP[3]} />
          </svg>
          feasible
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10" aria-hidden>
            <circle cx="5" cy="5" r="3" fill="none" stroke={CHROME.muted} />
          </svg>
          rejected by constraints
        </span>
        {best && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" aria-hidden>
              <circle cx="7" cy="7" r="5.5" fill="none" stroke={CHROME.ink} strokeWidth="2" />
            </svg>
            optimizer pick
          </span>
        )}
        {current && (
          <span className="inline-flex items-center gap-1.5">
            <svg width="14" height="14" aria-hidden>
              <circle cx="7" cy="7" r="5" fill="none" stroke={CHROME.ink} strokeWidth="1.5" strokeDasharray="2 2" />
            </svg>
            live config
          </span>
        )}
      </div>
    </div>
  );
}
