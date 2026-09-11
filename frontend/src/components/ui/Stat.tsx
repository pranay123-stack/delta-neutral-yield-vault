import type { ReactNode } from "react";

import { type Tone, toneClass } from "@/lib/format";

import { cx } from "./Card";

interface StatProps {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  hint?: string;
  className?: string;
}

/** A labelled KPI tile. */
export function Stat({ label, value, sub, tone = "neutral", hint, className }: StatProps) {
  return (
    <div className={cx("min-w-0 rounded-lg border border-line bg-panel px-4 py-3", className)} title={hint}>
      <div className="truncate text-[0.7rem] font-medium uppercase tracking-[0.06em] text-muted">{label}</div>
      <div className={cx("mt-1 truncate text-xl font-semibold tabular-nums", toneClass[tone])}>{value}</div>
      {sub !== undefined && <div className="mt-0.5 truncate text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

/** Label / value rows for dense detail panels. */
export function KV({ rows, className }: { rows: { label: ReactNode; value: ReactNode; tone?: Tone; hint?: string }[]; className?: string }) {
  return (
    <dl className={cx("divide-y divide-line", className)}>
      {rows.map((r, i) => (
        <div key={i} className="flex items-baseline justify-between gap-4 py-1.5 text-[0.8125rem]" title={r.hint}>
          <dt className="min-w-0 text-ink-2">{r.label}</dt>
          <dd className={cx("shrink-0 text-right font-medium tabular-nums", toneClass[r.tone ?? "neutral"])}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}
