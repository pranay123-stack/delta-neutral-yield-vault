import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { PositionsView } from "./PositionsView";

export const metadata: Metadata = { title: "Positions" };

export default function PositionsPage() {
  return (
    <>
      <PageHeader title="Positions" description="Every leg of the book, read live from the adapters: USDC reserve, WETH long, ETH perp short, plus liquidation distance and hedge state." />
      <PositionsView />
    </>
  );
}
