import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { SimulationView } from "./SimulationView";

export const metadata: Metadata = { title: "Simulation" };

export default function SimulationPage() {
  return (
    <>
      <PageHeader
        title="Simulation"
        description="Stress the strategy off-chain with the same planner the keeper runs: the A–J scenario catalogue with and without the keeper, a custom scenario builder, and a Monte Carlo backtester."
      />
      <SimulationView />
    </>
  );
}
