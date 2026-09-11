import {
  type AlertView,
  type PerformancePoint,
  REBALANCE_TRIGGERS,
  type RebalanceRecordView,
  type RiskStateName,
  type TransactionView,
  decodeBits,
} from "@dnv/shared";

import type { Db } from "./pool";

export interface SnapshotRow {
  blockNumber: number;
  ts: number;
  tvlUsd: number;
  sharePrice: number;
  totalSupply: number;
  idleUsd: number;
  availableLiquidityUsd: number;
  ethPrice: number;
  oracleStatus: string;
  riskState: RiskStateName;
  riskFlags: number;
  netDeltaBps: number;
  netDeltaUsd: number;
  hedgeRatio: number;
  leverage: number;
  liquidationDistanceBps: number | null;
  drawdownBps: number;
  fundingRate8h: number;
  usdcSupplyApr: number;
  wethSupplyApr: number;
  annualizedVolBps: number;
  effectiveLeverage: number;
  depositsPaused: boolean;
  strategyPaused: boolean;
  shutdown: boolean;
  mgmtFeesUsd: number;
  perfFeesUsd: number;
  positions: {
    reserveUsd: number;
    longQty: number;
    longValueUsd: number;
    perpSize: number;
    perpEntryPrice: number;
    markPrice: number;
    perpMarginUsd: number;
    perpEquityUsd: number;
    perpUpnlUsd: number;
    pendingFundingUsd: number;
    shortNotionalUsd: number;
    liquidationPrice: number | null;
    maintenanceMarginUsd: number;
  };
  pnl: {
    lendingUsdc: number;
    lendingWeth: number;
    funding: number;
    spotRealized: number;
    spotUnrealized: number;
    perpRealized: number;
    perpUnrealized: number;
    tradingFees: number;
    slippage: number;
    badDebtAbsorbed: number;
    netPnl: number;
    netCapital: number;
    strategyNav: number;
  };
}

