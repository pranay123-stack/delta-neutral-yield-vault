import type { Logger } from "pino";
import type { Hex } from "viem";

import type { Chain_ } from "./chain/clients";
import { recordKeeperRun } from "./db/repo";
import type { Db } from "./db/pool";
import { withGasHeadroom } from "@dnv/shared";

export interface KeeperTickResult {
  actions: string[];
  rebalanced: boolean;
  errors: string[];
}

const FEE_ACCRUAL_INTERVAL = 24 * 3600;
const VOL_OBSERVATION_INTERVAL = 3600;

/**
 * Centralised demo keeper. Every tick:
 *   1. poke the oracle (records last-good price)          - permissionless
 *   2. observe volatility when an observation is due      - KEEPER
 *   3. crystallise vault fees once per (chain) day        - permissionless
 *   4. checkpoint the risk engine (may trip the breaker)  - KEEPER
 *   5. checkUpkeep -> performUpkeep                        - KEEPER
 * It decides nothing itself: `checkUpkeep` is computed on-chain, and `performUpkeep` recomputes the plan,
 * so swapping this process for Chainlink Automation / Gelato changes who calls, not what happens.
 * Each call is simulated first so a would-revert never costs gas.
 */
export class Keeper {
  constructor(
    private readonly chain: Chain_,
    private readonly db: Db | null,
    private readonly keeperKey: string,
    private readonly log?: Logger,
  ) {}

  private get wallet() {
    return this.chain.wallet(this.keeperKey);
  }

  async tick(): Promise<KeeperTickResult> {
    const c = this.chain.contracts;
    const d = this.chain.deployment;
    const res: KeeperTickResult = { actions: [], rebalanced: false, errors: [] };
    const block = await this.chain.publicClient.getBlock();
    const now = Number(block.timestamp);

    await this.send("oracle.poke", res, now, () =>
      this.write({ address: d.oracleManager, abi: c.oracle.abi, functionName: "poke", args: [d.weth] }),
    );

    const lastObs = Number(await c.rebalanceManager.read.lastObservedAt());
    if (now - lastObs >= VOL_OBSERVATION_INTERVAL) {
      await this.send("rebalancer.observeVolatility", res, now, () =>
        this.write({ address: d.rebalanceManager, abi: c.rebalanceManager.abi, functionName: "observeVolatility" }),
      );
    }

    const lastAccrual = Number(await c.feeManager.read.lastAccrual());
    if (now - lastAccrual >= FEE_ACCRUAL_INTERVAL) {
      await this.send("vault.accrueFees", res, now, () =>
        this.write({ address: d.vault, abi: c.vault.abi, functionName: "accrueFees" }),
      );
    }

    await this.send("risk.checkpoint", res, now, () =>
      this.write({ address: d.riskManager, abi: c.riskManager.abi, functionName: "checkpoint" }),
    );

    const [needed] = await c.rebalanceManager.read.checkUpkeep(["0x"]);
    if (needed) {
      const ok = await this.send("rebalancer.performUpkeep", res, now, () =>
        this.write({ address: d.rebalanceManager, abi: c.rebalanceManager.abi, functionName: "performUpkeep", args: ["0x"] }),
      );
      res.rebalanced = ok;
    }
    return res;
  }

  private async write(req: { address: Hex; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }) {
    const pc = this.chain.publicClient;
    // simulate first: surfaces the revert reason and never wastes gas on a doomed tx
    const { request } = await pc.simulateContract({ ...(req as object), account: this.wallet.account } as never);
    // Gas depends on block.timestamp (interest/funding accrual short-circuit when dt == 0, as they do
    // inside an estimate but not in the next mined block), so send with a 30% buffer over the estimate.
    const estimate = await pc.estimateContractGas({ ...(req as object), account: this.wallet.account } as never);
    const hash = await this.wallet.writeContract({ ...(request as object), gas: withGasHeadroom(estimate) } as never);
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${req.functionName} reverted`);
    return receipt;
  }

  private async send(
    action: string,
    res: KeeperTickResult,
    now: number,
    fn: () => Promise<{ transactionHash: Hex; gasUsed: bigint }>,
  ): Promise<boolean> {
    try {
      const r = await fn();
      res.actions.push(action);
      if (this.db) await recordKeeperRun(this.db, { ts: now, action, txHash: r.transactionHash, gasUsed: r.gasUsed, success: true });
      this.log?.debug({ action, gas: r.gasUsed.toString() }, "keeper action");
      return true;
    } catch (e) {
      const msg = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message : String(e);
      res.errors.push(`${action}: ${msg}`);
      if (this.db) await recordKeeperRun(this.db, { ts: now, action, success: false, error: msg.slice(0, 500) });
      this.log?.warn({ action, err: msg }, "keeper action failed");
      return false;
    }
  }
}
