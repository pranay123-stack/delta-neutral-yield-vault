/**
 * Response shapes the API returns but @dnv/shared does not (yet) declare. Simulation payloads reuse
 * the simulator's own result types (type-only imports: nothing from the simulator ships to the browser).
 */
import type { ApyEstimate, CustomScenarioInput, MonteCarloResult, OptimizeResult, ScenarioResult } from "@dnv/simulator";

export type { ApyEstimate, MonteCarloResult, OptimizeResult, ScenarioResult };

/** GET /strategy/apy - `estimate` and `optimizer.current` are both evaluated at the live configuration. */
export interface StrategyApyView {
  estimate: ApyEstimate;
  optimizer: Pick<OptimizeResult, "best" | "current" | "recommendation" | "frontier" | "constraints">;
}

export type FrontierPoint = OptimizeResult["frontier"][number];

/** POST /simulation body (mirrors backend SimulationRequest). */
export type SimulationRequest =
  | { type: "scenario"; scenarioId: string; tvl?: number }
  | ({ type: "custom" } & CustomScenarioInput)
  | { type: "montecarlo"; paths?: number; days?: number; seed?: number; tvl?: number }
  | { type: "optimizer" };

export interface SimulationResponse<T> {
  id: number;
  type: SimulationRequest["type"];
  result: T;
}

/** GET /simulation/:id */
export interface StoredSimulation {
  id: number;
  createdAt: string;
  kind: SimulationRequest["type"];
  input: SimulationRequest;
  result: unknown;
}