/** Insert a snapshot (idempotent per block). Returns false if that block was already snapshotted. */
export async function insertSnapshot(db: Db, s: SnapshotRow): Promise<boolean> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `INSERT INTO vault_snapshots (block_number, ts, tvl_usd, share_price, total_supply, idle_usd, available_liquidity_usd,
        eth_price, oracle_status, risk_state, risk_flags, net_delta_bps, net_delta_usd, hedge_ratio, leverage,
        liquidation_distance_bps, drawdown_bps, funding_rate_8h, usdc_supply_apr, weth_supply_apr, annualized_vol_bps,
        effective_leverage, deposits_paused, strategy_paused, shutdown, mgmt_fees_usd, perf_fees_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (block_number) DO NOTHING RETURNING id`,
      [
        s.blockNumber, s.ts, s.tvlUsd, s.sharePrice, s.totalSupply, s.idleUsd, s.availableLiquidityUsd, s.ethPrice,
        s.oracleStatus, s.riskState, s.riskFlags, s.netDeltaBps, s.netDeltaUsd, s.hedgeRatio, s.leverage,
        s.liquidationDistanceBps, s.drawdownBps, s.fundingRate8h, s.usdcSupplyApr, s.wethSupplyApr, s.annualizedVolBps,
        s.effectiveLeverage, s.depositsPaused, s.strategyPaused, s.shutdown, s.mgmtFeesUsd, s.perfFeesUsd,
      ],
    );
    if (r.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const id = r.rows[0].id as number;
    const p = s.positions;
    await client.query(
      `INSERT INTO position_snapshots (snapshot_id, reserve_usd, long_qty, long_value_usd, perp_size, perp_entry_price,
        mark_price, perp_margin_usd, perp_equity_usd, perp_upnl_usd, pending_funding_usd, short_notional_usd,
        liquidation_price, maintenance_margin_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, p.reserveUsd, p.longQty, p.longValueUsd, p.perpSize, p.perpEntryPrice, p.markPrice, p.perpMarginUsd,
        p.perpEquityUsd, p.perpUpnlUsd, p.pendingFundingUsd, p.shortNotionalUsd, p.liquidationPrice, p.maintenanceMarginUsd],
    );
    const q = s.pnl;
    await client.query(
      `INSERT INTO pnl_snapshots (snapshot_id, lending_usdc, lending_weth, funding, spot_realized, spot_unrealized,
        perp_realized, perp_unrealized, trading_fees, slippage, bad_debt_absorbed, net_pnl, net_capital, strategy_nav)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [id, q.lendingUsdc, q.lendingWeth, q.funding, q.spotRealized, q.spotUnrealized, q.perpRealized, q.perpUnrealized,
        q.tradingFees, q.slippage, q.badDebtAbsorbed, q.netPnl, q.netCapital, q.strategyNav],
    );
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function lastSnapshotTs(db: Db): Promise<number | null> {
  const r = await db.query("SELECT max(ts) AS ts FROM vault_snapshots");
  return r.rows[0]?.ts ?? null;
}

/** Snapshot series for charts, optionally downsampled to at most `maxPoints`. */
export async function performanceSeries(db: Db, fromTs = 0, maxPoints = 1500): Promise<Omit<PerformancePoint, "apy7d" | "apy30d">[]> {
  const count = await db.query("SELECT count(*)::int AS n FROM vault_snapshots WHERE ts >= $1", [fromTs]);
  const n = count.rows[0].n as number;
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const r = await db.query(
    `SELECT * FROM (
       SELECT v.ts, v.block_number, v.tvl_usd, v.share_price, v.eth_price, v.net_delta_bps, v.leverage,
              v.liquidation_distance_bps, v.drawdown_bps, v.funding_rate_8h, v.usdc_supply_apr, v.weth_supply_apr,
              v.risk_state, p.net_pnl, p.funding, p.lending_usdc + p.lending_weth AS lending,
              p.trading_fees + p.slippage AS costs, row_number() OVER (ORDER BY v.ts) AS rn, count(*) OVER () AS total
       FROM vault_snapshots v JOIN pnl_snapshots p ON p.snapshot_id = v.id WHERE v.ts >= $1
     ) x WHERE (rn - 1) % $2 = 0 OR rn = total ORDER BY ts`,
    [fromTs, step],
  );
  return r.rows.map((row) => ({
    ts: row.ts,
    blockNumber: row.block_number,
    tvlUsd: row.tvl_usd,
    sharePrice: row.share_price,
    ethPrice: row.eth_price,
    netDeltaBps: row.net_delta_bps,
    leverage: row.leverage,
    liquidationDistanceBps: row.liquidation_distance_bps,
    drawdownBps: row.drawdown_bps,
    fundingRatePer8h: row.funding_rate_8h,
    usdcSupplyApr: row.usdc_supply_apr,
    wethSupplyApr: row.weth_supply_apr,
    strategyNetPnl: row.net_pnl,
    fundingIncome: row.funding,
    lendingIncome: row.lending,
    tradingCosts: row.costs,
    riskState: row.risk_state,
  }));
}

/** Share price at or before `ts` (for trailing-window APY). */
export async function sharePriceAt(db: Db, ts: number): Promise<{ ts: number; sharePrice: number } | null> {
  const r = await db.query("SELECT ts, share_price FROM vault_snapshots WHERE ts <= $1 ORDER BY ts DESC LIMIT 1", [ts]);
  return r.rows[0] ? { ts: r.rows[0].ts, sharePrice: r.rows[0].share_price } : null;
}

export async function firstSnapshot(db: Db): Promise<{ ts: number; sharePrice: number; income: number; tvl: number } | null> {
  const r = await db.query(
    `SELECT v.ts, v.share_price, v.tvl_usd, p.lending_usdc + p.lending_weth + p.funding AS income
     FROM vault_snapshots v JOIN pnl_snapshots p ON p.snapshot_id = v.id ORDER BY v.ts ASC LIMIT 1`,
  );
  const row = r.rows[0];
  return row ? { ts: row.ts, sharePrice: row.share_price, income: row.income, tvl: row.tvl_usd } : null;
}

export async function avgTvlSince(db: Db, fromTs: number): Promise<number | null> {
  const r = await db.query("SELECT avg(tvl_usd) AS avg FROM vault_snapshots WHERE ts >= $1", [fromTs]);
  return r.rows[0]?.avg ?? null;
}

export async function incomeAt(db: Db, ts: number): Promise<number | null> {
  const r = await db.query(
    `SELECT p.lending_usdc + p.lending_weth + p.funding AS income FROM vault_snapshots v
     JOIN pnl_snapshots p ON p.snapshot_id = v.id WHERE v.ts <= $1 ORDER BY v.ts DESC LIMIT 1`,
    [ts],
  );
  return r.rows[0]?.income ?? null;
}

export async function rebalanceHistory(db: Db, limit = 200): Promise<RebalanceRecordView[]> {
  const r = await db.query("SELECT * FROM rebalances ORDER BY id DESC LIMIT $1", [limit]);
  return r.rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    triggers: decodeBits(row.triggers, REBALANCE_TRIGGERS),
    urgent: row.urgent,
    longUsdDelta: row.long_usd_delta,
    marginDelta: row.margin_delta,
    perpSizeChange: row.perp_size_change,
    preDeltaBps: row.pre_delta_bps,
    postDeltaBps: row.post_delta_bps,
    preLeverage: row.pre_leverage_bps / 10_000,
    postLeverage: row.post_leverage_bps / 10_000,
    estimatedCostUsd: row.estimated_cost_usd,
    realizedCostUsd: row.realized_cost_usd,
  }));
}

