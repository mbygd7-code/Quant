-- 00000000000033_price_forecasts.sql
-- Price-forecast ledger: the self-improving accuracy loop.
--
-- Purpose (per product intent): every day we RECORD the 5-trading-day
-- price forecast together with the AI-expert consensus that produced
-- it. Five days later the row is evaluated against the realized close.
-- The accumulated ledger then CALIBRATES future forecasts:
--   • k (expert tilt strength)  ← corr(expert_score, realized return)
--   • band_mult (cone width)    ← realized 95%-band coverage
-- So the forecast literally gets more reliable as evidence accumulates,
-- and the UI can show "how well do the experts' calls map to prices".
--
-- Rows are IMMUTABLE once written (insert-only per (ticker, date));
-- only the evaluation columns are filled in later.

CREATE TABLE IF NOT EXISTS price_forecasts (
    ticker         TEXT NOT NULL,
    forecast_date  DATE NOT NULL,            -- base KR close date
    target_date    DATE NOT NULL,            -- forecast_date + horizon trading days
    horizon_days   INT  NOT NULL DEFAULT 5,

    -- forecast at creation time
    base_price     BIGINT NOT NULL,
    predicted      BIGINT NOT NULL,          -- point (median path)
    lower_band     BIGINT NOT NULL,          -- 95% lower
    upper_band     BIGINT NOT NULL,          -- 95% upper
    mu_eff         FLOAT,                    -- shrunk daily drift used
    sigma          FLOAT,                    -- daily log-return stdev used
    overnight_gap  FLOAT,                    -- applied US→KR log gap

    -- expert inputs at creation time (the thing we're auditing)
    expert_score   FLOAT,                    -- soros weighted_score (-2..+2)
    expert_grade   TEXT,                     -- STRONG_BUY..RISK
    expert_tilt    FLOAT,                    -- applied per-day log drift from experts
    calib_k        FLOAT,                    -- calibration coefficient used
    band_mult      FLOAT,                    -- band-width multiplier used
    model          TEXT NOT NULL,

    -- evaluation (filled once target_date's close is known)
    actual         BIGINT,
    actual_date    DATE,
    direction_hit  BOOLEAN,                  -- sign(predicted-base) == sign(actual-base)
    within_band    BOOLEAN,                  -- lower ≤ actual ≤ upper
    abs_pct_err    FLOAT,                    -- |actual-predicted|/actual
    evaluated_at   TIMESTAMPTZ,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ticker, forecast_date)
);

CREATE INDEX IF NOT EXISTS price_forecasts_eval_due_idx
    ON price_forecasts (target_date) WHERE actual IS NULL;
CREATE INDEX IF NOT EXISTS price_forecasts_evaluated_idx
    ON price_forecasts (ticker, forecast_date) WHERE actual IS NOT NULL;

COMMENT ON TABLE price_forecasts IS
    '일일 5거래일 가격 예측 기록부 — 전문가 합의 입력 + 실측 대조 + 자기보정 (signals/price_forecast.py)';

ALTER TABLE price_forecasts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS price_forecasts_read ON price_forecasts;
CREATE POLICY price_forecasts_read ON price_forecasts
    FOR SELECT TO authenticated USING (true);

NOTIFY pgrst, 'reload schema';
