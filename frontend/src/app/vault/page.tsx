import type { Metadata } from "next";

import { PageHeader } from "@/components/layout/PageHeader";

import { VaultView } from "./VaultView";

export const metadata: Metadata = { title: "Vault" };

export default function VaultPage() {
  return (
    <>
      <PageHeader
        title="Vault"
        description="Deposit mock USDC for dnUSDC shares and exit again - via standard ERC-4626 withdraw / redeem from liquid assets, or redeemWithUnwind for larger exits. Local Anvil, no real funds."
      />
      <VaultView />
    </>
  );
}
