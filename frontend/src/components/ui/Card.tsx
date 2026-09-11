import type { ReactNode } from "react";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

interface CardProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Remove body padding (tables that run edge to edge). */
  flush?: boolean;
}

export function Card({ title, subtitle, action, children, className, bodyClassName, flush }: CardProps) {
  return (
    <section className={cx("min-w-0 rounded-lg border border-line bg-panel", className)}>
      {(title || action) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="text-[0.8125rem] font-semibold tracking-wide text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cx(flush ? "" : "p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export function SectionTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-2 mt-1 flex items-baseline justify-between gap-2">
      <h3 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">{children}</h3>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warn" }) {
  return (
    <div
      className={cx(
        "rounded-md border px-3 py-2.5 text-xs leading-relaxed",
        tone === "warn" ? "border-warn/30 bg-warn/5 text-ink-2" : "border-accent/25 bg-accent-soft text-ink-2",
      )}
    >
      {children}
    </div>
  );
}
