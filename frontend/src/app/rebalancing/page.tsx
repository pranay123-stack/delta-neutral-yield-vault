import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { RebalancingView } from "./RebalancingView";

export const metadata: Metadata = { title: "Rebalancing" };

export default function RebalancingPage() {
  return (
    <>
      <PageHeader
        title="Rebalancing"
        description="Every rebalance the keeper executed through the RebalanceManager: what triggered it, how it moved each leg, and what it cost versus the estimate."
      />
      <RebalancingView />
    </>
  );
}
