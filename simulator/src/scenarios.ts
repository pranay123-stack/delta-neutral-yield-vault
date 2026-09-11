import { DEFAULT_STRATEGY, DEFAULT_VENUES, type StrategyConfig } from "./config";
import { type SimSummary, simulate } from "./engine";
import { baseMarket, generateMarketPath, shockPath } from "./market";
import type { MarketState } from "./model";

/**
 * Scenario catalogue A-H from the spec plus two tail events. Each scenario is a deterministic market
 * path; every one is run twice - keeper online (the protocol as designed) and keeper offline (what
 * the hedge alone does) - so the value of active delta/leverage management is visible.
 */

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  days: number;
  build: (t0: number) => MarketState[];
}

export interface ScenarioMetrics {
  vaultValue: number;
  userShareValue: number; // value of a $1 share at start
  hedgePnl: number;
  lendingIncome: number;
  fundingPnl: number;
  spotPnl: number;
  tradingCosts: number;
  netPnl: number; // strategy PnL before vault fees
  netReturnPct: number;
  endDeltaBps: number;
  maxAbsDeltaBps: number;
  endLiquidationDistanceBps: number | null;
  minLiquidationDistanceBps: number | null;
  maxDrawdownBps: number;
  maxLeverage: number;
  rebalances: number;
  liquidations: number;
  badDebtAbsorbed: number;
}

export interface ScenarioResult {
  id: string;
  name: string;
  description: string;
  days: number;
  ethPriceStart: number;
  ethPriceEnd: number;
  ethMovePct: number;
  withKeeper: ScenarioMetrics;
  withoutKeeper: ScenarioMetrics;
}

const DAYS = 30;

