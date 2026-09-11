import {
  accessRegistryAbi,
  deltaNeutralVaultAbi,
  emergencyControllerAbi,
  feeManagerAbi,
  lendingAdapterAbi,
  mockAggregatorV3Abi,
  mockERC20Abi,
  mockLendingProtocolAbi,
  mockPerpetualMarketAbi,
  mockSpotDEXAbi,
  oracleManagerAbi,
  perpAdapterAbi,
  positionManagerAbi,
  rebalanceManagerAbi,
  riskManagerAbi,
  strategyManagerAbi,
  swapAdapterAbi,
  type Deployment,
} from "@dnv/shared";
import {
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  getContract,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Config } from "../config";

export function chainFor(cfg: Pick<Config, "CHAIN_ID" | "RPC_URL">): Chain {
  return defineChain({
    id: cfg.CHAIN_ID,
    name: cfg.CHAIN_ID === 31337 ? "Anvil" : `chain-${cfg.CHAIN_ID}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.RPC_URL] } },
  });
}

export type Wallet = WalletClient<Transport, Chain, Account>;

export interface Chain_ {
  publicClient: PublicClient<Transport, Chain>;
  wallet: (key: string) => Wallet;
  contracts: ReturnType<typeof bindContracts>;
  deployment: Deployment;
}

export function bindContracts(client: PublicClient<Transport, Chain>, d: Deployment) {
  const c = <A extends readonly unknown[]>(address: `0x${string}`, abi: A) => getContract({ address, abi, client });
  return {
    vault: c(d.vault, deltaNeutralVaultAbi),
    strategy: c(d.strategyManager, strategyManagerAbi),
    positionManager: c(d.positionManager, positionManagerAbi),
    riskManager: c(d.riskManager, riskManagerAbi),
    rebalanceManager: c(d.rebalanceManager, rebalanceManagerAbi),
    feeManager: c(d.feeManager, feeManagerAbi),
    oracle: c(d.oracleManager, oracleManagerAbi),
    emergency: c(d.emergencyController, emergencyControllerAbi),
    registry: c(d.accessRegistry, accessRegistryAbi),
    lendingAdapter: c(d.lendingAdapter, lendingAdapterAbi),
    perpAdapter: c(d.perpAdapter, perpAdapterAbi),
    swapAdapter: c(d.swapAdapter, swapAdapterAbi),
    usdc: c(d.usdc, mockERC20Abi),
    weth: c(d.weth, mockERC20Abi),
    feed: c(d.ethUsdFeed, mockAggregatorV3Abi),
    fallbackFeed: c(d.ethUsdFallbackFeed, mockAggregatorV3Abi),
    lendingPool: c(d.lendingPool, mockLendingProtocolAbi),
    perp: c(d.perpMarket, mockPerpetualMarketAbi),
    dex: c(d.spotDex, mockSpotDEXAbi),
  };
}

export function createChain(cfg: Config): Chain_ {
  const chain = chainFor(cfg);
  // JSON-RPC batching: the ~40 view calls behind a state read go out as a handful of HTTP requests
  const transport = http(cfg.RPC_URL, { batch: { batchSize: 64, wait: 5 }, retryCount: 2 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: 250 });
  const wallets = new Map<string, Wallet>();
  return {
    publicClient,
    deployment: cfg.deployment,
    contracts: bindContracts(publicClient, cfg.deployment),
    wallet: (key: string) => {
      let w = wallets.get(key);
      if (!w) {
        w = createWalletClient({ account: privateKeyToAccount(key as Hex), chain, transport: http(cfg.RPC_URL) });
        wallets.set(key, w);
      }
      return w;
    },
  };
}

/** Anvil-only helpers used by the market driver and the demo. */
export async function anvilIncreaseTime(client: PublicClient, seconds: number): Promise<void> {
  await client.request({ method: "evm_increaseTime" as never, params: [seconds] as never });
  await client.request({ method: "evm_mine" as never, params: [] as never });
}
