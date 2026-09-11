import type { FundingView, PerformanceView, VaultMetrics } from "@dnv/shared";
import { usd } from "@dnv/shared";
import {
  type CustomScenarioInput,
  DEFAULT_STRATEGY,
  type StrategyConfig,
  estimateApy,
  monteCarlo,
  optimize,
  runAllScenarios,
  runCustomScenario,
  SCENARIOS,
  runScenario,
} from "@dnv/simulator";

import type { Chain_ } from "../chain/clients";
import { type RawState, readRawState } from "../chain/reader";
import type { Config } from "../config";
import * as repo from "../db/repo";
import type { Db } from "../db/pool";
import { annualize, summarize, withTrailingApy } from "../performance";
import { deltaView, feesView, leverageOf, pnlView, positionsView, riskView, strategyView, vaultView } from "../views";

const DAY = 24 * 3600;

/** Map live on-chain parameters onto the simulator's config so estimates reflect what is deployed. */
export function strategyConfigFromChain(s: RawState): StrategyConfig {
  const t = s.rebalance.targets;
  const p = s.rebalance.params;
  const r = s.risk.config;
  return {
    ...DEFAULT_STRATEGY,
    targetLeverageBps: t.targetLeverageBps,
    hedgeRatioBps: t.hedgeRatioBps,
    reserveBps: t.reserveBps,
    defensiveReserveBps: t.defensiveReserveBps,
    minLeverageBps: s.rebalance.bounds.minLeverageBps,
    deltaBandBps: p.deltaBandBps,
    leverageBandBps: p.leverageBandBps,
    allocationBandBps: p.allocationBandBps,
    minIntervalSec: p.minIntervalSec,
    maxCostBps: p.maxCostBps,
    carryHorizonSec: p.carryHorizonSec,
    volRefBps: p.volRefBps,
    fundingFloorAprBps: p.fundingFloorAprBps,
    minTradeUsd: usd(p.minTradeUsd),
    minDeployUsd: usd(p.minDeployUsd),
    gasCostUsd: usd(p.gasCostUsd),
    maxSlippageBps: r.maxSlippageBps,
    managementFeeBps: Number(s.fees.mgmtBps),
    performanceFeeBps: Number(s.fees.perfBps),
    risk: {
      leverage: r.leverage,
      delta: r.delta,
      drawdown: r.drawdown,
      liquidationDistance: r.liquidationDistance,
    },
  };
}

export class ApiService {
  private cache: { at: number; state: RawState } | null = null;
  private scenarioCache: { key: string; value: ReturnType<typeof runAllScenarios> } | null = null;

  constructor(
    readonly cfg: Config,
    readonly chain: Chain_,
    readonly db: Db,
  ) {}

