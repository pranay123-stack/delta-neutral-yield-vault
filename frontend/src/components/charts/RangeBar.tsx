interface RangeBarProps {
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  domain: [number, number];
  format: (v: number) => string;
  color?: string;
}

/** Percentile strip: thin p5-p95 whisker, thick p25-p75 box, tick at the median, zero line if in range. */
export function RangeBar({ p5, p25, p50, p75, p95, domain: [lo, hi], format, color = "#3987e5" }: RangeBarProps) {
  const pos = (v: number) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo || 1)) * 100));
  return (
    <div className="w-full" title={`p5 ${format(p5)} · p25 ${format(p25)} · p50 ${format(p50)} · p75 ${format(p75)} · p95 ${format(p95)}`}>
      <div className="relative h-5">
        {lo < 0 && hi > 0 && <div className="absolute inset-y-0 w-px bg-line-strong" style={{ left: `${pos(0)}%` }} aria-hidden />}
        <div className="absolute top-1/2 h-[2px] -translate-y-1/2 rounded" style={{ left: `${pos(p5)}%`, width: `${pos(p95) - pos(p5)}%`, background: color, opacity: 0.55 }} />
        <div className="absolute top-1/2 h-3 -translate-y-1/2 rounded-sm" style={{ left: `${pos(p25)}%`, width: `${Math.max(0.6, pos(p75) - pos(p25))}%`, background: color, opacity: 0.85 }} />
        <div className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-ink shadow-[0_0_0_2px_var(--color-panel)]" style={{ left: `${pos(p50)}%` }} />
      </div>
      <div className="flex justify-between text-[0.65rem] text-muted">
        <span>{format(lo)}</span>
        <span>{format(hi)}</span>
      </div>
    </div>
  );
}
