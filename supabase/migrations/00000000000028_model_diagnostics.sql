-- 00000000000028_model_diagnostics.sql
-- Weekly score↔price predictive-power snapshots.
--
-- Each run of scripts/run_score_diagnostic.py (driven by the GitHub
-- Actions weekly cron) inserts one row per (horizon, scope) pair.
-- The admin dashboard reads this table to plot rolling correlation
-- and decide when voter weights need re-tuning.
--
-- We keep the schema small and column-light so it's easy to evolve:
-- new dimensions (e.g. ticker breakdown) can be added later via
-- separate ALTER TABLE migrations or a sibling table.

CREATE TABLE IF NOT EXISTS model_diagnostics (
    id           BIGSERIAL    PRIMARY KEY,
    run_date     DATE         NOT NULL,             -- KST date the diagnostic was run
    window_days  INTEGER      NOT NULL,             -- score-window lookback used
    scope_kind   VARCHAR(20)  NOT NULL,             -- 'overall' | 'voter' | 'sector'
    scope_name   VARCHAR(60)  NOT NULL,             -- 'final_score' / column name / sector name
    horizon_days INTEGER      NOT NULL,             -- 1 / 5 / 10
    spearman_rho FLOAT,                             -- NULL if n<3 or constant series
    n_pairs      INTEGER      NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT model_diagnostics_scope_kind_check
        CHECK (scope_kind IN ('overall', 'voter', 'sector', 'ticker'))
);

-- Hot path: "last N weeks of overall correlation at t+1" for the dashboard.
CREATE INDEX IF NOT EXISTS model_diagnostics_run_idx
    ON model_diagnostics (run_date DESC, scope_kind, horizon_days);

-- Per-voter trend lookup.
CREATE INDEX IF NOT EXISTS model_diagnostics_scope_idx
    ON model_diagnostics (scope_kind, scope_name, run_date DESC);

NOTIFY pgrst, 'reload schema';
