import { ANVIL_ACCOUNTS } from "@dnv/shared";

/**
 * Anvil demo users. These keys are Foundry's published dev keys; Anvil keeps the accounts unlocked,
 * so eth_sendTransaction from them works with no wallet extension at all.
 */
export const DEMO_WALLETS = [
  { key: "alice", label: "Alice", address: ANVIL_ACCOUNTS[4].address },
  { key: "bob", label: "Bob", address: ANVIL_ACCOUNTS[5].address },
  { key: "carol", label: "Carol", address: ANVIL_ACCOUNTS[6].address },
] as const;

export type DemoWallet = (typeof DEMO_WALLETS)[number];

const KNOWN: Record<string, string> = {
  [ANVIL_ACCOUNTS[0].address.toLowerCase()]: "Admin",
  [ANVIL_ACCOUNTS[1].address.toLowerCase()]: "Keeper",
  [ANVIL_ACCOUNTS[2].address.toLowerCase()]: "Guardian",
  [ANVIL_ACCOUNTS[3].address.toLowerCase()]: "Fee recipient",
  ...Object.fromEntries(DEMO_WALLETS.map((w) => [w.address.toLowerCase(), w.label])),
};

/** Friendly label for known Anvil accounts (Alice / Bob / Carol / Admin ...). */
export function accountLabel(address: string | null | undefined): string | null {
  if (!address) return null;
  return KNOWN[address.toLowerCase()] ?? null;
}

export const demoConnectorId = (key: DemoWallet["key"]) => `demo-${key}`;
