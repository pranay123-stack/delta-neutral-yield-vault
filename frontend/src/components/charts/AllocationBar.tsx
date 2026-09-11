import { fmtPct, fmtUsd } from "@/lib/format";

export interface AllocationSlice {
  label: string;
  value: number;
  pct: number;
  color: string;
  hint?: string;
}

/** Part-to-whole as one stacked bar (2px gaps between segments) plus a labelled legend table. */
export function AllocationBar({ slices, compact }: { slices: AllocationSlice[]; compact?: boolean }) {
  const visible = slices.filter((s) => s.pct > 0.0005);
  return (
    <div>
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-sm bg-panel-3" role="img" aria-label="Allocation breakdown">
        {visible.map((s) => (
          <div key={s.label} className="h-full first:rounded-l-sm last:rounded-r-sm" style={{ width: `${s.pct * 100}%`, background: s.color }} title={`${s.label}: ${fmtPct(s.pct, 1)}`} />
        ))}
      </div>
      <div className={compact ? "mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs" : "mt-3 space-y-1.5 text-[0.8125rem]"}>
        {slices.map((s) => (
          <div key={s.label} className="flex items-center justify-between gap-3" title={s.hint}>
            <span className="flex min-w-0 items-center gap-2 text-ink-2">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
              <span className="truncate">{s.label}</span>
            </span>
            <span className="shrink-0 tabular-nums">
              {!compact && <span className="mr-3 text-ink-2">{fmtUsd(s.value, { digits: 0 })}</span>}
              <span className="font-medium text-ink">{fmtPct(s.pct, 1)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
