import { cx } from "./Card";

export interface Thresholds {
  warn: number;
  high: number;
  critical: number | null;
}

interface ThresholdBarProps {
  value: number | null;
  thresholds: Thresholds;
  higherIsWorse: boolean;
  format: (v: number) => string;
  /** Optional fixed scale; otherwise derived from thresholds and value. */
  domain?: [number, number];
  showTicks?: boolean;
  className?: string;
}

const ZONE = {
  normal: "bg-good/30",
  warn: "bg-warn/40",
  serious: "bg-serious/45",
  crit: "bg-crit/50",
} as const;

type Zone = { from: number; to: number; level: keyof typeof ZONE };

export function thresholdDomain(value: number | null, t: Thresholds, higherIsWorse: boolean): [number, number] {
  const fallbackCrit = higherIsWorse ? t.high + Math.abs(t.high - t.warn) : t.high - Math.abs(t.warn - t.high);
  const crit = t.critical ?? fallbackCrit;
  const pts = [t.warn, t.high, crit, ...(value === null ? [] : [value])];
  let lo = Math.min(0, ...pts);
  let hi = Math.max(...pts);
  const span = hi - lo || 1;
  if (higherIsWorse) hi += span * 0.12;
  else {
    hi += span * 0.12;
    if (lo < 0) lo -= span * 0.05;
  }
  return [lo, hi];
}

function zones(t: Thresholds, higherIsWorse: boolean, [lo, hi]: [number, number]): Zone[] {
  if (higherIsWorse) {
    const z: Zone[] = [
      { from: lo, to: t.warn, level: "normal" },
      { from: t.warn, to: t.high, level: "warn" },
    ];
    if (t.critical === null) z.push({ from: t.high, to: hi, level: "serious" });
    else z.push({ from: t.high, to: t.critical, level: "serious" }, { from: t.critical, to: hi, level: "crit" });
    return z;
  }
  const z: Zone[] = [];
  if (t.critical === null) z.push({ from: lo, to: t.high, level: "serious" });
  else z.push({ from: lo, to: t.critical, level: "crit" }, { from: t.critical, to: t.high, level: "serious" });
  z.push({ from: t.high, to: t.warn, level: "warn" }, { from: t.warn, to: hi, level: "normal" });
  return z;
}

/**
 * A metric against its warn / high / critical thresholds: coloured zones on a linear scale with a
 * marker at the current value. Zone colours are the reserved status palette.
 */
export function ThresholdBar({ value, thresholds, higherIsWorse, format, domain, showTicks = true, className }: ThresholdBarProps) {
  const [lo, hi] = domain ?? thresholdDomain(value, thresholds, higherIsWorse);
  const frac = (v: number) => Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  const pos = (v: number) => `${frac(v)}%`;
  // drop a label that would collide with the previous one (e.g. 95% / 100% on a 0-110% scale)
  const ticks: { v: number; label: string }[] = [];
  for (const t of [
    { v: thresholds.warn, label: "warn" },
    { v: thresholds.high, label: "high" },
    ...(thresholds.critical === null ? [] : [{ v: thresholds.critical, label: "crit" }]),
  ]) {
    if (ticks.every((s) => Math.abs(frac(s.v) - frac(t.v)) >= 9)) ticks.push(t);
  }
  return (
    <div className={cx("w-full", className)}>
      <div className="relative h-2.5 w-full overflow-hidden rounded-sm bg-panel-3">
        {zones(thresholds, higherIsWorse, [lo, hi]).map((z, i) => {
          const a = Math.max(lo, Math.min(z.from, z.to));
          const b = Math.min(hi, Math.max(z.from, z.to));
          if (b <= a) return null;
          return <div key={i} className={cx("absolute inset-y-0", ZONE[z.level])} style={{ left: pos(a), width: `calc(${pos(b)} - ${pos(a)})` }} />;
        })}
      </div>
      <div className="relative h-0">
        {value !== null && (
          <div className="absolute -top-[14px] h-[18px] w-[3px] -translate-x-1/2 rounded-sm bg-ink shadow-[0_0_0_2px_var(--color-panel)]" style={{ left: pos(value) }} aria-hidden />
        )}
      </div>
      {showTicks && (
        <div className="relative mt-1 h-4 text-[0.65rem] text-muted">
          {ticks.map((t) => (
            <span key={t.label} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: pos(t.v) }}>
              {format(t.v)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
