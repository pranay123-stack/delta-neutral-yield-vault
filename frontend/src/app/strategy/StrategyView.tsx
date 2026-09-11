"use client";

import { FrontierChart } from "@/components/charts/FrontierChart";
import { Waterfall } from "@/components/charts/Waterfall";
import { Badge, Chip } from "@/components/ui/Badge";
import { Card, Note, SectionTitle } from "@/components/ui/Card";
import { Query, Skeleton, SkeletonRows } from "@/components/ui/QueryState";
import { KV, Stat } from "@/components/ui/Stat";
import { fmtAgo, fmtBps, fmtDuration, fmtFunding8h, fmtNum, fmtPct, fmtUsd, fmtX, pnlTone } from "@/lib/format";
import { useApy, useStrategy } from "@/lib/queries";
import type { ApyEstimate } from "@/lib/types";

function StrategyStats() {
  const strategy = useStrategy();
  if (!strategy.data) {
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-[78px]" />
        ))}
      </div>
    );
  }
  const s = strategy.data;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Target leverage" value={fmtX(s.targets.leverage)} sub={`bounds ${fmtX(s.bounds.minLeverage)} – ${fmtX(s.bounds.maxLeverage)}`} />
      <Stat label="Effective leverage" value={fmtX(s.effectiveLeverage, 3)} sub="after volatility scaling" hint="Target leverage scaled down by realised vol relative to the reference vol." />
      <Stat label="Annualised vol" value={fmtBps(s.annualizedVolBps, 1)} sub={`reference ${fmtBps(s.params.volRefBps, 0)}`} />
      <Stat label="Hedge ratio target" value={fmtPct(s.targets.hedgeRatio, 1)} sub={`bounds ${fmtPct(s.bounds.minHedgeRatio, 0)} – ${fmtPct(s.bounds.maxHedgeRatio, 0)}`} />
      <Stat label="Reserve target" value={fmtPct(s.targets.reservePct, 1)} sub={`defensive ${fmtPct(s.targets.defensiveReservePct, 0)}`} />
      <div className="min-w-0 rounded-lg border border-line bg-panel px-4 py-3">
        <div className="text-[0.7rem] font-medium uppercase tracking-[0.06em] text-muted">Mode</div>
        <div className="mt-2">{s.defensive ? <Badge level="warn">Defensive</Badge> : <Badge level="normal">Normal carry</Badge>}</div>
        <div className="mt-1 text-xs text-ink-2">defensive below {fmtBps(s.params.fundingFloorAprBps, 1)} funding APR</div>
      </div>
    </div>
  );
}

function ConfigCards() {
  const strategy = useStrategy();
  return (
    <Query query={strategy} skeleton={<SkeletonRows rows={10} />}>
      {(s) => (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="Targets & bounds" subtitle="RebalanceManager configuration (strategist-set, guardian-bounded)" flush>
            <table className="table-dense">
              <thead>
                <tr>
                  <th>Parameter</th>
                  <th className="num">Target</th>
                  <th className="num">Min</th>
                  <th className="num">Max</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Leverage</td>
                  <td className="num text-ink">{fmtX(s.targets.leverage)}</td>
                  <td className="num">{fmtX(s.bounds.minLeverage)}</td>
                  <td className="num">{fmtX(s.bounds.maxLeverage)}</td>
                </tr>
                <tr>
                  <td>Hedge ratio</td>
                  <td className="num text-ink">{fmtPct(s.targets.hedgeRatio, 1)}</td>
                  <td className="num">{fmtPct(s.bounds.minHedgeRatio, 0)}</td>
                  <td className="num">{fmtPct(s.bounds.maxHedgeRatio, 0)}</td>
                </tr>
                <tr>
                  <td>Reserve</td>
                  <td className="num text-ink">{fmtPct(s.targets.reservePct, 1)}</td>
                  <td className="num">{fmtPct(s.bounds.minReservePct, 0)}</td>
                  <td className="num">{fmtPct(s.bounds.maxReservePct, 0)}</td>
                </tr>
                <tr>
                  <td>Defensive reserve</td>
                  <td className="num text-ink">{fmtPct(s.targets.defensiveReservePct, 1)}</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                </tr>
              </tbody>
            </table>
          </Card>
          <Card title="Rebalance parameters" subtitle="No-trade bands, cost filters, keeper cadence">
            <KV
              rows={[
                { label: "Delta band", value: `±${fmtBps(s.params.deltaBandBps, 2)}` },
                { label: "Leverage band", value: `±${fmtBps(s.params.leverageBandBps, 0)}` },
                { label: "Allocation band", value: `±${fmtBps(s.params.allocationBandBps, 1)}` },
                { label: "Min interval", value: fmtDuration(s.params.minIntervalSec) },
                { label: "Max cost / rebalance", value: `${fmtBps(s.params.maxCostBps, 2)} of NAV` },
                { label: "Carry horizon", value: fmtDuration(s.params.carryHorizonSec) },
                { label: "Vol reference", value: fmtBps(s.params.volRefBps, 0) },
                { label: "Funding floor (defensive)", value: `${fmtBps(s.params.fundingFloorAprBps, 1)} APR` },
                { label: "Min trade", value: fmtUsd(s.params.minTradeUsd, { digits: 0 }) },
                { label: "Min deploy", value: fmtUsd(s.params.minDeployUsd, { digits: 0 }) },
                { label: "Gas cost assumption", value: fmtUsd(s.params.gasCostUsd) },
              ]}
            />
          </Card>
          <Card title="Next plan" subtitle="What the keeper would do right now">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {s.nextPlan.execute ? (
                <Badge level={s.nextPlan.urgent ? "crit" : "warn"}>{s.nextPlan.urgent ? "Urgent" : "Execute"}</Badge>
              ) : (
                <Badge level="normal">Hold · inside bands</Badge>
              )}
              {s.nextPlan.triggers.length === 0 ? (
                <span className="text-xs text-ink-2">no triggers fired</span>
              ) : (
                s.nextPlan.triggers.map((t) => (
                  <Chip key={t} tone="accent">
                    {t}
                  </Chip>
                ))
              )}
            </div>
            <KV
              rows={[
                { label: "Long leg Δ", value: fmtUsd(s.nextPlan.longUsdDelta, { sign: true }) },
                { label: "Margin Δ", value: fmtUsd(s.nextPlan.marginDelta, { sign: true }) },
                { label: "Idle sweep", value: fmtUsd(s.nextPlan.sweepIdleUsd) },
                { label: "Estimated cost", value: fmtUsd(s.nextPlan.estimatedCostUsd) },
                { label: "Rebalances so far", value: String(s.rebalanceCount) },
                { label: "Last rebalance", value: fmtAgo(s.lastRebalanceAt, s.blockTimestamp) },
              ]}
            />
          </Card>
        </div>
      )}
    </Query>
  );
}

