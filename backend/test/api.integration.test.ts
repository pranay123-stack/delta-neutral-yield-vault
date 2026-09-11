import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ApiService } from "../src/api/service";
import { buildServer } from "../src/api/server";
import { createChain } from "../src/chain/clients";
import { loadConfig } from "../src/config";
import { createPool, migrate } from "../src/db/pool";

/**
 * End-to-end over a running Anvil + Postgres (INTEGRATION=1). `pnpm e2e` at the repo root brings both
 * up, deploys, replays history and runs this suite.
 */
const run = process.env.INTEGRATION === "1";
const SPEC_ENDPOINTS = [
  "/vault",
  "/vault/metrics",
  "/vault/performance",
  "/vault/positions",
  "/vault/risk",
  "/vault/delta",
  "/vault/funding",
  "/vault/pnl",
  "/vault/fees",
  "/strategy",
  "/strategy/apy",
  "/strategy/scenarios",
  "/rebalance/history",
  "/alerts",
];

describe.skipIf(!run)("API integration", () => {
  let app: FastifyInstance;
  const cfg = loadConfig();
  const db = createPool(cfg.DATABASE_URL);

  beforeAll(async () => {
    await migrate(db);
    app = await buildServer(new ApiService(cfg, createChain(cfg), db));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it.each(SPEC_ENDPOINTS)("GET %s -> 200 JSON", async (url) => {
    const r = await app.inject({ method: "GET", url });
    expect(r.statusCode).toBe(200);
    expect(() => r.json()).not.toThrow();
  });

  it("metrics are internally consistent", async () => {
    const m = (await app.inject({ url: "/vault/metrics" })).json();
    const v = (await app.inject({ url: "/vault" })).json();
    expect(m.tvlUsd).toBeCloseTo(v.tvlUsd, 2);
    expect(Math.abs(m.netDeltaBps)).toBeLessThanOrEqual(500);
    expect(["NORMAL", "WARNING", "HIGH_RISK", "EMERGENCY"]).toContain(m.riskState);
  });

  it("pnl reconciles through the API", async () => {
    const p = (await app.inject({ url: "/vault/pnl" })).json();
    expect(Math.abs(p.reconciliationResidualUsd)).toBeLessThan(0.05);
  });

  it("performance history exists (market driver ran)", async () => {
    const perf = (await app.inject({ url: "/vault/performance" })).json();
    expect(perf.points.length).toBeGreaterThan(10);
    expect(perf.summary.toTs).toBeGreaterThan(perf.summary.fromTs);
  });

  it("POST /simulation persists and GET /simulation/:id returns it", async () => {
    const post = await app.inject({ method: "POST", url: "/simulation", payload: { type: "custom", priceMovePct: -30, moveDays: 2, horizonDays: 10 } });
    expect(post.statusCode).toBe(200);
    const { id, result } = post.json();
    expect(result.withKeeper.liquidations).toBe(0);
    const get = await app.inject({ url: `/simulation/${id}` });
    expect(get.statusCode).toBe(200);
    expect(get.json().kind).toBe("custom");
  });

  it("rejects invalid simulation input", async () => {
    const r = await app.inject({ method: "POST", url: "/simulation", payload: { type: "bogus" } });
    expect(r.statusCode).toBe(400);
  });

  it("OpenAPI document covers every spec endpoint", async () => {
    const doc = (await app.inject({ url: "/openapi.json" })).json();
    for (const p of [...SPEC_ENDPOINTS, "/simulation"]) expect(Object.keys(doc.paths)).toContain(p);
  });
});
