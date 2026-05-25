-- Phase A — Signal accuracy measurement infrastructure
--
-- Adds five views the admin dashboard needs to answer the core question:
-- "Are our signals actually right?"  All views are CREATE OR REPLACE and
-- read-only — no schema changes to existing tables.
--
-- Time-zone note: final_signals.cycle_at is TIMESTAMPTZ; korea_market.date
-- is DATE in KST.  We convert via AT TIME ZONE 'Asia/Seoul' before casting
-- to DATE so the entry day lines up correctly.
--
-- Trading-day forward returns are computed via ROW_NUMBER() per ticker.
-- Holidays/non-trading days are skipped naturally because korea_market only
-- contains trading-day rows.

-- ---------------------------------------------------------------------------
-- Base view: each final_signal augmented with entry close and forward closes
-- at the next 1, 5, and 10 trading days.  All downstream views read from
-- this one so the JOIN logic lives in exactly one place.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_signal_forward_returns AS
WITH market_ranked AS (
    SELECT
        ticker,
        date,
        close,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date) AS rn
    FROM korea_market
    WHERE close IS NOT NULL AND close > 0
),
signals AS (
    SELECT
        f.id AS signal_id,
        f.ticker,
        f.signal_grade,
        f.confidence::FLOAT AS confidence,
        f.weighted_score::FLOAT AS weighted_score,
        f.taleb_severity,
        f.taleb_override,
        (f.cycle_at AT TIME ZONE 'Asia/Seoul')::DATE AS cycle_date,
        f.cycle_at
    FROM final_signals f
)
SELECT
    s.signal_id,
    s.ticker,
    s.signal_grade,
    s.confidence,
    s.weighted_score,
    s.taleb_severity,
    s.taleb_override,
    s.cycle_date,
    s.cycle_at,
    r0.close AS entry_close,
    r1.close AS close_1d,
    r5.close AS close_5d,
    r10.close AS close_10d,
    CASE
        WHEN r0.close IS NOT NULL AND r1.close IS NOT NULL
        THEN (r1.close::FLOAT - r0.close) / r0.close
    END AS return_1d,
    CASE
        WHEN r0.close IS NOT NULL AND r5.close IS NOT NULL
        THEN (r5.close::FLOAT - r0.close) / r0.close
    END AS return_5d,
    CASE
        WHEN r0.close IS NOT NULL AND r10.close IS NOT NULL
        THEN (r10.close::FLOAT - r0.close) / r0.close
    END AS return_10d
FROM signals s
LEFT JOIN market_ranked r0
       ON r0.ticker = s.ticker AND r0.date = s.cycle_date
LEFT JOIN market_ranked r1
       ON r1.ticker = s.ticker AND r1.rn = r0.rn + 1
LEFT JOIN market_ranked r5
       ON r5.ticker = s.ticker AND r5.rn = r0.rn + 5
LEFT JOIN market_ranked r10
      ON r10.ticker = s.ticker AND r10.rn = r0.rn + 10;

COMMENT ON VIEW v_signal_forward_returns IS
    'Phase A base view: every final_signal joined to its entry close and '
    'forward closes at 1/5/10 trading days. Used by hit-rate, calibration, '
    'and Taleb-override views.';

-- ---------------------------------------------------------------------------
-- v_signal_hit_rate
-- Per signal_grade × horizon: how often the next-N-day return is positive,
-- plus the average return.  This is the single most important table for
-- answering "does STRONG_BUY actually mean strong upside?".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_signal_hit_rate AS
SELECT
    signal_grade,
    COUNT(return_1d) AS n_1d,
    ROUND(AVG((return_1d > 0)::INT)::NUMERIC, 3) AS hit_rate_1d,
    ROUND(AVG(return_1d)::NUMERIC, 4) AS avg_return_1d,
    COUNT(return_5d) AS n_5d,
    ROUND(AVG((return_5d > 0)::INT)::NUMERIC, 3) AS hit_rate_5d,
    ROUND(AVG(return_5d)::NUMERIC, 4) AS avg_return_5d,
    COUNT(return_10d) AS n_10d,
    ROUND(AVG((return_10d > 0)::INT)::NUMERIC, 3) AS hit_rate_10d,
    ROUND(AVG(return_10d)::NUMERIC, 4) AS avg_return_10d
FROM v_signal_forward_returns
GROUP BY signal_grade;

COMMENT ON VIEW v_signal_hit_rate IS
    'Hit rate (% of times forward return > 0) and average forward return '
    'per signal grade, at 1/5/10 trading-day horizons.';