function apySteps(e: ApyEstimate) {
  return [
    { label: "Lending · USDC", value: e.gross.lendingUsdc },
    { label: "Lending · WETH", value: e.gross.lendingWeth },
    { label: "Funding", value: e.gross.funding },
    { label: "Gross APY", value: 0, total: true },
    { label: "Entry (amortised)", value: -e.costs.entryAmortized },
    { label: "Rebalancing", value: -e.costs.rebalancing },
    { label: "Keeper gas", value: -e.costs.gas },
    { label: "Management fee", value: -e.costs.managementFee },
    { label: "Performance fee", value: -e.costs.performanceFee },
    { label: "Net APY", value: 0, total: true },
  ];
}

function ApyCard() {
  const apy = useApy();
  return (
    <Card title="Expected APY estimate" subtitle="Closed-form estimation engine on live rates, vol and config - an estimate, not a promise">
      <Query query={apy} skeleton={<SkeletonRows rows={10} />}>
        {({ estimate: e }) => (
          <div className="grid gap-6 lg:grid-cols-5">
            <div className="lg:col-span-3">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
                <div>
                  <div className="text-[0.7rem] uppercase tracking-[0.06em] text-muted">Net APY</div>
                  <div className={`text-2xl font-semibold tabular-nums ${pnlTone(e.netApy) === "neg" ? "text-neg" : "text-ink"}`}>{fmtPct(e.netApy)}</div>
                </div>
                <div>
                  <div className="text-[0.7rem] uppercase tracking-[0.06em] text-muted">Gross APY</div>
                  <div className="text-2xl font-semibold tabular-nums text-ink-2">{fmtPct(e.grossApy)}</div>
                </div>
                <div>
                  <div className="text-[0.7rem] uppercase tracking-[0.06em] text-muted">Costs</div>
                  <div className="text-2xl font-semibold tabular-nums text-ink-2">{fmtPct(e.costs.total)}</div>
                </div>
              </div>
              <Waterfall steps={apySteps(e)} format={(v) => fmtPct(v, 3, true)} axisFormat={(v) => fmtPct(v, 1)} />
            </div>
            <div className="space-y-4 lg:col-span-2">
              <div>
                <SectionTitle>Risk & frequency</SectionTitle>
                <KV
                  rows={[
                    { label: "Rebalances / year", value: fmtNum(e.rebalancesPerYear, 1) },
                    { label: "Rebalance trigger (ETH up / down)", value: `+${fmtPct(e.risk.rebalanceTriggerUpPct, 1)} / −${fmtPct(e.risk.rebalanceTriggerDownPct, 1)}` },
                    { label: "ETH rally that liquidates the short", value: `+${fmtPct(e.risk.liquidationMovePct, 1)}` },
                    { label: "P(liquidation) 1d, no keeper", value: fmtPct(e.risk.liquidationProb1dNoKeeper, 4) },
                    { label: "P(liquidation) 7d, no keeper", value: fmtPct(e.risk.liquidationProb7dNoKeeper, 4) },
                    { label: "Funding breakeven APR", value: fmtPct(e.risk.fundingBreakevenApr, 2), hint: "Funding APR at which the basis earns no more than parking in the USDC reserve" },
                  ]}
                />
              </div>
              <div>
                <SectionTitle>Inputs</SectionTitle>
                <KV
                  rows={[
                    { label: "USDC supply APR", value: fmtPct(e.inputs.usdcSupplyApr) },
                    { label: "WETH supply APR", value: fmtPct(e.inputs.wethSupplyApr) },
                    { label: "Funding", value: fmtFunding8h(e.inputs.fundingRatePer8h) },
                    { label: "Annualised vol", value: fmtPct(e.inputs.volAnnual, 1) },
                    { label: "Leverage / reserve / hedge", value: `${fmtX(e.inputs.targetLeverage)} · ${fmtPct(e.inputs.reserveRatio, 0)} · ${fmtPct(e.inputs.hedgeRatio, 0)}` },
                    { label: "Allocation (reserve / long / margin)", value: `${fmtPct(e.allocation.reservePct, 0)} / ${fmtPct(e.allocation.longPct, 0)} / ${fmtPct(e.allocation.marginPct, 0)}` },
                    { label: "TVL", value: fmtUsd(e.inputs.tvl, { digits: 0 }) },
                  ]}
                />
              </div>
            </div>
          </div>
        )}
      </Query>
    </Card>
  );
}

