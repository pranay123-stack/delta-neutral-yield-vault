import type { AlertSeverity, RiskStateName } from "@dnv/shared";
import type { ReactNode } from "react";

import { cx } from "./Card";

type Level = "normal" | "warn" | "serious" | "crit" | "info" | "neutral";

const LEVEL_CLASS: Record<Level, string> = {
  normal: "border-good/35 bg-good/10 text-good",
  warn: "border-warn/40 bg-warn/10 text-warn",
  serious: "border-serious/40 bg-serious/10 text-serious",
  crit: "border-crit/45 bg-crit/12 text-crit",
  info: "border-accent/40 bg-accent-soft text-accent-strong",
  neutral: "border-line-strong bg-panel-2 text-ink-2",
};

const DOT_CLASS: Record<Level, string> = {
  normal: "bg-good",
  warn: "bg-warn",
  serious: "bg-serious",
  crit: "bg-crit",
  info: "bg-accent",
  neutral: "bg-muted",
};

export function Badge({ level = "neutral", children, dot = true, className }: { level?: Level; children: ReactNode; dot?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-[0.7rem] font-semibold uppercase tracking-wide",
        LEVEL_CLASS[level],
        className,
      )}
    >
      {dot && <span className={cx("h-1.5 w-1.5 rounded-full", DOT_CLASS[level])} aria-hidden />}
      {children}
    </span>
  );
}

export const RISK_LEVEL: Record<RiskStateName, Level> = {
  NORMAL: "normal",
  WARNING: "warn",
  HIGH_RISK: "serious",
  EMERGENCY: "crit",
};

export function RiskBadge({ state, className }: { state: RiskStateName | null | undefined; className?: string }) {
  if (!state) return <Badge className={className}>unknown</Badge>;
  return (
    <Badge level={RISK_LEVEL[state]} className={className}>
      {state.replace("_", " ")}
    </Badge>
  );
}

const SEVERITY_LEVEL: Record<AlertSeverity, Level> = { INFO: "info", WARNING: "warn", CRITICAL: "crit" };

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return <Badge level={SEVERITY_LEVEL[severity]}>{severity}</Badge>;
}

/** Small rectangular tag (rebalance triggers, risk flags). */
export function Chip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" | "crit" }) {
  return (
    <span
      className={cx(
        "inline-flex items-center whitespace-nowrap rounded border px-1.5 py-px font-mono text-[0.68rem] font-medium",
        tone === "accent" && "border-accent/40 bg-accent-soft text-accent-strong",
        tone === "warn" && "border-warn/40 bg-warn/10 text-warn",
        tone === "crit" && "border-crit/45 bg-crit/10 text-crit",
        tone === "neutral" && "border-line-strong bg-panel-2 text-ink-2",
      )}
    >
      {children}
    </span>
  );
}

/** On/off indicator with a text label (never colour alone). */
export function Flag({ on, onLabel = "ON", offLabel = "OFF", danger = true }: { on: boolean; onLabel?: string; offLabel?: string; danger?: boolean }) {
  return (
    <Badge level={on ? (danger ? "crit" : "info") : "neutral"} className="normal-case">
      {on ? onLabel : offLabel}
    </Badge>
  );
}