-- ---------------------------------------------------------------------------
-- v_signal_calibration
-- Confidence decile × actual 5-day hit rate. For a well-calibrated model,
-- bucket "0.7-0.8" should have ~75% hit rate.  Front-end plots
-- actual_hit_rate_5d vs avg_confidence and looks for the y=x line.
-- Restricted to positive-direction signals (STRONG_BUY / BUY) since those
-- are the actionable ones for an investor following the recommendation.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_signal_calibration AS
WITH bucketed AS (
    SELECT
        CASE
            WHEN confidence < 0.1 THEN 1
            WHEN confidence < 0.2 THEN 2
            WHEN confidence < 0.3 THEN 3
            WHEN confidence < 0.4 THEN 4
            WHEN confidence < 0.5 THEN 5
            WHEN confidence < 0.6 THEN 6
            WHEN confidence < 0.7 THEN 7
            WHEN confidence < 0.8 THEN 8
            WHEN confidence < 0.9 THEN 9
            ELSE 10
        END AS confidence_decile,
        confidence,
        return_5d
    FROM v_signal_forward_returns
    WHERE confidence IS NOT NULL
      AND return_5d IS NOT NULL
      AND signal_grade IN ('STRONG_BUY', 'BUY')
)
SELECT
    confidence_decile,
    (confidence_decile - 1) * 0.1 AS decile_low,
    confidence_decile * 0.1 AS decile_high,
    COUNT(*) AS n_signals,
    ROUND(AVG(confidence)::NUMERIC, 3) AS avg_confidence,
    ROUND(AVG((return_5d > 0)::INT)::NUMERIC, 3) AS actual_hit_rate_5d,
    ROUND(AVG(return_5d)::NUMERIC, 4) AS avg_return_5d
FROM bucketed
GROUP BY confidence_decile
ORDER BY confidence_decile;

COMMENT ON VIEW v_signal_calibration IS
    'Calibration table: for positive signals (STRONG_BUY/BUY), how does '
    'stated confidence compare to actual 5-day hit rate?';

-- ---------------------------------------------------------------------------
-- v_taleb_override_effectiveness
-- The auto-downgrade by Taleb (severity >= 4) is supposed to predict big
-- losses.  This view checks whether stocks that got overridden actually
-- under-performed peers in the next 10 trading days.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_taleb_override_effectiveness AS
WITH override_signals AS (
    SELECT *
    FROM v_signal_forward_returns
    WHERE taleb_override = TRUE
      AND return_10d IS NOT NULL
),
no_override AS (
    SELECT *
    FROM v_signal_forward_returns
    WHERE taleb_override = FALSE
      AND return_10d IS NOT NULL
)
SELECT
    -- Override cohort metrics
    (SELECT COUNT(*) FROM override_signals) AS n_overrides,
    ROUND(
        (SELECT AVG(return_10d) FROM override_signals)::NUMERIC, 4
    ) AS override_avg_return_10d,
    ROUND(
        (SELECT AVG((return_10d < -0.05)::INT) FROM override_signals)::NUMERIC, 3
    ) AS override_loss_5pct_rate,
    -- Baseline cohort metrics (everything else)
    (SELECT COUNT(*) FROM no_override) AS n_baseline,
    ROUND(
        (SELECT AVG(return_10d) FROM no_override)::NUMERIC, 4
    ) AS baseline_avg_return_10d,
    ROUND(
        (SELECT AVG((return_10d < -0.05)::INT) FROM no_override)::NUMERIC, 3
    ) AS baseline_loss_5pct_rate;

COMMENT ON VIEW v_taleb_override_effectiveness IS
    'Did Taleb auto-overrides actually predict bad outcomes? Compares '
    '10-day forward returns of override vs non-override signals.';

-- ---------------------------------------------------------------------------
-- v_feedback_signal_link
-- Joins user_feedback to the corresponding final_signal on (ticker, date),
-- then attaches the forward returns from v_signal_forward_returns.
-- Lets us answer:
--   • Do 5-star user ratings correlate with actually-correct signals?
--   • Does the model agree with subjective user satisfaction?
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_feedback_signal_link AS
SELECT
    uf.id AS feedback_id,
    uf.user_id,
    uf.date AS feedback_date,
    uf.ticker,
    uf.accuracy_score,
    uf.usefulness_score,
    uf.comment,
    uf.source AS feedback_source,
    uf.created_at AS feedback_created_at,
    vfr.signal_id,
    vfr.signal_grade,
    vfr.confidence,
    vfr.weighted_score,
    vfr.taleb_override,
    vfr.return_1d,
    vfr.return_5d,
    vfr.return_10d
FROM user_feedback uf
LEFT JOIN v_signal_forward_returns vfr
       ON vfr.ticker = uf.ticker
      AND vfr.cycle_date = uf.date;

COMMENT ON VIEW v_feedback_signal_link IS
    'User feedback joined to the same-date final_signal, plus forward '
    'returns. Used to detect whether subjective user scores correlate '
    'with actual signal accuracy.';
