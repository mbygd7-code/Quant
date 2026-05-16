-- 24 · user_favorites — personal 관심주식 set per user
--
-- Mirrors the localStorage `qs:favorites:v1` list on the server so the
-- cycle orchestrator (`agents/cycle/run_m4_cycle.py`) knows which tickers
-- to spend LLM budget on. Stage-1 data collection (collectors/) continues
-- to run over the full admin watchlist; only the expensive Stage-2 LLM
-- analysis is gated by this table.
--
-- Why a new table instead of repurposing user_watchlists (migration 4)?
--   - `user_watchlists` is per-watchlist-config (the legacy "베타 테스터
--     마다 자기 watchlist" model). Favorites are a lighter concept and
--     the union across all users feeds the cycle universe selector.
--   - Keeping it separate lets us bulk-query the union without joining
--     through a watchlist_id intermediate.
--
-- DEV_BYPASS_AUTH special-cases user_id = 'dev-bypass' so local dev can
-- still write here without a real auth.users row.

CREATE TABLE IF NOT EXISTS user_favorites (
    -- Either an auth.users.id, OR the literal 'dev-bypass' for the dev
    -- shortcut. TEXT (not UUID) so the dev sentinel passes the check.
    user_id     TEXT        NOT NULL,
    ticker      TEXT        NOT NULL,
    added_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT user_favorites_pkey
        PRIMARY KEY (user_id, ticker),
    CONSTRAINT user_favorites_ticker_format_chk
        -- 6-char alphanumeric — letters appear in newer ETF codes (0167A0).
        CHECK (ticker ~ '^[A-Z0-9]{6}$')
);

-- Hot path: "what tickers does this user have?" for personalised pages.
CREATE INDEX IF NOT EXISTS user_favorites_user_idx
    ON user_favorites (user_id);

-- Cycle orchestrator hot path: union of all users' tickers.
CREATE INDEX IF NOT EXISTS user_favorites_ticker_idx
    ON user_favorites (ticker);

-- RLS — users can read/write only their own rows. The cycle worker uses
-- the service_role key so it bypasses RLS for the union query.
ALTER TABLE user_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_favorites_self_read ON user_favorites
    FOR SELECT TO authenticated
    USING (user_id = auth.uid()::text);

CREATE POLICY user_favorites_self_write ON user_favorites
    FOR ALL TO authenticated
    USING (user_id = auth.uid()::text)
    WITH CHECK (user_id = auth.uid()::text);

COMMENT ON TABLE user_favorites IS
    'Personal 관심주식 set per user — gates Stage-2 LLM analysis in the M4 cycle. Stage-1 collectors keep ingesting all is_watchlist=true stocks regardless.';

NOTIFY pgrst, 'reload schema';
