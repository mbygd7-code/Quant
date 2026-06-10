-- 00000000000035_paper_bot_orders.sql
-- Pending-order model for the Soros paper bot: next-open fills.
--
-- WHY: the bot previously filled at the latest close in DB, which at
-- 07:00 is YESTERDAY's close — a price from before the signal that no
-- real trader could obtain, and systematically flattering because our
-- signals react to the US overnight session (buy signal → filled at
-- pre-gap price). Standard daily-signal backtesting fills at the FIRST
-- OBTAINABLE price after the signal: the signal day's 09:00 open.
--
-- Mechanics: orders are placed pre-market on signal day S and fill at
-- S's open, which lands in korea_market the next morning — so fills are
-- confirmed one pipeline run later, at honest prices. Buy orders
-- RESERVE cash (budget) at placement; the unspent remainder is refunded
-- at fill, everything on cancellation.

CREATE TABLE IF NOT EXISTS paper_bot_orders (
    id             BIGSERIAL PRIMARY KEY,
    order_date     DATE        NOT NULL,            -- signal day (pre-market)
    ticker         VARCHAR(10) NOT NULL,
    side           VARCHAR(4)  NOT NULL CHECK (side IN ('buy', 'sell')),
    budget         BIGINT,                          -- buys: reserved cash (incl. costs)
    qty            INTEGER,                         -- sells: shares to exit
    signal_grade   TEXT,
    weighted_score FLOAT,
    reason         TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'filled', 'cancelled')),
    fill_date      DATE,
    fill_price     INTEGER,
    cancel_reason  TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_bot_orders_pending_idx
    ON paper_bot_orders (order_date) WHERE status = 'pending';

COMMENT ON TABLE paper_bot_orders IS
    'Soros 모의투자 체결 대기 주문 — 신호일 시가 체결 (executor/paper_trader_bot.py)';

ALTER TABLE paper_bot_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paper_bot_orders_read ON paper_bot_orders;
CREATE POLICY paper_bot_orders_read ON paper_bot_orders
    FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
