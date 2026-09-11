import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { OverviewView } from "./OverviewView";

// the layout's title template doesn't apply to a page in the layout's own segment
export const metadata: Metadata = { title: { absolute: "Overview · Delta-Neutral Vault" } };

export default function OverviewPage() {
  return (
    <>
      <PageHeader
        title="Overview"
        description="Delta-neutral basis carry: USDC reserve + WETH supplied to a lending market, hedged with an ETH perp short. Yield = lending + funding, minus hedge costs."
      />
      <OverviewView />
    </>
  );
}
