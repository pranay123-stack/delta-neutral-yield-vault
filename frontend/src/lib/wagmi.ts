import { defineChain } from "viem";
import { type CreateConnectorFn, createConfig, http, injected, mock } from "wagmi";

import { DEMO_WALLETS, type DemoWallet, demoConnectorId } from "./demo";
import { CHAIN_ID, RPC_URL } from "./env";

export const anvil = defineChain({
  id: CHAIN_ID,
  name: "Anvil (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

/**
 * One wagmi `mock` connector per demo user. The mock connector forwards eth_sendTransaction to the
 * chain RPC, and Anvil signs for its unlocked dev accounts - so the demo needs no wallet extension.
 * Each gets a distinct id/name so the picker (and our reconnect memory) can tell them apart.
 */
function demoConnector(wallet: DemoWallet): CreateConnectorFn {
  const base = mock({ accounts: [wallet.address], features: { reconnect: true } });
  return (config) => ({ ...base(config), id: demoConnectorId(wallet.key), name: `Demo · ${wallet.label}` });
}

export const wagmiConfig = createConfig({
  chains: [anvil],
  connectors: [injected({ shimDisconnect: true }), ...DEMO_WALLETS.map(demoConnector)],
  transports: { [anvil.id]: http(RPC_URL) },
  // one generic "Browser wallet" entry instead of one per EIP-6963 announcement
  multiInjectedProviderDiscovery: false,
  pollingInterval: 2_000,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

const STORAGE_KEY = "dnv.wallet";

/** Remember the last demo wallet so a page reload reconnects it (mock connectors keep no session). */
export function rememberConnector(id: string | null) {
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function rememberedConnector(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}
