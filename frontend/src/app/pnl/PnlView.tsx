"use client";

import type { PnlView as Pnl } from "@dnv/shared";

import { Waterfall, type WaterfallStep } from "@/components/charts/Waterfall";
import { Badge } from "@/components/ui/Badge";
import { Card, cx } from "@/components/ui/Card";
import { Query, SkeletonRows } from "@/components/ui/QueryState";
import { KV, Stat } from "@/components/ui/Stat";
import { fmtAgo, fmtBps, fmtDateTime, fmtNum, fmtPct, fmtUsd, pnlTone, shortHex, toneClass } from "@/lib/format";
import { useFees, useFunding, usePnl } from "@/lib/queries";

interface Line {
  label: string;
  value: number;
  group: "Carry" | "Hedge & spot" | "Costs" | "Vault fees";
  note?: string;
}

/** Attribution lines, signed as they hit NAV (costs and fees negative). */
function lines(p: Pnl): Line[] {
  return [
    { label: "Lending · USDC", value: p.lendingIncomeUsdc, group: "Carry", note: "reserve supply interest" },
    { label: "Lending · WETH", value: p.lendingIncomeWeth, group: "Carry", note: "long leg supply interest" },
    { label: "Funding", value: p.fundingIncome, group: "Carry", note: "settled + pending, short side" },
    { label: "Spot realised", value: p.spotRealizedPnl, group: "Hedge & spot", note: "WETH bought/sold on rebalances" },
    { label: "Spot unrealised", value: p.spotUnrealizedPnl, group: "Hedge & spot", note: "WETH mark vs cost basis" },
    { label: "Perp realised", value: p.perpRealizedPnl, group: "Hedge & spot", note: "closed hedge PnL" },
    { label: "Perp unrealised", value: p.perpUnrealizedPnl, group: "Hedge & spot", note: "open hedge mark-to-market" },
    { label: "Trading fees", value: -p.tradingFees, group: "Costs", note: "perp taker + DEX fees" },
    { label: "Slippage", value: -p.slippage, group: "Costs", note: "price impact on rebalances" },
    { label: "Bad debt absorbed", value: -p.badDebtAbsorbed, group: "Costs", note: "venue liquidation shortfall" },
    { label: "Management fee", value: -p.managementFees, group: "Vault fees", note: "streamed, minted as shares" },
    { label: "Performance fee", value: -p.performanceFees, group: "Vault fees", note: "above high-water mark" },
  ];
}

function waterfallSteps(p: Pnl): WaterfallStep[] {
  const l = lines(p);
  const pre = l.filter((x) => x.group !== "Vault fees");
  const fees = l.filter((x) => x.group === "Vault fees");
  return [
    ...pre.map((x) => ({ label: x.label, value: x.value })),
    { label: "Strategy net", value: 0, total: true },
    ...fees.map((x) => ({ label: x.label, value: x.value })),
    { label: "Net after fees", value: 0, total: true },
  ];
}

function Reconciliation({ p }: { p: Pnl }) {
  const residual = p.strategyNav - p.netCapital - p.strategyNetPnl;
  const ok = Math.abs(p.reconciliationResidualUsd) < 1;
  return (
    <Card
      title="Reconciliation check"
      subtitle="Does the attribution explain NAV to the cent?"
      action={<Badge level={ok ? "normal" : "crit"}>{ok ? "Reconciled" : "Mismatch"}</Badge>}
    >
      <div className="space-y-1 font-mono text-[0.8125rem]">
        <div className="flex justify-between gap-4">
          <span className="text-ink-2">strategyNav</span>
          <span>{fmtUsd(p.strategyNav)}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-ink-2">− netCapital (deposits − withdrawals)</span>
          <span>{fmtUsd(-p.netCapital, { sign: true })}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-ink-2">− strategyNetPnl</span>
          <span>{fmtUsd(-p.strategyNetPnl, { sign: true })}</span>
        </div>
        <div className="flex justify-between gap-4 border-t border-line-strong pt-1.5 text-base">
          <span className="font-semibold text-ink">= residual</span>
          <span className={cx("font-semibold", ok ? "text-good" : "text-crit")}>{fmtUsd(p.reconciliationResidualUsd, { digits: 6, sign: true })}</span>
        </div>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-ink-2">
        Every dollar of NAV is either capital that users put in or a PnL line above. The residual is computed on-chain by the backend
        (client re-computation: {fmtUsd(residual, { digits: 6, sign: true })}); anything beyond rounding dust would mean an unattributed flow.
      </p>
    </Card>
  );
}

