import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { PnlView } from "./PnlView";

export const metadata: Metadata = { title: "PnL attribution" };

export default function PnlPage() {
  return (
    <>
      <PageHeader
        title="PnL attribution"
        description="Where the return comes from: carry (lending + funding), hedge and spot legs that should offset, trading costs, and vault fees - reconciled against NAV."
      />
      <PnlView />
    </>
  );
}
