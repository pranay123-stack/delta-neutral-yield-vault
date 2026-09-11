import {
  deltaNeutralVaultAbi,
  emergencyControllerAbi,
  feeManagerAbi,
  fromFixed,
  mockPerpetualMarketAbi,
  oracleManagerAbi,
  price,
  rebalanceManagerAbi,
  RISK_STATES,
  riskManagerAbi,
  strategyManagerAbi,
  usd,
} from "@dnv/shared";
import type { Log } from "viem";

import type { Chain_ } from "./chain/clients";
import type { Db } from "./db/pool";

const CHUNK = 2_000n;
const jsonSafe = (v: unknown) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x)));

type DecodedLog = Log & { eventName: string; args: Record<string, unknown> };

/**
 * Pull-based event indexer. Each tick processes [lastBlock+1, head] in chunks, decodes logs from
 * every protocol contract, and writes idempotently (UNIQUE(tx_hash, log_index)), so re-running a range
 * after a crash never double counts.
 */
export class Indexer {
  private blockTs = new Map<bigint, number>();

  constructor(
    private readonly chain: Chain_,
    private readonly db: Db,
  ) {}

  async lastBlock(): Promise<bigint> {
    const r = await this.db.query("SELECT last_block FROM indexer_state WHERE id = 1");
    return r.rows[0] ? BigInt(r.rows[0].last_block) : BigInt(this.chain.deployment.startBlock) - 1n;
  }

  private async setLastBlock(b: bigint) {
    await this.db.query(
      "INSERT INTO indexer_state (id, last_block) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET last_block = $1, updated_at = now()",
      [b.toString()],
    );
  }

  /** Index up to the current head. Returns the number of logs written. */
  async sync(): Promise<number> {
    const head = await this.chain.publicClient.getBlockNumber();
    let from = (await this.lastBlock()) + 1n;
    let written = 0;
    while (from <= head) {
      const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
      written += await this.indexRange(from, to);
      await this.setLastBlock(to);
      from = to + 1n;
    }
    return written;
  }

  private async ts(blockNumber: bigint): Promise<number> {
    let t = this.blockTs.get(blockNumber);
    if (t === undefined) {
      const b = await this.chain.publicClient.getBlock({ blockNumber });
      t = Number(b.timestamp);
      this.blockTs.set(blockNumber, t);
      if (this.blockTs.size > 50_000) this.blockTs.clear();
    }
    return t;
  }

  private async indexRange(fromBlock: bigint, toBlock: bigint): Promise<number> {
    const d = this.chain.deployment;
    const pc = this.chain.publicClient;
    const range = { fromBlock, toBlock };
    const [vaultLogs, rebalLogs, perpLogs, riskLogs, emergencyLogs, feeLogs, strategyLogs, oracleLogs] = await Promise.all([
      pc.getContractEvents({ address: d.vault, abi: deltaNeutralVaultAbi, ...range }),
      pc.getContractEvents({ address: d.rebalanceManager, abi: rebalanceManagerAbi, eventName: "Rebalanced", ...range }),
      pc.getContractEvents({ address: d.perpMarket, abi: mockPerpetualMarketAbi, ...range }),
      pc.getContractEvents({ address: d.riskManager, abi: riskManagerAbi, ...range }),
      pc.getContractEvents({ address: d.emergencyController, abi: emergencyControllerAbi, ...range }),
      pc.getContractEvents({ address: d.feeManager, abi: feeManagerAbi, eventName: "FeesAccrued", ...range }),
      pc.getContractEvents({ address: d.strategyManager, abi: strategyManagerAbi, ...range }),
      pc.getContractEvents({ address: d.oracleManager, abi: oracleManagerAbi, eventName: "OracleShutdown", ...range }),
    ]);
    let n = 0;
    // RedeemWithUnwind is emitted right after the matching Withdraw in the same tx
    const unwindTxs = new Set((vaultLogs as DecodedLog[]).filter((l) => l.eventName === "RedeemWithUnwind").map((l) => l.transactionHash));

    for (const l of vaultLogs as DecodedLog[]) {
      const a = l.args;
      const base = [l.blockNumber!.toString(), l.logIndex!, l.transactionHash!, await this.ts(l.blockNumber!)];
      if (l.eventName === "Deposit") {
        await this.db.query(
          `INSERT INTO deposits (block_number, log_index, tx_hash, ts, sender, owner, assets_usd, shares)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
          [...base, a.sender, a.owner, usd(a.assets as bigint), fromFixed(a.shares as bigint, 12)],
        );
        n++;
      } else if (l.eventName === "Withdraw") {
        await this.db.query(
          `INSERT INTO withdrawals (block_number, log_index, tx_hash, ts, sender, receiver, owner, assets_usd, shares, via_unwind)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
          [...base, a.sender, a.receiver, a.owner, usd(a.assets as bigint), fromFixed(a.shares as bigint, 12), unwindTxs.has(l.transactionHash)],
        );
        n++;
      }
    }

    for (const l of rebalLogs as DecodedLog[]) {
      const id = l.args.id as bigint;
      const r = l.args.record as Record<string, bigint | number | boolean>;
      await this.db.query(
        `INSERT INTO rebalances (id, block_number, tx_hash, ts, triggers, urgent, long_usd_delta, margin_delta, perp_size_change,
          pre_delta_bps, post_delta_bps, pre_leverage_bps, post_leverage_bps, estimated_cost_usd, realized_cost_usd)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
        [
          id.toString(), l.blockNumber!.toString(), l.transactionHash, await this.ts(l.blockNumber!),
          Number(r.triggers), r.urgent, usd(r.longUsdDelta as bigint), usd(r.marginDelta as bigint),
          fromFixed(r.perpSizeChange as bigint, 18), Number(r.preDeltaBps), Number(r.postDeltaBps),
          capBps(r.preLeverageBps as bigint), capBps(r.postLeverageBps as bigint), usd(r.estimatedCost as bigint), usd(r.realizedCost as bigint),
        ],
      );
      n++;
    }

    const account = d.perpAdapter.toLowerCase();
    for (const l of perpLogs as DecodedLog[]) {
      if (String(l.args.account ?? "").toLowerCase() !== account) continue;
      const ts = await this.ts(l.blockNumber!);
      if (l.eventName === "FundingSettled") {
        await this.db.query(
          `INSERT INTO funding_payments (block_number, log_index, tx_hash, ts, amount_usd, funding_index)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [l.blockNumber!.toString(), l.logIndex, l.transactionHash, ts, usd(l.args.fundingPnl as bigint), fromFixed(l.args.fundingIndex as bigint, 18)],
        );
        n++;
      } else if (l.eventName === "Liquidated" || l.eventName === "AutoDeleveraged") {
        await this.riskEvent(l, ts, l.eventName === "Liquidated" ? "PERP_LIQUIDATED" : "PERP_ADL", null, null, null, {
          ...jsonSafe(l.args),
          ...(l.args.markPrice ? { markPriceUsd: price(l.args.markPrice as bigint) } : {}),
        });
        n++;
      }
    }