export const SCENARIOS: ScenarioDef[] = [
  {
    id: "A",
    name: "ETH +20%",
    description: "ETH rallies 20% over five days, then holds. The short hedge loses, the long gains; margin must be topped up.",
    days: DAYS,
    build: (t0) => shockPath({ days: DAYS, base: baseMarket(t0), knots: [{ day: 0, price: 3000 }, { day: 5, price: 3600 }] }),
  },
  {
    id: "B",
    name: "ETH -20%",
    description: "ETH falls 20% over five days. The hedge gains, margin piles up, leverage falls and the book re-levers.",
    days: DAYS,
    build: (t0) => shockPath({ days: DAYS, base: baseMarket(t0), knots: [{ day: 0, price: 3000 }, { day: 5, price: 2400 }] }),
  },
  {
    id: "C",
    name: "ETH -40%",
    description: "A 40% crash over ten days. Funding drifts negative during the sell-off, then recovers.",
    days: DAYS,
    build: (t0) =>
      shockPath({
        days: DAYS,
        base: baseMarket(t0),
        knots: [{ day: 0, price: 3000 }, { day: 10, price: 1800 }],
        // the book is opened in normal carry; funding only turns negative once the crash is under way
        mutate: (m, day) => ({ ...m, fundingRatePer8h: day >= 2 && day < 12 ? -0.00005 : day >= 12 ? 0.00008 : m.fundingRatePer8h }),
      }),
  },
  {
    id: "D",
    name: "Funding turns negative",
    description: "Funding flips to -0.03%/8h (~ -33% APR) for the month: the short pays. The vault goes defensive.",
    days: DAYS,
    build: (t0) =>
      shockPath({
        days: DAYS,
        base: baseMarket(t0),
        knots: [],
        mutate: (m, day) => ({ ...m, fundingRatePer8h: day >= 1 ? -0.0003 : m.fundingRatePer8h }),
      }),
  },
  {
    id: "E",
    name: "Lending APY drops",
    description: "Borrow demand dries up: USDC utilisation 80% -> 10%, WETH 60% -> 5%. Only funding carries the vault.",
    days: DAYS,
    build: (t0) =>
      shockPath({
        days: DAYS,
        base: baseMarket(t0),
        knots: [],
        mutate: (m, day) => (day >= 1 ? { ...m, usdcUtilization: 0.1, wethUtilization: 0.05 } : m),
      }),
  },
  {
    id: "F",
    name: "High volatility",
    description: "30 days of ~120% annualised volatility (seeded GBM, no drift). Vol scaling cuts leverage; churn costs rise.",
    days: DAYS,
    build: (t0) =>
      generateMarketPath({
        seed: 7,
        days: DAYS,
        stepSec: 3600,
        startTime: t0,
        regimes: [{ vol: 1.2, stayProbPerDay: 1 }],
        funding: { mean8h: 0.0001, kappaPerDay: 0.5, sigma8hPerSqrtDay: 0, momentumBeta: 0, clip8h: 0.003 },
        utilization: { usdcMean: 0.8, wethMean: 0.6, kappaPerDay: 0, sigmaPerSqrtDay: 0 },
      }),
  },
  {
    id: "G",
    name: "Oracle becomes stale",
    description: "The price feed stops for three days while ETH rises 15%. No trade is allowed on a stale price, so leverage drifts until the feed recovers.",
    days: DAYS,
    build: (t0) =>
      shockPath({
        days: DAYS,
        base: baseMarket(t0),
        knots: [{ day: 0, price: 3000 }, { day: 2, price: 3000 }, { day: 5, price: 3450 }],
        mutate: (m, day) => ({ ...m, oracleHealthy: !(day >= 2 && day < 5) }),
      }),
  },
  {
    id: "H",
    name: "Large slippage",
    description: "Venues become 200x shallower with 10x spreads during a 15% sell-off. Rebalances get expensive; the cost filter holds off non-urgent ones.",
    days: DAYS,
    build: (t0) => {
      const shallow = {
        ...DEFAULT_VENUES,
        perpDepthUsd: DEFAULT_VENUES.perpDepthUsd / 200,
        dexDepthUsd: DEFAULT_VENUES.dexDepthUsd / 200,
        perpSpreadBps: 20,
        dexSpreadBps: 20,
      };
      return shockPath({
        days: DAYS,
        base: baseMarket(t0),
        knots: [{ day: 0, price: 3000 }, { day: 4, price: 2550 }],
        mutate: (m, day) => (day >= 1 ? { ...m, venues: shallow } : m),
      });
    },
  },
  {
    id: "I",
    name: "ETH +60% squeeze",
    description: "Tail event: a 60% short squeeze in three days. Without a keeper the 2x short is liquidated; with one, margin is rebuilt in time.",
    days: DAYS,
    build: (t0) => shockPath({ days: DAYS, base: baseMarket(t0), knots: [{ day: 0, price: 3000 }, { day: 3, price: 4800 }] }),
  },
  {
    id: "J",
    name: "Crash + negative funding",
    description: "Combined stress: ETH -30% while funding pays -0.05%/8h and lending utilisation collapses.",
    days: DAYS,
    build: (t0) =>
      shockPath({
        days: DAYS,
        base: baseMarket(t0),
        knots: [{ day: 0, price: 3000 }, { day: 7, price: 2100 }],
        mutate: (m, day) => (day >= 1 ? { ...m, fundingRatePer8h: -0.0005, usdcUtilization: 0.3, wethUtilization: 0.2 } : m),
      }),
  },
];

function metrics(s: SimSummary, tvl: number): ScenarioMetrics {
  return {
    vaultValue: s.endNav,
    userShareValue: s.endSharePrice,
    hedgePnl: s.hedgePnl,
    lendingIncome: s.lendingPnl,
    fundingPnl: s.fundingPnl,
    spotPnl: s.spotPnl,
    tradingCosts: s.tradingCosts,
    netPnl: s.grossPnl,
    netReturnPct: (s.grossPnl / tvl) * 100,
    endDeltaBps: s.endDeltaBps,
    maxAbsDeltaBps: s.maxAbsDeltaBps,
    endLiquidationDistanceBps: s.endLiquidationDistanceBps,
    minLiquidationDistanceBps: s.minLiquidationDistanceBps,
    maxDrawdownBps: s.maxDrawdownBps,
    maxLeverage: s.maxLeverage,
    rebalances: s.rebalances,
    liquidations: s.liquidations,
    badDebtAbsorbed: s.badDebtAbsorbed,
  };
}

