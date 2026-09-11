"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { Hash } from "viem";
import { useConfig } from "wagmi";
import { waitForTransactionReceipt } from "wagmi/actions";

import { describeError } from "./errors";

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
            const receipt = await waitForTransactionReceipt(config, { hash });
            if (receipt.status !== "success") throw new Error(`${step.label} reverted on-chain (tx ${hash}).`);
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
