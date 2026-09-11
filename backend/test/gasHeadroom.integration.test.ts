import { ANVIL_ACCOUNTS, deltaNeutralVaultAbi, mockAggregatorV3Abi, withGasHeadroom } from "@dnv/shared";
import { type Hex, type PublicClient, type WalletClient, createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { chainFor } from "../src/chain/clients";
import { loadConfig } from "../src/config";

/**
 * Guards GAS_HEADROOM_PCT against a real node. For each share operation the dashboard sends, the node's
 * estimate is taken right after a block that wrote the vault's accrual checkpoints (no time elapsed),
 * then the transaction is sent with estimate + headroom and lands exactly one second later - the race
 * that made a dashboard withdraw run out of gas in CI (docs/security.md, bug 10).
 *
 * A Foundry test cannot stand in for this: an internal `call{gas: g}` from a test contract does not
 * reproduce what eth_estimateGas returns for these paths (it reported withdraw as needing more than 30%;
 * a real node measures 8.3%).
 *
 * Every probe is undone with evm_snapshot / evm_revert and the chain is restored at the end, but the
 * transactions still pass through any indexer watching the chain, so this only runs on the throwaway
 * chain scripts/e2e.sh creates (E2E_DISPOSABLE_CHAIN=1).
 */
const run = process.env.INTEGRATION === "1" && process.env.E2E_DISPOSABLE_CHAIN === "1";

const ADMIN = ANVIL_ACCOUNTS[0]!.address as Hex; // owner of the mock price feeds
const USER = ANVIL_ACCOUNTS[6]!.address as Hex; // Carol: seeded, funded and approved by the replay

describe.skipIf(!run)("gas headroom against a real node", () => {
  let pc: PublicClient;
  let user: WalletClient;
  let admin: WalletClient;
  let vault: Hex;
  let feeds: Hex[];
  let root: unknown;

  const rpc = (method: string, params: unknown[] = []) =>
    pc.request({ method: method as never, params: params as never }) as Promise<unknown>;

  // Lazy, like the other integration suite: config reads the deployment file, which a skipped suite
  // on a fresh clone does not have.
  beforeAll(async () => {
    const cfg = loadConfig();
    const chain = chainFor(cfg);
    pc = createPublicClient({ chain, transport: http(cfg.RPC_URL) });
    user = createWalletClient({ account: USER, chain, transport: http(cfg.RPC_URL) });
    admin = createWalletClient({ account: ADMIN, chain, transport: http(cfg.RPC_URL) });
    vault = cfg.deployment.vault as Hex;
    feeds = [cfg.deployment.ethUsdFeed, cfg.deployment.ethUsdFallbackFeed] as Hex[];
    root = await rpc("evm_snapshot");
  });

  afterAll(async () => {
    if (root !== undefined) await rpc("evm_revert", [root]); // leave the chain exactly as found
  });

  /** A fresh oracle round plus a fee accrual: every checkpoint now carries the latest block's timestamp. */
  async function stampCheckpoints() {
    for (const feed of feeds) {
      const [, answer] = await pc.readContract({ address: feed, abi: mockAggregatorV3Abi, functionName: "latestRoundData" });
      const hash = await admin.writeContract({ address: feed, abi: mockAggregatorV3Abi, functionName: "setAnswer", args: [answer] } as never);
      await pc.waitForTransactionReceipt({ hash });
    }
    const hash = await user.writeContract({ address: vault, abi: deltaNeutralVaultAbi, functionName: "accrueFees" } as never);
    await pc.waitForTransactionReceipt({ hash });
  }

  /** Send with an explicit gas limit so the tx is mined at `timestamp`; report success; undo it. */
  async function landsAt(functionName: string, args: readonly unknown[], gas: bigint, timestamp: bigint): Promise<boolean> {
    const snap = await rpc("evm_snapshot");
    try {
      await rpc("evm_setNextBlockTimestamp", [Number(timestamp)]);
      const hash = await user.writeContract({ address: vault, abi: deltaNeutralVaultAbi, functionName, args, gas } as never);
      return (await pc.waitForTransactionReceipt({ hash })).status === "success";
    } catch {
      return false;
    } finally {
      await rpc("evm_revert", [snap]);
    }
  }

  const shares = (usd: string) =>
    pc.readContract({ address: vault, abi: deltaNeutralVaultAbi, functionName: "convertToShares", args: [parseUnits(usd, 6)] });

  const OPS: [string, () => Promise<readonly unknown[]>][] = [
    ["deposit", async () => [parseUnits("1000", 6), USER]],
    ["withdraw", async () => [parseUnits("500", 6), USER, USER]],
    ["redeem", async () => [await shares("500"), USER, USER]],
    ["redeemWithUnwind", async () => [await shares("2000"), USER, USER, 0n]],
  ];

  it.each(OPS)(
    "%s: estimate + headroom succeeds when it lands one second after the checkpoints",
    async (functionName, argsFor) => {
      const args = await argsFor();
      await stampCheckpoints();
      const { timestamp } = await pc.getBlock();
      const estimate = await pc.estimateContractGas({
        address: vault,
        abi: deltaNeutralVaultAbi,
        functionName: functionName as never,
        args: args as never,
        account: USER,
      });
      const bare = await landsAt(functionName, args, estimate, timestamp + 1n);
      expect(await landsAt(functionName, args, withGasHeadroom(estimate), timestamp + 1n)).toBe(true);
      // the hazard itself depends on what accrues, so it is reported rather than asserted
      console.info(`${functionName}: estimate ${estimate}; bare estimate one second later ${bare ? "succeeds" : "FAILS"}`);
    },
    30_000,
  );
});
