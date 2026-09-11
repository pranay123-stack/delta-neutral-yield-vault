/**
 * Typed REST client for the backend API. Response types come from @dnv/shared (the contract the
 * backend builds against) plus the few shapes declared in ./types.
 */
import type {
  AlertView,
  DeltaView,
  FeesView,
  FundingView,
  HealthView,
  PerformanceView,
  PnlView,
  PositionsView,
  RebalanceRecordView,
  RiskEventView,
  RiskView,
  StrategyView,
  TransactionView,
  VaultMetrics,
  VaultView,
} from "@dnv/shared";

import { API_URL } from "./env";
import type { ScenarioResult, SimulationRequest, SimulationResponse, StoredSimulation, StrategyApyView } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get unreachable(): boolean {
    return this.status === 0;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(`API unreachable at ${API_URL} - is the backend running?`, 0);
  }
  if (!res.ok) {
    let message = `HTTP ${res.status} on ${path}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body?.message) message = `${message}: ${body.message}`;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal });

export const api = {
  health: (signal?: AbortSignal) => get<HealthView>("/health", signal),
  vault: (signal?: AbortSignal) => get<VaultView>("/vault", signal),
  metrics: (signal?: AbortSignal) => get<VaultMetrics>("/vault/metrics", signal),
  performance: (days: number | null, signal?: AbortSignal) =>
    get<PerformanceView>(days ? `/vault/performance?days=${days}` : "/vault/performance", signal),
  positions: (signal?: AbortSignal) => get<PositionsView>("/vault/positions", signal),
  risk: (signal?: AbortSignal) => get<RiskView>("/vault/risk", signal),
  delta: (signal?: AbortSignal) => get<DeltaView>("/vault/delta", signal),
  funding: (signal?: AbortSignal) => get<FundingView>("/vault/funding", signal),
  pnl: (signal?: AbortSignal) => get<PnlView>("/vault/pnl", signal),
  fees: (signal?: AbortSignal) => get<FeesView>("/vault/fees", signal),
  transactions: (signal?: AbortSignal) => get<TransactionView[]>("/vault/transactions", signal),
  strategy: (signal?: AbortSignal) => get<StrategyView>("/strategy", signal),
  apy: (signal?: AbortSignal) => get<StrategyApyView>("/strategy/apy", signal),
  scenarios: (signal?: AbortSignal) => get<ScenarioResult[]>("/strategy/scenarios", signal),
  rebalances: (limit = 1000, signal?: AbortSignal) => get<RebalanceRecordView[]>(`/rebalance/history?limit=${limit}`, signal),
  alerts: (activeOnly: boolean, signal?: AbortSignal) => get<AlertView[]>(activeOnly ? "/alerts?active=true" : "/alerts", signal),
  riskEvents: (signal?: AbortSignal) => get<RiskEventView[]>("/risk/events", signal),
  simulate: <T>(body: SimulationRequest, signal?: AbortSignal) =>
    request<SimulationResponse<T>>("/simulation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),
  simulation: (id: number, signal?: AbortSignal) => get<StoredSimulation>(`/simulation/${id}`, signal),
};
