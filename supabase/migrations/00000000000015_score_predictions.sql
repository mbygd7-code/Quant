-- 00000000000015_score_predictions.sql
-- ML-based forecast of final_score for the next N business days.
--
-- Design:
--   - score_predictions(date, ticker, horizon_day) primary key —
--     `date` is the day the forecast was *made*, `horizon_day` is how
--     many business days ahead (1..5). target_date is derived but stored
--     for cheap range queries.
--   - predicted_score: ScoreRegressor median (50th-percentile quantile)
--   - lower_95 / upper_95: 2.5th and 97.5th quantile predictions
--   - model_version: GBM "r1" etc. (separate from binary classifier in
--     existing predictions table)
--
-- The frontend reads the latest forecast (whose date == today) and
-- replaces the in-browser OLS extrapolation when ML predictions exist.

CREATE TABLE IF NOT EXISTS score_predictions (
    date           DATE NOT NULL,
    ticker         VARCHAR(10) NOT NULL,
    horizon_day    INTEGER NOT NULL,                     -- 1..5
    target_date    DATE NOT NULL,                        -- date + horizon_day business days
    predicted_score DOUBLE PRECISION NOT NULL,           -- median
    lower_95       DOUBLE PRECISION,
    upper_95       DOUBLE PRECISION,
    model_version  VARCHAR(20) NOT NULL DEFAULT 'gbr_r1',
    created_at     TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (date, ticker, horizon_day)
);

ALTER TABLE score_predictions
    ADD CONSTRAINT score_predictions_ticker_fk
    FOREIGN KEY (ticker) REFERENCES stocks (ticker) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS score_predictions_ticker_date_idx
    ON score_predictions (ticker, date DESC);
CREATE INDEX IF NOT EXISTS score_predictions_target_idx
    ON score_predictions (target_date);

ALTER TABLE score_predictions ENABLE ROW LEVEL SECURITY;
CREATE POLICY auth_read_score_predictions ON score_predictions FOR SELECT
    TO authenticated USING (TRUE);

NOTIFY pgrst, 'reload schema';