    for (const l of riskLogs as DecodedLog[]) {
      const ts = await this.ts(l.blockNumber!);
      if (l.eventName === "RiskStateChanged") {
        await this.riskEvent(l, ts, "RISK_STATE_CHANGED", RISK_STATES[Number(l.args.previous)]!, RISK_STATES[Number(l.args.current)]!, Number(l.args.flags), {});
        n++;
      } else if (l.eventName === "PeakSharePriceUpdated") {
        // high-frequency and derivable from snapshots: not stored as an event
      } else if (l.eventName === "RiskConfigUpdated") {
        await this.riskEvent(l, ts, "RISK_CONFIG_UPDATED", null, null, null, {});
        n++;
      }
    }

    for (const l of emergencyLogs as DecodedLog[]) {
      const ts = await this.ts(l.blockNumber!);
      const kind = {
        DepositsPaused: "DEPOSITS_PAUSED",
        DepositsUnpaused: "DEPOSITS_UNPAUSED",
        StrategyPaused: "STRATEGY_PAUSED",
        StrategyUnpaused: "STRATEGY_UNPAUSED",
        EmergencyUnwind: "EMERGENCY_UNWIND",
      }[l.eventName];
      if (!kind) continue;
      await this.riskEvent(l, ts, kind, null, null, null, jsonSafe(l.args));
      n++;
    }

    for (const l of feeLogs as DecodedLog[]) {
      await this.db.query(
        `INSERT INTO fee_accruals (block_number, log_index, tx_hash, ts, management_usd, performance_usd, high_water_mark)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [
          l.blockNumber!.toString(), l.logIndex, l.transactionHash, await this.ts(l.blockNumber!),
          usd(l.args.managementAssets as bigint), usd(l.args.performanceAssets as bigint), fromFixed((l.args.highWaterMark as bigint) * 1_000_000n, 18),
        ],
      );
      n++;
    }

    for (const l of strategyLogs as DecodedLog[]) {
      if (l.eventName !== "PnlCrystallized" && l.eventName !== "EmergencyStepFailed" && l.eventName !== "EmergencyUnwound") continue;
      await this.riskEvent(l, await this.ts(l.blockNumber!), l.eventName === "PnlCrystallized" ? "PNL_CRYSTALLIZED" : l.eventName === "EmergencyUnwound" ? "EMERGENCY_UNWOUND" : "EMERGENCY_STEP_FAILED", null, null, null, jsonSafe(l.args));
      n++;
    }

    for (const l of oracleLogs as DecodedLog[]) {
      await this.riskEvent(l, await this.ts(l.blockNumber!), l.args.shutdown ? "ORACLE_SHUTDOWN" : "ORACLE_RESTORED", null, null, null, {});
      n++;
    }
    return n;
  }

  private async riskEvent(
    l: DecodedLog,
    ts: number,
    kind: string,
    prev: string | null,
    next: string | null,
    flags: number | null,
    details: unknown,
  ) {
    await this.db.query(
      `INSERT INTO risk_events (block_number, log_index, tx_hash, ts, kind, previous_state, new_state, flags, details)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
      [l.blockNumber!.toString(), l.logIndex, l.transactionHash, ts, kind, prev, next, flags, JSON.stringify(details)],
    );
  }
}

/** uint256.max leverage (equity 0) is stored as 999x so the column stays numeric. */
function capBps(v: bigint): number {
  return v > 9_990_000n ? 9_990_000 : Number(v);
}
