/**
 * On-chain unit conventions (mirrors contracts/libraries/Types.sol):
 *   USDC / USD values  -> 6 decimals ("usd6")
 *   ETH quantities     -> 18 decimals ("qty18")
 *   prices             -> 18 decimals ("price18"), USD per ETH
 *   vault shares       -> 12 decimals (6 asset + 6 virtual offset)
 *   ratios             -> basis points; rates -> WAD (1e18 = 100%)
 * The API converts everything to plain JS numbers in human units at the boundary.
 */
export const USD_DECIMALS = 6;
export const QTY_DECIMALS = 18;
export const PRICE_DECIMALS = 18;
export const SHARE_DECIMALS = 12;
export const WAD = 10n ** 18n;
export const SECONDS_PER_YEAR = 365 * 24 * 3600;
export const FUNDING_PERIODS_PER_YEAR = 3 * 365;

const pow10 = (d: number) => 10n ** BigInt(d);

/** bigint fixed-point -> JS number. Exact for display ranges (< 2^53 in the integer part). */
export function fromFixed(value: bigint, decimals: number): number {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = pow10(decimals);
  const n = Number(abs / base) + Number(abs % base) / Number(base);
  return neg ? -n : n;
}

export function toFixed(value: number, decimals: number): bigint {
  const [intPart, frac = ""] = Math.abs(value).toFixed(decimals).split(".");
  const raw = BigInt(intPart ?? "0") * pow10(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return value < 0 ? -raw : raw;
}

export const usd = (v: bigint) => fromFixed(v, USD_DECIMALS);
export const qty = (v: bigint) => fromFixed(v, QTY_DECIMALS);
export const price = (v: bigint) => fromFixed(v, PRICE_DECIMALS);
export const wadToFraction = (v: bigint) => fromFixed(v, 18);
export const bps = (v: bigint | number) => Number(v);

/** type(uint256).max sentinels (e.g. "no liquidation price") -> null for JSON. */
export const MAX_UINT256 = (1n << 256n) - 1n;
export function finiteOrNull(v: bigint, decimals = 0): number | null {
  return v === MAX_UINT256 ? null : fromFixed(v, decimals);
}
