-- 00000000000025_kr_fear_greed.sql
-- Add the 8th weighted factor: KR-specific Fear & Greed index.
--
-- Two columns:
--   weight_configs.kr_fear_greed_weight — admin-tunable weight
--   ai_scores.kr_fear_greed_score        — per-(date,ticker) subscore
--
-- Existing weight_configs rows are renormalized so they still sum to
-- 1.0 with the new factor at 0.05: each of the 7 original weights is
-- scaled by 0.95 and the new column defaults to 0.05.
--
-- Rollback strategy: set kr_fear_greed_weight = 0 on all rows. The
-- scorer's _combine becomes mathematically identical to pre-migration
-- (the 8th term vanishes), no code change required.

ALTER TABLE weight_configs
    ADD COLUMN IF NOT EXISTS kr_fear_greed_weight FLOAT NOT NULL DEFAULT 0.05;

ALTER TABLE ai_scores
    ADD COLUMN IF NOT EXISTS kr_fear_greed_score FLOAT;

-- Renormalize existing weight_configs rows (scale the 7 originals by
-- 0.95 so the 8 components still sum to 1.00). Rows inserted after
-- this migration set their own weights explicitly via the admin UI.
UPDATE weight_configs SET
    global_market_weight    = ROUND((global_market_weight    * 0.95)::NUMERIC, 4),
    sector_weight           = ROUND((sector_weight           * 0.95)::NUMERIC, 4),
    related_us_stock_weight = ROUND((related_us_stock_weight * 0.95)::NUMERIC, 4),
    news_sentiment_weight   = ROUND((news_sentiment_weight   * 0.95)::NUMERIC, 4),
    fundamental_weight      = ROUND((fundamental_weight      * 0.95)::NUMERIC, 4),
    volume_flow_weight      = ROUND((volume_flow_weight      * 0.95)::NUMERIC, 4),
    risk_penalty_weight     = ROUND((risk_penalty_weight     * 0.95)::NUMERIC, 4)
WHERE kr_fear_greed_weight = 0.05;  -- only the rows we haven't touched

-- Fix any tiny rounding drift on the active row so the UI's
-- "합계 1.00 ✓" check still passes after migration.
UPDATE weight_configs
SET kr_fear_greed_weight = ROUND(
    (1.0
        - global_market_weight
        - sector_weight
        - related_us_stock_weight
        - news_sentiment_weight
        - fundamental_weight
        - volume_flow_weight
        - risk_penalty_weight
    )::NUMERIC,
    4
)
WHERE is_active = TRUE;

NOTIFY pgrst, 'reload schema';
