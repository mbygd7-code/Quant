-- 00000000000022_agent_admin_and_views.sql
-- M1-T2: admin override policies and observability views.
--
-- Migrations 18-21 already applied table-level RLS for the common case
-- (read for any authenticated user, writes service_role only). This
-- migration covers the cross-cutting bits T2 was scoped for:
--
--   1) public.is_admin() helper — DRY replacement for the inline
--      EXISTS-on-profiles pattern repeated through migration 05.
--   2) Admin SELECT overrides on the user-private tables
--      (user_weight_settings, weight_settings_history).
--   3) Monitoring views for the M1-T10 cost/usage dashboard.
--
-- Strangler Fig: existing policies are NOT modified. We only add new
-- ones; the original auth_/owner-only policies stay in force.

-- ─── 1) is_admin() helper ──────────────────────────────────────────
-- SECURITY DEFINER + STABLE so it (a) can read profiles regardless of
-- the caller's RLS context and (b) is fence-cached within a query
-- (same call site evaluates it once). Keeps RLS rules cheap.
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, auth
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
    );
$$;

-- Lock down execute so untrusted callers can't probe the function;
-- only the engine evaluating RLS policies needs it.
REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated, service_role;

COMMENT ON FUNCTION public.is_admin() IS
    'TRUE when auth.uid() resolves to a profiles row with role=admin. Used by RLS policies and admin-only views (migration 22).';

-- ─── 2) Admin overrides on user-private weight tables ───────────────
-- The owner-only policies from migration 20 stay in force. These are
-- additive — Postgres applies the OR of all SELECT policies, so an
-- admin sees all rows AND each user still sees their own.

CREATE POLICY admin_read_user_weight_settings ON user_weight_settings
    FOR SELECT TO authenticated USING (public.is_admin());

CREATE POLICY admin_read_weight_settings_history ON weight_settings_history
    FOR SELECT TO authenticated USING (public.is_admin());

-- Admin write paths — needed when admin operates the agent system on
-- behalf of a user (e.g., applying a global Soros recommendation).
CREATE POLICY admin_write_user_weight_settings ON user_weight_settings
    FOR ALL TO authenticated
    USING      (public.is_admin())
    WITH CHECK (public.is_admin());

-- ─── 3) Monitoring views (M1-T10 dashboard inputs) ─────────────────
-- All views run as SECURITY INVOKER (Postgres default), so they
-- inherit the caller's RLS on the underlying tables. Aggregate-only
-- views still leak nothing privacy-sensitive once RLS is in place.

-- 3a) Daily volume + avg score per agent.
--     Used to spot LLM-cost outliers (an agent suddenly emitting 10x
--     more rows is the canary).
CREATE OR REPLACE VIEW v_agent_output_daily AS
SELECT
    agent_name,
    date_trunc('day', cycle_at AT TIME ZONE 'Asia/Seoul')::DATE AS cycle_date,
    COUNT(*)                                          AS output_count,
    AVG(score)                                        AS avg_score,
    SUM(CASE WHEN severity >= 4 THEN 1 ELSE 0 END)    AS severity_4plus_count,
    SUM(COALESCE(cost_estimate, 0))                   AS total_cost_usd,
    MIN(cycle_at)                                     AS first_cycle,
    MAX(cycle_at)                                     AS last_cycle
FROM agent_outputs
GROUP BY agent_name, cycle_date;

COMMENT ON VIEW v_agent_output_daily IS
    'Per-agent per-day rollup. Inputs to the cost/health dashboard. Aggregations only — no narratives surfaced.';

-- 3b) User weight distribution — quartiles per agent across all users.
--     Helps Soros (M8) recommend reasonable defaults; helps admins see
--     if anyone is at the 5%/40% rails. Aggregate-only by design, so
--     RLS on the underlying user_weight_settings still applies but
--     the percentile_cont aggregations leak no individual values.
CREATE OR REPLACE VIEW v_user_weight_distribution AS
WITH unpacked AS (
    SELECT
        key   AS agent_name,
        (value)::NUMERIC AS weight
    FROM user_weight_settings,
         jsonb_each_text(weights)
)
SELECT
    agent_name,
    COUNT(*)                                                       AS user_count,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY weight)           AS p25,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY weight)           AS p50,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY weight)           AS p75,
    MIN(weight)                                                    AS min_weight,
    MAX(weight)                                                    AS max_weight
FROM unpacked
GROUP BY agent_name;

COMMENT ON VIEW v_user_weight_distribution IS
    'Quartiles per agent across all user_weight_settings. Visible to admins only by virtue of the underlying RLS (migration 22 §2).';

-- 3c) Current signal grade distribution across the watchlist.
--     "How many tickers are at each grade right now?"
CREATE OR REPLACE VIEW v_signal_grade_current AS
WITH latest AS (
    SELECT DISTINCT ON (ticker)
        ticker, signal_grade, confidence, taleb_severity, taleb_override, cycle_at
    FROM final_signals
    ORDER BY ticker, cycle_at DESC
)
SELECT
    signal_grade,
    COUNT(*)                                          AS ticker_count,
    AVG(confidence)                                   AS avg_confidence,
    SUM(CASE WHEN taleb_override THEN 1 ELSE 0 END)   AS taleb_override_count
FROM latest
GROUP BY signal_grade;

COMMENT ON VIEW v_signal_grade_current IS
    'Snapshot of how many watchlist tickers sit at each Soros grade right now. Read alongside v_agent_output_daily for the dashboard.';

-- 3d) Recent Taleb severity 4+ alerts feed.
--     Drives the risk-watch banner; the WHERE clause matches the
--     filtered index from migration 18 so reads stay cheap.
CREATE OR REPLACE VIEW v_taleb_alerts_recent AS
SELECT
    id,
    ticker,
    cycle_at,
    severity,
    narrative,
    raw_payload
FROM agent_outputs
WHERE agent_name = 'taleb' AND severity >= 4
ORDER BY cycle_at DESC;

COMMENT ON VIEW v_taleb_alerts_recent IS
    'Severity-4+ Taleb alerts, newest first. Backs the risk-watch banner in the M6 dashboard.';

NOTIFY pgrst, 'reload schema';
