"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { Hash } from "viem";
import { type Config, useConfig } from "wagmi";
import { getPublicClient, simulateContract, writeContract } from "wagmi/actions";

import { CHAIN_ID } from "./env";
import { describeError } from "./errors";
import { withGasHeadroom } from "@dnv/shared";

type SimulateParams = Parameters<typeof simulateContract>[1];

/**
 * Simulate (so reverts are decoded before anything is sent), then send with gas headroom (`withGasHeadroom`, @dnv/shared).
 *
 * Gas is estimated against the latest block. If that block just wrote the vault's accrual checkpoints
 * (fees, lending interest, perp funding), no time has elapsed, so the estimate skips the accrual work;
 * the real transaction lands at least a second later and pays for it. Sent with the bare estimate it
 * can run out of gas and revert on-chain - which is exactly what a slow CI runner produced. The keeper
 * carries the same headroom for the same reason (docs/security.md, bugs 7 and 10).
 */
export async function sendContract(config: Config, params: SimulateParams): Promise<Hash> {
  const { request } = await simulateContract(config, params);
  const client = getPublicClient(config, { chainId: CHAIN_ID });
  if (!client) throw new Error(`No RPC client configured for chain ${CHAIN_ID}.`);
  const estimate = await client.estimateContractGas(request as never);
  return writeContract(config, { ...request, gas: withGasHeadroom(estimate) } as never);
}

export type TxStepStatus = "queued" | "signing" | "confirming" | "done" | "error";

export interface TxStep {
  label: string;
  status: TxStepStatus;
  hash?: Hash;
  blockNumber?: bigint;
}

export interface TxState {
  action: string | null;
  steps: TxStep[];
  error: string | null;
  running: boolean;
}

export interface TxStepSpec {
  label: string;
  /** Simulate + submit; resolves with the tx hash. Called lazily, in order. */
  send: () => Promise<Hash>;
}

const IDLE: TxState = { action: null, steps: [], error: null, running: false };

/**
 * Runs a sequence of transactions (e.g. approve -> deposit): waits for each receipt, surfaces the
 * decoded revert reason on failure, and refetches every API query + on-chain read after each receipt
 * (and once more shortly after, so the indexer has caught up with the new events).
 */
export function useTxRunner() {
  const config = useConfig();
  const queryClient = useQueryClient();
  const [state, setState] = useState<TxState>(IDLE);
  const busy = useRef(false);

  const patchStep = useCallback((index: number, patch: Partial<TxStep>) => {
    setState((s) => ({ ...s, steps: s.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)) }));
  }, []);

  const run = useCallback(
    async (action: string, steps: TxStepSpec[]): Promise<boolean> => {
      if (busy.current) return false;
      busy.current = true;
      setState({ action, steps: steps.map((s) => ({ label: s.label, status: "queued" })), error: null, running: true });
      try {
        for (const [i, step] of steps.entries()) {
          patchStep(i, { status: "signing" });
          let hash: Hash | undefined;
          try {
            hash = await step.send();
            patchStep(i, { status: "confirming", hash });
            // viem's wait, not wagmi's: wagmi replays a reverted tx with eth_call and throws whatever the
            // replay says, which for an out-of-gas revert is an unhelpful RPC error. Say what happened.
            const client = getPublicClient(config, { chainId: CHAIN_ID });
            if (!client) throw new Error(`No RPC client configured for chain ${CHAIN_ID}.`);
            const receipt = await client.waitForTransactionReceipt({ hash });
            if (receipt.status !== "success") {
              const sent = await client.getTransaction({ hash });
              // EIP-150: a starved inner call reverts while up to 1/64 of the gas is still left, so
              // "out of gas" shows as gasUsed >= 63/64 of the limit, not only as gasUsed == limit.
              throw new Error(
                receipt.gasUsed * 64n >= sent.gas * 63n
                  ? `${step.label} ran out of gas on-chain (used ${receipt.gasUsed} of ${sent.gas}, tx ${hash}).`
                  : `${step.label} reverted on-chain (tx ${hash}).`,
              );
            }
            patchStep(i, { status: "done", blockNumber: receipt.blockNumber });
            await queryClient.invalidateQueries();
          } catch (err) {
            patchStep(i, { status: "error", hash });
            setState((s) => ({ ...s, error: describeError(err), running: false }));
            return false;
          }
        }
        setState((s) => ({ ...s, running: false }));
        window.setTimeout(() => void queryClient.invalidateQueries(), 2_500);
        return true;
      } finally {
        busy.current = false;
      }
    },
    [config, queryClient, patchStep],
  );

  const reset = useCallback(() => setState(IDLE), []);

  return { state, run, reset };
}
