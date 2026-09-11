import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { StrategyView } from "./StrategyView";

export const metadata: Metadata = { title: "Strategy" };

export default function StrategyPage() {
  return (
    <>
      <PageHeader
        title="Strategy"
        description="Live on-chain targets and rebalance parameters, the volatility-scaled leverage the keeper actually aims for, a forward APY estimate, and what the optimizer would change."
      />
      <StrategyView />
    </>
  );
}
