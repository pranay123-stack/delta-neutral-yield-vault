"use client";

import { AllocationBar } from "@/components/charts/AllocationBar";
import { S1, S2, S3, S4 } from "@/components/charts/palette";
import { Badge, RISK_LEVEL } from "@/components/ui/Badge";
import { Card, Note } from "@/components/ui/Card";
import { Query, SkeletonRows } from "@/components/ui/QueryState";
import { KV, Stat } from "@/components/ui/Stat";
import { ThresholdBar } from "@/components/ui/ThresholdBar";
import { fmtBps, fmtEth, fmtFunding8h, fmtNum, fmtPct, fmtUsd, fmtX, pnlTone } from "@/lib/format";
import { useDelta, usePositions, useRisk } from "@/lib/queries";

function LiquidationGauge() {
  const positions = usePositions();
  const risk = useRisk();
  return (
    <Card title="Liquidation distance" subtitle="How far ETH must rally before the perp short is liquidated">
      <Query query={risk} skeleton={<SkeletonRows rows={3} />}>
        {(r) => {
          const metric = r.metrics.find((m) => m.key === "LIQUIDATION");
          const distance = r.liquidation.distanceBps;
          const thresholds = metric?.thresholds ?? { warn: 3000, high: 2000, critical: 1000 };
          return (
            <div className="space-y-4">
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <div>
                  <div className="text-3xl font-semibold tabular-nums text-ink">{distance === null ? "No liquidation" : fmtBps(distance, 2)}</div>
                  <div className="mt-0.5 text-xs text-ink-2">
                    mark {fmtUsd(r.liquidation.markPrice)} → liquidation {r.liquidation.liquidationPrice ? fmtUsd(r.liquidation.liquidationPrice) : "none"}
                  </div>
                </div>
                {metric && (
                  <Badge level={RISK_LEVEL[metric.level]}>
                    {metric.level.replace("_", " ")}
                  </Badge>
                )}
              </div>
              <ThresholdBar
                value={distance}
                thresholds={thresholds}
                higherIsWorse={false}
                format={(v) => fmtBps(v, 0)}
                domain={[0, Math.max(10_000, (distance ?? 0) * 1.1)]}
              />
              <div className="grid grid-cols-3 gap-2 text-center text-xs">
                <div className="rounded-md border border-line bg-panel-2 px-2 py-1.5">
                  <div className="text-muted">warn below</div>
                  <div className="font-medium text-warn">{fmtBps(thresholds.warn, 0)}</div>
                </div>
                <div className="rounded-md border border-line bg-panel-2 px-2 py-1.5">
                  <div className="text-muted">high below</div>
                  <div className="font-medium text-serious">{fmtBps(thresholds.high, 0)}</div>
                </div>
                <div className="rounded-md border border-line bg-panel-2 px-2 py-1.5">
                  <div className="text-muted">critical below</div>
                  <div className="font-medium text-crit">{thresholds.critical === null ? "—" : fmtBps(thresholds.critical, 0)}</div>
                </div>
              </div>
              <KV
                rows={[
                  { label: "Safety buffer above critical", value: fmtBps(r.liquidation.safetyBufferBps, 2) },
                  { label: "Collateral ratio (equity / maint.)", value: positions.data?.perp.collateralRatio ? fmtX(positions.data.perp.collateralRatio) : "—" },
                  { label: "Perp leverage", value: fmtX(r.liquidation.leverage) },
                ]}
              />
            </div>
          );
        }}
      </Query>
    </Card>
  );
}

function DeltaCard() {
  const delta = useDelta();
  return (
    <Card title="Hedge / delta" subtitle="Long exposure vs short exposure">
      <Query query={delta} skeleton={<SkeletonRows rows={6} />}>
        {(d) => {
          const max = Math.max(d.longExposureUsd, d.shortExposureUsd, 1);
          return (
            <div className="space-y-4">
              <div className="space-y-2 text-xs">
                <ExposureRow label="Long (spot WETH)" value={d.longExposureUsd} max={max} color={S2} />
                <ExposureRow label="Short (perp)" value={d.shortExposureUsd} max={max} color={S3} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge level={d.withinBand ? "normal" : "warn"}>{d.withinBand ? "Within band" : "Outside band"}</Badge>
                <span className="text-xs text-ink-2">
                  band ±{fmtBps(d.bandBps, 2)} configured, ±{fmtBps(d.effectiveBandBps, 2)} after vol scaling
                </span>
              </div>
              <KV
                rows={[
                  { label: "Net delta", value: `${fmtBps(d.deltaBpsExact, 2, true)} of NAV` },
                  { label: "Net delta (USD)", value: fmtUsd(d.netDeltaUsd, { sign: true }) },
                  { label: "Net delta (ETH)", value: fmtEth(d.netDeltaQty, 4, true) },
                  { label: "Hedge ratio", value: fmtBps(d.hedgeRatioBps, 2) },
                  { label: "Gross exposure", value: fmtUsd(d.grossExposureUsd, { digits: 0 }) },
                  { label: "Target perp size", value: fmtEth(d.targetPerpSize, 4) },
                  { label: "Hedge change to flatten", value: `${fmtEth(d.requiredPerpSizeChange, 4, true)} (${fmtUsd(d.requiredHedgeChangeUsd, { sign: true })})` },
                ]}
              />
            </div>
          );
        }}
      </Query>
    </Card>
  );
}

function ExposureRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-ink-2">
        <span>{label}</span>
        <span className="font-medium text-ink">{fmtUsd(value, { digits: 0 })}</span>
      </div>
      <div className="h-2 w-full rounded-sm bg-panel-3">
        <div className="h-full rounded-sm" style={{ width: `${(value / max) * 100}%`, background: color }} />
      </div>
    </div>
  );
}

