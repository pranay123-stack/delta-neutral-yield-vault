import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { PerformanceView } from "./PerformanceView";

export const metadata: Metadata = { title: "Performance" };

export default function PerformancePage() {
  return (
    <>
      <PageHeader
        title="Performance"
        description="Indexed 6-hourly snapshots of the vault. The x-axis is chain time: the demo warps the local chain to build 90 days of history."
      />
      <PerformanceView />
    </>
  );
}
