-- 00000000000019_signals_and_briefings.sql
-- Soros' final outputs: per-ticker signal grade, change ledger, and the
-- daily briefing card that aggregates everything for the dashboard.
--
-- Reads from agent_outputs (migration 18). Writes consumed by the web UI
-- (M6+) and notifier dispatch (replaces nothing — adds alongside
-- legacy notifier/dispatcher.py).
--
-- Three tables in this migration so they share one transactional unit
-- (signal change → ledger row → briefing update happen together).

-- 1) final_signals — current signal per ticker per cycle.
--    One row per (ticker, cycle_at). Latest grade lookup is the hot path.
CREATE TABLE IF NOT EXISTS final_signals (
    id              UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    ticker          TEXT NOT NULL,
    cycle_at        TIMESTAMPTZ NOT NULL,
    signal_grade    TEXT NOT NULL,                            -- 강한관심 / 관심 / 관망 / 주의 / 위험
    confidence      NUMERIC(3, 2),                            -- 0.00 ~ 1.00 (Soros' Q1 weighted score → confidence)
    weighted_score  NUMERIC(4, 2),                            -- Q1 result before grade mapping
    weights_snapshot JSONB NOT NULL,                          -- {simons:0.20, graham:0.18, ...} + any Soros overlay applied
    narrative       TEXT NOT NULL,                            -- Soros' synthesis quoting other agents
    taleb_severity  SMALLINT,                                 -- echoed from agent_outputs for fast filtering
    taleb_override  BOOLEAN NOT NULL DEFAULT FALSE,           -- TRUE when Taleb auto-constraint downgraded the grade
    cost_estimate   DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT final_signals_grade_chk
        CHECK (signal_grade IN ('STRONG_BUY','BUY','HOLD','CAUTION','RISK')),
    CONSTRAINT final_signals_confidence_chk
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    CONSTRAINT final_signals_weighted_score_chk
        CHECK (weighted_score IS NULL OR (weighted_score >= -2 AND weighted_score <= 2)),
    CONSTRAINT final_signals_taleb_severity_chk
        CHECK (taleb_severity IS NULL OR (taleb_severity BETWEEN 1 AND 5)),
    CONSTRAINT final_signals_ticker_format_chk
        CHECK (ticker ~ '^[A-Z0-9.\-]{1,12}$'),
    CONSTRAINT final_signals_unique_per_cycle
        UNIQUE (ticker, cycle_at)
);

CREATE INDEX IF NOT EXISTS final_signals_ticker_cycle_idx
    ON final_signals (ticker, cycle_at DESC);
CREATE INDEX IF NOT EXISTS final_signals_grade_cycle_idx
    ON final_signals (signal_grade, cycle_at DESC);

-- 2) signal_change_events — append-only audit of grade transitions.
--    Source for "오늘 무엇이 바뀌었나" notification + history view.
CREATE TABLE IF NOT EXISTS signal_change_events (
    id                  UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    ticker              TEXT NOT NULL,
    from_grade          TEXT,                                 -- NULL on first appearance
    to_grade            TEXT NOT NULL,
    from_signal_id      UUID REFERENCES final_signals(id),
    to_signal_id        UUID NOT NULL REFERENCES final_signals(id),
    reason              TEXT NOT NULL,                        -- e.g., 'agent_consensus_shift', 'taleb_severity_4', 'weight_change'
    taleb_override      BOOLEAN NOT NULL DEFAULT FALSE,
    notified_at         TIMESTAMPTZ,                          -- NULL if not yet pushed
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT signal_change_events_grade_from_chk
        CHECK (from_grade IS NULL OR from_grade IN ('STRONG_BUY','BUY','HOLD','CAUTION','RISK')),
    CONSTRAINT signal_change_events_grade_to_chk
        CHECK (to_grade IN ('STRONG_BUY','BUY','HOLD','CAUTION','RISK'))
);

CREATE INDEX IF NOT EXISTS signal_change_events_ticker_idx
    ON signal_change_events (ticker, created_at DESC);
CREATE INDEX IF NOT EXISTS signal_change_events_pending_notify_idx
    ON signal_change_events (created_at) WHERE notified_at IS NULL;

-- 3) daily_briefings — one card per day summarising Soros' view across
--    the watchlist. Shown above the global cards on /dashboard (M6+).
CREATE TABLE IF NOT EXISTS daily_briefings (
    date            DATE PRIMARY KEY,
    headline        VARCHAR(200) NOT NULL,
    summary_md      TEXT NOT NULL,                            -- Soros' day-opener narrative (Korean, markdown)
    top_stocks      JSONB NOT NULL DEFAULT '[]'::JSONB,       -- [{ticker, grade, conviction, hook}, ...]
    risk_alerts     JSONB NOT NULL DEFAULT '[]'::JSONB,       -- Taleb-severity-4+ items surfaced to the briefing
    market_regime   TEXT,                                     -- e.g., 'late-cycle', 'early-recovery' (Shiller-driven)
    weights_in_use  JSONB,                                    -- system default; per-user overlays applied at read time
    cost_estimate   DOUBLE PRECISION,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS daily_briefings_created_idx
    ON daily_briefings (created_at DESC);

-- RLS — read for any authenticated user. Writes service_role only.
-- Signals + briefings are not PII; everyone with watchlist access
-- benefits from seeing them.
ALTER TABLE final_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE signal_change_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_briefings ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_read_final_signals ON final_signals
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_signal_change_events ON signal_change_events
    FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY auth_read_daily_briefings ON daily_briefings
    FOR SELECT TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
