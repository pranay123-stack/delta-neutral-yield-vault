import type { ReactNode } from "react";

export interface TooltipRow {
  label: ReactNode;
  value: ReactNode;
  color?: string;
}

/** Shared tooltip body for every chart. */
export function TooltipBox({ title, rows }: { title?: ReactNode; rows: TooltipRow[] }) {
  return (
    <div className="min-w-[180px] rounded-md border border-line-strong bg-panel-2/95 px-3 py-2 text-xs shadow-xl backdrop-blur">
      {title !== undefined && <div className="mb-1.5 font-medium text-ink-2">{title}</div>}
      <div className="space-y-1">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-ink-2">
              {r.color && <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: r.color }} aria-hidden />}
              {r.label}
            </span>
            <span className="font-medium tabular-nums text-ink">{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Loose shape of what recharts hands a custom tooltip. */
export interface RechartsTooltipProps {
  active?: boolean;
  label?: unknown;
  payload?: ReadonlyArray<{ dataKey?: unknown; value?: unknown; color?: string; name?: unknown; payload?: unknown }>;
}

export function Legend({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-3.5 rounded"
            style={it.dashed ? { backgroundImage: `linear-gradient(90deg, ${it.color} 60%, transparent 60%)`, backgroundSize: "5px 2px" } : { background: it.color }}
            aria-hidden
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}
