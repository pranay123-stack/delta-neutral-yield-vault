/**
 * Display formatting. Every number on screen goes through here so units stay consistent:
 * USD with thousands separators, fractions and bps rendered as %, leverage as "x", chain time in UTC.
 */

export const DASH = "—";

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", options);
    numberFormats.set(key, f);
  }
  return f;
}

type Num = number | null | undefined;
const missing = (v: Num): v is null | undefined => v === null || v === undefined || !Number.isFinite(v);
const signDisplay = (sign: boolean): Intl.NumberFormatOptions["signDisplay"] => (sign ? "exceptZero" : "auto");

export interface UsdOptions {
  digits?: number;
  compact?: boolean;
  sign?: boolean;
}

export function fmtUsd(v: Num, { digits = 2, compact = false, sign = false }: UsdOptions = {}): string {
  if (missing(v)) return DASH;
  if (compact && Math.abs(v) >= 10_000) {
    return nf({ style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2, signDisplay: signDisplay(sign) }).format(v);
  }
  return nf({
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: signDisplay(sign),
  }).format(v);
}

export function fmtNum(v: Num, digits = 2, sign = false): string {
  if (missing(v)) return DASH;
  return nf({ minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: signDisplay(sign) }).format(v);
}

export function fmtInt(v: Num): string {
  return fmtNum(v, 0);
}

/** Fraction -> percent (0.0787 -> "7.87%"). */
export function fmtPct(fraction: Num, digits = 2, sign = false): string {
  if (missing(fraction)) return DASH;
  return nf({ style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: signDisplay(sign) }).format(fraction);
}

/** Basis points -> percent (6659 -> "66.59%"). */
export function fmtBps(bps: Num, digits = 2, sign = false): string {
  if (missing(bps)) return DASH;
  return fmtPct(bps / 10_000, digits, sign);
}

export function fmtBpsRaw(bps: Num): string {
  if (missing(bps)) return DASH;
  return `${fmtNum(bps, 0)} bps`;
}

export function fmtX(v: Num, digits = 2): string {
  if (missing(v)) return DASH;
  return `${fmtNum(v, digits)}x`;
}

export function fmtEth(v: Num, digits = 4, sign = false): string {
  if (missing(v)) return DASH;
  return `${fmtNum(v, digits, sign)} ETH`;
}

/** Funding is quoted per 8h; show enough precision for tiny rates. */
export function fmtFunding8h(rate: Num): string {
  if (missing(rate)) return DASH;
  return `${fmtPct(rate, 4, true)} / 8h`;
}

// ---- chain time --------------------------------------------------------------------------------
// The demo warps chain time, so every date on screen is a chain timestamp rendered in UTC.

const dtFull = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const dtDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "2-digit" });
const dtShort = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

export function fmtDateTime(ts: Num): string {
  if (missing(ts) || ts <= 0) return DASH;
  return `${dtFull.format(new Date(ts * 1000))} UTC`;
}

export function fmtDate(ts: Num): string {
  if (missing(ts) || ts <= 0) return DASH;
  return dtDay.format(new Date(ts * 1000));
}

export function fmtDateShort(ts: Num): string {
  if (missing(ts) || ts <= 0) return DASH;
  return dtShort.format(new Date(ts * 1000));
}

export function fmtDuration(seconds: Num): string {
  if (missing(seconds)) return DASH;
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  const d = s / 86_400;
  return `${d >= 10 ? d.toFixed(0) : d.toFixed(1)}d`;
}

/** "3.2d ago" relative to chain time (never wall clock). */
export function fmtAgo(ts: Num, chainNow: Num): string {
  if (missing(ts) || missing(chainNow) || ts <= 0) return DASH;
  return `${fmtDuration(chainNow - ts)} ago`;
}

// ---- misc --------------------------------------------------------------------------------------

export function shortHex(hex: string | null | undefined, lead = 6, tail = 4): string {
  if (!hex) return DASH;
  if (hex.length <= lead + tail + 1) return hex;
  return `${hex.slice(0, lead)}…${hex.slice(-tail)}`;
}

export type Tone = "pos" | "neg" | "neutral";

/** Tone for PnL-like values (green/red are reserved for PnL signs). */
export function pnlTone(v: Num, epsilon = 1e-9): Tone {
  if (missing(v) || Math.abs(v) <= epsilon) return "neutral";
  return v > 0 ? "pos" : "neg";
}

export const toneClass: Record<Tone, string> = {
  pos: "text-pos",
  neg: "text-neg",
  neutral: "text-ink",
};
