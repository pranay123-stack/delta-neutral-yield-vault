import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";

import * as repo from "../db/repo";
import { schemas } from "./schemas";
import type { ApiService, SimulationRequest } from "./service";

const tag = (t: string) => ({ tags: [t] });

export async function buildServer(svc: ApiService, opts: { logger?: boolean; corsOrigin?: string } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: opts.corsOrigin === "*" || !opts.corsOrigin ? true : opts.corsOrigin.split(",") });
  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "Delta-Neutral Vault API",
        version: "0.1.0",
        description:
          "Read API over the delta-neutral ERC-4626 vault running against LOCAL MOCK MARKETS (no real funds). " +
          "Money is in human units (USD numbers, ETH numbers), ratios in basis points, rates as fractions. " +
          "`blockTimestamp` / `ts` fields are chain time: the demo warps time to build history.",
      },
      tags: [
        { name: "vault", description: "ERC-4626 vault state, metrics, positions, PnL, fees" },
        { name: "strategy", description: "Targets, rebalance plan, APY estimation, scenarios" },
        { name: "risk", description: "Risk engine, alerts and on-chain risk events" },
        { name: "simulation", description: "Run and retrieve simulations" },
        { name: "system", description: "Health" },
      ],
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    const status = err.statusCode ?? (err.validation ? 400 : 500);
    reply.status(status).send({ error: status >= 500 ? "internal_error" : "bad_request", message: err.message });
  });

  const ok = (schema: object) => ({ response: { 200: schema } });

  app.get("/health", { schema: { ...tag("system"), summary: "Service health", ...ok(schemas.health) } }, async () => {
    const [chainOk, dbOk] = await Promise.all([
      svc.chain.publicClient.getBlockNumber({ cacheTime: 0 }).then((b) => b, () => null),
      svc.db.query("SELECT 1").then(() => true, () => false),
    ]);
    const lastIndexed = dbOk ? await svc.db.query("SELECT last_block FROM indexer_state WHERE id = 1").then((r) => r.rows[0]?.last_block ?? null) : null;
    const keeper = dbOk ? await repo.lastKeeperRun(svc.db) : null;
    return {
      ok: chainOk !== null && dbOk,
      chain: { connected: chainOk !== null, blockNumber: chainOk === null ? null : Number(chainOk), chainId: svc.cfg.CHAIN_ID },
      db: { connected: dbOk },
      indexer: { lastBlock: lastIndexed, lagBlocks: chainOk !== null && lastIndexed !== null ? Number(chainOk) - lastIndexed : null },
      keeper: { enabled: svc.cfg.KEEPER_ENABLED, lastRunAt: keeper?.ts ?? null, lastAction: keeper?.action ?? null },
    };
  });

  app.get("/vault", { schema: { ...tag("vault"), summary: "Vault overview", ...ok(schemas.vault) } }, () => svc.vault());
  app.get("/vault/metrics", { schema: { ...tag("vault"), summary: "Headline metrics (TVL, APYs, delta, leverage, risk)", ...ok(schemas.metrics) } }, () => svc.metrics());
  app.get<{ Querystring: { days?: number } }>(
    "/vault/performance",
    { schema: { ...tag("vault"), summary: "Historical series + summary statistics", querystring: { type: "object", properties: { days: { type: "integer", minimum: 1 } } }, ...ok(schemas.performance) } },
    (req) => svc.performance(req.query.days),
  );
  app.get("/vault/positions", { schema: { ...tag("vault"), summary: "Every leg: reserve, long WETH, perp short", ...ok(schemas.positions) } }, () => svc.positions());
  app.get("/vault/risk", { schema: { ...tag("risk"), summary: "Risk engine assessment", ...ok(schemas.risk) } }, () => svc.risk());
  app.get("/vault/delta", { schema: { ...tag("vault"), summary: "Delta report", ...ok(schemas.delta) } }, () => svc.delta());
  app.get("/vault/funding", { schema: { ...tag("vault"), summary: "Funding rate, income and history", ...ok(schemas.funding) } }, () => svc.funding());
  app.get("/vault/pnl", { schema: { ...tag("vault"), summary: "PnL attribution (reconciles to NAV)", ...ok(schemas.pnl) } }, () => svc.pnl());
  app.get("/vault/fees", { schema: { ...tag("vault"), summary: "Fee configuration and collected fees", ...ok(schemas.fees) } }, () => svc.fees());
  app.get("/vault/transactions", { schema: { ...tag("vault"), summary: "Deposits and withdrawals", ...ok(schemas.transactions) } }, () => repo.transactions(svc.db));

  app.get("/strategy", { schema: { ...tag("strategy"), summary: "Targets, params, vol, next rebalance plan", ...ok(schemas.strategy) } }, () => svc.strategy());
  app.get("/strategy/apy", { schema: { ...tag("strategy"), summary: "Expected net APY estimate + optimizer", ...ok(schemas.apy) } }, () => svc.apy());
  app.get("/strategy/scenarios", { schema: { ...tag("strategy"), summary: "Scenario catalogue A-J under live on-chain config", ...ok(schemas.scenarios) } }, () => svc.scenarios());

  app.get<{ Querystring: { limit?: number } }>(
    "/rebalance/history",
    { schema: { ...tag("strategy"), summary: "Executed rebalances (indexed events)", querystring: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 1000 } } }, ...ok(schemas.rebalances) } },
    (req) => repo.rebalanceHistory(svc.db, req.query.limit ?? 200),
  );
  app.get<{ Querystring: { active?: boolean } }>(
    "/alerts",
    { schema: { ...tag("risk"), summary: "Alerts (active first)", querystring: { type: "object", properties: { active: { type: "boolean" } } }, ...ok(schemas.alerts) } },
    (req) => repo.listAlerts(svc.db, { activeOnly: req.query.active }),
  );
  app.get("/risk/events", { schema: { ...tag("risk"), summary: "On-chain risk & emergency events", ...ok(schemas.riskEvents) } }, () => repo.riskEvents(svc.db));

  app.post<{ Body: SimulationRequest }>(
    "/simulation",
    { schema: { ...tag("simulation"), summary: "Run a scenario, custom scenario, Monte Carlo or optimizer; result is persisted", body: schemas.simulationRequest, ...ok(schemas.simulationResult) } },
    (req) => svc.simulate(req.body),
  );
  app.get<{ Params: { id: number } }>(
    "/simulation/:id",
    { schema: { ...tag("simulation"), summary: "Fetch a stored simulation", params: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } } },
    async (req, reply) => {
      const sim = await repo.getSimulation(svc.db, req.params.id);
      if (!sim) return reply.status(404).send({ error: "not_found", message: `simulation ${req.params.id} not found` });
      return sim;
    },
  );

  app.get("/openapi.json", { schema: { hide: true } }, () => app.swagger());
  return app;
}
