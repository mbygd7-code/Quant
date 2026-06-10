-- 00000000000034_paper_bot.sql
-- Soros 모의투자 (paper-trading bot) — the live usability audit.
--
-- A single global virtual portfolio that the Soros consensus trades
-- automatically every signal cycle. Separate from the per-user
-- paper_trades/paper_portfolio (migration 03, auth.users-keyed): this
-- is a SYSTEM portfolio with no user, plus snapshots for the equity
-- curve and a singleton config row (editable starting capital).
--
-- Purpose: measure whether the service's signals are actually usable —
-- realized P&L with realistic fees/taxes, reported weekly via Telegram.

CREATE TABLE IF NOT EXISTS paper_config (
    id              SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    initial_capital BIGINT  NOT NULL DEFAULT 100000000,   -- 1억원
    cash            BIGINT  NOT NULL DEFAULT 100000000,
    max_positions   INT     NOT NULL DEFAULT 10,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO paper_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS paper_bot_trades (
    id             BIGSERIAL PRIMARY KEY,
    trade_date     DATE        NOT NULL,
    ticker         VARCHAR(10) NOT NULL,
    side           VARCHAR(4)  NOT NULL CHECK (side IN ('buy', 'sell')),
    qty            INTEGER     NOT NULL CHECK (qty > 0),
    price          INTEGER     NOT NULL CHECK (price > 0),
    amount         BIGINT      NOT NULL,                 -- qty × price
    fee            BIGINT      NOT NULL DEFAULT 0,       -- commission
    tax            BIGINT      NOT NULL DEFAULT 0,       -- sell tax
    signal_grade   TEXT,                                 -- grade that triggered it
    weighted_score FLOAT,
    reason         TEXT,                                 -- human-readable trigger
    realized_pnl   BIGINT,                               -- sells only (vs avg_price, net of costs)
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_bot_trades_date_idx ON paper_bot_trades (trade_date DESC);

CREATE TABLE IF NOT EXISTS paper_bot_positions (
    ticker      VARCHAR(10) PRIMARY KEY,
    qty         INTEGER NOT NULL CHECK (qty > 0),
    avg_price   INTEGER NOT NULL,                        -- cost basis incl. buy fee
    opened_at   DATE    NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_bot_snapshots (
    snap_date        DATE PRIMARY KEY,
    total_value      BIGINT NOT NULL,
    cash             BIGINT NOT NULL,
    invested         BIGINT NOT NULL,
    unrealized_pnl   BIGINT NOT NULL DEFAULT 0,
    realized_pnl_cum BIGINT NOT NULL DEFAULT 0,
    ret_pct          FLOAT  NOT NULL DEFAULT 0,          -- vs initial_capital
    n_positions      INT    NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE paper_config IS
    'Soros 모의투자 설정 (singleton) — executor/paper_trader_bot.py';

ALTER TABLE paper_config        ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_bot_trades    ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_bot_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE paper_bot_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paper_config_read        ON paper_config;
DROP POLICY IF EXISTS paper_bot_trades_read    ON paper_bot_trades;
DROP POLICY IF EXISTS paper_bot_positions_read ON paper_bot_positions;
DROP POLICY IF EXISTS paper_bot_snapshots_read ON paper_bot_snapshots;
CREATE POLICY paper_config_read        ON paper_config        FOR SELECT TO authenticated USING (true);
CREATE POLICY paper_bot_trades_read    ON paper_bot_trades    FOR SELECT TO authenticated USING (true);
CREATE POLICY paper_bot_positions_read ON paper_bot_positions FOR SELECT TO authenticated USING (true);
CREATE POLICY paper_bot_snapshots_read ON paper_bot_snapshots FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
