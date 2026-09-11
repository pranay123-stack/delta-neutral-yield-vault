"use client";

import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { fmtDateShort, fmtDateTime } from "@/lib/format";

import { TooltipBox } from "./ChartTooltip";
import { CHROME, axisTick } from "./palette";

export interface SeriesDef<T> {
  key: keyof T & string;
  label: string;
  color: string;
  /** Tooltip value formatter (defaults to the axis formatter). */
  format?: (v: number) => string;
}

export interface RefLine {
  y: number;
  label?: string;
  color?: string;
}

interface TimeSeriesChartProps<T extends { ts: number }> {
  data: T[];
  series: SeriesDef<T>[];
  yFormat: (v: number) => string;
  height?: number;
  /** Fill under a single series. */
  area?: boolean;
  refLines?: RefLine[];
  yDomain?: [number | "auto" | "dataMin" | "dataMax", number | "auto" | "dataMin" | "dataMax"];
  step?: boolean;
}

/**
 * Line / area chart over chain time (x = `ts`, unix seconds). One y-axis only: charts never mix
 * scales - different measures get their own chart.
 */
export function TimeSeriesChart<T extends { ts: number }>({
  data,
  series,
  yFormat,
  height = 200,
  area = false,
  refLines,
  yDomain,
  step = false,
}: TimeSeriesChartProps<T>) {
  const curve = step ? "stepAfter" : "linear";
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={CHROME.grid} vertical={false} />
          <XAxis
            dataKey="ts"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => fmtDateShort(v)}
            tick={axisTick}
            stroke={CHROME.axis}
            tickLine={false}
            minTickGap={36}
          />
          <YAxis
            tickFormatter={(v: number) => yFormat(v)}
            tick={axisTick}
            axisLine={false}
            tickLine={false}
            width={62}
            domain={yDomain ?? ["auto", "auto"]}
          />
          <Tooltip
            cursor={{ stroke: CHROME.axis, strokeWidth: 1 }}
            isAnimationActive={false}
            content={(p) => {
              if (!p.active || !p.payload?.length) return null;
              const row = p.payload[0]?.payload as T | undefined;
              if (!row) return null;
              return (
                <TooltipBox
                  title={fmtDateTime(row.ts)}
                  rows={series.map((s) => {
                    const v = row[s.key] as unknown;
                    return {
                      label: s.label,
                      color: s.color,
                      value: typeof v === "number" ? (s.format ?? yFormat)(v) : "—",
                    };
                  })}
                />
              );
            }}
          />
          {refLines?.map((r) => (
            <ReferenceLine
              key={`${r.y}-${r.label}`}
              y={r.y}
              stroke={r.color ?? CHROME.muted}
              strokeDasharray="4 3"
              ifOverflow="extendDomain"
              label={r.label ? { value: r.label, position: "insideTopRight", fill: CHROME.tick, fontSize: 10 } : undefined}
            />
          ))}
          {series.map((s) =>
            area ? (
              <Area
                key={s.key}
                type={curve}
                dataKey={s.key as string}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                fill={s.color}
                fillOpacity={0.12}
                dot={false}
                activeDot={{ r: 4, stroke: CHROME.surface, strokeWidth: 2 }}
                isAnimationActive={false}
                connectNulls
              />
            ) : (
              <Line
                key={s.key}
                type={curve}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: CHROME.surface, strokeWidth: 2 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            ),
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
