import type { RateModel } from "./config";

/** Kinked utilisation curve - identical to MockLendingProtocol._borrowRate. */
export function borrowRate(m: RateModel, u: number): number {
  if (u <= m.optimalUtilization) return m.baseRate + (m.slope1 * u) / m.optimalUtilization;
  const excess = (u - m.optimalUtilization) / (1 - m.optimalUtilization);
  return m.baseRate + m.slope1 + m.slope2 * excess;
}

/** supply = borrow * U * (1 - reserveFactor) - identical to MockLendingProtocol._supplyRate. */
export function supplyRate(m: RateModel, u: number): number {
  return borrowRate(m, u) * u * (1 - m.reserveFactor);
}

/** 8h funding rate -> simple APR (3 periods/day). */
export function fundingApr(ratePer8h: number): number {
  return ratePer8h * 3 * 365;
}