export async function rebalanceCountBetween(db: Db, fromTs: number, toTs: number): Promise<number> {
  const r = await db.query("SELECT count(*)::int AS n FROM rebalances WHERE ts BETWEEN $1 AND $2", [fromTs, toTs]);
  return r.rows[0].n;
}

export async function fundingPayments(db: Db, limit = 200) {
  const r = await db.query("SELECT ts, block_number, amount_usd, tx_hash FROM funding_payments ORDER BY ts DESC LIMIT $1", [limit]);
  return r.rows.map((row) => ({ ts: row.ts, blockNumber: row.block_number, amountUsd: row.amount_usd, txHash: row.tx_hash }));
}

export async function transactions(db: Db, limit = 200): Promise<TransactionView[]> {
  const r = await db.query(
    `(SELECT id, 'DEPOSIT' AS kind, ts, block_number, tx_hash, sender, owner, owner AS receiver, assets_usd, shares FROM deposits)
     UNION ALL
     (SELECT id, 'WITHDRAW' AS kind, ts, block_number, tx_hash, sender, owner, receiver, assets_usd, shares FROM withdrawals)
     ORDER BY ts DESC, block_number DESC LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    ts: row.ts,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    sender: row.sender,
    owner: row.owner,
    receiver: row.receiver,
    assetsUsd: row.assets_usd,
    shares: row.shares,
  }));
}

export async function listAlerts(db: Db, opts: { activeOnly?: boolean; limit?: number } = {}): Promise<AlertView[]> {
  const r = await db.query(
    `SELECT * FROM alerts ${opts.activeOnly ? "WHERE active" : ""} ORDER BY active DESC, opened_at DESC LIMIT $1`,
    [opts.limit ?? 200],
  );
  return r.rows.map((row) => ({
    id: row.id,
    key: row.key,
    severity: row.severity,
    title: row.title,
    message: row.message,
    value: row.value,
    threshold: row.threshold,
    openedAt: row.opened_at,
    resolvedAt: row.resolved_at,
    active: row.active,
  }));
}

export async function riskEvents(db: Db, limit = 200) {
  const r = await db.query("SELECT * FROM risk_events ORDER BY ts DESC, id DESC LIMIT $1", [limit]);
  return r.rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    kind: row.kind,
    previousState: row.previous_state,
    newState: row.new_state,
    flags: row.flags,
    details: row.details,
  }));
}

export async function saveSimulation(db: Db, kind: string, input: unknown, result: unknown): Promise<number> {
  const r = await db.query("INSERT INTO simulation_results (kind, input, result) VALUES ($1, $2, $3) RETURNING id", [
    kind,
    JSON.stringify(input),
    JSON.stringify(result),
  ]);
  return r.rows[0].id;
}

export async function getSimulation(db: Db, id: number) {
  const r = await db.query("SELECT * FROM simulation_results WHERE id = $1", [id]);
  const row = r.rows[0];
  return row ? { id: row.id, createdAt: row.created_at, kind: row.kind, input: row.input, result: row.result } : null;
}

export async function recordKeeperRun(
  db: Db,
  run: { ts: number; action: string; txHash?: string; gasUsed?: bigint; success: boolean; error?: string; details?: unknown },
): Promise<void> {
  await db.query(
    "INSERT INTO keeper_runs (ts, action, tx_hash, gas_used, success, error, details) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [run.ts, run.action, run.txHash ?? null, run.gasUsed === undefined ? null : Number(run.gasUsed), run.success, run.error ?? null, JSON.stringify(run.details ?? {})],
  );
}

export async function lastKeeperRun(db: Db) {
  const r = await db.query("SELECT ts, action, wall_at FROM keeper_runs ORDER BY id DESC LIMIT 1");
  return r.rows[0] ?? null;
}
