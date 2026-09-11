/**
 * Prints the scenario table, APY estimate, optimizer recommendation and a Monte Carlo summary.
 *   pnpm --filter @dnv/simulator report [--mc 200] [--json]
 */
import { BASE_MARKET, DEFAULT_VENUES } from "./config";
import { monteCarlo } from "./montecarlo";
import { estimateApy, optimize } from "./optimizer";
import { supplyRate } from "./rates";
import { runAllScenarios } from "./scenarios";

const args = process.argv.slice(2);
const json = args.includes("--json");
const mcIdx = args.indexOf("--mc");
const mcPaths = mcIdx >= 0 ? Number(args[mcIdx + 1]) : 100;

const baseInputs = {
  usdcSupplyApr: supplyRate(DEFAULT_VENUES.usdcRateModel, BASE_MARKET.usdcUtilization),
  wethSupplyApr: supplyRate(DEFAULT_VENUES.wethRateModel, BASE_MARKET.wethUtilization),
  fundingRatePer8h: BASE_MARKET.fundingRatePer8h,
  volAnnual: 0.6,
};

const scenarios = runAllScenarios();
const apy = estimateApy(baseInputs);
const opt = optimize(baseInputs);
const mc = monteCarlo({ paths: mcPaths, days: 365, seed: 42 });

if (json) {
  console.log(JSON.stringify({ scenarios, apy, optimizer: { best: opt.best, recommendation: opt.recommendation }, monteCarlo: mc }, null, 2));
  process.exit(0);
}

const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const bpsOrDash = (x: number | null) => (x === null ? "-" : `${(x / 100).toFixed(1)}%`);

console.log("\n=== Scenarios ($100k vault, 30 days) - keeper ON / keeper OFF ===");
console.table(
  scenarios.map((s) => ({
    id: s.id,
    scenario: s.name,
    ethMove: `${s.ethMovePct.toFixed(0)}%`,
    netPnl: `${usd(s.withKeeper.netPnl)} / ${usd(s.withoutKeeper.netPnl)}`,
    hedge: usd(s.withKeeper.hedgePnl),
    funding: usd(s.withKeeper.fundingPnl),
    lending: usd(s.withKeeper.lendingIncome),
    costs: usd(s.withKeeper.tradingCosts),
    maxDelta: `${s.withKeeper.maxAbsDeltaBps.toFixed(0)} / ${s.withoutKeeper.maxAbsDeltaBps.toFixed(0)} bps`,
    minLiqDist: `${bpsOrDash(s.withKeeper.minLiquidationDistanceBps)} / ${bpsOrDash(s.withoutKeeper.minLiquidationDistanceBps)}`,
    maxDD: `${(s.withKeeper.maxDrawdownBps / 100).toFixed(2)}%`,
    rebal: s.withKeeper.rebalances,
    liq: `${s.withKeeper.liquidations} / ${s.withoutKeeper.liquidations}`,
  })),
);

console.log("\n=== Expected APY at base market ===");
console.table({
  "lending (USDC reserve)": pct(apy.gross.lendingUsdc),
  "lending (WETH long leg)": pct(apy.gross.lendingWeth),
  "funding (short leg)": pct(apy.gross.funding),
  "gross APY": pct(apy.grossApy),
  "entry cost (amortised)": pct(-apy.costs.entryAmortized, 3),
  "rebalancing costs": pct(-apy.costs.rebalancing, 3),
  "keeper gas": pct(-apy.costs.gas, 3),
  "management fee": pct(-apy.costs.managementFee),
  "performance fee": pct(-apy.costs.performanceFee),
  "NET APY (estimate)": pct(apy.netApy),
  "rebalances / year": apy.rebalancesPerYear.toFixed(0),
  "rally that liquidates the short": pct(apy.risk.liquidationMovePct, 1),
  "funding breakeven APR": pct(apy.risk.fundingBreakevenApr),
});

console.log("\n=== Optimizer ===");
console.log(opt.recommendation);

console.log(`\n=== Monte Carlo (${mc.paths} paths x ${mc.days} days, regime-switching GBM) ===`);
console.table({
  "annualised return p5 / p50 / p95": `${pct(mc.annualizedReturn.p5)} / ${pct(mc.annualizedReturn.p50)} / ${pct(mc.annualizedReturn.p95)}`,
  "max drawdown p50 / p95": `${(mc.maxDrawdownBps.p50 / 100).toFixed(2)}% / ${(mc.maxDrawdownBps.p95 / 100).toFixed(2)}%`,
  "VaR95 / CVaR95 (1y)": `${pct(mc.var95)} / ${pct(mc.cvar95)}`,
  "P(loss over 1y)": pct(mc.lossProbability, 1),
  "P(venue liquidation)": pct(mc.liquidationProbability, 1),
  "rebalances / year p50": mc.rebalances.p50.toFixed(0),
  "trading cost % TVL p50": `${mc.tradingCostPct.p50.toFixed(2)}%`,
});
