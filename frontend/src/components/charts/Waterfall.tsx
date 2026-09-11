"use client";

import { Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { fmtUsd } from "@/lib/format";

import { TooltipBox } from "./ChartTooltip";
import { CHROME, PNL, axisTick } from "./palette";

export interface WaterfallStep {
  label: string;
  /** Signed contribution; ignored for totals. */
  value: number;
  /** A subtotal bar drawn from zero to the running total. */
  total?: boolean;
}

interface Row {
  label: string;
  range: [number, number];
  delta: number;
  running: number;
  kind: "pos" | "neg" | "total";
}

function buildRows(steps: WaterfallStep[]): Row[] {
  let running = 0;
  return steps.map((s) => {
    if (s.total) {
      return { label: s.label, range: [Math.min(0, running), Math.max(0, running)], delta: running, running, kind: "total" };
    }
    const start = running;
    running += s.value;
    return {
      label: s.label,
      range: [Math.min(start, running), Math.max(start, running)],
      delta: s.value,
      running,
      kind: s.value >= 0 ? "pos" : "neg",
    };
  });
}

const FILL = { pos: PNL.pos, neg: PNL.neg, total: PNL.total };

/** Horizontal waterfall (floating range bars): each step moves the running total; totals start at 0. */
export function Waterfall({
  steps,
  height,
  format = (v) => fmtUsd(v, { sign: true }),
  axisFormat = (v) => fmtUsd(v, { digits: 0, compact: true }),
}: {
  steps: WaterfallStep[];
  height?: number;
  /** Signed value formatter for tooltips. */
  format?: (v: number) => string;
  axisFormat?: (v: number) => string;
}) {
  const rows = buildRows(steps);
  return (
    <div style={{ height: height ?? rows.length * 30 + 40 }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 4 }} barCategoryGap={4}>
          <CartesianGrid stroke={CHROME.grid} horizontal={false} />
          <XAxis type="number" tickFormatter={(v: number) => axisFormat(v)} tick={axisTick} stroke={CHROME.axis} tickLine={false} />
          <YAxis type="category" dataKey="label" width={128} tick={{ ...axisTick, fill: CHROME.ink }} axisLine={false} tickLine={false} interval={0} />
          <ReferenceLine x={0} stroke={CHROME.axis} />
          <Tooltip
            cursor={{ fill: "rgba(255,255,255,0.04)" }}
            isAnimationActive={false}
            content={(p) => {
              if (!p.active || !p.payload?.length) return null;
              const row = p.payload[0]?.payload as Row | undefined;
              if (!row) return null;
              return (
                <TooltipBox
                  title={row.label}
                  rows={
                    row.kind === "total"
                      ? [{ label: "Total", value: format(row.running), color: FILL.total }]
                      : [
                          { label: "Contribution", value: format(row.delta), color: FILL[row.kind] },
                          { label: "Running total", value: format(row.running) },
                        ]
                  }
                />
              );
            }}
          />
          <Bar dataKey="range" isAnimationActive={false} radius={2} maxBarSize={20}>
            {rows.map((r) => (
              <Cell key={r.label} fill={FILL[r.kind]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
