import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { TransactionsView } from "./TransactionsView";

export const metadata: Metadata = { title: "Transactions" };

export default function TransactionsPage() {
  return (
    <>
      <PageHeader title="Transactions" description="Every deposit into and withdrawal from the vault, as indexed from on-chain ERC-4626 events. Times are chain time." />
      <TransactionsView />
    </>
  );
}