function FeesCard() {
  const fees = useFees();
  return (
    <Card title="Vault fees" subtitle="FeeManager configuration and accruals">
      <Query query={fees} skeleton={<SkeletonRows rows={8} />}>
        {(f) => {
          const hwmGap = f.sharePrice / f.highWaterMark - 1;
          return (
            <div className="space-y-4">
              <div className="rounded-md border border-line bg-panel-2 p-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-ink-2">Share price vs high-water mark</span>
                  <Badge level={f.aboveHighWaterMark ? "normal" : "neutral"}>{f.aboveHighWaterMark ? "above HWM · perf fee accrues" : "below HWM · no perf fee"}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  <div>
                    <div className="text-[0.68rem] text-muted">Share price</div>
                    <div className="font-semibold tabular-nums">{f.sharePrice.toFixed(6)}</div>
                  </div>
                  <div>
                    <div className="text-[0.68rem] text-muted">High-water mark</div>
                    <div className="font-semibold tabular-nums">{f.highWaterMark.toFixed(6)}</div>
                  </div>
                  <div>
                    <div className="text-[0.68rem] text-muted">Gap</div>
                    <div className={cx("font-semibold tabular-nums", toneClass[pnlTone(hwmGap)])}>{fmtPct(hwmGap, 4, true)}</div>
                  </div>
                </div>
              </div>
              <KV
                rows={[
                  { label: "Management fee", value: `${fmtBps(f.managementFeeBps, 2)} / yr (cap ${fmtBps(f.caps.managementFeeBps, 2)})` },
                  { label: "Performance fee", value: `${fmtBps(f.performanceFeeBps, 0)} of gains (cap ${fmtBps(f.caps.performanceFeeBps, 0)})` },
                  { label: "Withdrawal fee", value: `${fmtBps(f.withdrawalFeeBps, 2)} (cap ${fmtBps(f.caps.withdrawalFeeBps, 2)})` },
                  { label: "Management fees collected", value: fmtUsd(f.totalManagementFeesUsd) },
                  { label: "Performance fees collected", value: fmtUsd(f.totalPerformanceFeesUsd) },
                  { label: "Fee recipient", value: <span className="font-mono text-xs">{shortHex(f.feeRecipient)}</span> },
                  { label: "Recipient holdings", value: `${fmtNum(f.feeRecipientShares, 2)} sh · ${fmtUsd(f.feeRecipientValueUsd)}` },
                  { label: "Last accrual", value: `${fmtDateTime(f.lastAccrual)} (${fmtAgo(f.lastAccrual, f.blockTimestamp)})` },
                ]}
              />
            </div>
          );
        }}
      </Query>
    </Card>
  );
}

