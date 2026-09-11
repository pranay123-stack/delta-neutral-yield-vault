import { BASE_MARKET, DAY, DEFAULT_VENUES, HOUR, SECONDS_PER_YEAR, type VenueParams } from "./config";
import type { MarketState } from "./model";
import { Rng } from "./rng";

/**
 * Synthetic market generator. Stylised facts it reproduces:
 *   - ETH price: GBM with a 3-state volatility regime (calm / normal / stressed) that clusters
 *   - funding: mean-reverting (OU) around a level that rises with trailing momentum - perp longs
 *     pay more in uptrends and funding turns negative in sharp sell-offs
 *   - lending utilisation: OU around its long-run mean, mapped to APR through the same kinked
 *     rate curve as the on-chain mock
 * It is a demo generator, not a calibrated model - see docs/simulation.md for its limitations.
 */

export interface RegimeSpec {
  vol: number; // annualised
  stayProbPerDay: number;
}

export interface PathOptions {
  seed: number;
  days: number;
  stepSec: number;
  startTime?: number;
  startPrice?: number;
  driftAnnual?: number;
  regimes?: RegimeSpec[];
  funding?: { mean8h: number; kappaPerDay: number; sigma8hPerSqrtDay: number; momentumBeta: number; clip8h: number };
  utilization?: { usdcMean: number; wethMean: number; kappaPerDay: number; sigmaPerSqrtDay: number };
  venues?: VenueParams;
}

export const DEFAULT_REGIMES: RegimeSpec[] = [
  { vol: 0.45, stayProbPerDay: 0.93 },
  { vol: 0.65, stayProbPerDay: 0.9 },
  { vol: 1.1, stayProbPerDay: 0.8 },
];

export function baseMarket(time = 0, venues: VenueParams = DEFAULT_VENUES): MarketState {
  return {
    time,
    price: BASE_MARKET.price,
    fundingRatePer8h: BASE_MARKET.fundingRatePer8h,
    usdcUtilization: BASE_MARKET.usdcUtilization,
    wethUtilization: BASE_MARKET.wethUtilization,
    oracleHealthy: true,
    venues,
  };
}

export function generateMarketPath(o: PathOptions): MarketState[] {
  const rng = new Rng(o.seed);
  const venues = o.venues ?? DEFAULT_VENUES;
  const regimes = o.regimes ?? DEFAULT_REGIMES;
  const f = o.funding ?? { mean8h: 0.0001, kappaPerDay: 0.35, sigma8hPerSqrtDay: 0.00006, momentumBeta: 0.0012, clip8h: 0.003 };
  const u = o.utilization ?? { usdcMean: 0.8, wethMean: 0.6, kappaPerDay: 0.2, sigmaPerSqrtDay: 0.03 };
  const steps = Math.round((o.days * DAY) / o.stepSec);
  const dtYears = o.stepSec / SECONDS_PER_YEAR;
  const dtDays = o.stepSec / DAY;
  const mu = o.driftAnnual ?? 0;

  let regime = Math.min(1, regimes.length - 1); // start in the "normal" regime when there is one
  let price = o.startPrice ?? BASE_MARKET.price;
  let funding = f.mean8h;
  let uUsdc = u.usdcMean;
  let uWeth = u.wethMean;
  const t0 = o.startTime ?? 0;
  const history: number[] = [price];
  const lookback = Math.max(1, Math.round((3 * DAY) / o.stepSec));

  const path: MarketState[] = [
    { time: t0, price, fundingRatePer8h: funding, usdcUtilization: uUsdc, wethUtilization: uWeth, oracleHealthy: true, venues },
  ];
  for (let i = 1; i <= steps; i++) {
    // regime switch (per-day probabilities scaled to the step)
    const spec = regimes[regime]!;
    if (rng.next() > Math.pow(spec.stayProbPerDay, dtDays)) {
      const others = regimes.map((_, k) => k).filter((k) => k !== regime);
      regime = others[Math.floor(rng.next() * others.length)]!;
    }
    const vol = regimes[regime]!.vol;
    price *= Math.exp((mu - 0.5 * vol * vol) * dtYears + vol * Math.sqrt(dtYears) * rng.normal());
    history.push(price);

    const past = history[Math.max(0, history.length - 1 - lookback)]!;
    const momentum = price / past - 1;
    const target = f.mean8h + f.momentumBeta * momentum;
    funding += f.kappaPerDay * (target - funding) * dtDays + f.sigma8hPerSqrtDay * Math.sqrt(dtDays) * rng.normal();
    funding = Math.max(-f.clip8h, Math.min(f.clip8h, funding));

    uUsdc = clamp01(uUsdc + u.kappaPerDay * (u.usdcMean - uUsdc) * dtDays + u.sigmaPerSqrtDay * Math.sqrt(dtDays) * rng.normal(), 0.98);
    uWeth = clamp01(uWeth + u.kappaPerDay * (u.wethMean - uWeth) * dtDays + u.sigmaPerSqrtDay * Math.sqrt(dtDays) * rng.normal(), 0.98);

    path.push({
      time: t0 + i * o.stepSec,
      price,
      fundingRatePer8h: funding,
      usdcUtilization: uUsdc,
      wethUtilization: uWeth,
      oracleHealthy: true,
      venues,
    });
  }
  return path;
}

/** Deterministic path: interpolate price geometrically between knots, everything else constant. */
export function shockPath(opts: {
  days: number;
  stepSec?: number;
  knots: { day: number; price: number }[];
  base?: MarketState;
  mutate?: (m: MarketState, day: number) => MarketState;
}): MarketState[] {
  const stepSec = opts.stepSec ?? HOUR;
  const base = opts.base ?? baseMarket();
  const knots = [...opts.knots].sort((a, b) => a.day - b.day);
  const steps = Math.round((opts.days * DAY) / stepSec);
  const out: MarketState[] = [];
  for (let i = 0; i <= steps; i++) {
    const day = (i * stepSec) / DAY;
    let price = base.price;
    if (knots.length) {
      if (day <= knots[0]!.day) price = knots[0]!.price;
      else if (day >= knots[knots.length - 1]!.day) price = knots[knots.length - 1]!.price;
      else {
        for (let k = 1; k < knots.length; k++) {
          const a = knots[k - 1]!;
          const b = knots[k]!;
          if (day <= b.day) {
            const w = (day - a.day) / (b.day - a.day);
            price = a.price * Math.pow(b.price / a.price, w);
            break;
          }
        }
      }
    }
    let m: MarketState = { ...base, time: base.time + i * stepSec, price };
    if (opts.mutate) m = opts.mutate(m, day);
    out.push(m);
  }
  return out;
}

function clamp01(x: number, max = 1): number {
  return Math.max(0, Math.min(max, x));
}
