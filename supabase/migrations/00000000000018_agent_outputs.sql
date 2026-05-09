-- 00000000000018_agent_outputs.sql
-- 8-agent character system: per-agent per-cycle output ledger.
--
-- Lives ALONGSIDE the legacy 7-step pipeline tables (ai_scores, ai_commentary,
-- market_briefs). Strangler Fig: nothing in this migration touches existing
-- tables — agent outputs are written by the new agents/* package and consumed
-- by Soros (M2+) to produce final_signals (migration 19).
--
-- One row per (agent, ticker, cycle_at). Tickers are NULL for whole-market
-- outputs (e.g., Soros' daily briefing, Shiller's market regime call).
--
-- Score scale: -2.00 (strong sell) … 0.00 (hold) … +2.00 (strong buy).
-- Severity is Taleb-only (1=mild, 5=catastrophic), see character-taleb.md.
--
-- RLS: read by any authenticated user; writes service_role only (CLAUDE.md §E).

CREATE TABLE IF NOT EXISTS agent_outputs (
    id            UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    agent_name    TEXT NOT NULL,
    cycle_at      TIMESTAMPTZ NOT NULL,
    ticker        TEXT,                                       -- NULL = market-wide output
    score         NUMERIC(4, 2),                              -- -2.00 ~ +2.00, NULL allowed for narrative-only outputs
    severity      SMALLINT,                                   -- Taleb only, 1..5
    narrative     TEXT NOT NULL,                              -- Korean human-readable; CLAUDE.md §3-A forbidden-words guard upstream
    raw_payload   JSONB NOT NULL DEFAULT '{}'::JSONB,         -- character-specific structured data (Graham fair-value breakdown, Dow trend stage, etc.)
    model         VARCHAR(50),                                -- e.g., "claude-sonnet-4-6"
    cost_estimate DOUBLE PRECISION,                           -- USD; sums into M1-T10 cost dashboard
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT agent_outputs_agent_name_chk
        CHECK (agent_name IN ('soros','taleb','simons','graham','dow','shiller','keynes','turing')),
    CONSTRAINT agent_outputs_score_range_chk
        CHECK (score IS NULL OR (score >= -2.00 AND score <= 2.00)),
    CONSTRAINT agent_outputs_severity_range_chk
        CHECK (severity IS NULL OR (severity BETWEEN 1 AND 5)),
    CONSTRAINT agent_outputs_severity_taleb_only_chk
        CHECK (severity IS NULL OR agent_name = 'taleb'),
    CONSTRAINT agent_outputs_ticker_format_chk
        CHECK (ticker IS NULL OR ticker ~ '^[A-Z0-9.\-]{1,12}$')   -- KR 6-digit, US ticker, BRK.B / BRK-B share class all pass
);

-- Hot read paths:
--   1) "give me agent X's recent outputs" (ledger view)
--   2) "give me all agents' takes on ticker T at the latest cycle" (Soros aggregation)
--   3) "scan for severity 4+ Taleb alerts since timestamp" (real-time alerts)
CREATE INDEX IF NOT EXISTS agent_outputs_agent_cycle_idx
    ON agent_outputs (agent_name, cycle_at DESC);
CREATE INDEX IF NOT EXISTS agent_outputs_ticker_cycle_idx
    ON agent_outputs (ticker, cycle_at DESC) WHERE ticker IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_outputs_taleb_severity_idx
    ON agent_outputs (cycle_at DESC, severity)
    WHERE agent_name = 'taleb' AND severity >= 4;

-- RLS — read for any authenticated user, writes only via service_role.
-- Soros narratives + Taleb warnings are not PII and benefit all watchers,
-- so SELECT is broad. Cost data leaks competitive info; we may revisit
-- masking cost_estimate at the API layer in M2+ if needed.
ALTER TABLE agent_outputs ENABLE ROW LEVEL SECURITY;

CREATE POLICY auth_read_agent_outputs ON agent_outputs
    FOR SELECT TO authenticated USING (TRUE);

-- service_role bypasses RLS by default; no explicit INSERT/UPDATE policy
-- means non-service-role writes are denied. This matches the convention
-- in 00000000000005_rls_policies.sql.

-- PostgREST schema cache reload so the new table is queryable from the
-- Supabase JS client immediately after migration.
NOTIFY pgrst, 'reload schema';
