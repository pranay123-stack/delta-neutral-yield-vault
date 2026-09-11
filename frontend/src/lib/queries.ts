"use client";

/**
 * React Query hooks, one per endpoint. Live endpoints poll every ~5s, history every 30s.
 * Every tx invalidates the whole cache (see lib/tx.ts), so views refresh right after a receipt.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { api } from "./api";
import { POLL_LIVE, POLL_SLOW } from "./env";

function useLive<T>(queryKey: readonly unknown[], fn: (signal: AbortSignal) => Promise<T>, refetchInterval = POLL_LIVE) {
  return useQuery({ queryKey, queryFn: ({ signal }) => fn(signal), refetchInterval });
}

export const useHealth = () => useLive(["health"], api.health);
export const useVault = () => useLive(["vault"], api.vault);
export const useMetrics = () => useLive(["vault", "metrics"], api.metrics);
export const usePositions = () => useLive(["vault", "positions"], api.positions);
export const useRisk = () => useLive(["vault", "risk"], api.risk);
export const useDelta = () => useLive(["vault", "delta"], api.delta);
export const useFunding = () => useLive(["vault", "funding"], api.funding);
export const usePnl = () => useLive(["vault", "pnl"], api.pnl);
export const useFees = () => useLive(["vault", "fees"], api.fees);
export const useTransactions = () => useLive(["vault", "transactions"], api.transactions);
export const useStrategy = () => useLive(["strategy"], api.strategy);
export const useApy = () => useLive(["strategy", "apy"], api.apy);
export const useScenarios = () => useLive(["strategy", "scenarios"], api.scenarios, POLL_SLOW);
export const useRebalances = () => useLive(["rebalance", "history"], (s) => api.rebalances(1000, s));
export const useAlerts = (activeOnly: boolean) => useLive(["alerts", activeOnly], (s) => api.alerts(activeOnly, s));
export const useRiskEvents = () => useLive(["risk", "events"], api.riskEvents);

/** Historical series: 30s cadence, keeps the previous range on screen while a new range loads. */
export function usePerformance(days: number | null) {
  return useQuery({
    queryKey: ["vault", "performance", days ?? "all"],
    queryFn: ({ signal }) => api.performance(days, signal),
    refetchInterval: POLL_SLOW,
    placeholderData: keepPreviousData,
  });
}