  /** Latest state, cached for 1.5s so a dashboard refresh doesn't re-read the chain per endpoint. */
  async state(): Promise<RawState> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < 1500) return this.cache.state;
    const state = await readRawState(this.chain);
    this.cache = { at: now, state };
    return state;
  }

  apyInputs(s: RawState) {
    const snap = s.snapshot;
    return {
      usdcSupplyApr: Number(snap.usdcSupplyRate) / 1e18,
      wethSupplyApr: Number(snap.wethSupplyRate) / 1e18,
      fundingRatePer8h: Number(snap.fundingRatePer8h) / 1e18,
      volAnnual: Number(s.rebalance.annualizedVolBps) / 10_000,
      targetLeverage: Number(s.rebalance.effectiveLeverageBps) / 10_000,
      reserveRatio: s.rebalance.targets.reserveBps / 10_000,
      hedgeRatio: s.rebalance.targets.hedgeRatioBps / 10_000,
      tvl: Math.max(usd(s.vault.totalAssets), 10_000),
      cfg: strategyConfigFromChain(s),
    };
  }

  async vault() {
    const s = await this.state();
    return vaultView(s, this.cfg.CHAIN_ID, this.cfg.deployment.vault, this.cfg.deployment.usdc);
  }

  async metrics(): Promise<VaultMetrics> {
    const s = await this.state();
    const snap = s.snapshot;
    const now = Number(s.timestamp);
    const pps = Number(s.vault.sharePrice) / 1e18;
    const first = await repo.firstSnapshot(this.db);
    const windowStart = Math.max(first?.ts ?? now, now - 30 * DAY);
    const past = await repo.sharePriceAt(this.db, windowStart);
    const netApy = past ? annualize(past.sharePrice, pps, now - past.ts) : null;
    // gross: carry income over the window / average TVL, before trading costs and vault fees
    let grossApy: number | null = null;
    const incomePast = await repo.incomeAt(this.db, windowStart);
    const avgTvl = await repo.avgTvlSince(this.db, windowStart);
    const incomeNow = usd(s.pnl.lendingIncomeUsdc) + usd(s.pnl.lendingIncomeWeth) + usd(s.pnl.fundingIncome);
    if (past && incomePast !== null && avgTvl && now - past.ts >= DAY) {
      grossApy = ((incomeNow - incomePast) / avgTvl) * ((365 * DAY) / (now - past.ts));
    }
    const nav = usd(snap.totalNav);
    const deployedLendingApr =
      nav > 0 ? (usd(snap.reserveAssets) * Number(snap.usdcSupplyRate) + usd(snap.longValue) * Number(snap.wethSupplyRate)) / 1e18 / Math.max(usd(snap.reserveAssets) + usd(snap.longValue), 1) : 0;
    const lev = leverageOf(s);
    const liq = s.liquidationReport.distanceBps;
    const fundingRate = Number(snap.fundingRatePer8h) / 1e18;
    return {
      chainId: this.cfg.CHAIN_ID,
      blockNumber: Number(s.blockNumber),
      blockTimestamp: now,
      tvlUsd: usd(s.vault.totalAssets),
      sharePrice: pps,
      netApy,
      grossApy,
      estimatedNetApy: estimateApy(this.apyInputs(s)).netApy,
      lendingApy: deployedLendingApr,
      usdcSupplyApr: Number(snap.usdcSupplyRate) / 1e18,
      wethSupplyApr: Number(snap.wethSupplyRate) / 1e18,
      fundingRatePer8h: fundingRate,
      fundingApr: fundingRate * 1095,
      netDeltaBps: Number(s.deltaReport.deltaBps),
      netDeltaUsd: usd(s.deltaReport.netDeltaUsd),
      hedgeRatio: s.deltaReport.hedgeRatioBps > 10n ** 9n ? 0 : Number(s.deltaReport.hedgeRatioBps) / 10_000,
      leverage: Number.isFinite(lev) ? lev : 999,
      liquidationDistanceBps: liq > 10n ** 12n ? null : Number(liq),
      drawdownBps: Number(s.risk.report.drawdownBps),
      totalPnlUsd: usd(s.pnl.netPnl) - usd(s.fees.totalMgmt) - usd(s.fees.totalPerf),
      riskState: riskView(s, this.cfg.CHAIN_ID).state,
      ethPrice: Number(snap.price) / 1e18,
    };
  }

  async performance(days?: number): Promise<PerformanceView> {
    const s = await this.state();
    const now = Number(s.timestamp);
    const from = days ? now - days * DAY : 0;
    const points = withTrailingApy(await repo.performanceSeries(this.db, from));
    const rebalances = points.length ? await repo.rebalanceCountBetween(this.db, points[0]!.ts, now) : 0;
    return { points, summary: summarize(points, rebalances) };
  }

  async positions() {
    return positionsView(await this.state(), this.cfg.CHAIN_ID);
  }

  async risk() {
    return riskView(await this.state(), this.cfg.CHAIN_ID);
  }

  async delta() {
    return deltaView(await this.state(), this.cfg.CHAIN_ID);
  }

  async pnl() {
    return pnlView(await this.state(), this.cfg.CHAIN_ID);
  }

  async fees() {
    return feesView(await this.state(), this.cfg.CHAIN_ID);
  }

  async strategy() {
    return strategyView(await this.state(), this.cfg.CHAIN_ID);
  }

  async funding(): Promise<FundingView> {
    const s = await this.state();
    const snap = s.snapshot;
    const rate = Number(snap.fundingRatePer8h) / 1e18;
    const settled = usd(s.perp.accountStats.fundingPnl);
    const pending = usd(snap.perpPendingFunding);
    const notional = usd(snap.shortNotional);
    const series = await repo.performanceSeries(this.db, 0, 500);
    return {
      chainId: this.cfg.CHAIN_ID,
      blockNumber: Number(s.blockNumber),
      blockTimestamp: Number(s.timestamp),
      ratePer8h: rate,
      apr: rate * 1095,
      settledFundingUsd: settled,
      pendingFundingUsd: pending,
      cumulativeFundingUsd: settled + pending,
      shortNotionalUsd: notional,
      annualizedIncomeUsd: (snap.perpSize < 0n ? 1 : -1) * notional * rate * 1095,
      history: series.map((p) => ({ ts: p.ts, ratePer8h: p.fundingRatePer8h, cumulativeFundingUsd: p.fundingIncome })),
      settlements: await repo.fundingPayments(this.db, 100),
    };
  }

  async apy() {
    const s = await this.state();
    const inputs = this.apyInputs(s);
    const estimate = estimateApy(inputs);
    const opt = optimize({ ...inputs, targetLeverage: undefined, reserveRatio: undefined } as never);
    return { estimate, optimizer: { best: opt.best, recommendation: opt.recommendation, frontier: opt.frontier, constraints: opt.constraints } };
  }

  async scenarios() {
    const s = await this.state();
    const cfg = strategyConfigFromChain(s);
    const tvl = Math.max(usd(s.vault.totalAssets), 100_000);
    const key = JSON.stringify({ cfg, tvl: Math.round(tvl / 1000) });
    if (this.scenarioCache?.key !== key) this.scenarioCache = { key, value: runAllScenarios({ tvl, cfg }) };
    return this.scenarioCache.value;
  }

  async simulate(body: SimulationRequest) {
    const s = await this.state();
    const cfg = strategyConfigFromChain(s);
    let result: unknown;
    if (body.type === "scenario") {
      const def = SCENARIOS.find((d) => d.id === body.scenarioId);
      if (!def) throw Object.assign(new Error(`unknown scenario ${body.scenarioId}`), { statusCode: 400 });
      result = runScenario(def, { tvl: body.tvl ?? 100_000, cfg });
    } else if (body.type === "custom") {
      result = runCustomScenario(body);
    } else if (body.type === "montecarlo") {
      result = monteCarlo({ paths: Math.min(body.paths ?? 100, 500), days: Math.min(body.days ?? 365, 730), seed: body.seed ?? 42, cfg, tvl: body.tvl ?? 100_000 });
    } else {
      result = optimize(this.apyInputs(s) as never);
    }
    const id = await repo.saveSimulation(this.db, body.type, body, result);
    return { id, type: body.type, result };
  }
}

export type SimulationRequest =
  | { type: "scenario"; scenarioId: string; tvl?: number }
  | ({ type: "custom" } & CustomScenarioInput)
  | { type: "montecarlo"; paths?: number; days?: number; seed?: number; tvl?: number }
  | { type: "optimizer" };
