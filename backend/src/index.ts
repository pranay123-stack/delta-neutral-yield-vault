import pino from "pino";

import { evaluateAlerts, syncAlerts } from "./alerts";
import { ApiService } from "./api/service";
import { buildServer } from "./api/server";
import { createChain } from "./chain/clients";
import { loadConfig } from "./config";
import { createPool, migrate, resetData } from "./db/pool";
import { Indexer } from "./indexer";
import { Keeper } from "./keeper";
import { runMarketDriver } from "./marketDriver";
import { takeSnapshot } from "./snapshot";
import { deltaView, positionsView, riskView, strategyView } from "./views";

/**
 * Entrypoint. Modes:
 *   migrate            apply DB migrations
 *   api                REST API only
 *   keeper             keeper loop only
 *   indexer            indexer + snapshotter + alert engine loop
 *   all                api + indexer loop + keeper loop (the Docker "backend" service)
 *   history [days]     reset data and replay a synthetic market on Anvil to build chart history
 */
const mode = process.argv[2] ?? "all";
const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: undefined });
const chain = createChain(cfg);
const db = createPool(cfg.DATABASE_URL);

function loop(name: string, intervalMs: number, fn: () => Promise<unknown>) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log.warn({ loop: name, err: e instanceof Error ? e.message : String(e) }, "loop iteration failed");
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(run, intervalMs);
}

async function indexerLoop() {
  const indexer = new Indexer(chain, db);
  loop("indexer", cfg.INDEXER_INTERVAL_MS, () => indexer.sync());
  loop("snapshot+alerts", cfg.SNAPSHOT_INTERVAL_MS, async () => {
    const { state } = await takeSnapshot(chain, db);
    const r = await syncAlerts(
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
    if (r.opened || r.resolved) log.info(r, "alerts updated");
  });
}

function keeperLoop() {
  const keeper = new Keeper(chain, db, cfg.KEEPER_PRIVATE_KEY, log);
  loop("keeper", cfg.KEEPER_INTERVAL_MS, async () => {
    const r = await keeper.tick();
    if (r.rebalanced || r.errors.length) log.info(r, "keeper tick");
  });
}

async function api() {
  const app = await buildServer(new ApiService(cfg, chain, db), { corsOrigin: cfg.CORS_ORIGIN });
  await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
  log.info({ port: cfg.API_PORT, docs: `http://localhost:${cfg.API_PORT}/docs` }, "API listening");
}

async function main() {
  await migrate(db);
  switch (mode) {
    case "migrate":
      log.info("migrations applied");
      await db.end();
      return;
    case "api":
      await api();
      return;
    case "keeper":
      keeperLoop();
      return;
    case "indexer":
      await indexerLoop();
      return;
    case "all":
      await api();
      await indexerLoop();
      if (cfg.KEEPER_ENABLED) keeperLoop();
      return;
    case "history": {
      const days = Number(process.argv[3] ?? 90);
      const stepHours = Number(process.argv[4] ?? 6);
      await resetData(db);
      const indexer = new Indexer(chain, db);
      await indexer.sync();
      await takeSnapshot(chain, db);
      const t0 = Date.now();
      const r = await runMarketDriver(cfg, chain, db, new Keeper(chain, db, cfg.KEEPER_PRIVATE_KEY), indexer, {
        days,
        stepHours,
        seed: Number(process.env.HISTORY_SEED ?? 20260911),
        userFlows: true,
        log,
      });
      log.info({ ...r, seconds: ((Date.now() - t0) / 1000).toFixed(1) }, "history built");
      await db.end();
      return;
    }
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
