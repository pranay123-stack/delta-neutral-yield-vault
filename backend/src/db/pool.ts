import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import pg from "pg";

// NUMERIC (oid 1700) and INT8 (oid 20) arrive as strings by default; the API works in JS numbers.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number.parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number.parseInt(v, 10)));

export type Db = pg.Pool;

export function createPool(url: string): Db {
  return new pg.Pool({ connectionString: url, max: 10 });
}

/** Apply every `migrations/*.sql` not yet recorded in schema_migrations, in filename order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  );
  const dir = resolve(import.meta.dirname, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const { rowCount } = await db.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (rowCount) continue;
    const sql = readFileSync(resolve(dir, file), "utf8");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied.push(file);
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }
  return applied;
}

/** Wipe all indexed/derived data (used by the demo to rebuild history from a fresh chain). */
export async function resetData(db: Db): Promise<void> {
  await db.query(`TRUNCATE vault_snapshots, position_snapshots, pnl_snapshots, deposits, withdrawals, rebalances,
    funding_payments, fee_accruals, risk_events, alerts, keeper_runs, simulation_results, indexer_state RESTART IDENTITY CASCADE`);
}
