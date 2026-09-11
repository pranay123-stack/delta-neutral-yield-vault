"use client";

import type { TransactionView } from "@dnv/shared";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Query, Skeleton, SkeletonRows } from "@/components/ui/QueryState";
import { Segmented } from "@/components/ui/Segmented";
import { Stat } from "@/components/ui/Stat";
import { accountLabel } from "@/lib/demo";
import { fmtDateTime, fmtNum, fmtUsd, pnlTone, shortHex } from "@/lib/format";
import { useTransactions } from "@/lib/queries";

type Filter = "ALL" | TransactionView["kind"];

export function AddressCell({ address }: { address: string }) {
  const label = accountLabel(address);
  return (
    <span className="whitespace-nowrap" title={address}>
      {label && <span className="mr-1.5 font-medium text-ink">{label}</span>}
      <span className="font-mono text-xs text-ink-2">{shortHex(address)}</span>
    </span>
  );
}

export function TransactionsTable({ list, compact }: { list: TransactionView[]; compact?: boolean }) {
  return (
    <div className="max-h-[640px] overflow-auto">
      <table className="table-dense">
        <thead>
          <tr>
            <th>Kind</th>
            <th>Time (chain)</th>
            <th>Owner</th>
            <th className="num">Assets</th>
            <th className="num">Shares</th>
            {!compact && <th className="num">Price / share</th>}
            {!compact && <th className="num">Block</th>}
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {list.map((t) => (
            <tr key={t.id}>
              <td>
                <Badge level={t.kind === "DEPOSIT" ? "info" : "neutral"}>{t.kind === "DEPOSIT" ? "Deposit" : "Withdraw"}</Badge>
              </td>
              <td className="whitespace-nowrap text-xs text-ink-2">{fmtDateTime(t.ts)}</td>
              <td>
                <AddressCell address={t.owner} />
                {t.receiver && t.receiver.toLowerCase() !== t.owner.toLowerCase() && (
                  <div className="text-[0.68rem] text-muted">→ receiver {shortHex(t.receiver)}</div>
                )}
              </td>
              <td className="num text-ink">{fmtUsd(t.assetsUsd)}</td>
              <td className="num">{fmtNum(t.shares, 4)}</td>
              {!compact && <td className="num text-ink-2">{t.shares > 0 ? (t.assetsUsd / t.shares).toFixed(6) : "—"}</td>}
              {!compact && <td className="num text-ink-2">{t.blockNumber}</td>}
              <td className="whitespace-nowrap font-mono text-xs text-ink-2" title={t.txHash}>
                {shortHex(t.txHash)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TransactionsView() {
  const txs = useTransactions();
  const [filter, setFilter] = useState<Filter>("ALL");
  const sorted = useMemo(() => (txs.data ? [...txs.data].sort((a, b) => b.ts - a.ts || b.id - a.id) : []), [txs.data]);
  const shown = filter === "ALL" ? sorted : sorted.filter((t) => t.kind === filter);

  const deposits = sorted.filter((t) => t.kind === "DEPOSIT");
  const withdrawals = sorted.filter((t) => t.kind === "WITHDRAW");
  const depUsd = deposits.reduce((a, t) => a + t.assetsUsd, 0);
  const wdUsd = withdrawals.reduce((a, t) => a + t.assetsUsd, 0);
  const owners = new Set(sorted.map((t) => t.owner.toLowerCase())).size;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {txs.data ? (
          <>
            <Stat label="Deposits" value={fmtUsd(depUsd, { digits: 0 })} sub={`${deposits.length} transactions`} />
            <Stat label="Withdrawals" value={fmtUsd(wdUsd, { digits: 0 })} sub={`${withdrawals.length} transactions`} />
            <Stat label="Net flows" value={fmtUsd(depUsd - wdUsd, { digits: 0, sign: true })} tone={pnlTone(depUsd - wdUsd)} sub="deposits − withdrawals" />
            <Stat label="Depositors" value={String(owners)} sub="unique owners" />
          </>
        ) : (
          Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[78px]" />)
        )}
      </div>
      <Card
        title="Deposits & withdrawals"
        subtitle="Indexed ERC-4626 Deposit / Withdraw events (redeemWithUnwind exits appear as withdrawals)"
        action={
          <Segmented
            ariaLabel="Filter by kind"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "ALL", label: "All" },
              { value: "DEPOSIT", label: "Deposits" },
              { value: "WITHDRAW", label: "Withdrawals" },
            ]}
          />
        }
        flush
      >
        <Query query={txs} skeleton={<div className="p-4"><SkeletonRows rows={8} /></div>} isEmpty={(l) => l.length === 0} empty="No deposits or withdrawals indexed yet. Use the Vault page to make one.">
          {() => (shown.length ? <TransactionsTable list={shown} /> : <p className="px-4 py-6 text-center text-xs text-muted">No {filter === "DEPOSIT" ? "deposits" : "withdrawals"} yet.</p>)}
        </Query>
      </Card>
    </div>
  );
}
