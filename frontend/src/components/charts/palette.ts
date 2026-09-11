/**
 * Chart colours (SVG attributes need literal values, not CSS variables).
 * Categorical slots are assigned in fixed order and validated for the dark panel surface
 * (#13161b): lightness band, chroma floor, adjacent CVD separation >= 8.4, contrast >= 3:1.
 */
export const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;

export const S1 = SERIES[0];
export const S2 = SERIES[1];
export const S3 = SERIES[2];
export const S4 = SERIES[3];

/** Sequential single-hue (blue) ramp, dark -> light; for ordered magnitudes (e.g. reserve %). */
export const BLUE_RAMP = ["#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb"] as const;

export const CHROME = {
  surface: "#13161b",
  grid: "#222730",
  axis: "#353c47",
  tick: "#8a929e",
  ink: "#e6e8eb",
  muted: "#6b7380",
};

/** PnL sign colours (only used where the colour means gain / loss). */
export const PNL = { pos: "#3fb96b", neg: "#ef5b5b", total: "#3987e5" };

/** Reserved status palette (risk thresholds). */
export const STATUS = { good: "#2fb45a", warn: "#fab219", serious: "#ec835a", crit: "#e04848" };

export const axisTick = { fill: CHROME.tick, fontSize: 11 };
