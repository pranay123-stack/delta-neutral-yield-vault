-- Delta-neutral vault analytics schema.
-- Timestamps named `ts` are *chain* time (unix seconds): the local demo warps time, so wall-clock
-- time would be meaningless for performance maths. Money is NUMERIC (exact), USD human units.

CREATE TABLE IF NOT EXISTS indexer_state (
  id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_block   BIGINT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per snapshot: vault-level numbers.
CREATE TABLE IF NOT EXISTS vault_snapshots (
  id                     BIGSERIAL PRIMARY KEY,
  block_number           BIGINT NOT NULL UNIQUE,
  ts                     BIGINT NOT NULL,
  tvl_usd                NUMERIC NOT NULL,
  share_price            NUMERIC NOT NULL,
  total_supply           NUMERIC NOT NULL,
  idle_usd               NUMERIC NOT NULL,
  available_liquidity_usd NUMERIC NOT NULL,
  eth_price              NUMERIC NOT NULL,
  oracle_status          TEXT NOT NULL,
  risk_state             TEXT NOT NULL,
  risk_flags             INT NOT NULL,
  net_delta_bps          NUMERIC NOT NULL,
  net_delta_usd          NUMERIC NOT NULL,
  hedge_ratio            NUMERIC NOT NULL,
  leverage               NUMERIC NOT NULL,
  liquidation_distance_bps NUMERIC,
  drawdown_bps           NUMERIC NOT NULL,
  funding_rate_8h        NUMERIC NOT NULL,
  usdc_supply_apr        NUMERIC NOT NULL,
  weth_supply_apr        NUMERIC NOT NULL,
  annualized_vol_bps     NUMERIC NOT NULL,
  effective_leverage     NUMERIC NOT NULL,
  deposits_paused        BOOLEAN NOT NULL,
  strategy_paused        BOOLEAN NOT NULL,
  shutdown               BOOLEAN NOT NULL,
  mgmt_fees_usd          NUMERIC NOT NULL,
  perf_fees_usd          NUMERIC NOT NULL
);
CREATE INDEX IF NOT EXISTS vault_snapshots_ts ON vault_snapshots (ts);

-- Strategy positions at the same block (1:1 with vault_snapshots).
CREATE TABLE IF NOT EXISTS position_snapshots (
  snapshot_id            BIGINT PRIMARY KEY REFERENCES vault_snapshots (id) ON DELETE CASCADE,
  reserve_usd            NUMERIC NOT NULL,
  long_qty               NUMERIC NOT NULL,
  long_value_usd         NUMERIC NOT NULL,
  perp_size              NUMERIC NOT NULL,
  perp_entry_price       NUMERIC NOT NULL,
  mark_price             NUMERIC NOT NULL,
  perp_margin_usd        NUMERIC NOT NULL,
  perp_equity_usd        NUMERIC NOT NULL,
  perp_upnl_usd          NUMERIC NOT NULL,
  pending_funding_usd    NUMERIC NOT NULL,
  short_notional_usd     NUMERIC NOT NULL,
  liquidation_price      NUMERIC,
  maintenance_margin_usd NUMERIC NOT NULL
);

-- Cumulative PnL attribution at the same block (1:1 with vault_snapshots).
CREATE TABLE IF NOT EXISTS pnl_snapshots (
  snapshot_id            BIGINT PRIMARY KEY REFERENCES vault_snapshots (id) ON DELETE CASCADE,
  lending_usdc           NUMERIC NOT NULL,
  lending_weth           NUMERIC NOT NULL,
  funding                NUMERIC NOT NULL,
  spot_realized          NUMERIC NOT NULL,
  spot_unrealized        NUMERIC NOT NULL,
  perp_realized          NUMERIC NOT NULL,
  perp_unrealized        NUMERIC NOT NULL,
  trading_fees           NUMERIC NOT NULL,
  slippage               NUMERIC NOT NULL,
  bad_debt_absorbed      NUMERIC NOT NULL,
  net_pnl                NUMERIC NOT NULL,
  net_capital            NUMERIC NOT NULL,
  strategy_nav           NUMERIC NOT NULL
);

CREATE OR REPLACE VIEW share_price_history AS
  SELECT ts, block_number, share_price, tvl_usd FROM vault_snapshots ORDER BY ts;

CREATE TABLE IF NOT EXISTS deposits (
  id            BIGSERIAL PRIMARY KEY,
  block_number  BIGINT NOT NULL,
  log_index     INT NOT NULL,
  tx_hash       TEXT NOT NULL,
  ts            BIGINT NOT NULL,
  sender        TEXT NOT NULL,
  owner         TEXT NOT NULL,
  assets_usd    NUMERIC NOT NULL,
  shares        NUMERIC NOT NULL,
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            BIGSERIAL PRIMARY KEY,
  block_number  BIGINT NOT NULL,
  log_index     INT NOT NULL,
  tx_hash       TEXT NOT NULL,
  ts            BIGINT NOT NULL,
  sender        TEXT NOT NULL,
  receiver      TEXT NOT NULL,
  owner         TEXT NOT NULL,
  assets_usd    NUMERIC NOT NULL,
  shares        NUMERIC NOT NULL,
  via_unwind    BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS rebalances (
  id                  BIGINT PRIMARY KEY, -- on-chain rebalance id
  block_number        BIGINT NOT NULL,
  tx_hash             TEXT NOT NULL,
  ts                  BIGINT NOT NULL,
  triggers            INT NOT NULL,
  urgent              BOOLEAN NOT NULL,
  long_usd_delta      NUMERIC NOT NULL,
  margin_delta        NUMERIC NOT NULL,
  perp_size_change    NUMERIC NOT NULL,
  pre_delta_bps       NUMERIC NOT NULL,
  post_delta_bps      NUMERIC NOT NULL,
  pre_leverage_bps    NUMERIC NOT NULL,
  post_leverage_bps   NUMERIC NOT NULL,
  estimated_cost_usd  NUMERIC NOT NULL,
  realized_cost_usd   NUMERIC NOT NULL
);
CREATE INDEX IF NOT EXISTS rebalances_ts ON rebalances (ts);

CREATE TABLE IF NOT EXISTS funding_payments (
  id            BIGSERIAL PRIMARY KEY,
  block_number  BIGINT NOT NULL,
  log_index     INT NOT NULL,
  tx_hash       TEXT NOT NULL,
  ts            BIGINT NOT NULL,
  amount_usd    NUMERIC NOT NULL, -- + received, - paid
  funding_index NUMERIC NOT NULL,
  UNIQUE (tx_hash, log_index)
);

CREATE TABLE IF NOT EXISTS fee_accruals (
  id                BIGSERIAL PRIMARY KEY,
  block_number      BIGINT NOT NULL,
  log_index         INT NOT NULL,
  tx_hash           TEXT NOT NULL,
  ts                BIGINT NOT NULL,
  management_usd    NUMERIC NOT NULL,
  performance_usd   NUMERIC NOT NULL,
  high_water_mark   NUMERIC NOT NULL,
  UNIQUE (tx_hash, log_index)
);

-- On-chain risk / emergency events (state changes, breakers, pauses, unwinds, peak updates).
CREATE TABLE IF NOT EXISTS risk_events (
  id            BIGSERIAL PRIMARY KEY,
  block_number  BIGINT NOT NULL,
  log_index     INT NOT NULL,
  tx_hash       TEXT NOT NULL,
  ts            BIGINT NOT NULL,
  kind          TEXT NOT NULL,
  previous_state TEXT,
  new_state     TEXT,
  flags         INT,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS risk_events_ts ON risk_events (ts);

-- Off-chain alerts raised by the alert engine (open -> resolved lifecycle, one active per key).
CREATE TABLE IF NOT EXISTS alerts (
  id           BIGSERIAL PRIMARY KEY,
  key          TEXT NOT NULL,
  severity     TEXT NOT NULL,
  title        TEXT NOT NULL,
  message      TEXT NOT NULL,
  value        NUMERIC,
  threshold    NUMERIC,
  opened_at    BIGINT NOT NULL,
  resolved_at  BIGINT,
  active       BOOLEAN NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_one_active_per_key ON alerts (key) WHERE active;

CREATE TABLE IF NOT EXISTS keeper_runs (
  id          BIGSERIAL PRIMARY KEY,
  ts          BIGINT NOT NULL,
  wall_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  action      TEXT NOT NULL,
  tx_hash     TEXT,
  gas_used    BIGINT,
  success     BOOLEAN NOT NULL,
  error       TEXT,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS keeper_runs_wall ON keeper_runs (wall_at);

CREATE TABLE IF NOT EXISTS simulation_results (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind        TEXT NOT NULL, -- scenario | custom | montecarlo | optimizer
  input       JSONB NOT NULL,
  result      JSONB NOT NULL
);