export function runScenario(def: ScenarioDef, opts: { tvl?: number; cfg?: StrategyConfig } = {}): ScenarioResult {
  const tvl = opts.tvl ?? 100_000;
  const cfg = opts.cfg ?? DEFAULT_STRATEGY;
  const path = def.build(0);
  const on = simulate(path, { tvl, cfg, rebalancing: true, recordEvery: 24 });
  const off = simulate(path, { tvl, cfg, rebalancing: false, recordEvery: 24 });
  const p0 = path[0]!.price;
  const p1 = path[path.length - 1]!.price;
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    days: def.days,
    ethPriceStart: p0,
    ethPriceEnd: p1,
    ethMovePct: (p1 / p0 - 1) * 100,
    withKeeper: metrics(on.summary, tvl),
    withoutKeeper: metrics(off.summary, tvl),
  };
}

export function runAllScenarios(opts: { tvl?: number; cfg?: StrategyConfig } = {}): ScenarioResult[] {
  return SCENARIOS.map((d) => runScenario(d, opts));
}

/** Custom scenario from API input: a price move over N days plus optional regime overrides. */
export interface CustomScenarioInput {
  priceMovePct: number;
  moveDays: number;
  horizonDays: number;
  fundingRatePer8h?: number;
  usdcUtilization?: number;
  wethUtilization?: number;
  oracleOutageDays?: number;
  liquidityMultiplier?: number; // 1 = normal depth, 0.01 = 100x shallower
  tvl?: number;
  leverageBps?: number;
  reserveBps?: number;
}

export function runCustomScenario(input: CustomScenarioInput): ScenarioResult {
  const cfg: StrategyConfig = {
    ...DEFAULT_STRATEGY,
    targetLeverageBps: input.leverageBps ?? DEFAULT_STRATEGY.targetLeverageBps,
    reserveBps: input.reserveBps ?? DEFAULT_STRATEGY.reserveBps,
  };
  const liq = input.liquidityMultiplier ?? 1;
  const venues = {
    ...DEFAULT_VENUES,
    perpDepthUsd: DEFAULT_VENUES.perpDepthUsd * liq,
    dexDepthUsd: DEFAULT_VENUES.dexDepthUsd * liq,
  };
  const horizon = Math.max(input.horizonDays, input.moveDays, 1);
  const outage = input.oracleOutageDays ?? 0;
  const def: ScenarioDef = {
    id: "CUSTOM",
    name: `Custom: ETH ${input.priceMovePct >= 0 ? "+" : ""}${input.priceMovePct}% over ${input.moveDays}d`,
    description: "User-defined scenario",
    days: horizon,
    build: (t0) =>
      shockPath({
        days: horizon,
        base: { ...baseMarket(t0, venues) },
        knots: [
          { day: 0, price: 3000 },
          { day: Math.max(input.moveDays, 1 / 24), price: 3000 * (1 + input.priceMovePct / 100) },
        ],
        mutate: (m, day) => ({
          ...m,
          fundingRatePer8h: input.fundingRatePer8h ?? m.fundingRatePer8h,
          usdcUtilization: input.usdcUtilization ?? m.usdcUtilization,
          wethUtilization: input.wethUtilization ?? m.wethUtilization,
          oracleHealthy: !(outage > 0 && day > 0 && day <= outage),
        }),
      }),
  };
  return runScenario(def, { tvl: input.tvl ?? 100_000, cfg });
}
