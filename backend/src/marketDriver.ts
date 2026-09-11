import { ANVIL_ACCOUNTS, toFixed } from "@dnv/shared";
import { Rng, generateMarketPath } from "@dnv/simulator";
import type { Logger } from "pino";
import { type Hex, maxUint256 } from "viem";

import { type Chain_, anvilIncreaseTime } from "./chain/clients";
import { readRawState } from "./chain/reader";
import { evaluateAlerts, syncAlerts } from "./alerts";
import type { Config } from "./config";
import { insertSnapshot } from "./db/repo";
import type { Db } from "./db/pool";
import type { Indexer } from "./indexer";
import type { Keeper } from "./keeper";
import { toSnapshotRow } from "./snapshot";
import { deltaView, positionsView, riskView, strategyView } from "./views";

export interface DriverOptions {
  days: number;
  stepHours: number;
  seed: number;
  userFlows: boolean;
  log?: Logger;
}

const USERS = [ANVIL_ACCOUNTS[4], ANVIL_ACCOUNTS[5], ANVIL_ACCOUNTS[6]];

/**
 * Replays a synthetic market on the local chain so the dashboard's history is produced by the real
 * contracts: every step warps chain time, publishes new oracle rounds, moves funding and lending
 * utilisation, lets demo users deposit/withdraw, runs one keeper tick and snapshots the state.
 * Local Anvil only (uses evm_increaseTime and the mock markets' simulator role).
 */
export async function runMarketDriver(
  cfg: Config,
  chain: Chain_,
  db: Db,
  keeper: Keeper,
  indexer: Indexer,
  o: DriverOptions,
): Promise<{ steps: number; rebalances: number }> {
  const c = chain.contracts;
  const d = chain.deployment;
  const sim = chain.wallet(cfg.SIMULATOR_PRIVATE_KEY);
  const pc = chain.publicClient;
  const rng = new Rng(o.seed ^ 0x5eed);
  const [, answer] = await c.feed.read.latestRoundData();
  const startBlock = await pc.getBlock();
  const path = generateMarketPath({
    seed: o.seed,
    days: o.days,
    stepSec: o.stepHours * 3600,
    startPrice: Number(answer) / 1e8,
    startTime: Number(startBlock.timestamp),
  });

  const send = async (address: Hex, abi: readonly unknown[], functionName: string, args: readonly unknown[], key = cfg.SIMULATOR_PRIVATE_KEY) => {
    const w = key === cfg.SIMULATOR_PRIVATE_KEY ? sim : chain.wallet(key);
    const call = { address, abi: abi as never, functionName: functionName as never, args: args as never, account: w.account };
    // 30% gas buffer: accrual code paths make gas depend on the next block's timestamp
    const gas = ((await pc.estimateContractGas(call as never)) * 13n) / 10n;
    // Anvil automines: the tx is final when the hash comes back
    return w.writeContract({ ...call, gas, chain: w.chain } as never);
  };

  if (o.userFlows) {
    const empty = (await c.vault.read.totalSupply()) === 0n;
    const seed = [150_000, 75_000, 25_000];
    for (const [k, u] of USERS.entries()) {
      await send(d.usdc, c.usdc.abi, "faucet", [1_000_000_000_000n], u.key);
      await send(d.usdc, c.usdc.abi, "approve", [d.vault, maxUint256], u.key);
      // an empty vault gets initial depositors so the replay starts from a deployed book
      if (empty) await send(d.vault, c.vault.abi, "deposit", [toFixed(seed[k]!, 6), u.address], u.key);
    }
  }

  let rebalances = 0;
  for (let i = 1; i < path.length; i++) {
    const m = path[i]!;
    await anvilIncreaseTime(pc, o.stepHours * 3600);
    const p8 = toFixed(m.price, 8);
    await send(d.ethUsdFeed, c.feed.abi, "setAnswer", [p8]);
    await send(d.ethUsdFallbackFeed, c.fallbackFeed.abi, "setAnswer", [p8]);
    await send(d.perpMarket, c.perp.abi, "setFundingRate", [toFixed(m.fundingRatePer8h, 18)]);
    await send(d.lendingPool, c.lendingPool.abi, "setUtilization", [d.usdc, toFixed(m.usdcUtilization, 18)]);
    await send(d.lendingPool, c.lendingPool.abi, "setUtilization", [d.weth, toFixed(m.wethUtilization, 18)]);

    if (o.userFlows) {
      // A demo user's deposit/withdrawal is not worth killing a multi-minute replay over: log and skip.
      try {
        await userFlow(i, rng, c, d, send);
      } catch (err) {
        o.log?.warn({ err, step: i }, "user flow skipped");
      }
    }

    const tick = await keeper.tick();
    if (tick.rebalanced) rebalances++;

    const state = await readRawState(chain);
    await insertSnapshot(db, toSnapshotRow(state));
    if (i % 4 === 0 || tick.rebalanced) {
      await indexer.sync();
      await syncAlerts(
        db,
        evaluateAlerts({
          risk: riskView(state, cfg.CHAIN_ID),
          delta: deltaView(state, cfg.CHAIN_ID),
          positions: positionsView(state, cfg.CHAIN_ID),
          strategy: strategyView(state, cfg.CHAIN_ID),
          nowTs: Number(state.timestamp),
        }),
        Number(state.timestamp),
      );
    }
    if (o.log && i % 20 === 0) {
      o.log.info({ step: i, of: path.length - 1, day: ((i * o.stepHours) / 24).toFixed(1), eth: m.price.toFixed(0), rebalances }, "market driver");
    }
  }
  await indexer.sync();
  return { steps: path.length - 1, rebalances };
}

/** Occasional deposits and withdrawals by three demo users, so the history has real flows. */
async function userFlow(
  step: number,
  rng: Rng,
  c: Chain_["contracts"],
  d: Chain_["deployment"],
  send: (address: Hex, abi: readonly unknown[], fn: string, args: readonly unknown[], key?: string) => Promise<Hex>,
) {
  const roll = rng.next();
  const user = USERS[Math.floor(rng.next() * USERS.length)]!;
  if (roll < 0.07) {
    const amount = toFixed(5_000 + Math.floor(rng.next() * 45_000), 6);
    const max = await c.vault.read.maxDeposit([user.address]);
    if (max >= amount) await send(d.vault, c.vault.abi, "deposit", [amount, user.address], user.key);
  } else if (roll < 0.1 && step > 10) {
    const max = await c.vault.read.maxWithdraw([user.address]);
    const amount = (max * BigInt(10 + Math.floor(rng.next() * 50))) / 100n;
    if (amount > 1_000_000n) await send(d.vault, c.vault.abi, "withdraw", [amount, user.address, user.address], user.key);
  }
}
