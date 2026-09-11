import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { RiskView } from "./RiskView";

export const metadata: Metadata = { title: "Risk" };

export default function RiskPage() {
  return (
    <>
      <PageHeader
        title="Risk"
        description="The on-chain risk engine scores leverage, delta, drawdown, liquidation distance, collateral, funding and venue exposure against warn / high / critical thresholds; oracle health and circuit breakers gate every trade."
      />
      <RiskView />
    </>
  );
}