function FundingCard() {
  const funding = useFunding();
  return (
    <Card title="Funding income" subtitle="Perp funding settlements to the short">
      <Query query={funding} skeleton={<SkeletonRows rows={6} />}>
        {(f) => (
          <div className="space-y-4">
            <KV
              rows={[
                { label: "Settled", value: fmtUsd(f.settledFundingUsd, { sign: true }), tone: pnlTone(f.settledFundingUsd) },
                { label: "Pending", value: fmtUsd(f.pendingFundingUsd, { sign: true }), tone: pnlTone(f.pendingFundingUsd) },
                { label: "Cumulative", value: fmtUsd(f.cumulativeFundingUsd, { sign: true }), tone: pnlTone(f.cumulativeFundingUsd) },
                { label: "Current rate", value: `${fmtPct(f.ratePer8h, 4, true)} / 8h (${fmtPct(f.apr, 2, true)} APR)` },
                { label: "Short notional", value: fmtUsd(f.shortNotionalUsd, { digits: 0 }) },
                { label: "Run-rate income", value: `${fmtUsd(f.annualizedIncomeUsd, { digits: 0, sign: true })} / yr`, tone: pnlTone(f.annualizedIncomeUsd) },
              ]}
            />
            {f.settlements.length > 0 ? (
              <div className="max-h-56 overflow-auto rounded-md border border-line">
                <table className="table-dense">
                  <thead>
                    <tr>
                      <th>Settled</th>
                      <th className="num">Amount</th>
                      <th>Tx</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.settlements.slice(0, 25).map((s) => (
                      <tr key={`${s.txHash}-${s.ts}`}>
                        <td className="whitespace-nowrap text-xs text-ink-2">{fmtDateTime(s.ts)}</td>
                        <td className={cx("num", toneClass[pnlTone(s.amountUsd)])}>{fmtUsd(s.amountUsd, { sign: true })}</td>
                        <td className="whitespace-nowrap font-mono text-xs text-ink-2" title={s.txHash}>
                          {shortHex(s.txHash)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-muted">No settlement events indexed yet.</p>
            )}
          </div>
        )}
      </Query>
    </Card>
  );
}

export function PnlView() {
  const pnl = usePnl();
  return (
    <div className="space-y-5">
      <Query query={pnl} skeleton={<SkeletonRows rows={10} />}>
        {(p) => {
          const all = lines(p);
          const carry = all.filter((l) => l.group === "Carry").reduce((a, l) => a + l.value, 0);
          const hedge = all.filter((l) => l.group === "Hedge & spot").reduce((a, l) => a + l.value, 0);
          const costs = all.filter((l) => l.group === "Costs").reduce((a, l) => a + l.value, 0);
          const fees = all.filter((l) => l.group === "Vault fees").reduce((a, l) => a + l.value, 0);
          return (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                <Stat label="Carry income" value={fmtUsd(carry, { sign: true })} tone={pnlTone(carry)} sub="lending + funding" />
                <Stat label="Hedge & spot" value={fmtUsd(hedge, { sign: true })} tone={pnlTone(hedge)} sub="should net to ~0" />
                <Stat label="Trading costs" value={fmtUsd(costs, { sign: true })} tone={pnlTone(costs)} sub="fees + slippage + bad debt" />
                <Stat label="Strategy net" value={fmtUsd(p.strategyNetPnl, { sign: true })} tone={pnlTone(p.strategyNetPnl)} sub="before vault fees" />
                <Stat label="Vault fees" value={fmtUsd(fees, { sign: true })} tone={pnlTone(fees)} sub="management + performance" />
                <Stat label="Net after fees" value={fmtUsd(p.netPnlAfterFees, { sign: true })} tone={pnlTone(p.netPnlAfterFees)} sub={`${fmtPct(p.netPnlAfterFees / Math.max(p.netCapital, 1), 3, true)} on net capital`} />
              </div>

              <div className="grid gap-5 xl:grid-cols-5">
                <Card title="Attribution waterfall" subtitle="Each bar moves the running total; blue bars are subtotals" className="xl:col-span-3">
                  <Waterfall steps={waterfallSteps(p)} />
                </Card>
                <div className="space-y-5 xl:col-span-2">
                  <Reconciliation p={p} />
                  <Card title="Capital" subtitle="What the PnL is measured against">
                    <KV
                      rows={[
                        { label: "Net capital (deposits − withdrawals)", value: fmtUsd(p.netCapital) },
                        { label: "Strategy NAV", value: fmtUsd(p.strategyNav) },
                        { label: "Strategy net PnL", value: fmtUsd(p.strategyNetPnl, { sign: true }), tone: pnlTone(p.strategyNetPnl) },
                      ]}
                    />
                  </Card>
                </div>
              </div>

              <Card title="Attribution table" subtitle="Signed as each line hits NAV (USD)" flush>
                <div className="overflow-x-auto">
                  <table className="table-dense">
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th>Component</th>
                        <th className="num">USD</th>
                        <th className="num">% of strategy net</th>
                        <th>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {all.slice(0, 10).map((l) => (
                        <AttrRow key={l.label} line={l} base={p.strategyNetPnl} />
                      ))}
                      <tr className="font-semibold">
                        <td />
                        <td className="text-ink">Strategy net PnL</td>
                        <td className={cx("num", toneClass[pnlTone(p.strategyNetPnl)])}>{fmtUsd(p.strategyNetPnl, { sign: true })}</td>
                        <td className="num">100.0%</td>
                        <td className="text-xs text-muted">before vault fees</td>
                      </tr>
                      {all.slice(10).map((l) => (
                        <AttrRow key={l.label} line={l} base={p.strategyNetPnl} />
                      ))}
                      <tr className="font-semibold">
                        <td />
                        <td className="text-ink">Net PnL after fees</td>
                        <td className={cx("num", toneClass[pnlTone(p.netPnlAfterFees)])}>{fmtUsd(p.netPnlAfterFees, { sign: true })}</td>
                        <td className="num">{fmtPct(p.netPnlAfterFees / (p.strategyNetPnl || 1), 1)}</td>
                        <td className="text-xs text-muted">what depositors keep</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            </>
          );
        }}
      </Query>
      <div className="grid gap-5 xl:grid-cols-2">
        <FeesCard />
        <FundingCard />
      </div>
    </div>
  );
}

function AttrRow({ line, base }: { line: Line; base: number }) {
  return (
    <tr>
      <td className="whitespace-nowrap text-xs text-muted">{line.group}</td>
      <td className="text-ink">{line.label}</td>
      <td className={cx("num", toneClass[pnlTone(line.value, 0.005)])}>{fmtUsd(line.value, { sign: true })}</td>
      <td className="num text-ink-2">{base ? fmtPct(line.value / base, 1, true) : "—"}</td>
      <td className="text-xs text-muted">{line.note}</td>
    </tr>
  );
}
