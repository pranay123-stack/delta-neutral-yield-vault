/** Shape of `deployments/<chainId>.json` written by script/Deploy.s.sol. */
export interface Deployment {
  chainId: number;
  startBlock: number;
  admin: `0x${string}`;
  guardian: `0x${string}`;
  keeper: `0x${string}`;
  strategist: `0x${string}`;
  feeRecipient: `0x${string}`;
  accessRegistry: `0x${string}`;
  usdc: `0x${string}`;
  weth: `0x${string}`;
  ethUsdFeed: `0x${string}`;
  ethUsdFallbackFeed: `0x${string}`;
  lendingPool: `0x${string}`;
  perpMarket: `0x${string}`;
  spotDex: `0x${string}`;
  oracleManager: `0x${string}`;
  feeManager: `0x${string}`;
  emergencyController: `0x${string}`;
  vault: `0x${string}`;
  strategyManager: `0x${string}`;
  lendingAdapter: `0x${string}`;
  perpAdapter: `0x${string}`;
  swapAdapter: `0x${string}`;
  positionManager: `0x${string}`;
  riskManager: `0x${string}`;
  rebalanceManager: `0x${string}`;
}

/** Anvil's public dev accounts. Local chain only - these keys are published by Foundry. */
export const ANVIL_ACCOUNTS = [
  { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", key: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", role: "admin / market simulator" },
  { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", key: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", role: "keeper + strategist" },
  { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", key: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", role: "guardian" },
  { address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", key: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", role: "fee recipient" },
  { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", key: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", role: "demo user (Alice)" },
  { address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", key: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", role: "demo user (Bob)" },
  { address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", key: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", role: "demo user (Carol)" },
] as const;
