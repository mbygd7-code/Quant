-- 00000000000036_paper_policy.sql
-- Soros 트레이딩 정책 진화 — learned, bounded, evidence-backed.
--
-- The trading policy (grade trust multipliers, stop-loss level, sector
-- multipliers) is no longer hardcoded: a weekly learner replays the
-- immutable trade ledger, measures what actually worked (per-grade win
-- rates, post-stop price paths, per-sector hit rates), and appends a
-- new policy VERSION here. The bot always reads the latest version.
--
-- Safety-by-construction:
--   · append-only versions — full audit trail of how the policy evolved
--   · every parameter is HARD-BOUNDED in executor/policy_learner.py
--     (e.g., stop-loss can only live in [-15%, -7%]) and moves at most
--     one capped step per update
--   · minimum-sample gates: a bucket with too few round-trips cannot
--     move its parameter (no learning from noise)
--   · evidence jsonb stores the stats that justified each change

CREATE TABLE IF NOT EXISTS paper_policy_state (
    version     BIGSERIAL PRIMARY KEY,
    params      JSONB NOT NULL,     -- {grade_mult, stop_loss_pct, sector_mult}
    evidence    JSONB NOT NULL,     -- bucket stats that justified params
    notes       TEXT,               -- human-readable change summary
    n_episodes  INT NOT NULL DEFAULT 0,  -- round-trips analyzed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE paper_policy_state IS
    'Soros 매매 정책 버전 — executor/policy_learner.py가 주간 학습으로 append';

ALTER TABLE paper_policy_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS paper_policy_state_read ON paper_policy_state;
CREATE POLICY paper_policy_state_read ON paper_policy_state
    FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
