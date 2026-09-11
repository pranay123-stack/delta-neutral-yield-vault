import type { PerformancePoint, PerformanceView } from "@dnv/shared";

const YEAR = 365 * 24 * 3600;
const DAY = 24 * 3600;

/** Annualised compound return between two share prices over `seconds`. */
export function annualize(p0: number, p1: number, seconds: number): number | null {
  if (p0 <= 0 || seconds < DAY) return null; // < 1 day of history is noise, not an APY
  return Math.pow(p1 / p0, YEAR / seconds) - 1;
}

/** Share price at or before `ts` from an ascending series. */
function priceAt<T extends { ts: number; sharePrice: number }>(points: T[], ts: number): T | null {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0 || points[0]!.ts > ts) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]!.ts <= ts) lo = mid;
    else hi = mid - 1;
  }
  return points[lo]!;
}

/** Attach trailing 7d / 30d APY to each point (chain-time windows). */
export function withTrailingApy(points: Omit<PerformancePoint, "apy7d" | "apy30d">[]): PerformancePoint[] {
  return points.map((p) => {
    const w7 = priceAt(points, p.ts - 7 * DAY);
    const w30 = priceAt(points, p.ts - 30 * DAY);
    return {
      ...p,
      apy7d: w7 ? annualize(w7.sharePrice, p.sharePrice, p.ts - w7.ts) : null,
      apy30d: w30 ? annualize(w30.sharePrice, p.sharePrice, p.ts - w30.ts) : null,
    };
  });
}

/** Summary statistics over a series: return, max drawdown, vol and Sharpe of daily share-price returns. */
export function summarize(points: PerformancePoint[], rebalances: number): PerformanceView["summary"] {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) {
    return { fromTs: 0, toTs: 0, sharePriceStart: 1, sharePriceEnd: 1, periodReturn: 0, annualizedReturn: null, maxDrawdownBps: 0, volatilityAnnual: null, sharpe: null, rebalances };
  }
  let peak = first.sharePrice;
  let maxDd = 0;
  for (const p of points) {
    peak = Math.max(peak, p.sharePrice);
    maxDd = Math.max(maxDd, peak > 0 ? ((peak - p.sharePrice) / peak) * 10_000 : 0);
  }
  // daily returns sampled on the chain-time grid
  const daily: number[] = [];
  let prev = first;
  for (let t = first.ts + DAY; t <= last.ts; t += DAY) {
    const cur = priceAt(points, t);
    if (cur && prev.sharePrice > 0) daily.push(cur.sharePrice / prev.sharePrice - 1);
    if (cur) prev = cur;
  }
  let vol: number | null = null;
  let sharpe: number | null = null;
  const ann = annualize(first.sharePrice, last.sharePrice, last.ts - first.ts);
  if (daily.length >= 5) {
    const mean = daily.reduce((a, b) => a + b, 0) / daily.length;
    const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (daily.length - 1));
    vol = sd * Math.sqrt(365);
    // excess over a 0% benchmark; a delta-neutral vault's vol is tiny, so this Sharpe is large by nature
    sharpe = vol > 0 && ann !== null ? ann / vol : null;
  }
  return {
    fromTs: first.ts,
    toTs: last.ts,
    sharePriceStart: first.sharePrice,
    sharePriceEnd: last.sharePrice,
    periodReturn: last.sharePrice / first.sharePrice - 1,
    annualizedReturn: ann,
    maxDrawdownBps: maxDd,
    volatilityAnnual: vol,
    sharpe,
    rebalances,
  };
}
