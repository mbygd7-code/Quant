-- 00000000000020_weights_v2.sql
-- 8-agent weight system. Distinct from the legacy 7-factor weight_config
-- (migration 08, used by cognition.scorer) — both coexist until M2+ when
-- we can verify the new system is producing better signals.
--
-- Three tables:
--   * user_weight_settings — current per-user weights (one row per user)
--   * weight_settings_history — append-only ledger of changes
--   * soros_weight_adjustments — Soros' temporary ±50% market-adaptive overlays
--
-- See system-weight-settings.md for the constraint logic (5%~40% per
-- agent, Taleb floor 10%, sum = 1.0). Validation lives in
-- agents/weights/validator.py (M1-T4). DB-level CHECKs catch only the
-- range bounds; sum-equals-1 + Taleb floor are enforced application-side
-- because postgres can't easily express "sum of jsonb floats = 1.0".

-- 1) user_weight_settings — one row per user.
--    Default values applied at insert via app code (constants.py
--    DEFAULT_WEIGHTS), not DB default, because the value depends on the
--    8-agent set evolving over time.
CREATE TABLE IF NOT EXISTS user_weight_settings (
    user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    weights     JSONB NOT NULL,                               -- {simons, graham, dow, shiller, keynes, taleb}
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Range guard: every agent's weight must be 0.05..0.40. Sum check
    -- is application-side (validator.py) because jsonb_each requires a
    -- subquery that's awkward in CHECK.
    CONSTRAINT user_weight_settings_per_agent_range_chk CHECK (
        (weights -> 'simons')::NUMERIC BETWEEN 0.05 AND 0.40
        AND (weights -> 'graham')::NUMERIC BETWEEN 0.05 AND 0.40
        AND (weights -> 'dow')::NUMERIC BETWEEN 0.05 AND 0.40
        AND (weights -> 'shiller')::NUMERIC BETWEEN 0.05 AND 0.40
        AND (weights -> 'keynes')::NUMERIC BETWEEN 0.05 AND 0.40
        AND (weights -> 'taleb')::NUMERIC BETWEEN 0.10 AND 0.40       -- Taleb floor 10%
    )
);

-- 2) weight_settings_history — append-only.
CREATE TABLE IF NOT EXISTS weight_settings_history (
    id              UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    before_weights  JSONB,                                    -- NULL on first set
    after_weights   JSONB NOT NULL,
    source          TEXT NOT NULL,                            -- 'user_manual' | 'soros_recommendation' | 'admin' | 'migration'
    note            TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT weight_settings_history_source_chk
        CHECK (source IN ('user_manual','soros_recommendation','admin','migration'))
);

CREATE INDEX IF NOT EXISTS weight_settings_history_user_idx
    ON weight_settings_history (user_id, created_at DESC);

-- 3) soros_weight_adjustments — Soros' temporary overlay (e.g., raise
--    Taleb's weight 50% during high-volatility regimes). User's stored
--    weights are NOT modified; this overlay is applied at signal-
--    generation time only.
CREATE TABLE IF NOT EXISTS soros_weight_adjustments (
    id                UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    cycle_at          TIMESTAMPTZ NOT NULL,
    overlay           JSONB NOT NULL,                         -- {agent: multiplier}, e.g., {"taleb": 1.5, "simons": 0.5}
    rationale         TEXT NOT NULL,
    valid_until       TIMESTAMPTZ,                            -- NULL = single-cycle only
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Soros can flex any single agent ±50% per spec; cap multiplier 0.5..1.5.
    CONSTRAINT soros_weight_adjustments_overlay_range_chk CHECK (
        NOT EXISTS (
            SELECT 1 FROM jsonb_each_text(overlay) AS e(k, v)
            WHERE v::NUMERIC < 0.5 OR v::NUMERIC > 1.5
        )
    )
);

CREATE INDEX IF NOT EXISTS soros_weight_adjustments_cycle_idx
    ON soros_weight_adjustments (cycle_at DESC);

-- updated_at trigger reused from migration 07 pattern.
CREATE OR REPLACE FUNCTION user_weight_settings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_weight_settings_updated_at ON user_weight_settings;
CREATE TRIGGER user_weight_settings_updated_at
    BEFORE UPDATE ON user_weight_settings
    FOR EACH ROW EXECUTE FUNCTION user_weight_settings_set_updated_at();

-- RLS — owners only on user_weight_settings + weight_settings_history.
-- soros_weight_adjustments is system-wide and readable by all.
ALTER TABLE user_weight_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE weight_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE soros_weight_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_owns_weight_settings ON user_weight_settings
    FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY user_updates_weight_settings ON user_weight_settings
    FOR UPDATE TO authenticated
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY user_inserts_weight_settings ON user_weight_settings
    FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

CREATE POLICY user_reads_own_weight_history ON weight_settings_history
    FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY auth_read_soros_adjustments ON soros_weight_adjustments
    FOR SELECT TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