function OptimizerCard() {
  const apy = useApy();
  return (
    <Card title="Optimizer" subtitle="Grid search over target leverage × reserve share, maximising net APY within risk constraints">
      <Query query={apy} skeleton={<Skeleton className="h-[360px]" />}>
        {({ estimate, optimizer: o }) => {
          const topFeasible = o.frontier
            .filter((p) => p.feasible)
            .sort((a, b) => b.netApy - a.netApy)
            .slice(0, 6);
          const feasibleCount = o.frontier.filter((p) => p.feasible).length;
          return (
            <div className="space-y-5">
              <Note>
                <span className="font-semibold text-ink">Recommendation.</span> {o.recommendation}
              </Note>
              <div className="grid gap-6 xl:grid-cols-3">
                <div className="xl:col-span-2">
                  <FrontierChart
                    frontier={o.frontier}
                    best={{ leverage: o.best.inputs.targetLeverage, netApy: o.best.netApy }}
                    current={{ leverage: estimate.inputs.targetLeverage, netApy: estimate.netApy }}
                  />
                </div>
                <div className="space-y-4">
                  <div>
                    <SectionTitle>Optimizer pick</SectionTitle>
                    <KV
                      rows={[
                        { label: "Target leverage", value: fmtX(o.best.inputs.targetLeverage) },
                        { label: "Reserve", value: fmtPct(o.best.inputs.reserveRatio, 0) },
                        { label: "Est. net APY", value: fmtPct(o.best.netApy), tone: pnlTone(o.best.netApy) },
                        { label: "vs live config", value: fmtPct(o.best.netApy - estimate.netApy, 2, true), tone: pnlTone(o.best.netApy - estimate.netApy) },
                        { label: "Survives ETH rally of", value: `+${fmtPct(o.best.risk.liquidationMovePct, 0)}` },
                        { label: "Rebalances / year", value: fmtNum(o.best.rebalancesPerYear, 0) },
                      ]}
                    />
                  </div>
                  <div>
                    <SectionTitle hint={`${feasibleCount} / ${o.frontier.length} feasible`}>Constraints</SectionTitle>
                    <KV
                      rows={[
                        { label: "Min liquidation move", value: `+${fmtPct(o.constraints.minLiquidationMovePct, 0)}` },
                        { label: "Max rebalances / year", value: fmtNum(o.constraints.maxRebalancesPerYear, 0) },
                        { label: "Max P(liq) 7d, no keeper", value: fmtPct(o.constraints.maxLiquidationProb7d, 3) },
                      ]}
                    />
                  </div>
                </div>
              </div>
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="table-dense">
                  <thead>
                    <tr>
                      <th>Top feasible configs</th>
                      <th className="num">Leverage</th>
                      <th className="num">Reserve</th>
                      <th className="num">Net APY</th>
                      <th className="num">Liq. move</th>
                      <th className="num">Rebalances / yr</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topFeasible.map((p, i) => (
                      <tr key={`${p.leverage}-${p.reservePct}`}>
                        <td className="text-ink-2">#{i + 1}</td>
                        <td className="num">{fmtX(p.leverage)}</td>
                        <td className="num">{fmtPct(p.reservePct, 0)}</td>
                        <td className="num text-ink">{fmtPct(p.netApy)}</td>
                        <td className="num">+{fmtPct(p.liquidationMovePct, 0)}</td>
                        <td className="num">{fmtNum(p.rebalancesPerYear, 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        }}
      </Query>
    </Card>
  );
}

export function StrategyView() {
  return (
    <div className="space-y-5">
      <StrategyStats />
      <ConfigCards />
      <ApyCard />
      <OptimizerCard />
    </div>
  );
}