export function PositionsView() {
  const positions = usePositions();
  return (
    <div className="space-y-5">
      <Query
        query={positions}
        skeleton={
          <div className="grid gap-5 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} title="Loading…">
                <SkeletonRows rows={7} />
              </Card>
            ))}
          </div>
        }
      >
        {(p) => {
          const spotUnrealized = p.long.valueUsd - p.long.costBasisUsd;
          return (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Stat label="ETH price" value={fmtUsd(p.ethPrice)} sub={p.oracleHealthy ? "oracle healthy" : "oracle UNHEALTHY"} tone={p.oracleHealthy ? "neutral" : "neg"} />
                <Stat label="Perp uPnL" value={fmtUsd(p.perp.unrealizedPnlUsd, { sign: true })} tone={pnlTone(p.perp.unrealizedPnlUsd)} sub="mark vs entry" />
                <Stat label="Pending funding" value={fmtUsd(p.perp.pendingFundingUsd, { sign: true })} tone={pnlTone(p.perp.pendingFundingUsd)} sub={fmtFunding8h(p.perp.fundingRatePer8h)} />
                <Stat label="Spot vs cost basis" value={fmtUsd(spotUnrealized, { sign: true })} tone={pnlTone(spotUnrealized)} sub="WETH long, unrealised" />
              </div>
              <div className="grid gap-5 lg:grid-cols-3">
                <Card title="Reserve · USDC lending" subtitle="Liquid buffer; funds standard withdrawals">
                  <KV
                    rows={[
                      { label: "Supplied", value: fmtUsd(p.reserve.suppliedUsd) },
                      { label: "Principal", value: fmtUsd(p.reserve.principalUsd) },
                      { label: "Interest earned", value: fmtUsd(p.reserve.interestUsd, { sign: true }), tone: pnlTone(p.reserve.interestUsd) },
                      { label: "Supply APR", value: fmtPct(p.reserve.supplyApr) },
                      { label: "Pool utilisation", value: fmtPct(p.reserve.utilization, 1) },
                      { label: "Withdrawable now", value: fmtUsd(p.reserve.withdrawableUsd) },
                    ]}
                  />
                </Card>
                <Card title="Long leg · WETH lending" subtitle="Spot ETH exposure, earning supply APR">
                  <KV
                    rows={[
                      { label: "WETH supplied", value: fmtEth(p.long.wethQty, 4) },
                      { label: "Value", value: fmtUsd(p.long.valueUsd) },
                      { label: "Principal", value: fmtEth(p.long.principalQty, 4) },
                      { label: "Interest earned", value: fmtEth(p.long.interestQty, 4, true), tone: pnlTone(p.long.interestQty) },
                      { label: "Cost basis", value: fmtUsd(p.long.costBasisUsd) },
                      { label: "Supply APR", value: fmtPct(p.long.supplyApr) },
                      { label: "Pool utilisation", value: fmtPct(p.long.utilization, 1) },
                    ]}
                  />
                </Card>
                <Card title="Perp short · ETH" subtitle="Hedge leg; earns funding when positive">
                  <KV
                    rows={[
                      { label: "Size", value: fmtEth(p.perp.size, 4) },
                      { label: "Entry price", value: fmtUsd(p.perp.entryPrice) },
                      { label: "Mark price", value: fmtUsd(p.perp.markPrice) },
                      { label: "Notional", value: fmtUsd(p.perp.notionalUsd) },
                      { label: "Margin", value: fmtUsd(p.perp.marginUsd) },
                      { label: "Equity", value: fmtUsd(p.perp.equityUsd) },
                      { label: "Unrealised PnL", value: fmtUsd(p.perp.unrealizedPnlUsd, { sign: true }), tone: pnlTone(p.perp.unrealizedPnlUsd) },
                      { label: "Pending funding", value: fmtUsd(p.perp.pendingFundingUsd, { sign: true }), tone: pnlTone(p.perp.pendingFundingUsd) },
                      { label: "Leverage", value: fmtX(p.perp.leverage) },
                      { label: "Liquidation price", value: p.perp.liquidationPrice ? fmtUsd(p.perp.liquidationPrice) : "none" },
                      { label: "Liquidation distance", value: fmtBps(p.perp.liquidationDistanceBps, 2) },
                      { label: "Maintenance margin", value: fmtUsd(p.perp.maintenanceMarginUsd) },
                      { label: "Collateral ratio", value: p.perp.collateralRatio === null ? "—" : `${fmtNum(p.perp.collateralRatio, 2)}x maint.` },
                    ]}
                  />
                </Card>
              </div>
              <div className="grid gap-5 lg:grid-cols-3">
                <Card title="Allocation" subtitle="Share of TVL by bucket (perp counted at equity)">
                  <AllocationBar
                    slices={[
                      { label: "USDC reserve", value: p.reserve.suppliedUsd, pct: p.allocation.reservePct, color: S1 },
                      { label: "WETH long", value: p.long.valueUsd, pct: p.allocation.longPct, color: S2 },
                      { label: "Perp margin (equity)", value: p.perp.equityUsd, pct: p.allocation.perpPct, color: S3 },
                      { label: "Idle (vault + strategy float)", value: p.idle.vaultUsd + p.idle.strategyFloatUsd, pct: p.allocation.idlePct, color: S4 },
                    ]}
                  />
                  <div className="mt-4">
                    <Note>
                      The long leg is sized so that <em>long ≈ short notional</em>; the perp margin backing the short sits at roughly long / target leverage. The reserve is the liquid buffer standard ERC-4626 exits draw from.
                    </Note>
                  </div>
                </Card>
                <LiquidationGauge />
                <DeltaCard />
              </div>
            </>
          );
        }}
      </Query>
    </div>
  );
}
